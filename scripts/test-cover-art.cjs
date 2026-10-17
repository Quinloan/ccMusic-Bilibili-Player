const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createArtworkResolver, sameSong } = require('../cover-art.cjs');
async function run() {
  const folder = fs.mkdtempSync(path.join(__dirname, '../validation/cover-unit-')), cacheFile = path.join(folder, 'covers.json');
  try {
    let count = 0, clock = Date.now();
    const image = 'https://p1.music.126.net/album.jpg';
    const resolver = createArtworkResolver({ cacheFile, now: () => clock, interval: 0, request: async url => {
      count++; assert(String(url).endsWith('/eapi/v3/song/detail'));
      // A song without playback rights still has its album art. No audio lookup.
      return Response.json({ code: 200, songs: [{ id: 347230, al: { picUrl: image } }], privileges: [{ id: 347230, st: -200, pl: 0 }] });
    } });
    const input = { name: '海阔天空', artist: 'Beyond', neteaseId: '347230' };
    const [a, b] = await Promise.all([resolver.resolve(input), resolver.resolve(input)]);
    assert.equal(a, image); assert.equal(b, image); assert.equal(count, 1, 'coalesce concurrent album lookups');
    assert.equal(await resolver.resolve(input), image); assert.equal(count, 1);
    const reopened = createArtworkResolver({ cacheFile, now: () => clock, interval: 0, request: async () => { throw Error('persistent cache should avoid network'); } });
    assert.equal(await reopened.resolve(input), image);
    assert.equal(await resolver.resolve({ name: 'Shazam song', cover: 'https://is1-ssl.mzstatic.com/cover.jpg' }), 'https://is1-ssl.mzstatic.com/cover.jpg');
    assert.equal(count, 1, 'direct provider art needs no metadata request');
    clock += 31 * 86400000; await resolver.resolve(input); assert.equal(count, 2, 'expired artwork metadata is refreshed');
    const calls = [];
    const fallback = createArtworkResolver({ interval: 0, request: async url => {
      calls.push(String(url));
      if (String(url).includes('music.163.com')) return Response.json({ code: 200, result: { songs: [{ name: '七里香', ar: [{ name: '不相关歌手' }], al: { picUrl: image } }] } });
      return Response.json({ code: 0, req: { code: 0, data: { body: { song: { list: [
        { name: '七里香', singer: [{ name: '周杰伦' }], album: { mid: 'album12345' } },
      ] } } } } });
    } });
    assert.equal(await fallback.resolve({ name: '七里香', artist: '周杰伦' }), 'https://y.gtimg.cn/music/photo_new/T002R300x300M000album12345.jpg');
    assert.equal(calls.length, 2, 'reject another artist before QQ fallback');
    assert(!sameSong({ name: '七里香 (Live)', artist: '周杰伦' }, '七里香', '周杰倫'));
    assert(sameSong({ name: '七里香 (Live)', artist: '周杰伦' }, '七里香（Live）', '周杰倫'));
    assert(!sameSong({ name: '稻香', artist: '周杰伦' }, '稻香', '周杰伦./街道办GDC/欧阳耀莹'));
    assert(!sameSong({ name: '七里香', artist: '周杰伦' }, '七里香', '无关翻唱'));
    assert(!sameSong({ name: 'Blinding Lights', artist: 'The Weeknd' }, 'Hymn for the Weekend', 'Coldplay'));
    let failures = 0;
    const unavailable = createArtworkResolver({ interval: 0, request: async () => { failures++; throw new Error('unavailable'); } });
    assert.equal(await unavailable.resolve({ name: '无结果', artist: '未知' }), '');
    const first = failures; assert.equal(await unavailable.resolve({ name: '无结果', artist: '未知' }), ''); assert.equal(failures, first, 'negative cache prevents repeated failure storms');
    assert.equal(await unavailable.resolve({ cover: 'file:///secret.png' }), '');
    let net = 0, qq = 0;
    const throttled = createArtworkResolver({ interval: 0, request: async url => {
      if (String(url).includes('music.163.com')) { net++; return new Response('{}', { status: 429 }); }
      qq++; return Response.json({ code: 0, req: { code: 0, data: {} } });
    } });
    await throttled.resolve({ name: '一', neteaseId: 1 }); await throttled.resolve({ name: '二', neteaseId: 2 });
    assert.equal(net, 1, 'NetEase cooldown applies to detail/search and later songs'); assert.equal(qq, 4, 'each empty QQ search may try public suggestions');
    // Actual NetEase provider extraction preserves identity/art, independent of playback privileges.
    const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const context = { Buffer, Float32Array, AbortSignal, console: { log() {} }, SPLIT_RATE: 8000, UA: 'test', agent: undefined,
      identifyNextAt: 0, loadAfp: () => ({ GenerateFP: async () => 'fingerprint' }),
      ufetch: async () => Response.json({ code: 200, data: { result: [{ song: { id: 347230, name: '海阔天空', artists: [{ name: 'Beyond' }], album: { picUrl: image }, privilege: { st: -200 } } }] } }),
    };
    vm.createContext(context);
    vm.runInContext(main.slice(main.indexOf('async function identifyNetease('), main.indexOf('function ffmpegPath()')), context);
    const hit = await context.identifyNetease(Buffer.alloc(8000 * 2 * 12));
    assert.equal(hit.neteaseId, '347230'); assert.equal(hit.cover, image);
    // Actual Shazam wrapper retains artwork while keeping its existing recognition gate.
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../shazam-provider.cjs'), 'utf8'), { module, Buffer, AbortSignal,
      require: name => { assert.equal(name, 'shazamio-api'); return { Shazam: class { async recognize() { return { matches: [{}], track: { title: 'Test', images: { coverart: image } } }; } } }; },
    });
    assert.equal((await module.exports.identifyShazam(Buffer.alloc(16))).cover, image);
    console.log('PASS: provider art/ID, no-rights metadata, direct art, dedup, persistent/expired cache, conservative matching, QQ fallback, fail-soft/negative cache and provider cooldown');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
