<div class="acp-page-container">
	<!-- IMPORT admin/partials/settings/header.tpl -->

	<div class="row settings m-0">
		<div id="spy-container" class="col-12 col-md-8 px-0 mb-4" tabindex="0">

			<!-- Havaintokartta Storage -->
			<div id="havaintokartta-storage" class="mb-4">
				<h5 class="fw-bold tracking-tight settings-header">Havaintokartta Storage</h5>
				<div class="table-responsive">
					<table class="table table-sm">
						<thead>
							<tr>
								<th>Directory</th>
								<th>Files</th>
								<th>Size</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td>Report images</td>
								<td>{havaintokartta.reportImages.fileCount}</td>
								<td>{havaintokartta.reportImages.sizeFormatted}</td>
							</tr>
							<tr class="table-active fw-bold">
								<td>Total</td>
								<td>{havaintokartta.totalFileCount}</td>
								<td>{havaintokartta.totalSizeFormatted}</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>

			<!-- Ylivieskahub Storage -->
			<div id="ylivieskahub-storage" class="mb-4">
				<h5 class="fw-bold tracking-tight settings-header">Ylivieskahub Storage</h5>
				<div class="table-responsive">
					<table class="table table-sm">
						<thead>
							<tr>
								<th>Directory</th>
								<th>Files</th>
								<th>Size</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td>News images <small class="text-muted">(on forum)</small></td>
								<td>{ylivieskahub.newsImages.fileCount}</td>
								<td>{ylivieskahub.newsImages.sizeFormatted}</td>
							</tr>
							<tr>
								<td>Event images <small class="text-muted">(on forum)</small></td>
								<td>{ylivieskahub.eventImages.fileCount}</td>
								<td>{ylivieskahub.eventImages.sizeFormatted}</td>
							</tr>
							{{{ if ylivieskahub.local }}}
							<tr>
								<td>Local news images <small class="text-muted">(on Ylivieskahub)</small></td>
								<td>{ylivieskahub.local.localNewsImages.fileCount}</td>
								<td>{ylivieskahub.local.localNewsImages.sizeFormatted}</td>
							</tr>
							<tr>
								<td>Database <small class="text-muted">(on Ylivieskahub)</small></td>
								<td>{ylivieskahub.local.database.fileCount}</td>
								<td>{ylivieskahub.local.database.sizeFormatted}</td>
							</tr>
							{{{ else }}}
							<tr>
								<td colspan="3" class="text-warning">
									<small>Ylivieskahub local stats unavailable. Ensure <code>YLIVIESKAHUB_URL</code> and <code>NODEBB_API_KEY</code> are configured.</small>
								</td>
							</tr>
							{{{ end }}}
							<tr class="table-active fw-bold">
								<td>Total</td>
								<td>{ylivieskahub.totalFileCount}</td>
								<td>{ylivieskahub.totalSizeFormatted}</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>

			<!-- Palvelukartta Storage -->
			<div id="palvelukartta-storage" class="mb-4">
				<h5 class="fw-bold tracking-tight settings-header">Palvelukartta Storage</h5>
				<div class="table-responsive">
					<table class="table table-sm">
						<thead>
							<tr>
								<th>Directory</th>
								<th>Files</th>
								<th>Size</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td>Service images</td>
								<td>{palvelukartta.serviceImages.fileCount}</td>
								<td>{palvelukartta.serviceImages.sizeFormatted}</td>
							</tr>
							<tr class="table-active fw-bold">
								<td>Total</td>
								<td>{palvelukartta.totalFileCount}</td>
								<td>{palvelukartta.totalSizeFormatted}</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>

			<!-- Refresh button -->
			<div class="mb-4">
				<button id="refresh-storage" class="btn btn-secondary btn-sm">Refresh</button>
			</div>

			<!-- Orphan Scan -->
			<div id="orphan-scan" class="mb-4">
				<h5 class="fw-bold tracking-tight settings-header">Orphaned File Scan</h5>
				<p class="text-muted small mb-2">Scans all upload directories for files that no longer have a corresponding database record.</p>
				<button id="scan-orphans" class="btn btn-primary btn-sm mb-3">Scan for orphaned files</button>

				<div id="orphan-scan-loading" class="alert alert-info d-none">
					<span class="spinner-border spinner-border-sm me-2"></span> Scanning...
				</div>

				<div id="orphan-scan-error" class="alert alert-danger d-none"></div>

				<div id="orphan-scan-results" class="d-none">
					<div id="orphan-grand-total" class="alert alert-warning mb-3"></div>

					<!-- Havaintokartta orphans -->
					<h6 class="fw-bold mt-3">Havaintokartta <small class="text-muted">(files/reports)</small></h6>
					<div id="orphan-havaintokartta-summary" class="text-muted small mb-2"></div>
					<div class="table-responsive mb-3">
						<table class="table table-sm" id="orphan-havaintokartta-table">
							<thead>
								<tr>
									<th style="width: 24px;"><input type="checkbox" class="orphan-select-all" data-app="havaintokartta"></th>
									<th>File</th>
									<th>Size</th>
								</tr>
							</thead>
							<tbody></tbody>
						</table>
					</div>
					<button class="btn btn-danger btn-sm mb-3 orphan-delete-btn" data-app="havaintokartta">Delete selected</button>

					<!-- Havaintokartta empty dirs -->
					<h6 class="fw-bold mt-3">Havaintokartta Empty Directories</h6>
					<div id="empty-dirs-havaintokartta-summary" class="text-muted small mb-2"></div>
					<div class="table-responsive mb-3">
						<table class="table table-sm" id="empty-dirs-havaintokartta-table">
							<thead>
								<tr>
									<th style="width: 24px;"><input type="checkbox" class="empty-dir-select-all" data-app="havaintokartta"></th>
									<th>Directory</th>
								</tr>
							</thead>
							<tbody></tbody>
						</table>
					</div>
					<button class="btn btn-warning btn-sm mb-3 empty-dir-delete-btn" data-app="havaintokartta">Delete selected</button>

					<!-- Ylivieskahub orphans -->
					<h6 class="fw-bold mt-3">Ylivieskahub <small class="text-muted">(files/news + files/events)</small></h6>
					<div id="orphan-ylivieskahub-summary" class="text-muted small mb-2"></div>
					<div id="orphan-ylivieskahub-unavailable" class="alert alert-warning d-none mb-2">
						<small>Ylivieskahub API unavailable — cannot determine referenced URLs. Ensure <code>YLIVIESKAHUB_URL</code> and <code>NODEBB_API_KEY</code> are configured.</small>
					</div>
					<div class="table-responsive mb-3">
						<table class="table table-sm" id="orphan-ylivieskahub-table">
							<thead>
								<tr>
									<th style="width: 24px;"><input type="checkbox" class="orphan-select-all" data-app="ylivieskahub"></th>
									<th>File</th>
									<th>Type</th>
									<th>Size</th>
								</tr>
							</thead>
							<tbody></tbody>
						</table>
					</div>
					<button class="btn btn-danger btn-sm mb-3 orphan-delete-btn" data-app="ylivieskahub">Delete selected</button>

					<!-- Ylivieskahub empty dirs -->
					<h6 class="fw-bold mt-3">Ylivieskahub Empty Directories</h6>
					<div id="empty-dirs-ylivieskahub-summary" class="text-muted small mb-2"></div>
					<div class="table-responsive mb-3">
						<table class="table table-sm" id="empty-dirs-ylivieskahub-table">
							<thead>
								<tr>
									<th style="width: 24px;"><input type="checkbox" class="empty-dir-select-all" data-app="ylivieskahub"></th>
									<th>Directory</th>
									<th>Source</th>
								</tr>
							</thead>
							<tbody></tbody>
						</table>
					</div>
					<button class="btn btn-warning btn-sm mb-3 empty-dir-delete-btn" data-app="ylivieskahub">Delete selected</button>

					<!-- Palvelukartta orphans -->
					<h6 class="fw-bold mt-3">Palvelukartta <small class="text-muted">(files/services)</small></h6>
					<div id="orphan-palvelukartta-summary" class="text-muted small mb-2"></div>
					<div class="table-responsive mb-3">
						<table class="table table-sm" id="orphan-palvelukartta-table">
							<thead>
								<tr>
									<th style="width: 24px;"><input type="checkbox" class="orphan-select-all" data-app="palvelukartta"></th>
									<th>File</th>
									<th>Size</th>
								</tr>
							</thead>
							<tbody></tbody>
						</table>
					</div>
					<button class="btn btn-danger btn-sm mb-3 orphan-delete-btn" data-app="palvelukartta">Delete selected</button>

					<!-- Palvelukartta empty dirs -->
					<h6 class="fw-bold mt-3">Palvelukartta Empty Directories</h6>
					<div id="empty-dirs-palvelukartta-summary" class="text-muted small mb-2"></div>
					<div class="table-responsive mb-3">
						<table class="table table-sm" id="empty-dirs-palvelukartta-table">
							<thead>
								<tr>
									<th style="width: 24px;"><input type="checkbox" class="empty-dir-select-all" data-app="palvelukartta"></th>
									<th>Directory</th>
								</tr>
							</thead>
							<tbody></tbody>
						</table>
					</div>
					<button class="btn btn-warning btn-sm mb-3 empty-dir-delete-btn" data-app="palvelukartta">Delete selected</button>
				</div>
			</div>

		</div>
	</div>
</div>
