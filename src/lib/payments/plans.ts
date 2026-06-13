// Shared payment types. Plan→product resolution lives in plan-store.ts (DB-backed,
// synced to Dodo), so there are no product ids in env.

export type PlanId = 'free' | 'pro';
export type Interval = 'monthly' | 'yearly';

// Dodo subscription statuses that grant Pro access.
export const ACTIVE_STATUSES = new Set(['active', 'on_hold']);
