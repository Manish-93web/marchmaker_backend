import CircuitBreaker from 'opossum';

export class CircuitOpenError extends Error {
  constructor(public readonly provider = 'provider') {
    super(`${provider} is failing; calls are paused for a moment`);
    this.name = 'CircuitOpenError';
  }
}

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  /** A call slower than this counts as a failure. */
  timeoutMs?: number;
  /** Share of failed calls (in the rolling window) that opens the circuit. */
  errorThresholdPercentage?: number;
  /** Calls needed in the window before the circuit may open at all. */
  volumeThreshold?: number;
  /** How long it stays open before one probe call is allowed. */
  resetTimeoutMs?: number;
  log?: { warn: (o: object, m: string) => void };
}

const registry = new Map<string, ProviderBreaker>();

/** Mistakes by the caller (4xx, validation) are not the provider's fault and must not open the circuit. */
function isClientError(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; name?: string } | undefined;
  const code = e?.status ?? e?.statusCode;
  return (typeof code === 'number' && code >= 400 && code < 500 && code !== 429) || e?.name === 'ZodError' || e?.name === 'AppError';
}

/** One circuit breaker (opossum) per outside provider, so a failing vendor cannot tie up requests and workers. */
export class ProviderBreaker {
  private readonly breaker: CircuitBreaker<[() => Promise<unknown>], unknown>;

  constructor(
    readonly name: string,
    opts: BreakerOptions = {},
  ) {
    this.breaker = new CircuitBreaker((thunk: () => Promise<unknown>) => thunk(), {
      timeout: opts.timeoutMs ?? 20_000,
      errorThresholdPercentage: opts.errorThresholdPercentage ?? 50,
      volumeThreshold: opts.volumeThreshold ?? 5,
      resetTimeout: opts.resetTimeoutMs ?? 30_000,
      rollingCountTimeout: 60_000,
      errorFilter: isClientError,
      name,
    });
    this.breaker.on('open', () => opts.log?.warn({ provider: name }, 'circuit opened: provider is failing'));
    this.breaker.on('halfOpen', () => opts.log?.warn({ provider: name }, 'circuit half-open: probing provider'));
    this.breaker.on('close', () => opts.log?.warn({ provider: name }, 'circuit closed: provider recovered'));
    registry.set(name, this);
  }

  get state(): BreakerState {
    return this.breaker.opened ? 'open' : this.breaker.halfOpen ? 'half_open' : 'closed';
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return (await this.breaker.fire(fn)) as T;
    } catch (err) {
      if ((err as { code?: string }).code === 'EOPENBREAKER') throw new CircuitOpenError(this.name);
      throw err;
    }
  }

  close() {
    this.breaker.shutdown();
    registry.delete(this.name);
  }
}

/** Wraps the named async methods of an adapter; everything else (names, sync verification) passes straight through. */
export function withBreaker<T extends object>(name: string, target: T | null, methods: (keyof T)[], opts: BreakerOptions = {}): T | null {
  if (!target) return target;
  const breaker = new ProviderBreaker(name, opts);
  const wrapped = new Set<PropertyKey>(methods);
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const v = Reflect.get(obj, prop, receiver);
      if (typeof v === 'function' && wrapped.has(prop)) {
        return (...args: unknown[]) => breaker.run(() => (v as (...a: unknown[]) => Promise<unknown>).apply(obj, args));
      }
      return typeof v === 'function' ? v.bind(obj) : v;
    },
  });
}

/** Current state of every provider circuit, for the admin console. */
export function breakerStates(): { name: string; state: BreakerState }[] {
  return [...registry.values()].map((b) => ({ name: b.name, state: b.state })).sort((a, b) => a.name.localeCompare(b.name));
}
