import type { IntroState } from '../enums';
import { defineMachine } from './machine';

export const introductionMachine = defineMachine<IntroState>('introduction', 'released', {
  released: ['viewed', 'accepted_by_one', 'declined', 'expired'],
  viewed: ['accepted_by_one', 'declined', 'expired'],
  accepted_by_one: ['mutually_accepted', 'declined', 'expired'],
  mutually_accepted: [],
  declined: [],
  expired: [],
});

export const TERMINAL_INTRO_STATES: readonly IntroState[] = ['mutually_accepted', 'declined', 'expired'];
export const isTerminalIntro = (s: IntroState) => TERMINAL_INTRO_STATES.includes(s);
