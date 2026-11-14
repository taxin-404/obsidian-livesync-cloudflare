import qrcode from 'qrcode-generator';

// The ESM build maps each code unit to one byte (`charCodeAt(i) & 0xff`), which
// mangles anything outside Latin-1. Encode UTF-8 instead so a passphrase or URI
// with non-ASCII characters still decodes to the original text.
qrcode.stringToBytes = (value: string): number[] => Array.from(new TextEncoder().encode(value));

const DEFAULT_QUIET_ZONE = 4;

/**
 * Render `text` as a compact QR code. The code is emitted as horizontal runs in
 * a single <path> instead of the library's per-module markup, which keeps a real
 * setup URI (about 1.3 KB, a version ~26 code) to tens of kilobytes rather than
 * a couple of hundred. The four-module quiet zone is part of the viewBox, and a
 * white field is painted behind the dark runs so the code stays scannable on the
 * dark page.
 */
export function qrSvg(text: string, quietZone = DEFAULT_QUIET_ZONE): string {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const size = count + quietZone * 2;
  let runs = '';
  for (let row = 0; row < count; row += 1) {
    let col = 0;
    while (col < count) {
      if (!qr.isDark(row, col)) {
        col += 1;
        continue;
      }
      let width = 1;
      while (col + width < count && qr.isDark(row, col + width)) width += 1;
      runs += `M${col + quietZone} ${row + quietZone}h${width}v1h-${width}z`;
      col += width;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Setup QR code" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="#fff"/>`
    + `<path fill="#000" d="${runs}"/>`
    + `</svg>`;
}
