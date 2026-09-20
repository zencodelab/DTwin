import { KeyedLimiter } from '@dtwin/types';
import type { Config } from './config.ts';

/**
 * The three things this service rations, and what each one protects
 * (docs/decisions.md §54).
 *
 * They are separate limiters with separate keys because they protect separate
 * resources, and one budget keyed one way would protect none of them well:
 *
 *   authFailures  per ADDRESS   the connection pool. Every key that does not
 *                               resolve still costs a query, on a ten-
 *                               connection pool shared with the telemetry
 *                               writer — so a stranger with no key at all could
 *                               slow ingest for every tenant. Charged only on
 *                               failure: a gateway with a good key is never
 *                               slowed by it.
 *   requests      per API KEY   parse CPU. Checked before the body is read.
 *   readings      per TENANT    the write buffer, and this is the fairness one.
 *                               The buffer sheds OLDEST on overflow and does
 *                               not look at whose rows they are, so one tenant
 *                               flooding it drops every other tenant's data.
 *                               Per tenant rather than per key, or a tenant
 *                               would multiply its share by minting keys.
 */
export interface Limits {
  authFailures: KeyedLimiter;
  requests: KeyedLimiter;
  readings: KeyedLimiter;
  frames: KeyedLimiter;
}

export function createLimits(config: Config): Limits {
  const maxKeys = config.INGEST_RATE_MAX_KEYS;
  return {
    authFailures: new KeyedLimiter({
      ratePerS: config.INGEST_RATE_AUTH_FAILURES_PER_MIN / 60,
      burst: config.INGEST_RATE_AUTH_FAILURES_BURST,
      maxKeys,
    }),
    requests: new KeyedLimiter({
      ratePerS: config.INGEST_RATE_REQUESTS_PER_S,
      burst: config.INGEST_RATE_REQUESTS_PER_S * 2,
      maxKeys,
    }),
    readings: new KeyedLimiter({
      ratePerS: config.INGEST_RATE_READINGS_PER_S,
      burst: config.INGEST_RATE_READINGS_BURST,
      maxKeys,
    }),
    // Keyed by connection id, so each socket has its own budget.
    frames: new KeyedLimiter({
      ratePerS: config.WS_RATE_FRAMES_PER_S,
      burst: config.WS_RATE_FRAMES_PER_S * 3,
      maxKeys,
    }),
  };
}
