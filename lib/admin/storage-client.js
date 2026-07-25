// ── Havaintokartta Storage Admin Client ──────────────────────────────
// Bundled via acpScripts into scripts-admin.js (loaded on every admin page).
// Uses event delegation so handlers survive NodeBB's AJAX navigation.
// ──────────────────────────────────────────────────────────────────────

$(window).on('action:ajaxify.contentLoaded', function () {
	// Only initialise on the storage settings page.
	if (ajaxify.data.template.name !== 'admin/plugins/havaintokartta') {
		return;
	}
	initStoragePage();
});

function initStoragePage() {
	console.log('[havaintokartta] Storage page initialised.');

	// ── Refresh button ───────────────────────────────────────────
	$('#refresh-storage').off('click').on('click', function () {
		location.reload();
	});

	// ── Orphan scan ──────────────────────────────────────────────
	$('#scan-orphans').off('click').on('click', async function () {
		console.log('[havaintokartta] Scan button clicked.');
		const $btn = $(this);
		const $loading = $('#orphan-scan-loading');
		const $error = $('#orphan-scan-error');
		const $results = $('#orphan-scan-results');

		$btn.prop('disabled', true);
		$loading.removeClass('d-none');
		$error.addClass('d-none').empty();
		$results.addClass('d-none');

		try {
			const response = await fetch('/api/admin/plugins/havaintokartta/orphans/scan', {
				headers: { Accept: 'application/json' },
			});
			console.log('[havaintokartta] Scan response:', response.status);

			if (!response.ok) {
				throw new Error('Scan failed (HTTP ' + response.status + ')');
			}

			const data = await response.json();
			console.log('[havaintokartta] Scan data:', data);
			renderOrphanResults(data);
			$results.removeClass('d-none');
		} catch (err) {
			console.error('[havaintokartta] Scan error:', err);
			$error.text(err.message || 'Scan failed.').removeClass('d-none');
		} finally {
			$loading.addClass('d-none');
			$btn.prop('disabled', false);
		}
	});

	// ── Select-all checkboxes (delegated) ────────────────────────
	$(document).off('change', '.orphan-select-all').on('change', '.orphan-select-all', function () {
		const app = $(this).data('app');
		const tableId = '#orphan-' + app + '-table';
		$(tableId + ' tbody input[type="checkbox"]').prop('checked', this.checked);
	});

	// ── Delete selected orphans (delegated) ──────────────────────
	$(document).off('click', '.orphan-delete-btn').on('click', '.orphan-delete-btn', async function () {
		const app = $(this).data('app');
		const tableId = '#orphan-' + app + '-table';

		const selected = [];
		$(tableId + ' tbody input[type="checkbox"]:checked').each(function () {
			const row = $(this).closest('tr');
			const filePath = row.data('path');
			const fileType = row.data('type');
			if (app === 'ylivieskahub') {
				selected.push({ app: 'ylivieskahub-' + fileType, path: filePath });
			} else {
				selected.push({ app: app, path: filePath });
			}
		});

		if (selected.length === 0) {
			return;
		}

		if (!confirm('Delete ' + selected.length + ' orphaned file(s)? This cannot be undone.')) {
			return;
		}

		const $btn = $(this);
		$btn.prop('disabled', true);

		try {
			const grouped = {};
			for (const item of selected) {
				if (!grouped[item.app]) grouped[item.app] = [];
				grouped[item.app].push(item.path);
			}

			let totalDeleted = 0;
			let totalFailed = 0;

			for (const [subApp, files] of Object.entries(grouped)) {
				const result = await new Promise(function (resolve, reject) {
					$.ajax({
						url: '/api/admin/plugins/havaintokartta/orphans/delete',
						method: 'POST',
						contentType: 'application/json',
						data: JSON.stringify({ app: subApp, files: files }),
						headers: { 'x-csrf-token': config.csrf_token },
						success: resolve,
						error: function (jqXHR) {
							reject(new Error('Delete failed (HTTP ' + jqXHR.status + ')'));
						},
					});
				});

				totalDeleted += result.deleted || 0;
				totalFailed += result.failed || 0;
			}

			alert('Deleted ' + totalDeleted + ' file(s).' + (totalFailed > 0 ? ' ' + totalFailed + ' failed.' : ''));

			$(tableId + ' tbody input[type="checkbox"]:checked').each(function () {
				$(this).closest('tr').remove();
			});

			updateOrphanSummary('havaintokartta');
			updateOrphanSummary('ylivieskahub');
			updateOrphanSummary('palvelukartta');
			updateGrandTotal();
		} catch (err) {
			alert(err.message || 'Delete failed.');
		} finally {
			$btn.prop('disabled', false);
		}
	});

	// ── Empty dir select-all (delegated) ─────────────────────────
	$(document).off('change', '.empty-dir-select-all').on('change', '.empty-dir-select-all', function () {
		const app = $(this).data('app');
		const tableId = '#empty-dirs-' + app + '-table';
		$(tableId + ' tbody input[type="checkbox"]').prop('checked', this.checked);
	});

	// ── Delete selected empty dirs (delegated) ───────────────────
	$(document).off('click', '.empty-dir-delete-btn').on('click', '.empty-dir-delete-btn', async function () {
		const app = $(this).data('app');
		const tableId = '#empty-dirs-' + app + '-table';

		const selected = [];
		$(tableId + ' tbody input[type="checkbox"]:checked').each(function () {
			const row = $(this).closest('tr');
			selected.push(row.data('path'));
		});

		if (selected.length === 0) {
			return;
		}

		if (!confirm('Delete ' + selected.length + ' empty director(y/ies)? This cannot be undone.')) {
			return;
		}

		const $btn = $(this);
		$btn.prop('disabled', true);

		try {
			const result = await new Promise(function (resolve, reject) {
				$.ajax({
					url: '/api/admin/plugins/havaintokartta/empty-dirs/delete',
					method: 'POST',
					contentType: 'application/json',
					data: JSON.stringify({ app: app, dirs: selected }),
					headers: { 'x-csrf-token': config.csrf_token },
					success: resolve,
					error: function (jqXHR) {
						reject(new Error('Delete failed (HTTP ' + jqXHR.status + ')'));
					},
				});
			});

			alert('Deleted ' + result.deleted + ' director(y/ies).' + (result.failed > 0 ? ' ' + result.failed + ' failed.' : ''));

			$(tableId + ' tbody input[type="checkbox"]:checked').each(function () {
				$(this).closest('tr').remove();
			});

			updateEmptyDirSummary(app);
		} catch (err) {
			alert(err.message || 'Delete failed.');
		} finally {
			$btn.prop('disabled', false);
		}
	});
}

