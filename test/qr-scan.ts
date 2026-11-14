import jsQR from 'jsqr';

// One horizontal run of dark modules, as the renderer emits them.
const PATH_RUN = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;

export interface QrRaster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Independent reader for the compact QR SVG the worker renders. It parses the
 * emitted markup — the viewBox size plus the horizontal runs in the single
 * <path> — and paints them on a white canvas. It deliberately does not import
 * the renderer, so a renderer bug (bad coordinate, wrong run length) shows up
 * as a decode failure instead of being mirrored by shared logic.
 */
export function rasterizeQrSvg(svg: string, scale = 4): QrRaster {
  const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!box) throw new Error('QR SVG has no viewBox');
  if (box[2] !== box[1]) throw new Error('QR SVG viewBox is not square');
  const modules = Number(box[1]);
  const path = /<path[^>]*\sd="([^"]+)"/.exec(svg);
  if (!path) throw new Error('QR SVG has no <path>');

  const width = modules * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  let runs = 0;
  for (const run of path[1].matchAll(PATH_RUN)) {
    const x = Number(run[1]);
    const y = Number(run[2]);
    const w = Number(run[3]);
    if (run[4] !== run[3]) throw new Error('QR SVG run does not close');
    for (let dy = 0; dy < scale; dy += 1) {
      for (let dx = 0; dx < w * scale; dx += 1) {
        const offset = ((y * scale + dy) * width + x * scale + dx) * 4;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
      }
    }
    runs += 1;
  }
  if (runs === 0) throw new Error('QR SVG has no dark modules');
  return { width, height: width, data };
}

export function decodeQrSvg(svg: string, scale = 4): string | null {
  const { width, height, data } = rasterizeQrSvg(svg, scale);
  return jsQR(data, width, height)?.data ?? null;
}
