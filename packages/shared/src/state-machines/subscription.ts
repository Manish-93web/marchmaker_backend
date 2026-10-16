import type { SubscriptionState } from '../enums';
import { defineMachine } from './machine';

export const subscriptionMachine = defineMachine<SubscriptionState>('subscription', 'created', {
  created: ['authenticated', 'active', 'cancelled', 'expired'],
  authenticated: ['active', 'cancelled', 'expired'],
  active: ['pending', 'halted', 'cancelled', 'completed'],
  pending: ['active', 'halted', 'cancelled'],
  halted: ['active', 'cancelled', 'expired'],
  cancelled: [],
  completed: [],
  expired: [],
});
