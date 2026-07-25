'use strict';

const storageStats = require('../storage-stats');
const orphanScan = require('../orphan-scan');

const controller = {};

controller.get = async function (req, res) {
	const stats = await storageStats.getStorageStats();

	// Totals are now computed in storage-stats.js, grouped by app ownership.
	// Ylivieskahub's local stats (from the API) may be null if unavailable,
	// but the NodeBB-stored news/event images are always present.
	const yh = stats.ylivieskahub || null;

	res.render('admin/plugins/havaintokartta', {
		title: 'Havaintokartta',
		hideSave: true,
		havaintokartta: stats.havaintokartta,
		palvelukartta: stats.palvelukartta,
		ylivieskahub: yh,
	});
};

/**
 * GET /api/admin/plugins/havaintokartta/orphans/scan
 * Triggers an orphan scan across all apps and returns JSON results.
 */
controller.scanOrphans = async function (req, res) {
	try {
		const results = await orphanScan.scanOrphans();
		res.json(results);
	} catch (err) {
		console.error('[havaintokartta] Orphan scan failed:', err?.message || err);
		res.status(500).json({ error: 'Orphan scan failed.' });
	}
};

/**
 * POST /api/admin/plugins/havaintokartta/orphans/delete
 * Deletes specific orphaned files. Body: { app: string, files: string[] }
 */
controller.deleteOrphans = async function (req, res) {
	try {
		const { app, files } = req.body || {};

		if (!app || !Array.isArray(files) || files.length === 0) {
			res.status(400).json({ error: 'app and files[] are required.' });
			return;
		}

		const result = await orphanScan.deleteOrphans(app, files);
		res.json(result);
	} catch (err) {
		console.error('[havaintokartta] Orphan deletion failed:', err?.message || err);
		res.status(500).json({ error: 'Orphan deletion failed.' });
	}
};

/**
 * POST /api/admin/plugins/havaintokartta/empty-dirs/delete
 * Deletes empty directories. Body: { app: string, dirs: string[] }
 */
controller.deleteEmptyDirs = async function (req, res) {
	try {
		const { app, dirs } = req.body || {};

		if (!app || !Array.isArray(dirs) || dirs.length === 0) {
			res.status(400).json({ error: 'app and dirs[] are required.' });
			return;
		}

		const result = await orphanScan.deleteEmptyDirectories(app, dirs);
		res.json(result);
	} catch (err) {
		console.error('[havaintokartta] Empty directory deletion failed:', err?.message || err);
		res.status(500).json({ error: 'Empty directory deletion failed.' });
	}
};

module.exports = controller;
