import { describe, expect, it } from 'vitest';
import { qrSvg } from '../src/qr';
import { decodeQrSvg, rasterizeQrSvg } from './qr-scan';

const URI = 'obsidian://setuplivesync?settings=test';

describe('qrSvg', () => {
  it('renders a QR that decodes back to the exact input', () => {
    expect(decodeQrSvg(qrSvg(URI))).toBe(URI);
  });

  it('decodes a setup URI at its real length', () => {
    const long = `obsidian://setuplivesync?settings=${'aZ9-_x0'.repeat(180)}`;
    expect(long.length).toBeGreaterThan(1200);
    expect(decodeQrSvg(qrSvg(long))).toBe(long);
  });

  it('encodes non-ASCII characters as UTF-8', () => {
    const unicode = 'obsidian://setuplivesync?settings=caf\u00e9-\u2713';
    expect(decodeQrSvg(qrSvg(unicode))).toBe(unicode);
  });

  it('is deterministic', () => {
    expect(qrSvg(URI)).toBe(qrSvg(URI));
  });

  it('surrounds the code with a four-module quiet zone on a white background', () => {
    const svg = qrSvg(URI);
    const { width } = rasterizeQrSvg(svg, 1);
    expect(svg).toContain(`viewBox="0 0 ${width} ${width}"`);
    // The top-left finder pattern is the first dark run; it sits after the
    // quiet zone on both axes.
    expect(/<path[^>]*d="M4 4h/.test(svg)).toBe(true);
    // Dark-on-dark would not scan, so the code carries its own white field.
    expect(svg).toMatch(/<rect[^>]*fill="#fff"/);
  });

  it('honours a custom quiet zone', () => {
    const [narrow, wide] = [qrSvg(URI, 2), qrSvg(URI, 4)];
    // Two fewer quiet modules per side means four fewer viewBox units.
    expect(rasterizeQrSvg(wide, 1).width - rasterizeQrSvg(narrow, 1).width).toBe(4);
    expect(/<path[^>]*d="M2 2h/.test(narrow)).toBe(true);
  });
});
