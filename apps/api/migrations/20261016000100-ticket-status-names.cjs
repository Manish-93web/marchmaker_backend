/** Support tickets now use awaiting_member / awaiting_team instead of waiting_on_member. */
module.exports = {
  async up(db) {
    await db.collection('tickets').updateMany({ status: 'waiting_on_member' }, { $set: { status: 'awaiting_member' } });
  },
  async down(db) {
    await db.collection('tickets').updateMany({ status: 'awaiting_member' }, { $set: { status: 'waiting_on_member' } });
  },
};
