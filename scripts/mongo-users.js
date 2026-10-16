// Least-privilege database users, with an audit log that nobody (including the application) can alter.
// Re-runnable: run it again after adding collections so the application role covers them.
//   mongosh "mongodb+srv://admin:...@cluster/" --file scripts/mongo-users.js //     --eval 'globalThis.CFG = { db: "marchmaker", apiPassword: "...", workerPassword: "...", analyticsPassword: "..." }'
// On Atlas, create the same users and custom roles under Database Access with these privileges.

const cfg = globalThis.CFG;
if (!cfg || !cfg.db) throw new Error('Pass CFG with db and the three passwords');
const d = db.getSiblingDB(cfg.db);

const WRITE = ['find', 'insert', 'update', 'remove', 'createIndex', 'listIndexes', 'collStats', 'changeStream'];
const READ = ['find', 'listIndexes', 'collStats'];

// Every collection except auditlogs gets full application access; auditlogs can only be added to and read.
const existing = d.getCollectionNames().filter((c) => !c.startsWith('system.'));
const ensure = (name, privileges) => {
  const has = d.getRole(name);
  if (has) d.updateRole(name, { privileges, roles: [] });
  else d.createRole({ role: name, privileges, roles: [] });
};
ensure('appData', existing.filter((c) => c !== 'auditlogs').map((c) => ({ resource: { db: cfg.db, collection: c }, actions: WRITE })));
ensure('auditAppendOnly', [{ resource: { db: cfg.db, collection: 'auditlogs' }, actions: ['find', 'insert', 'createIndex', 'listIndexes'] }]);

// Analytics may read only collections that hold no personal or secret data.
const safe = ['analyticsevents', 'activedays', 'payments', 'invoices', 'introductions', 'matchsuggestions', 'subscriptions', 'orders', 'tickets', 'reports'];
ensure('analyticsReadOnly', safe.map((c) => ({ resource: { db: cfg.db, collection: c }, actions: READ })));

const ensureUser = (user, pwd, roles) => {
  if (d.getUser(user)) d.updateUser(user, { pwd, roles });
  else d.createUser({ user, pwd, roles });
};
const appRoles = [{ role: 'appData', db: cfg.db }, { role: 'auditAppendOnly', db: cfg.db }];
ensureUser('marchmaker_api', cfg.apiPassword, appRoles);
ensureUser('marchmaker_worker', cfg.workerPassword, appRoles);
ensureUser('marchmaker_analytics', cfg.analyticsPassword, [{ role: 'analyticsReadOnly', db: cfg.db }]);

print('Done. Application users cannot update or delete audit records. Collections now covered: ' + existing.length);
