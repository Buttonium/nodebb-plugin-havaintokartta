'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { getConfig } = require('./config');
const { db } = require('./nodebb');
const { formatBytes } = require('./utils');

// Redis/PostgreSQL keys (must match store.js and services.js)
const REPORT_KEYS = {
	allReports: 'havaintokartta:reports:all',
	report(reportId) {
		return `havaintokartta:report:${reportId}`;
	},
};

const SERVICE_KEYS = {
	allServices: 'palvelukartta:services:all',
	service(serviceId) {
		return `palvelukartta:service:${serviceId}`;
	},
};

async function listFilesRecursive(dirPath) {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		const results = [];

		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const fullPath = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				const subFiles = await listFilesRecursive(fullPath);
				for (const subFile of subFiles) {
					results.push(path.join(entry.name, subFile));
				}
			} else {
				results.push(entry.name);
			}
		}

		return results;
	} catch {
		return [];
	}
}

async function isEmptyDirectory(dirPath) {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			if (!entry.isDirectory()) return false; // has a visible file
			if (!(await isEmptyDirectory(path.join(dirPath, entry.name)))) {
				return false;
			}
		}
		return true; // no visible files, all subdirs are empty
	} catch {
		return true; // doesn't exist, treat as empty
	}
}

// empty dirs — safe to delete even date folders (they won't get new uploads)
async function findEmptyDirectories(dirPath, basePath) {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		const emptyDirs = [];

		for (const entry of entries) {
			if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
			const fullPath = path.join(dirPath, entry.name);
			if (await isEmptyDirectory(fullPath)) {
				const relPath = path.relative(basePath, fullPath);
				emptyDirs.push(relPath);
			} else {
				const subEmpty = await findEmptyDirectories(fullPath, basePath);
				for (const d of subEmpty) {
					emptyDirs.push(path.join(entry.name, d));
				}
			}
		}

		return emptyDirs;
	} catch {
		return [];
	}
}

async function getFileSize(filePath) {
	try {
		const stat = await fs.stat(filePath);
		return stat.size;
	} catch {
		return 0;
	}
}

function extractRelativePath(imageUrl, urlPrefix) {
	if (!imageUrl || typeof imageUrl !== 'string') return null;

	let pathname;
	try {
		pathname = new URL(imageUrl).pathname;
	} catch {
		// Not a full URL — maybe already a relative path
		pathname = imageUrl;
	}

	const normalizedPrefix = String(urlPrefix ?? '').trim().replace(/\/+$/, '');
	const expectedPrefix = `/${normalizedPrefix.replace(/^\/+/, '')}`;

	if (!pathname.startsWith(expectedPrefix)) return null;

	return pathname.slice(expectedPrefix.length).replace(/^\/+/, '');
}

async function getReferencedReportPaths(config) {
	const reportIds = await db.getSortedSetRevRange(REPORT_KEYS.allReports, 0, -1);
	const referencedPaths = new Set();

	if (reportIds.length === 0) {
		return referencedPaths;
	}

	const keys = reportIds.map((id) => REPORT_KEYS.report(id));
	const reports = await db.getObjects(keys);

	for (const report of reports) {
		if (report && report.images) {
			const relPath = extractRelativePath(report.images, config.uploadsUrlPrefix);
			if (relPath) {
				referencedPaths.add(relPath);
			}
		}
	}

	return referencedPaths;
}

async function getReferencedServicePaths(config) {
	const serviceIds = await db.getSortedSetRevRange(SERVICE_KEYS.allServices, 0, -1);
	const referencedPaths = new Set();

	if (serviceIds.length === 0) {
		return referencedPaths;
	}

	const keys = serviceIds.map((id) => SERVICE_KEYS.service(id));
	const services = await db.getObjects(keys);

	for (const service of services) {
		if (service && service.images) {
			let images;
			try {
				images = JSON.parse(service.images);
			} catch {
				images = [];
			}
			if (Array.isArray(images)) {
				for (const imageUrl of images) {
					const relPath = extractRelativePath(imageUrl, config.serviceUploadsUrlPrefix);
					if (relPath) {
						referencedPaths.add(relPath);
					}
				}
			}
		}
	}

	return referencedPaths;
}

