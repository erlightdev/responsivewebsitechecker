// Lightweight activity log persisted to localStorage. Records user actions
// (adding/deleting screens, workspace changes, captures, etc.) so they can be
// reviewed on the Settings page. Capped to the most recent entries.

const KEY = 'vp-activity';
const MAX = 200;

export type ActivityType = 'success' | 'error' | 'info' | 'warning';

export interface ActivityEntry {
  id: string;
  type: ActivityType;
  action: string; // short category, e.g. "Screen added"
  detail?: string; // optional context, e.g. the name
  at: number; // epoch ms
}

export function getActivity(): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as ActivityEntry[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function logActivity(type: ActivityType, action: string, detail?: string): ActivityEntry {
  const entry: ActivityEntry = {
    id: 'ev-' + Math.random().toString(36).slice(2, 10),
    type,
    action,
    detail,
    at: Date.now(),
  };
  try {
    const list = getActivity();
    list.unshift(entry);
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
  return entry;
}

export function clearActivity(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
