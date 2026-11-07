// Material image extraction, opaque Material contrast, bounded network/cache; no Electron/audio.
const assert = require('node:assert/strict');
const { extractPalette, themeFromColors, surfaceContrast, contrast, createPaletteResolver, coverUrl, FALLBACK } = require('../cover-palette.cjs');
const pixels = colors => Buffer.from(colors.flatMap(([r, g, b, count, a = 255]) => Array.from({ length: count }, () => [b, g, r, a]).flat()));
(async () => {
  const picture = painter => { const data = Buffer.alloc(48 * 48 * 4); for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) { const [r,g,b] = painter(x,y); data.set([b,g,r,255], (y * 48 + x) * 4); } return data; };
  const fixtures = [
    ['portrait', picture((x,y) => x > 5 && x < 42 && y > 5 && y < 42 ? [190,145,110] : [24,48,88])],
    ['neutral-sticker', picture((x,y) => x > 30 && y < 15 ? [245,25,15] : [32,32,35])],
    ['white-sticker', picture((x,y) => x > 30 && y < 15 ? [245,25,15] : [240,240,238])],
    ['compression-rim', picture((x,y) => !x || !y || x === 47 || y === 47 ? [255,255,255] : [35,80,140])],
    ['dark-blue-highlight', picture((x,y) => x < 6 || y < 6 || x > 41 || y > 41 ? [40,95,170] : [8,35,95])],
    ['bright', picture(() => [235,220,190])], ['black', picture(() => [0,0,0])],
    ['midtone', picture(() => [117,117,117])], ['neon', picture(() => [240,15,130])],
  ];
  const themes = new Map(fixtures.map(([name, data]) => [name, extractPalette(data,48,48)]));
  assert.ok(themes.get('portrait').background[0] > themes.get('portrait').background[2], 'Material considers the whole artwork, including its dominant warm portrait');
  for (const name of ['neutral-sticker','white-sticker']) { const bg = themes.get(name).background; assert.ok(Math.max(...bg) - Math.min(...bg) < 12, 'small colourful stickers must not replace a neutral background'); }
  assert.ok(themes.get('compression-rim').background[2] > themes.get('compression-rim').background[0] + 40, 'ignore one-pixel white compression fringes');
  assert.ok(themes.get('dark-blue-highlight').background[0] < 60 && themes.get('dark-blue-highlight').background[2] > 80, 'blue art produces a saturated dark blue, not a pale or grey-blue surface');
  assert.deepEqual(extractPalette(pixels([[240,10,10,100,0]])).background, themeFromColors(FALLBACK).background);
  assert.ok(Math.max(...themes.get('black').background) - Math.min(...themes.get('black').background) < 3, 'monochrome art does not become the library default blue');
  assert.deepEqual(extractPalette(Buffer.alloc(0)).background, themeFromColors(FALLBACK).background);
  assert.deepEqual(extractPalette(Buffer.alloc(4), 2, 2).background, themeFromColors(FALLBACK).background, 'invalid bitmap dimensions');
  const complex = picture((x,y)=>[(x*7+y*3)%256,(x*13+y*5)%256,(x*11+y*17)%256]);
  const repeated = extractPalette(complex,48,48);
  for(let i=0;i<5;i++) assert.deepEqual(extractPalette(complex,48,48),repeated,'same artwork must produce exactly the same colour across uncached calls');
  for (const [name, theme] of themes) {
    assert.ok(theme.opacity === 1, name + ': fully opaque cover-colour surface');
    for (const key of ['primary','secondary']) assert.ok(surfaceContrast(theme[key],theme.background,theme.opacity) >= 4.5, name + ': text contrast across arbitrary desktop colours');
    assert.ok(surfaceContrast(theme.accent,theme.background,theme.opacity) >= 3, name + ': controls remain visible');
    assert.ok(contrast(theme.accentText,theme.accent) >= 4.5, name + ': opaque play button icon');
  }
  // RGB sweep verifies direct cover colours are unchanged and paired text remains readable.
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
    const theme = themeFromColors([r,g,b]);
    assert.deepEqual(theme.background,[r,g,b], 'A uses the selected cover colour without a tone/chroma transform');
    assert.ok(surfaceContrast(theme.primary,theme.background,theme.opacity) >= 4.5);
    assert.ok(surfaceContrast(theme.secondary,theme.background,theme.opacity) >= 4.5);
    const material = extractPalette(pixels([[r,g,b,16]]), 4, 4);
    assert.ok(surfaceContrast(material.primary,material.background,material.opacity) >= 4.5);
    assert.ok(surfaceContrast(material.secondary,material.background,material.opacity) >= 4.5);
    assert.ok(contrast(material.accentText,material.accent) >= 4.5);
    assert.ok(material.background.every(v=>Number.isInteger(v) && v>=0 && v<=255));
  }
  assert.equal(coverUrl('https://p1.music.126.net/a.jpg'), 'https://p1.music.126.net/a.jpg');
  for (const url of ['https://localhost/a', 'file:///tmp/a', 'https://p1.music.126.net.evil.test/a', 'https://a:b@i0.hdslb.com/a', 'https://i0.hdslb.com:444/a']) assert.equal(coverUrl(url), '');
  let requests = 0, options;
  const resolve = createPaletteResolver({ request: async (url, opts) => { requests++; options = opts; return new Response(Buffer.from('image')); }, decode: () => pixels([[20, 80, 170, 12]]) });
  const url = 'https://p1.music.126.net/cover.jpg';
  const [a, b] = await Promise.all([resolve(url), resolve(url)]);
  assert.deepEqual(a, b); await resolve(url); assert.equal(requests, 1, 'concurrent and subsequent requests reuse the cover');
  assert.equal(options.redirect, 'error'); assert.equal(options.headers.Referer, 'https://music.163.com/');
  assert.equal(await resolve('https://127.0.0.1/test'), null); assert.equal(requests, 1);
  for (const request of [async () => { throw Error('timeout'); }, async () => new Response('bad', { status: 403 }), async () => new Response('x', { headers: { 'content-length': '5000000' } }), async () => new Response(Buffer.alloc(4 * 1024 * 1024 + 1))]) {
    let decoded = false;
    assert.equal(await createPaletteResolver({ request, decode: () => { decoded = true; } })(url), null);
    assert.equal(decoded, false, 'failure/oversize bodies must not reach image decoding');
  }
  assert.equal(await createPaletteResolver({ request: async () => new Response('bad image'), decode: () => null })(url), null);
  console.log('PASS: Material Wu/Score + direct colour, whole-artwork/neutral/stickers/rims/neon, paired text/control colours with opaque direct-colour contrast, 216-colour extraction and direct-colour contrast sweep, trusted URL/size/cache/fallback boundaries; no Electron');
})().catch(error => { console.error(error); process.exitCode = 1; });