async function getReferencedYlivieskahubPaths(config) {
	if (!config.ylivieskahubUrl || !config.apiKey) {
		return null;
	}

	try {
		const response = await fetch(
			config.ylivieskahubUrl + '/api/storage/referenced-urls',
			{
				headers: { Authorization: 'Bearer ' + config.apiKey },
				signal: AbortSignal.timeout(10_000),
			}
		);

		if (!response.ok) {
			console.warn('[havaintokartta] Ylivieskahub referenced-urls responded with status', response.status);
			return null;
		}

		const data = await response.json();

		const newsPaths = new Set();
		for (const url of data.newsImages || []) {
			const relPath = extractRelativePath(url, config.newsUploadsUrlPrefix);
			if (relPath) {
				newsPaths.add(relPath);
			}
		}

		const eventPaths = new Set();
		for (const url of data.eventImages || []) {
			const relPath = extractRelativePath(url, config.eventUploadsUrlPrefix);
			if (relPath) {
				eventPaths.add(relPath);
			}
		}

		return { newsPaths, eventPaths };
	} catch (err) {
		console.warn('[havaintokartta] Failed to fetch Ylivieskahub referenced URLs:', err?.message || err);
		return null;
	}
}

async function scanDirectoryForOrphans(dirPath, referencedPaths) {
	const allFiles = await listFilesRecursive(dirPath);

	const orphanPaths = allFiles.filter(function (relativePath) {
		const normalizedPath = relativePath.replace(/\\/g, '/');
		return !referencedPaths.has(normalizedPath);
	});

	const orphans = await Promise.all(
		orphanPaths.map(async function (relativePath) {
			const normalizedPath = relativePath.replace(/\\/g, '/');
			const fullPath = path.join(dirPath, relativePath);
			const size = await getFileSize(fullPath);
			return {
				path: normalizedPath,
				size,
				sizeFormatted: formatBytes(size),
			};
		})
	);

	return orphans;
}

async function scanOrphans() {
	const config = getConfig();

	const [reportPaths, servicePaths, yhPaths] = await Promise.all([
		getReferencedReportPaths(config),
		getReferencedServicePaths(config),
		getReferencedYlivieskahubPaths(config),
	]);

	// skip yh scan if API unavailable — don't want to flag everything as orphan
	const [
		reportOrphans, serviceOrphans, newsOrphans, eventOrphans,
		reportEmptyDirs, serviceEmptyDirs, newsEmptyDirs, eventEmptyDirs,
	] = await Promise.all([
		scanDirectoryForOrphans(config.uploadsDirectory, reportPaths),
		scanDirectoryForOrphans(config.serviceUploadsDirectory, servicePaths),
		yhPaths ? scanDirectoryForOrphans(config.newsUploadsDirectory, yhPaths.newsPaths) : [],
		yhPaths ? scanDirectoryForOrphans(config.eventUploadsDirectory, yhPaths.eventPaths) : [],
		findEmptyDirectories(config.uploadsDirectory, config.uploadsDirectory),
		findEmptyDirectories(config.serviceUploadsDirectory, config.serviceUploadsDirectory),
		yhPaths ? findEmptyDirectories(config.newsUploadsDirectory, config.newsUploadsDirectory) : [],
		yhPaths ? findEmptyDirectories(config.eventUploadsDirectory, config.eventUploadsDirectory) : [],
	]);

	const havaintokarttaSize = reportOrphans.reduce((sum, o) => sum + o.size, 0);
	const yhNewsSize = newsOrphans.reduce((sum, o) => sum + o.size, 0);
	const yhEventSize = eventOrphans.reduce((sum, o) => sum + o.size, 0);
	const yhTotalSize = yhNewsSize + yhEventSize;
	const palvelukarttaSize = serviceOrphans.reduce((sum, o) => sum + o.size, 0);
	const grandTotalSize = havaintokarttaSize + yhTotalSize + palvelukarttaSize;
	const grandTotalCount = reportOrphans.length + newsOrphans.length + eventOrphans.length + serviceOrphans.length;

	const totalEmptyDirs = reportEmptyDirs.length + serviceEmptyDirs.length + newsEmptyDirs.length + eventEmptyDirs.length;

	return {
		havaintokartta: {
			orphans: reportOrphans,
			totalCount: reportOrphans.length,
			totalSize: havaintokarttaSize,
			totalSizeFormatted: formatBytes(havaintokarttaSize),
			emptyDirs: reportEmptyDirs,
		},
		ylivieskahub: {
			newsOrphans,
			eventOrphans,
			totalCount: newsOrphans.length + eventOrphans.length,
			totalSize: yhTotalSize,
			totalSizeFormatted: formatBytes(yhTotalSize),
			apiAvailable: yhPaths !== null,
			// Prefix with source so news/2026-06-12 and events/2026-06-12 are distinguishable
			emptyDirs: newsEmptyDirs.map((d) => 'news/' + d).concat(
				eventEmptyDirs.map((d) => 'events/' + d)
			),
		},
		palvelukartta: {
			orphans: serviceOrphans,
			totalCount: serviceOrphans.length,
			totalSize: palvelukarttaSize,
			totalSizeFormatted: formatBytes(palvelukarttaSize),
			emptyDirs: serviceEmptyDirs,
		},
		grandTotal: {
			count: grandTotalCount,
			size: grandTotalSize,
			sizeFormatted: formatBytes(grandTotalSize),
			emptyDirsCount: totalEmptyDirs,
		},
	};
}

