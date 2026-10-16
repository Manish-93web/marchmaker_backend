/** Existing call records were phone bridges; reports and tickets get their new optional fields lazily, so only calls need a backfill. */
module.exports = {
  async up(db) {
    await db.collection('calllogs').updateMany({ mode: { $exists: false } }, { $set: { mode: 'phone' } });
  },
  async down(db) {
    await db.collection('calllogs').updateMany({}, { $unset: { mode: '' } });
  },
};
