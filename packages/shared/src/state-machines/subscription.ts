import type { SubscriptionState } from '../enums';
import { defineMachine } from './machine';

export const subscriptionMachine = defineMachine<SubscriptionState>('subscription', 'created', {
  created: ['authenticated', 'active', 'cancelled', 'expired'],
  authenticated: ['active', 'cancelled', 'expired'],
  active: ['pending', 'halted', 'paused', 'cancelled', 'completed'],
  pending: ['active', 'halted', 'paused', 'cancelled'],
  // A paused subscription can be resumed, or ended while paused.
  paused: ['active', 'cancelled', 'completed', 'expired'],
  halted: ['active', 'cancelled', 'expired'],
  cancelled: [],
  completed: [],
  expired: [],
});
