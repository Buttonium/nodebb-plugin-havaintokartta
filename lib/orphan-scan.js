'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Upload and attachment are separate operations; leave active editors time.
const UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;

const { getConfig } = require('./config');
const { db } = require('./nodebb');
const { formatBytes, parseReportImageUrls } = require('./utils');

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
			if (!entry.isDirectory()) return false; // has a visible file
			if (!(await isEmptyDirectory(path.join(dirPath, entry.name)))) {
				return false;
			}
		}
		return true; // no files, all subdirs are empty
	} catch {
		return false; // Cannot establish that the directory is empty.
	}
}

// List children before parents; deletion uses non-recursive rmdir so new files survive.
async function findEmptyDirectories(dirPath, basePath) {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		const emptyDirs = [];

		for (const entry of entries) {
			if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
			const fullPath = path.join(dirPath, entry.name);
			const subEmpty = await findEmptyDirectories(fullPath, basePath);
			emptyDirs.push(...subEmpty);
			if (await isEmptyDirectory(fullPath)) {
				const relPath = path.relative(basePath, fullPath).replace(/\\/g, '/');
				emptyDirs.push(relPath);
			}
		}

		return emptyDirs;
	} catch {
		return [];
	}
}

function extractRelativePath(imageUrl, urlPrefix) {
	if (!imageUrl || typeof imageUrl !== 'string') return null;
	try {
		// Static file serving decodes URL escapes once. Match that identity, including
		// encoded filenames/separators, without double-decoding literal percent signs.
		const pathname = path.posix.normalize(decodeURIComponent(new URL(imageUrl, 'https://uploads.invalid').pathname).replace(/\\/g, '/'));
		const prefix = path.posix.normalize(decodeURIComponent(new URL(urlPrefix, 'https://uploads.invalid').pathname).replace(/\\/g, '/')).replace(/\/+$/, '');
		if (!pathname.startsWith(prefix + '/')) return null;
		return path.posix.normalize(pathname.slice(prefix.length + 1));
	} catch { return null; }
}

async function readFreshObjects(keys) {
	// NodeBB object-cache invalidation also propagates to other workers.
	db.objectCache?.del(keys);
	const values = await db.getObjects(keys);
	if (!Array.isArray(values) || values.length !== keys.length) throw new Error('Incomplete reference lookup');
	return values;
}

async function eligibleFile(filePath) {
	const stat = await fs.lstat(filePath);
	return stat.isFile() && Number.isFinite(stat.mtimeMs) && Date.now() - stat.mtimeMs >= UPLOAD_GRACE_MS;
}

async function getReferencedReportPaths(config, prefix = config.uploadsUrlPrefix) {
	const reportIds = await db.getSortedSetRevRange(REPORT_KEYS.allReports, 0, -1);
	const referencedPaths = new Set();

	if (reportIds.length === 0) {
		return referencedPaths;
	}

	const keys = reportIds.map((id) => REPORT_KEYS.report(id));
	const reports = await readFreshObjects(keys);

	for (const report of reports) {
		if (report && report.images) {
			if (typeof report.images === 'string' && report.images.trim().startsWith('[')) {
				if (!Array.isArray(JSON.parse(report.images))) throw new Error('Invalid stored report image references');
			}
			const imageUrls = parseReportImageUrls(report.images, Number.MAX_SAFE_INTEGER);
			for (const imageUrl of imageUrls) {
				const relPath = extractRelativePath(imageUrl, prefix);
				if (relPath) {
					referencedPaths.add(relPath);
				}
			}
		}
	}

	return referencedPaths;
}

async function getReferencedServicePaths(config, prefix = config.serviceUploadsUrlPrefix) {
	const serviceIds = await db.getSortedSetRevRange(SERVICE_KEYS.allServices, 0, -1);
	const referencedPaths = new Set();

	if (serviceIds.length === 0) {
		return referencedPaths;
	}

	const keys = serviceIds.map((id) => SERVICE_KEYS.service(id));
	const services = await readFreshObjects(keys);

	for (const service of services) {
		if (service && service.images) {
			let images;
			try {
				images = JSON.parse(service.images);
			} catch {
				throw new Error('Invalid stored service image references');
			}
			if (!Array.isArray(images)) throw new Error('Invalid stored service image references');
			if (Array.isArray(images)) {
				for (const entry of images) {
					// Images may be legacy strings or objects with a .url property.
					const imageUrl = typeof entry === 'string' ? entry : (entry && entry.url);
					const relPath = extractRelativePath(imageUrl, prefix);
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
				cache: 'no-store',
			}
		);

		if (!response.ok) {
			console.warn('[havaintokartta] Ylivieskahub referenced-urls responded with status', response.status);
			return null;
		}

		const data = await response.json();
		if (!Array.isArray(data?.newsImages) || !Array.isArray(data?.eventImages) ||
			[...data.newsImages, ...data.eventImages].some(url => typeof url !== 'string')) {
			throw new Error('Incomplete hub reference response');
		}

		const newsPaths = new Set();
		for (const url of [...data.newsImages, ...data.eventImages]) {
			const relPath = extractRelativePath(url, config.newsUploadsUrlPrefix);
			if (relPath) {
				newsPaths.add(relPath);
			}
		}

		const eventPaths = new Set();
		for (const url of [...data.newsImages, ...data.eventImages]) {
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
			// Stat/read failures must not advertise a file as safe to remove.
			let size;
			try {
				if (!(await eligibleFile(fullPath))) return null;
				size = (await fs.stat(fullPath)).size;
			} catch { return null; }
			return {
				path: normalizedPath,
				size,
				sizeFormatted: formatBytes(size),
			};
		})
	);

	return orphans.filter(Boolean);
}

