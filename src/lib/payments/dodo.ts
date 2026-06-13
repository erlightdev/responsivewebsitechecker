// Dodo Payments client singleton.
//
// Security notes:
//  - DODO_PAYMENTS_API_KEY is a server-only secret. It is read via import.meta.env
//    (never a PUBLIC_ var) so it is never bundled into client code.
//  - `environment` is driven by DODO_PAYMENTS_ENVIRONMENT so you can run against
//    test_mode now and flip to live_mode later by changing env only — no code change.
import DodoPayments from 'dodopayments';

const apiKey = import.meta.env.DODO_PAYMENTS_API_KEY;
const rawEnv = (import.meta.env.DODO_PAYMENTS_ENVIRONMENT || 'test_mode') as
  | 'test_mode'
  | 'live_mode';

export const dodoEnvironment: 'test_mode' | 'live_mode' =
  rawEnv === 'live_mode' ? 'live_mode' : 'test_mode';

// Reuse a single client across hot-reloads in dev.
const globalForDodo = globalThis as unknown as { dodo?: DodoPayments };

export const dodo =
  globalForDodo.dodo ??
  new DodoPayments({
    bearerToken: apiKey,
    environment: dodoEnvironment,
  });

if (import.meta.env.DEV) globalForDodo.dodo = dodo;

/** Throws early with a clear message if payments env is not configured. */
export function assertPaymentsConfigured() {
  if (!apiKey) throw new Error('DODO_PAYMENTS_API_KEY is not set');
}

export const isPaymentsConfigured = Boolean(apiKey);
