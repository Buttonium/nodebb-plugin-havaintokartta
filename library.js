'use strict';

const routes = require('./lib/routes');
const adminController = require('./lib/admin/storage');
const { getConfig } = require('./lib/config');
const { buildTopicUrl } = require('./lib/utils');

const plugin = {};

plugin.init = async function init(params) {
  routes.mount(params.router);

  // Admin settings page
  const middleware = params.middleware || {};
  const adminMiddlewares = [
    middleware.autoLocale,
    middleware.admin && middleware.admin.buildHeader,
  ].filter(Boolean);

  // Explicit admin check on all /api/admin/* routes (NodeBB also does this globally).
  const adminApiGuard = [
    middleware.admin && middleware.admin.checkPrivileges,
  ].filter(Boolean);

  if (params.router) {
    params.router.get(
      '/admin/plugins/havaintokartta',
      adminMiddlewares,
      adminController.get
    );
    params.router.get(
      '/api/admin/plugins/havaintokartta',
      adminApiGuard,
      adminController.get
    );

    // Orphan scan API — explicit admin privilege check (defense-in-depth)
    params.router.get(
      '/api/admin/plugins/havaintokartta/orphans/scan',
      adminApiGuard,
      adminController.scanOrphans
    );
    params.router.post(
      '/api/admin/plugins/havaintokartta/orphans/delete',
      adminApiGuard,
      adminController.deleteOrphans
    );
    params.router.post(
      '/api/admin/plugins/havaintokartta/empty-dirs/delete',
      adminApiGuard,
      adminController.deleteEmptyDirs
    );
  }
};

plugin.addAdminNavigation = async function addAdminNavigation(header) {
  header.plugins.push({
    route: '/plugins/havaintokartta',
    name: 'Havaintokartta',
  });
  return header;
};

// buildTopicUrl uses forumUrl (FORUM_URL) if set, else baseUrl, so the
// cache-clearing URL matches the one stored at report creation.

/**
 * Hook fired when a moderator deletes a topic on NodeBB.
 * If the topic belongs to the Uutiset category, notify Ylivieskahub to clear
 * the cached forum_topic_url from SQLite so the "Aloita keskustelu" button
 * reappears on the next page load.
 */
plugin.onTopicDeleted = async function onTopicDeleted(data) {
  try {
    const config = getConfig();
    const topic = data.topic;

    // Only act on topics in the Uutiset category.
    if (!topic || topic.cid !== config.uutisetCategoryId) {
      return;
    }

    const ylivieskahubUrl = config.ylivieskahubUrl;
    if (!ylivieskahubUrl) {
      console.warn('[havaintokartta] YLIVIESKAHUB_URL not configured, skipping topic delete notification');
      return;
    }

    const topicUrl = buildTopicUrl(config.forumUrl || config.baseUrl, topic.tid, topic.slug);

    // Fire-and-forget — don't await so the hook handler returns immediately.
    fetch(ylivieskahubUrl + '/api/forum/topic/cache/clear', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ topicUrl }),
    })
      .then((response) => {
        if (response.ok) {
          console.log('[havaintokartta] Notified Ylivieskahub of topic deletion:', topicUrl);
        } else {
          console.warn('[havaintokartta] Ylivieskahub responded with status', response.status, 'for topic deletion:', topicUrl);
        }
      })
      .catch((err) => {
        console.warn('[havaintokartta] Failed to notify Ylivieskahub of topic deletion:', err?.message || err);
      });
  } catch (err) {
    // Fire-and-forget — never block or throw.
    console.warn('[havaintokartta] Failed to notify Ylivieskahub of topic deletion:', err?.message || err);
  }
};

module.exports = plugin;
