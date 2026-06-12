// Annotation editor logic for the CaptureEditor.astro modal. Lets you add
// draggable text labels and click-event markers over a screenshot/video,
// edit title/description/notes, and persist to IndexedDB.

import { putCapture, type Capture, type Annotation } from './captures-db';

type OnSaved = (c: Capture) => void;

const $ = (id: string) => document.getElementById(id)!;
const uid = () => 'a-' + Math.random().toString(36).slice(2, 9);
const fmtTime = (t: number) => new Date(t).toLocaleString();

let mounted = false;
let root: HTMLElement;
let overlay: HTMLElement;
let mediaWrap: HTMLElement;
let titleEl: HTMLInputElement;
let descEl: HTMLTextAreaElement;
let notesEl: HTMLTextAreaElement;
let metaEl: HTMLElement;
let hintEl: HTMLElement;

let current: Capture | null = null;
let objectUrl = '';
let tool: 'text' | 'click' | null = null;
let onSaved: OnSaved | null = null;

const isOpen = () => root.style.display === 'flex';

function setTool(t: 'text' | 'click' | null) {
  tool = t;
  $('ce-tool-text').setAttribute('aria-pressed', String(t === 'text'));
  $('ce-tool-click').setAttribute('aria-pressed', String(t === 'click'));
  overlay.style.cursor = t ? 'crosshair' : 'default';
  // let clicks reach the media (e.g. video controls) when no tool is active;
  // markers keep their own pointer-events:auto so they stay draggable
  overlay.style.pointerEvents = t ? 'auto' : 'none';
  hintEl.textContent = t ? `Click the image to place ${t === 'text' ? 'a label' : 'a click marker'}` : '';
}

function renderMarker(a: Annotation) {
  const m = document.createElement('div');
  m.dataset.id = a.id;
  m.className = 'group/marker absolute -translate-x-1/2 -translate-y-1/2 cursor-move';
  m.style.left = `${a.x * 100}%`;
  m.style.top = `${a.y * 100}%`;
  m.style.pointerEvents = 'auto'; // stay interactive even when overlay is click-through

  if (a.kind === 'click') {
    m.innerHTML = `
      <span class="relative grid size-7 place-items-center rounded-full bg-primary/30 ring-2 ring-primary">
        <span class="absolute inline-flex size-7 animate-ping rounded-full bg-primary/40"></span>
        <svg class="relative size-3.5 text-primary-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9l5 12 1.8-5.2L21 14 9 9z"/></svg>
      </span>
      ${a.text ? `<span class="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">${escapeHtml(a.text)}</span>` : ''}`;
  } else {
    m.innerHTML = `<span class="block max-w-[14rem] truncate rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground shadow-md">${escapeHtml(a.text || 'Text')}</span>`;
  }

  // delete button
  const del = document.createElement('button');
  del.type = 'button';
  del.className =
    'absolute -right-2 -top-2 hidden size-4 place-items-center rounded-full bg-destructive text-white group-hover/marker:grid';
  del.innerHTML = '<svg class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!current) return;
    current.annotations = current.annotations.filter((x) => x.id !== a.id);
    m.remove();
  });
  m.appendChild(del);

  // edit text on double-click
  m.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const text = prompt('Label text:', a.text) ?? a.text;
    a.text = text;
    repaint();
  });

  // drag to reposition
  m.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    m.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = overlay.getBoundingClientRect();
      a.x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      a.y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      m.style.left = `${a.x * 100}%`;
      m.style.top = `${a.y * 100}%`;
    };
    const up = () => {
      m.removeEventListener('pointermove', move);
      m.removeEventListener('pointerup', up);
    };
    m.addEventListener('pointermove', move);
    m.addEventListener('pointerup', up);
  });

  overlay.appendChild(m);
}

function repaint() {
  overlay.querySelectorAll('[data-id]').forEach((el) => {
    el.remove();
  });
  current?.annotations.forEach(renderMarker);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function close() {
  root.style.display = 'none';
  mediaWrap.querySelector('img,video')?.remove();
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = '';
  }
  current = null;
  setTool(null);
}

async function save() {
  if (!current) return;
  current.title = titleEl.value.trim();
  current.description = descEl.value.trim();
  current.notes = notesEl.value.trim();
  const cb = onSaved;
  const saved = current;
  await putCapture(saved);
  close();
  cb?.(saved);
}

function buildMedia(c: Capture) {
  mediaWrap.querySelector('img,video')?.remove();
  objectUrl = URL.createObjectURL(c.blob);
  let el: HTMLElement;
  if (c.type === 'video') {
    const v = document.createElement('video');
    v.src = objectUrl;
    v.controls = true;
    v.className = 'block max-h-[64vh] max-w-full rounded';
    el = v;
  } else {
    const img = document.createElement('img');
    img.src = objectUrl;
    img.alt = c.title || 'capture';
    img.className = 'block max-h-[64vh] max-w-full rounded';
    el = img;
  }
  mediaWrap.insertBefore(el, overlay);
}

export function mountEditor(): (c: Capture, cb?: OnSaved) => void {
  if (!mounted) {
    root = $('capture-editor');
    overlay = $('ce-overlay');
    mediaWrap = $('ce-media');
    titleEl = $('ce-title') as HTMLInputElement;
    descEl = $('ce-desc') as HTMLTextAreaElement;
    notesEl = $('ce-notes') as HTMLTextAreaElement;
    metaEl = $('ce-meta');
    hintEl = $('ce-tool-hint');

    $('ce-close').addEventListener('click', close);
    $('ce-cancel').addEventListener('click', close);
    $('ce-bg').addEventListener('click', close);
    $('ce-save').addEventListener('click', save);
    $('ce-tool-text').addEventListener('click', () => setTool(tool === 'text' ? null : 'text'));
    $('ce-tool-click').addEventListener('click', () => setTool(tool === 'click' ? null : 'click'));
    $('ce-clear').addEventListener('click', () => {
      if (current) current.annotations = [];
      repaint();
    });

    overlay.addEventListener('click', (e) => {
      if (!tool || !current || e.target !== overlay) return;
      const r = overlay.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      let text = '';
      if (tool === 'text') {
        text = prompt('Label text:') || '';
        if (!text) return;
      }
      const a: Annotation = { id: uid(), kind: tool, x, y, text };
      current.annotations.push(a);
      renderMarker(a);
      setTool(null);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) close();
    });
    mounted = true;
  }

  return (c: Capture, cb?: OnSaved) => {
    current = c;
    onSaved = cb ?? null;
    titleEl.value = c.title || '';
    descEl.value = c.description || '';
    notesEl.value = c.notes || '';
    const dur = c.durationMs ? ` · ${Math.round(c.durationMs / 1000)}s` : '';
    metaEl.textContent = `${c.type}${dur} · ${c.width}×${c.height} · ${c.host || 'no URL'} · ${fmtTime(c.createdAt)}`;
    buildMedia(c);
    repaint();
    setTool(null);
    root.style.display = 'flex';
    setTimeout(() => titleEl.focus(), 0);
  };
}