async function deleteOrphanFiles(dirPath, relativePaths) {
	let deleted = 0;
	let failed = 0;
	const errors = [];
	const deletedDirs = new Set();

	for (const relativePath of relativePaths) {
		if (relativePath.includes('..')) {
			failed++;
			errors.push(`Path traversal detected: ${relativePath}`);
			continue;
		}

		const fullPath = path.join(dirPath, relativePath);
		const resolvedPath = path.resolve(fullPath);
		const resolvedBase = path.resolve(dirPath);

		if (!resolvedPath.startsWith(resolvedBase)) {
			failed++;
			errors.push(`Path escapes directory: ${relativePath}`);
			continue;
		}

		try {
			await fs.unlink(resolvedPath);
			deleted++;
			deletedDirs.add(path.dirname(resolvedPath));
		} catch (err) {
			failed++;
			errors.push(`Failed to delete ${relativePath}: ${err?.message || err}`);
		}
	}

	for (const dir of deletedDirs) {
		try {
			const entries = await fs.readdir(dir);
			if (entries.length === 0) {
				await fs.rmdir(dir);
			}
		} catch {
			// ignore
		}
	}

	return { deleted, failed, errors };
}

async function deleteOrphans(app, relativePaths) {
	const config = getConfig();

	let dirPath;
	switch (app) {
		case 'havaintokartta':
			dirPath = config.uploadsDirectory;
			break;
		case 'ylivieskahub-news':
			dirPath = config.newsUploadsDirectory;
			break;
		case 'ylivieskahub-events':
			dirPath = config.eventUploadsDirectory;
			break;
		case 'palvelukartta':
			dirPath = config.serviceUploadsDirectory;
			break;
		default:
			throw new Error(`Unknown app: ${app}`);
	}

	return deleteOrphanFiles(dirPath, relativePaths);
}

async function deleteEmptyDirectories(app, relativePaths) {
	const config = getConfig();

	let deleted = 0;
	let failed = 0;
	const errors = [];

	const sorted = [...relativePaths].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);

	for (const relativePath of sorted) {
		if (relativePath.includes('..')) {
			failed++;
			errors.push(`Path traversal detected: ${relativePath}`);
			continue;
		}

		let dirPath, cleanPath;
		if (app === 'ylivieskahub') {
			if (relativePath.startsWith('news/')) {
				dirPath = config.newsUploadsDirectory;
				cleanPath = relativePath.slice('news/'.length);
			} else if (relativePath.startsWith('events/')) {
				dirPath = config.eventUploadsDirectory;
				cleanPath = relativePath.slice('events/'.length);
			} else {
				failed++;
				errors.push(`Unknown prefix for ylivieskahub path: ${relativePath}`);
				continue;
			}
		} else if (app === 'havaintokartta') {
			dirPath = config.uploadsDirectory;
			cleanPath = relativePath;
		} else if (app === 'palvelukartta') {
			dirPath = config.serviceUploadsDirectory;
			cleanPath = relativePath;
		} else {
			throw new Error(`Unknown app: ${app}`);
		}

		const fullPath = path.join(dirPath, cleanPath);
		const resolvedPath = path.resolve(fullPath);
		const resolvedBase = path.resolve(dirPath);

		if (!resolvedPath.startsWith(resolvedBase)) {
			failed++;
			errors.push(`Path escapes directory: ${relativePath}`);
			continue;
		}

		try {
			await fs.rmdir(resolvedPath);
			deleted++;
		} catch (err) {
			failed++;
			errors.push(`Failed to delete ${relativePath}: ${err?.message || err}`);
		}
	}

	return { deleted, failed, errors };
}

module.exports = {
	scanOrphans,
	deleteOrphans,
	deleteEmptyDirectories,
};
