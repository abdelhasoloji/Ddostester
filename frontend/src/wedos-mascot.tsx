import { useEffect, useRef } from 'react';
import talkUrl from './assets/mascot/talk.webp';
import mindUrl from './assets/mascot/mind.webp';
import shakenUrl from './assets/mascot/shaken.webp';

/**
 * WedosMascot — the animated "WEDOS AI Assistant" character.
 *
 * It is a faithful port of the approved mockup (maquette-mascotte-flottante):
 * three WebP sprite sheets drawn on a <canvas>, auto-cropped to their opaque
 * bounds, with a gentle floating bob and a shake wobble. The mockup's per-state
 * frame tables and geometry are kept verbatim so the on-screen result matches.
 *
 * Sprite sheets (shipped as assets, not inlined):
 *  - talk   1536×1024, frame 384×512  (idle / waving / speaking)
 *  - mind   1024×1536, frame 256×768  (listening / thinking)
 *  - shaken 1024×1536, frame 512×768  (shake)
 *
 * The character is state-driven (no dragging here — it lives in the assistant
 * panel): the caller maps assistant activity to a MascotState.
 */
export type MascotState = 'idle' | 'waving' | 'listening' | 'thinking' | 'speaking' | 'shaken';

const SRC: Record<'talk' | 'mind' | 'shaken', string> = {
  talk: talkUrl,
  mind: mindUrl,
  shaken: shakenUrl,
};

// One shared set of decoded images across every mounted mascot.
let sharedImages: Record<string, HTMLImageElement> | null = null;
function getImages(): Record<string, HTMLImageElement> {
  if (sharedImages) return sharedImages;
  const imgs: Record<string, HTMLImageElement> = {};
  for (const [k, v] of Object.entries(SRC)) {
    const im = new Image();
    im.src = v;
    imgs[k] = im;
  }
  sharedImages = imgs;
  return imgs;
}

interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
  feet: number;
}

export function WedosMascot({
  state = 'idle',
  width = 116,
  height = 150,
  className,
}: {
  state?: MascotState;
  width?: number;
  height?: number;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<MascotState>(state);
  const stateAtRef = useRef<number>(performance.now());
  const shakeRef = useRef<number>(0);

  // React to state changes without restarting the render loop.
  useEffect(() => {
    if (state !== stateRef.current) {
      stateRef.current = state;
      stateAtRef.current = performance.now();
      if (state === 'shaken') shakeRef.current = 1;
    }
  }, [state]);

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const images = getImages();

    const resize = () => {
      const d = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(box.clientWidth * d);
      canvas.height = Math.round(box.clientHeight * d);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    resize();

    const cropCache = new Map<string, Crop>();
    function bounds(im: HTMLImageElement, key: string, n: number, fw: number, fh: number): Crop {
      const id = key + '-' + n;
      const cached = cropCache.get(id);
      if (cached) return cached;
      const cols = Math.round(im.naturalWidth / fw);
      const off = document.createElement('canvas');
      off.width = fw;
      off.height = fh;
      const c = off.getContext('2d', { willReadFrequently: true });
      if (!c) return { x: 0, y: 0, w: fw, h: fh, feet: fw / 2 };
      c.drawImage(im, (n % cols) * fw, Math.floor(n / cols) * fh, fw, fh, 0, 0, fw, fh);
      const a = c.getImageData(0, 0, fw, fh).data;
      let minX = fw,
        minY = fh,
        maxX = 0,
        maxY = 0;
      for (let y = 0; y < fh; y += 2)
        for (let x = 0; x < fw; x += 2)
          if (a[(y * fw + x) * 4 + 3] > 70) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
      const result: Crop =
        minX > maxX
          ? { x: 0, y: 0, w: fw, h: fh, feet: fw / 2 }
          : {
              x: Math.max(0, minX - 2),
              y: Math.max(0, minY - 2),
              w: Math.min(fw, maxX + 3) - Math.max(0, minX - 2),
              h: Math.min(fh, maxY + 3) - Math.max(0, minY - 2),
              feet: fw / 2,
            };
      let footL = fw,
        footR = 0;
      const footStart = Math.floor(minY + (maxY - minY) * 0.8);
      for (let y = footStart; y <= maxY; y += 2)
        for (let x = 0; x < fw; x += 2)
          if (a[(y * fw + x) * 4 + 3] > 100) {
            footL = Math.min(footL, x);
            footR = Math.max(footR, x);
          }
      if (footL <= footR) result.feet = (footL + footR) / 2 - result.x;
      else result.feet = fw / 2 - result.x;
      cropCache.set(id, result);
      return result;
    }

    let raf = 0;
    let last = performance.now();
    const render = (now: number) => {
      raf = requestAnimationFrame(render);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const w = canvas.width,
        h = canvas.height;
      if (!w || !h) return;
      shakeRef.current *= Math.exp(-dt * 4);
      const st = stateRef.current;
      const q = (now - stateAtRef.current) / 1000;
      let asset: 'talk' | 'mind' | 'shaken' = 'talk';
      let n = 0,
        fw = 384,
        fh = 512;
      if (st === 'shaken') {
        asset = 'shaken';
        n = [0, 1, 2, 1, 2, 3][Math.min(5, Math.floor(q * 4.3))];
        fw = 512;
        fh = 768;
      } else if (st === 'listening') {
        asset = 'mind';
        n = [0, 1, 3, 1, 2, 3][Math.floor(q * 2.1) % 6];
        fw = 256;
        fh = 768;
      } else if (st === 'thinking') {
        asset = 'mind';
        n = 4 + (Math.floor(q * 2) % 4);
        fw = 256;
        fh = 768;
      } else if (st === 'speaking') {
        asset = 'talk';
        n = [1, 2, 3, 4, 5, 4, 3, 2, 6][Math.floor(q * 5) % 9];
      } else if (st === 'waving') {
        asset = 'talk';
        n = [0, 1, 2, 3, 5, 3, 5, 6, 7][Math.min(8, Math.floor(q * 3.5))];
      }
      const im = images[asset];
      ctx.clearRect(0, 0, w, h);
      if (!im.complete || !im.naturalWidth || !images.talk.complete || !images.talk.naturalWidth)
        return;
      const cols = Math.round(im.naturalWidth / fw);
      const crop = bounds(im, asset, n, fw, fh);
      const targetHeight = h * 0.91;
      const scaleY = targetHeight / crop.h;
      const scaleX =
        asset === 'mind' ? scaleY * Math.min(1.25, Math.max(1, 0.5 / (crop.w / crop.h))) : scaleY;
      const dw = crop.w * scaleX;
      const dh = targetHeight;
      const bob = Math.sin(now / 650) * h * 0.004;
      const shake = shakeRef.current;
      ctx.save();
      ctx.translate(w / 2, h * 0.96);
      ctx.rotate(shake * Math.sin(now * 0.04) * 0.09);
      ctx.translate(-w / 2, -h * 0.96);
      ctx.drawImage(
        im,
        (n % cols) * fw + crop.x,
        Math.floor(n / cols) * fh + crop.y,
        crop.w,
        crop.h,
        w / 2 - crop.feet * scaleX + shake * Math.sin(now * 0.03) * w * 0.03,
        h * 0.96 - dh + bob,
        dw,
        dh,
      );
      ctx.restore();
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={boxRef}
      className={`wedos-mascot${className ? ' ' + className : ''}`}
      style={{ width, height }}
      role="img"
      aria-label="WEDOS AI Assistant mascot"
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
