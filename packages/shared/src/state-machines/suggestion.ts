import type { SuggestionStatus } from '../enums';
import { defineMachine } from './machine';

export const suggestionMachine = defineMachine<SuggestionStatus>('suggestion', 'suggested', {
  suggested: ['in_review', 'snoozed'],
  in_review: ['approved', 'rejected', 'snoozed', 'escalated'],
  snoozed: ['suggested', 'in_review'],
  escalated: ['in_review', 'approved', 'rejected'],
  approved: [],
  rejected: [],
});
