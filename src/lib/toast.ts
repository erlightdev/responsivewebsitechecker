// Dependency-free Sonner-style toast notifications (no React). Reproduces the
// shadcn "sonner" look — stacked bottom-right cards with type icons, a swipe-y
// enter/exit, and auto-dismiss. Each toast can also append to the activity log
// so user actions are reviewable in Settings.

import { logActivity, type ActivityType } from './activity-log';

export type ToastType = 'success' | 'error' | 'info' | 'warning' | 'message';

export interface ToastOptions {
  description?: string;
  duration?: number; // ms; 0 = sticky until dismissed
  /** Append to the activity log. true = log under `action`; string = custom action label; false = skip. */
  log?: boolean | string;
}

const ICONS: Record<Exclude<ToastType, 'message'>, string> = {
  success:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  warning:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
};

const LOG_TYPE: Record<ToastType, ActivityType> = {
  success: 'success',
  error: 'error',
  info: 'info',
  warning: 'warning',
  message: 'info',
};

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (host && document.body.contains(host)) return host;
  injectStyles();
  host = document.createElement('section');
  host.id = 'vp-toaster';
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-label', 'Notifications');
  document.body.appendChild(host);
  return host;
}

function injectStyles() {
  if (document.getElementById('vp-toast-styles')) return;
  const style = document.createElement('style');
  style.id = 'vp-toast-styles';
  style.textContent = `
    #vp-toaster {
      position: fixed; right: 1rem; bottom: 1rem; z-index: 100;
      display: flex; flex-direction: column; gap: .625rem;
      width: min(22rem, calc(100vw - 2rem)); pointer-events: none;
    }
    .vp-toast {
      pointer-events: auto; display: flex; align-items: flex-start; gap: .625rem;
      padding: .8rem .9rem; border-radius: .65rem;
      background: var(--popover, #fff); color: var(--popover-foreground, #0a0a0a);
      border: 1px solid var(--border, #e5e5e5);
      box-shadow: 0 8px 24px -8px rgb(0 0 0 / .22), 0 2px 6px -2px rgb(0 0 0 / .14);
      font-size: .8125rem; line-height: 1.3;
      transform: translateY(8px) scale(.98); opacity: 0;
      transition: transform .26s cubic-bezier(.21,1.02,.73,1), opacity .26s ease;
    }
    .vp-toast.vp-in { transform: translateY(0) scale(1); opacity: 1; }
    .vp-toast.vp-out { transform: translateX(110%); opacity: 0; }
    .vp-toast-icon { flex-shrink: 0; margin-top: .05rem; }
    .vp-toast-icon svg { width: 1.1rem; height: 1.1rem; display: block; }
    .vp-toast--success .vp-toast-icon { color: #16a34a; }
    .vp-toast--error   .vp-toast-icon { color: var(--destructive, #dc2626); }
    .vp-toast--info    .vp-toast-icon { color: #2563eb; }
    .vp-toast--warning .vp-toast-icon { color: #d97706; }
    .vp-toast-body { min-width: 0; flex: 1; }
    .vp-toast-title { font-weight: 600; word-break: break-word; }
    .vp-toast-desc { margin-top: .15rem; color: var(--muted-foreground, #71717a); word-break: break-word; }
    .vp-toast-close {
      flex-shrink: 0; display: grid; place-items: center; width: 1.15rem; height: 1.15rem;
      margin: -.1rem -.15rem 0 0; border-radius: .3rem; color: var(--muted-foreground, #71717a);
      background: none; border: 0; cursor: pointer; opacity: 0; transition: opacity .15s, background-color .15s;
    }
    .vp-toast:hover .vp-toast-close { opacity: 1; }
    .vp-toast-close:hover { background: var(--muted, #f4f4f5); color: var(--foreground, #0a0a0a); }
    .vp-toast-close svg { width: .85rem; height: .85rem; }
    @media (prefers-reduced-motion: reduce) {
      .vp-toast { transition: opacity .15s ease; transform: none; }
      .vp-toast.vp-out { transform: none; }
    }
  `;
  document.head.appendChild(style);
}

function show(type: ToastType, message: string, opts: ToastOptions = {}) {
  const duration = opts.duration ?? (type === 'error' ? 6000 : 4000);

  // activity log
  if (opts.log !== false) {
    const action = typeof opts.log === 'string' ? opts.log : message;
    logActivity(LOG_TYPE[type], action, typeof opts.log === 'string' ? message : opts.description);
  }

  // SSR / no-DOM guard
  if (typeof document === 'undefined') return;

  const el = document.createElement('div');
  el.className = `vp-toast vp-toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const icon = type === 'message' ? '' : `<span class="vp-toast-icon">${ICONS[type]}</span>`;
  el.innerHTML = `
    ${icon}
    <div class="vp-toast-body">
      <div class="vp-toast-title"></div>
      ${opts.description ? '<div class="vp-toast-desc"></div>' : ''}
    </div>
    <button type="button" class="vp-toast-close" aria-label="Dismiss">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;
  el.querySelector('.vp-toast-title')!.textContent = message;
  if (opts.description) el.querySelector('.vp-toast-desc')!.textContent = opts.description;

  let timer = 0;
  const dismiss = () => {
    if (el.classList.contains('vp-out')) return;
    clearTimeout(timer);
    el.classList.remove('vp-in');
    el.classList.add('vp-out');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400); // fallback
  };

  el.querySelector('.vp-toast-close')!.addEventListener('click', dismiss);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => {
    if (duration > 0) timer = window.setTimeout(dismiss, 1500);
  });

  ensureHost().appendChild(el);
  requestAnimationFrame(() => el.classList.add('vp-in'));
  if (duration > 0) timer = window.setTimeout(dismiss, duration);
}

export const toast = Object.assign(
  (message: string, opts?: ToastOptions) => show('message', message, opts),
  {
    success: (m: string, o?: ToastOptions) => show('success', m, o),
    error: (m: string, o?: ToastOptions) => show('error', m, o),
    info: (m: string, o?: ToastOptions) => show('info', m, o),
    warning: (m: string, o?: ToastOptions) => show('warning', m, o),
    message: (m: string, o?: ToastOptions) => show('message', m, o),
  }
);