// ── Render helpers ───────────────────────────────────────────────────

function renderOrphanResults(data) {
	// ── Orphan files ─────────────────────────────────────────────
	renderOrphanTable('havaintokartta', data.havaintokartta.orphans, false);
	$('#orphan-havaintokartta-summary').text(
		data.havaintokartta.totalCount + ' orphan(s) — ' + data.havaintokartta.totalSizeFormatted
	);

	if (!data.ylivieskahub.apiAvailable) {
		$('#orphan-ylivieskahub-unavailable').removeClass('d-none');
		$('#orphan-ylivieskahub-table tbody').empty();
		$('#orphan-ylivieskahub-summary').text('Scan skipped — API unavailable.');
	} else {
		$('#orphan-ylivieskahub-unavailable').addClass('d-none');
		const merged = [];
		for (const o of data.ylivieskahub.newsOrphans) {
			merged.push(Object.assign({}, o, { type: 'news' }));
		}
		for (const o of data.ylivieskahub.eventOrphans) {
			merged.push(Object.assign({}, o, { type: 'events' }));
		}
		renderOrphanTable('ylivieskahub', merged, true);
		$('#orphan-ylivieskahub-summary').text(
			data.ylivieskahub.totalCount + ' orphan(s) — ' + data.ylivieskahub.totalSizeFormatted
		);
	}

	renderOrphanTable('palvelukartta', data.palvelukartta.orphans, false);
	$('#orphan-palvelukartta-summary').text(
		data.palvelukartta.totalCount + ' orphan(s) — ' + data.palvelukartta.totalSizeFormatted
	);

	// ── Empty directories ────────────────────────────────────────
	renderEmptyDirTable('havaintokartta', data.havaintokartta.emptyDirs);
	renderEmptyDirTable('ylivieskahub', data.ylivieskahub.emptyDirs);
	renderEmptyDirTable('palvelukartta', data.palvelukartta.emptyDirs);

	updateGrandTotalFromData(data);
}

