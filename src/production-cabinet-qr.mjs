import { crc32, deflateSync } from 'node:zlib';
import qrcodegen from './vendor/qrcodegen.mjs';
import { listRecords } from './production-store.mjs';

export const validCabinetId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function cabinetQrDetails(db, config, cabinetId) {
  if (!validCabinetId(cabinetId)) fail(400, 'Cabinet ID must use 1–64 letters, numbers, underscores or hyphens.');
  const station = listRecords(db, 'station').find(row => row.cabinetId === cabinetId);
  const deviceConfigured = (config.wschargeCabinets || []).includes(cabinetId);
  if (!station && !deviceConfigured) fail(404, 'Cabinet not found');
  // A printed label stays tied to the cabinet, independent of its location and prices.
  const url = new URL('/rent', config.publicOrigin);
  url.searchParams.set('cabinet', cabinetId);
  return { cabinetId, url: url.href, stationName: station?.name || '', deviceConfigured };
}

function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), check = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  check.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, check]);
}

// Bounded cache avoids repeated QR encoding on the public preview endpoint.
// Visibility is checked separately for every request; no station metadata is cached.
const imageCache = new Map();
export function cabinetQrImage(url, format) {
  if (!['png', 'svg'].includes(format)) fail(400, 'Choose PNG or SVG');
  const key = format + ':' + url;
  if (imageCache.has(key)) return imageCache.get(key);
  const image = encodeQrImage(url, format);
  if (imageCache.size >= 64) imageCache.delete(imageCache.keys().next().value);
  imageCache.set(key, image);
  return image;
}
function encodeQrImage(url, format) {
  const qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.QUARTILE);
  const border = 4, size = qr.size + border * 2;
  if (format === 'svg') {
    const path = [];
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) path.push(`M${x + border},${y + border}h1v1h-1z`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 12}" height="${size * 12}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${path.join('')}" fill="black"/></svg>`;
  }
  if (format !== 'png') fail(400, 'Choose PNG or SVG');
  // Fixed integer scaling and a four-module white margin preserve scan reliability.
  const scale = 12, pixels = size * scale, stride = pixels + 1;
  const raw = Buffer.alloc(stride * pixels, 255);
  for (let y = 0; y < pixels; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < pixels; x++) {
      if (qr.getModule(Math.floor(x / scale) - border, Math.floor(y / scale) - border)) raw[y * stride + x + 1] = 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(pixels, 0); header.writeUInt32BE(pixels, 4); header[8] = 8;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function cabinetQrResponse(db, config, params) {
  const details = cabinetQrDetails(db, config, params.get('cabinet'));
  const format = params.get('format') || 'json';
  if (!['json', 'png', 'svg'].includes(format)) fail(400, 'Choose PNG or SVG');
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (format === 'json') return Response.json(details, { headers });
  headers['Content-Type'] = format === 'png' ? 'image/png' : 'image/svg+xml';
  headers['Content-Disposition'] = `${params.get('download') === '1' ? 'attachment' : 'inline'}; filename="Smile-${details.cabinetId}-QR.${format}"`;
  return new Response(cabinetQrImage(details.url, format), { headers });
}
