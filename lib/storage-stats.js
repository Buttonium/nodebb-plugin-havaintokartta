'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { getConfig } = require('./config');
const { formatBytes } = require('./utils');

async function getDirectorySize(dirPath) {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		let total = 0;

		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const fullPath = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				total += await getDirectorySize(fullPath);
			} else {
				try {
					const stat = await fs.stat(fullPath);
					total += stat.size;
				} catch {
					// Skip files we can't stat
				}
			}
		}

		return total;
	} catch {
		return 0;
	}
}

async function countFiles(dirPath) {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		let total = 0;

		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const fullPath = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				total += await countFiles(fullPath);
			} else {
				total += 1;
			}
		}

		return total;
	} catch {
		return 0;
	}
}

async function getDirectoryStats(dirPath) {
	const size = await getDirectorySize(dirPath);
	const fileCount = await countFiles(dirPath);
	return {
		size,
		sizeFormatted: formatBytes(size),
		fileCount,
	};
}

// Ylivieskahub's own filesystem stats (local uploads + SQLite db)
// Returns null if unavailable — admin page still renders the rest
async function getYlivieskahubLocalStats() {
	const config = getConfig();

	if (!config.ylivieskahubUrl || !config.apiKey) {
		return null;
	}

	try {
		const response = await fetch(
			config.ylivieskahubUrl + '/api/storage/stats',
			{
				headers: { Authorization: 'Bearer ' + config.apiKey },
				signal: AbortSignal.timeout(10_000),
			}
		);

		if (!response.ok) {
			console.warn('[havaintokartta] Ylivieskahub storage stats responded with status', response.status);
			return null;
		}

		const data = await response.json();

		return {
			localNewsImages: {
				size: data.uploads.newsImages.size,
				sizeFormatted: formatBytes(data.uploads.newsImages.size),
				fileCount: data.uploads.newsImages.fileCount,
			},
			database: {
				size: data.database.newsDb.size,
				sizeFormatted: formatBytes(data.database.newsDb.size),
				fileCount: data.database.newsDb.fileCount,
			},
			localTotalSize: data.totalSize,
			localTotalSizeFormatted: formatBytes(data.totalSize),
			localTotalFileCount: data.totalFileCount,
		};
	} catch (err) {
		console.warn('[havaintokartta] Failed to fetch Ylivieskahub storage stats:', err?.message || err);
		return null;
	}
}

async function getStorageStats() {
	const config = getConfig();

	const reportImages = await getDirectoryStats(config.uploadsDirectory);
	const newsImages = await getDirectoryStats(config.newsUploadsDirectory);
	const eventImages = await getDirectoryStats(config.eventUploadsDirectory);
	const serviceImages = await getDirectoryStats(config.serviceUploadsDirectory);

	const yhLocal = await getYlivieskahubLocalStats();

	const hkTotalSize = reportImages.size;
	const yhNodebbSize = newsImages.size + eventImages.size;
	const yhNodebbFileCount = newsImages.fileCount + eventImages.fileCount;
	const yhLocalSize = yhLocal ? yhLocal.localTotalSize : 0;
	const yhLocalFileCount = yhLocal ? yhLocal.localTotalFileCount : 0;
	const yhTotalSize = yhNodebbSize + yhLocalSize;
	const yhTotalFileCount = yhNodebbFileCount + yhLocalFileCount;

	const result = {
		havaintokartta: {
			reportImages,
			totalSize: hkTotalSize,
			totalSizeFormatted: formatBytes(hkTotalSize),
			totalFileCount: reportImages.fileCount,
		},
		ylivieskahub: {
			newsImages,
			eventImages,
			local: yhLocal,
			totalSize: yhTotalSize,
			totalSizeFormatted: formatBytes(yhTotalSize),
			totalFileCount: yhTotalFileCount,
		},
		palvelukartta: {
			serviceImages,
			totalSize: serviceImages.size,
			totalSizeFormatted: formatBytes(serviceImages.size),
			totalFileCount: serviceImages.fileCount,
		},
	};

	return result;
}

module.exports = {
	getStorageStats,
};
