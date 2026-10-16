// Schema migrations (migrate-mongo). The connection string comes from MONGODB_URI; nothing is hard-coded.
// Usage: pnpm --filter @marchmaker/api migrate:up | migrate:down | migrate:status
require('dotenv').config();

module.exports = {
  mongodb: {
    url: process.env.MONGODB_URI || 'mongodb://localhost:27017/?replicaSet=rs0',
    databaseName: process.env.MONGODB_DB || undefined,
    options: {},
  },
  migrationsDir: 'migrations',
  changelogCollectionName: 'schema_migrations',
  migrationFileExtension: '.cjs',
  useFileHash: false,
  moduleSystem: 'commonjs',
};