function renderOrphanTable(app, orphans, hasTypeColumn) {
	const $tbody = $('#orphan-' + app + '-table tbody');
	$tbody.empty();

	if (orphans.length === 0) {
		const colCount = hasTypeColumn ? 4 : 3;
		$tbody.append(
			'<tr><td colspan="' + colCount + '" class="text-success"><small>No orphaned files found.</small></td></tr>'
		);
		return;
	}

	for (const orphan of orphans) {
		const typeCell = hasTypeColumn ? '<td><small class="text-muted">' + (orphan.type || '') + '</small></td>' : '';
		const row = $(
			'<tr>' +
			'<td><input type="checkbox" class="orphan-checkbox"></td>' +
			'<td><small>' + escapeHtml(orphan.path) + '</small></td>' +
			typeCell +
			'<td><small>' + orphan.sizeFormatted + '</small></td>' +
			'</tr>'
		);
		row.attr('data-path', orphan.path);
		if (hasTypeColumn) {
			row.attr('data-type', orphan.type || '');
		}
		$tbody.append(row);
	}
}

function updateOrphanSummary(app) {
	const tableId = '#orphan-' + app + '-table';
	const count = $(tableId + ' tbody input[type="checkbox"]').length;
	$('#orphan-' + app + '-summary').text(count + ' orphan(s) remaining');
}

function updateGrandTotal() {
	const hk = $('#orphan-havaintokartta-table tbody input[type="checkbox"]').length;
	const yh = $('#orphan-ylivieskahub-table tbody input[type="checkbox"]').length;
	const pk = $('#orphan-palvelukartta-table tbody input[type="checkbox"]').length;
	const total = hk + yh + pk;
	$('#orphan-grand-total').text(
		total === 0 ? 'No orphaned files remaining.' : total + ' orphaned file(s) remaining across all apps.'
	);
}

function updateGrandTotalFromData(data) {
	const total = data.grandTotal.count;
	const emptyDirs = data.grandTotal.emptyDirsCount || 0;
	let msg = total === 0
		? 'No orphaned files found across all apps.'
		: total + ' orphaned file(s) found across all apps — ' + data.grandTotal.sizeFormatted + ' of wasted space.';
	if (emptyDirs > 0) {
		msg += ' Plus ' + emptyDirs + ' empty director(y/ies).';
	}
	$('#orphan-grand-total').text(msg);
}

// ── Empty directory helpers ──────────────────────────────────────────

function renderEmptyDirTable(app, emptyDirs) {
	const $tbody = $('#empty-dirs-' + app + '-table tbody');
	$tbody.empty();

	// Ylivieskahub has a "Source" column (news/events) — 3 cols; others have 2
	const hasSource = app === 'ylivieskahub';
	const emptyColSpan = hasSource ? 3 : 2;

	if (!emptyDirs || emptyDirs.length === 0) {
		$tbody.append(
			'<tr><td colspan="' + emptyColSpan + '" class="text-success"><small>No empty directories found.</small></td></tr>'
		);
		return;
	}

	for (const dirPath of emptyDirs) {
		let displayPath, source;
		if (hasSource) {
			source = dirPath.split('/')[0]; // "news" or "events"
			displayPath = dirPath.slice(source.length + 1);
		} else {
			source = '';
			displayPath = dirPath;
		}

		const sourceCell = hasSource ? '<td><small class="text-muted">' + escapeHtml(source) + '</small></td>' : '';
		const row = $(
			'<tr>' +
			'<td><input type="checkbox" class="empty-dir-checkbox"></td>' +
			'<td><small>' + escapeHtml(displayPath.replace(/\\/g, '/')) + '</small></td>' +
			sourceCell +
			'</tr>'
		);
		row.attr('data-path', dirPath);
		$tbody.append(row);
	}

	$('#empty-dirs-' + app + '-summary').text(emptyDirs.length + ' empty director(y/ies)');
}

function updateEmptyDirSummary(app) {
	const tableId = '#empty-dirs-' + app + '-table';
	const count = $(tableId + ' tbody input[type="checkbox"]').length;
	$('#empty-dirs-' + app + '-summary').text(count + ' empty director(y/ies) remaining');
}

function escapeHtml(str) {
	const div = document.createElement('div');
	div.textContent = str;
	return div.innerHTML;
}
