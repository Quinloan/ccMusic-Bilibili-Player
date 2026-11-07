// Option A: deterministic Material Wu/Score extraction, using the cover colour directly.
// 0.3.0 is pinned because 0.4.0's barrel has broken Node ESM import paths.
const { QuantizerWu, Score, Hct,
  argbFromRgb, redFromArgb, greenFromArgb, blueFromArgb } = require('@material/material-color-utilities');
const FALLBACK = [222, 226, 234];
function luminance(rgb) {
  const c = rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
// Retained for validation callers; production surfaces are always opaque.
function surfaceContrast(foreground, background, opacity = 1) {
  const composite = rgb => rgb.map((v, i) => Math.round(v * (1 - opacity) + background[i] * opacity));
  return Math.min(contrast(foreground, composite([0,0,0])), contrast(foreground, composite([255,255,255])));
}
const rgbFromArgb = argb => [redFromArgb(argb), greenFromArgb(argb), blueFromArgb(argb)];
function quantizeColours(pixels) {
  // Celebi's WSMeans refinement randomly initializes assignments, sometimes
  // changing the selected colour even for identical images. Wu is Material's
  // deterministic first quantization stage; use its public API without patching
  // global randomness or depending on the library's private cube fields.
  const palette = new QuantizerWu().quantize(pixels, 128).map(argb => ({ argb, rgb: rgbFromArgb(argb) }));
  const frequencies = new Map(), colours = new Map();
  for (const argb of pixels) frequencies.set(argb, (frequencies.get(argb) || 0) + 1);
  for (const [argb, count] of frequencies) {
    const [r,g,b] = rgbFromArgb(argb);
    let nearest = palette[0], best = Infinity;
    for (const entry of palette) {
      const difference = (r-entry.rgb[0])**2 + (g-entry.rgb[1])**2 + (b-entry.rgb[2])**2;
      if (difference < best) { nearest = entry; best = difference; }
    }
    if (nearest) colours.set(nearest.argb, (colours.get(nearest.argb) || 0) + count);
  }
  return colours;
}
function themeFromColors(color) {
  const background = color.slice();
  const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
  let primary = [[20,20,24], [250,250,252]].sort((a,b) => contrast(b,background) - contrast(a,background))[0];
  // Midtones occasionally need pure black/white to satisfy text contrast.
  if (contrast(primary,background) < 4.5) primary = [[0,0,0], [255,255,255]].sort((a,b) => contrast(b,background) - contrast(a,background))[0];
  let secondary = primary;
  for (const fraction of [.22,.16,.10,.04]) {
    const candidate = mix(primary,background,fraction);
    if (contrast(candidate,background) >= 4.5) { secondary = candidate; break; }
  }
  return { background, primary, secondary, accent: primary, accentText: background,
    track: mix(background,primary,.23), error: [147,0,10], errorText: [255,218,214],
    opacity: 1, dark: primary[0] > 128 };
}
function extractSourceColor(pixels, width, height) {
  if (!pixels || pixels.length % 4 || pixels.length > 256 * 256 * 4) return null;
  const count = pixels.length / 4, side = Math.sqrt(count);
  width = width || (Number.isInteger(side) ? side : count); height = height || count / width;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width * height !== count || !count) return null;
  const sampled = [], trim = Math.min(width, height) >= 16 ? 1 : 0;
  // Keep work bounded even if a future decoder supplies a larger bitmap.
  const stride = Math.max(1, Math.ceil(Math.sqrt(count / 4096)));
  for (let y = trim; y < height - trim; y += stride) for (let x = trim; x < width - trim; x += stride) {
    const i = (y * width + x) * 4;
    const [b, g, r, a] = pixels.subarray(i, i + 4); // nativeImage BGRA
    if (a >= 192) sampled.push(argbFromRgb(r, g, b));
  }
  if (!sampled.length) return null;
  const quantized = quantizeColours(sampled);
  const population = [...quantized.values()].reduce((sum, n) => sum + n, 0);
  const entries = [...quantized].sort((a, b) => b[1] - a[1]);
  // All-neutral covers should stay neutral, not Material's default Google blue.
  // Tiny stickers/labels also must not colour an otherwise monochrome cover.
  const colourful = entries.filter(([argb]) => Hct.fromInt(argb).chroma >= 12)
    .reduce((sum, [, n]) => sum + n, 0);
  const neutral = colourful / population < .12;
  const seed = neutral ? entries[0][0] : Score.score(quantized, { desired: 1, fallbackColorARGB: entries[0][0] })[0];
  return { seed, neutral };
}
function extractPalette(pixels, width, height) {
  const source = extractSourceColor(pixels, width, height);
  return themeFromColors(source ? rgbFromArgb(source.seed) : FALLBACK);
}
const dominantColor = (pixels, width, height) => extractPalette(pixels, width, height).background;
function coverUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 2200) return '';
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '443')) return '';
    if (!/(?:^|\.)(?:hdslb\.com|biliimg\.com|music\.126\.net|gtimg\.cn|mzstatic\.com)$/.test(url.hostname)) return '';
    url.protocol = 'https:'; return url.href;
  } catch (_) { return ''; }
}
function createPaletteResolver({ request, decode }) {
  const cache = new Map(), pending = new Map();
  async function load(url) {
    try {
      const referer = url.includes('.music.126.net/') ? 'https://music.163.com/' : url.includes('.gtimg.cn/') ? 'https://y.qq.com/' : 'https://www.bilibili.com/';
      const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(4500), headers: { Referer: referer } });
      const limit = 4 * 1024 * 1024;
      if (!response.ok || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); return null; }
      let size = 0; const parts = [];
      for await (const part of response.body) { size += part.length; if (size > limit) throw Error('cover too large'); parts.push(part); }
      const image = decode(Buffer.concat(parts));
      const pixels = image?.pixels || image;
      if (!pixels?.length) return null;
      const color = extractPalette(pixels, image.width, image.height); cache.set(url, color);
      if (cache.size > 48) cache.delete(cache.keys().next().value);
      return color;
    } catch (_) { return null; }
    finally { pending.delete(url); }
  }
  return async value => {
    const url = coverUrl(value); if (!url) return null;
    if (cache.has(url)) return cache.get(url);
    if (!pending.has(url)) pending.set(url, load(url));
    return pending.get(url);
  };
}
module.exports = { extractSourceColor, dominantColor, extractPalette, themeFromColors, surfaceContrast, contrast, createPaletteResolver, coverUrl, FALLBACK };