async function currentReferences(config, app) {
	const prefixes = {
		havaintokartta: config.uploadsUrlPrefix,
		palvelukartta: config.serviceUploadsUrlPrefix,
		'ylivieskahub-news': config.newsUploadsUrlPrefix,
		'ylivieskahub-events': config.eventUploadsUrlPrefix,
	};
	const prefix = prefixes[app];
	if (!prefix) throw new Error('Missing upload namespace');
	const [reports, services] = await Promise.all([
		getReferencedReportPaths(config, prefix), getReferencedServicePaths(config, prefix),
	]);
	const references = new Set([...reports, ...services]);
	if (app.startsWith('ylivieskahub-')) {
		const hub = await getReferencedYlivieskahubPaths(config);
		if (!hub) throw new Error('Hub references unavailable; files preserved');
		for (const value of app === 'ylivieskahub-news' ? hub.newsPaths : hub.eventPaths) references.add(value);
	}
	return references;
}

async function scanOrphans() {
	const config = getConfig();

	const [reportPaths, servicePaths, yhPaths] = await Promise.all([
		currentReferences(config, 'havaintokartta'),
		currentReferences(config, 'palvelukartta'),
		getReferencedYlivieskahubPaths(config),
	]);
	if (yhPaths) {
		for (const [prefix, references] of [
			[config.newsUploadsUrlPrefix, yhPaths.newsPaths],
			[config.eventUploadsUrlPrefix, yhPaths.eventPaths],
		]) {
			const local = await Promise.all([
				getReferencedReportPaths(config, prefix), getReferencedServicePaths(config, prefix),
			]);
			for (const paths of local) for (const value of paths) references.add(value);
		}
	}

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

async function deleteOrphanFiles(dirPath, relativePaths, loadReferences) {
	let deleted = 0;
	let failed = 0;
	let skipped = 0;
	const errors = [];
	const deletedDirs = new Set();
	const deletedPaths = [];

	for (const relativePath of relativePaths) {
		if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || relativePath.includes('..')) {
			failed++;
			errors.push(`Path traversal detected: ${relativePath}`);
			continue;
		}

		const fullPath = path.join(dirPath, relativePath);
		const resolvedPath = path.resolve(fullPath);
		const resolvedBase = path.resolve(dirPath);

		if (!resolvedPath.startsWith(resolvedBase + path.sep)) {
			failed++;
			errors.push(`Path escapes directory: ${relativePath}`);
			continue;
		}

		try {
			const realBase = await fs.realpath(resolvedBase);
			const realFile = await fs.realpath(resolvedPath);
			if (!realFile.startsWith(realBase + path.sep)) throw new Error('Path escapes upload directory');
			if (!(await eligibleFile(resolvedPath))) { skipped++; continue; }
			// Refresh PER FILE, not once at the start of a long delete batch.
			const references = await loadReferences();
			const identity = path.relative(resolvedBase, resolvedPath).replace(/\\/g, '/');
			if (references.has(identity)) { skipped++; continue; }
			// Narrow the replacement/upload window after the asynchronous lookup.
			if (!(await eligibleFile(resolvedPath))) { skipped++; continue; }
			await fs.unlink(resolvedPath);
			deleted++;
			deletedPaths.push(relativePath);
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

	return { deleted, failed, skipped, deletedPaths, errors };
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

	return deleteOrphanFiles(dirPath, relativePaths, () => currentReferences(config, app));
}

async function deleteEmptyDirectories(app, relativePaths) {
	const config = getConfig();

	let deleted = 0;
	let failed = 0;
	const errors = [];
	const deletedPaths = [];

	const sorted = [...relativePaths].sort((a, b) => String(b).split(/[\\/]/).length - String(a).split(/[\\/]/).length);

	for (const relativePath of sorted) {
		if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || relativePath.includes('..')) {
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

		if (!resolvedPath.startsWith(resolvedBase + path.sep)) {
			failed++;
			errors.push(`Path escapes directory: ${relativePath}`);
			continue;
		}

		try {
			const realBase = await fs.realpath(resolvedBase);
			const realDir = await fs.realpath(resolvedPath);
			if (!realDir.startsWith(realBase + path.sep)) throw new Error('Path escapes upload directory');
			await fs.rmdir(resolvedPath);
			deleted++;
			deletedPaths.push(relativePath);
		} catch (err) {
			failed++;
			errors.push(`Failed to delete ${relativePath}: ${err?.message || err}`);
		}
	}

	return { deleted, failed, deletedPaths, errors };
}

module.exports = {
	scanOrphans,
	deleteOrphans,
	deleteEmptyDirectories,
};
