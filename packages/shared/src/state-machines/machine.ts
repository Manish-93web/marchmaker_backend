export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export class InvalidTransitionError extends Error {
  constructor(
    public readonly machine: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid ${machine} transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export interface Machine<S extends string> {
  readonly name: string;
  readonly initial: S;
  canTransition(from: S, to: S): boolean;
  assertTransition(from: S, to: S): void;
  next(from: S): readonly S[];
}

export function defineMachine<S extends string>(name: string, initial: S, map: TransitionMap<S>): Machine<S> {
  return {
    name,
    initial,
    canTransition: (from, to) => (map[from] ?? []).includes(to),
    assertTransition(from, to) {
      if (!(map[from] ?? []).includes(to)) throw new InvalidTransitionError(name, from, to);
    },
    next: (from) => map[from] ?? [],
  };
}
