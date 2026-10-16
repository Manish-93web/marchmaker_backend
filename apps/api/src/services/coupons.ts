import type { Types } from 'mongoose';
import { couponDiscount, type CouponInput } from '@marchmaker/shared';
import { AppError, conflict, notFound } from '../lib/errors';
import { Coupon, CouponRedemption } from '../models/billing';

const HOLD_MINUTES = 60;

const bad = (msg: string) => new AppError(422, 'COUPON_INVALID', msg);

/** Checks a code for this member and target. Throws a kind, specific error; returns the discount. */
export async function validate(code: string, userId: string, target: string, amountPaise: number) {
  const c = await Coupon.findOne({ code: code.trim().toUpperCase() });
  if (!c || !c.active) throw bad('That code is not valid');
  if (c.expiresAt && c.expiresAt.getTime() < Date.now()) throw bad('That code has expired');
  if (c.appliesTo.length && !c.appliesTo.includes(target)) throw bad('That code does not apply to this purchase');
  if (c.maxUses && c.usedCount >= c.maxUses) throw bad('That code has been fully used');
  const since = new Date(Date.now() - HOLD_MINUTES * 60_000);
  const mine = await CouponRedemption.countDocuments({
    couponId: c._id,
    userId,
    $or: [{ status: 'confirmed' }, { status: 'reserved', createdAt: { $gte: since } }],
  });
  if (mine >= (c.perUserLimit ?? 1)) throw bad('You have already used that code');
  const discountPaise = couponDiscount(
    { kind: c.kind as 'percent' | 'flat', value: c.value, maxDiscountPaise: c.maxDiscountPaise ?? undefined },
    amountPaise,
  );
  return { coupon: c, discountPaise };
}

/** Counts a use. The conditional update means two simultaneous checkouts cannot exceed maxUses. */
export async function reserve(couponId: Types.ObjectId | string, userId: string, orderId: Types.ObjectId | string, discountPaise: number) {
  const c = await Coupon.findOneAndUpdate(
    { _id: couponId, $or: [{ maxUses: { $exists: false } }, { maxUses: null }, { $expr: { $lt: ['$usedCount', '$maxUses'] } }] },
    { $inc: { usedCount: 1 } },
    { returnDocument: 'after' },
  );
  if (!c) throw bad('That code has been fully used');
  await CouponRedemption.create({ couponId, userId, orderId, discountPaise, status: 'reserved' });
}

export async function confirm(orderId: Types.ObjectId | string) {
  await CouponRedemption.updateOne({ orderId, status: 'reserved' }, { $set: { status: 'confirmed' } });
}

/** Gives the use back when an order is abandoned or expires. */
export async function release(orderId: Types.ObjectId | string) {
  const r = await CouponRedemption.findOneAndUpdate({ orderId, status: 'reserved' }, { $set: { status: 'released' } });
  if (r) await Coupon.updateOne({ _id: r.couponId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
}

const view = (c: InstanceType<typeof Coupon>) => ({
  id: String(c._id),
  code: c.code,
  description: c.description ?? '',
  kind: c.kind,
  value: c.value,
  maxDiscountPaise: c.maxDiscountPaise ?? null,
  expiresAt: c.expiresAt ?? null,
  maxUses: c.maxUses ?? null,
  usedCount: c.usedCount,
  perUserLimit: c.perUserLimit,
  appliesTo: c.appliesTo,
  razorpayOfferId: c.razorpayOfferId ?? null,
  active: c.active,
});

export async function list() {
  return (await Coupon.find().sort({ createdAt: -1 }).limit(200)).map(view);
}

export async function create(input: CouponInput, actorId: string) {
  try {
    return view(await Coupon.create({ ...input, createdBy: actorId }));
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('A coupon with that code already exists');
    throw err;
  }
}

export async function update(id: string, patch: Partial<CouponInput>) {
  const c = await Coupon.findById(id);
  if (!c) throw notFound();
  // The code is what members know it by; it is not editable once created.
  const rest: Partial<CouponInput> = { ...patch };
  delete rest.code;
  c.set(rest);
  await c.save();
  return view(c);
}
