'use strict';

module.exports = {
  db: require.main.require('./src/database'),
  groups: require.main.require('./src/groups'),
  topics: require.main.require('./src/topics'),
  user: require.main.require('./src/user'),
};
