// Screen capture via the native Screen Capture API. The display stream is
// requested once and reused for subsequent screenshots (no re-prompt).
// Screenshots can be cropped to a target element (e.g. the preview canvas);
// recordings capture the full shared surface, then stop sharing when done.

let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;

export function isSupported(): boolean {
  return !!(navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices);
}

export function isSharing(): boolean {
  return !!(stream && stream.active);
}

export function stopSharing(): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video = null;
}

function waitForFrame(v: HTMLVideoElement): Promise<void> {
  return new Promise((res) => {
    if (v.readyState >= 2 && v.videoWidth) return res();
    v.onloadeddata = () => res();
  });
}

export async function ensureStream(): Promise<HTMLVideoElement> {
  if (stream && stream.active && video) return video;
  stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 } as MediaTrackConstraints,
    audio: false,
    // Chromium: default-select the current tab for a one-click prompt
    preferCurrentTab: true,
  } as MediaStreamConstraints & { preferCurrentTab?: boolean });

  stream.getVideoTracks()[0].addEventListener('ended', () => {
    stream = null;
    video = null;
  });

  const v = document.createElement('video');
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  await v.play().catch(() => {});
  await waitForFrame(v);
  video = v;
  return v;
}

const toBlob = (canvas: HTMLCanvasElement, type: string, q: number): Promise<Blob> =>
  new Promise((res) => canvas.toBlob((b) => res(b!), type, q));

/** Grab a single frame, optionally cropped to an on-screen element. */
export async function screenshot(cropEl?: HTMLElement | null): Promise<{ blob: Blob; width: number; height: number }> {
  const v = await ensureStream();
  const vw = v.videoWidth;
  const vh = v.videoHeight;

  let sx = 0;
  let sy = 0;
  let sw = vw;
  let sh = vh;
  if (cropEl) {
    const r = cropEl.getBoundingClientRect();
    const kx = vw / window.innerWidth;
    const ky = vh / window.innerHeight;
    sx = Math.max(0, Math.round(r.left * kx));
    sy = Math.max(0, Math.round(r.top * ky));
    sw = Math.min(vw - sx, Math.round(r.width * kx));
    sh = Math.min(vh - sy, Math.round(r.height * ky));
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, sw);
  canvas.height = Math.max(1, sh);
  canvas.getContext('2d')!.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const blob = await toBlob(canvas, 'image/webp', 0.92);
  // release the display stream so the browser's "Sharing this tab" banner
  // clears immediately after the grab (a screenshot is a one-shot action)
  stopSharing();
  return { blob, width: canvas.width, height: canvas.height };
}

/** Record the shared surface for `ms` milliseconds → WebM blob + poster. */
export async function record(
  ms: number,
  onTick?: (remainingMs: number) => void
): Promise<{ blob: Blob; thumb: Blob; width: number; height: number; durationMs: number }> {
  const v = await ensureStream();
  const w = v.videoWidth;
  const h = v.videoHeight;

  const mime =
    ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) =>
      MediaRecorder.isTypeSupported(m)
    ) || 'video/webm';

  // poster frame at start
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(v, 0, 0, w, h);
  const thumb = await toBlob(canvas, 'image/webp', 0.8);

  const rec = new MediaRecorder(stream!, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<void>((res) => {
    rec.onstop = () => res();
  });

  rec.start();
  const start = performance.now();
  let timer = 0;
  if (onTick) timer = window.setInterval(() => onTick(Math.max(0, ms - (performance.now() - start))), 100);
  window.setTimeout(() => rec.state !== 'inactive' && rec.stop(), ms);
  await stopped;
  window.clearInterval(timer);

  const blob = new Blob(chunks, { type: mime });
  stopSharing();
  return { blob, thumb, width: w, height: h, durationMs: ms };
}
