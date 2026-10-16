/**
 * Feedback gained stages (checkin, closed, meeting). Existing rows are check-ins; the check-in marker's
 * unique index must now include the stage or the "did you meet?" marker could never be written.
 */
module.exports = {
  async up(db) {
    await db.collection('introfeedbacks').updateMany({ stage: { $exists: false } }, { $set: { stage: 'checkin' } });
    const markers = db.collection('checkinmarkers');
    await markers.updateMany({ stage: { $exists: false } }, { $set: { stage: 'checkin' } });
    const old = (await markers.indexes()).find((i) => i.name === 'introductionId_1_userId_1');
    if (old) await markers.dropIndex('introductionId_1_userId_1');
    await markers.createIndex({ introductionId: 1, userId: 1, stage: 1 }, { unique: true, name: 'introductionId_1_userId_1_stage_1' });
  },
  async down(db) {
    const markers = db.collection('checkinmarkers');
    await markers.deleteMany({ stage: { $ne: 'checkin' } });
    const idx = (await markers.indexes()).find((i) => i.name === 'introductionId_1_userId_1_stage_1');
    if (idx) await markers.dropIndex('introductionId_1_userId_1_stage_1');
    await markers.createIndex({ introductionId: 1, userId: 1 }, { unique: true });
  },
};
