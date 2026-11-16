// Actual renderer with simulated IPC; a separate muted page verifies local file decoding.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { mockBridge } = require('./test-ui.cjs');
const { createLocalAudioStore } = require('../local-audio.cjs');
const { parseLrc } = require('../renderer/lyrics-model.js');
const root = path.resolve(__dirname, '..');
async function run() {
  assert.deepEqual(parseLrc('[offset:500]\n[00:01.00][00:03.00]测试'), [{time:0.5,text:'测试'},{time:2.5,text:'测试'}]);
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const dir = fs.mkdtempSync(path.join(root,'validation/listening-'));
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const name = new URL(route.request().url()).pathname;
      if (!/^\/renderer\/[a-z.-]+\.(?:js|css|html)$/.test(name) && name !== '/assets/icon.png') return route.abort();
      const file = path.join(root,name);
      return route.fulfill({ body:fs.readFileSync(file),contentType:file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge);
    await page.addInitScript(() => {
      window.api.onDesktopLyricsOffset = callback => { window.emitLyricsOffset = callback; };
      window.api.getImportDraft = async () => JSON.parse(localStorage.importDraft || 'null');
      window.api.saveImportDraft = async draft => { localStorage.importDraft = JSON.stringify(draft); return true; };
      window.api.readSharedPlaylist = async () => ({ name:'恢复测试',tracks:[0,1,2].map(i=>({title:'曲目'+i,artist:'歌手'})) });
      window.api.searchPlaylistTrack = async query => {
        const i=Number(query.match(/\d+/)[0]);
        if (i === 1 && !localStorage.heldImport) { localStorage.heldImport='1'; await new Promise(()=>{}); }
        return [{bvid:'BV'+String(i).padStart(10,'0'),title:query,duration:200}];
      };
      window.api.video = async bvid => ({bvid,cid:Number(bvid.slice(2))+1,title:'曲目'+Number(bvid.slice(2))+' 歌手',duration:200});
    });
    await page.goto('http://listening.test/renderer/index.html');
    await page.locator('#folders .folder').first().waitFor();
    await page.locator('#libImport').click(); await page.getByText('导入歌单…', { exact: true }).click(); await page.locator('#playlistSource').fill('https://music.163.com/playlist?id=1');
    await page.locator('#playlistAction').click();
    await page.waitForFunction(()=>JSON.parse(localStorage.importDraft || 'null')?.jobs?.[0]?.index===1);
    await page.reload();
    await page.waitForFunction(()=>playlistImportJob?.paused && playlistImportJob.index===1);
    assert.equal(await page.evaluate(()=>playlistImportJob.index),1);
    assert.equal(await page.evaluate(()=>playlistImportJob.items.length),1);
    await page.locator('#libImport').click(); await page.getByText('导入歌单…', { exact: true }).click(); await page.locator('#playlistResume').click();
    await page.waitForFunction(()=>playlistImportJob?.index===3 && !playlistImportJob.running);
    await page.locator('#libImport').click(); await page.getByText('导入歌单…', { exact: true }).click(); await page.locator('#playlistAction').click();
    assert.equal(await page.evaluate(()=>folder().items.length),3);
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.importDraft).jobs),[]);
    await page.evaluate(()=>{
      window.desktopLines=[];
      window.api.toggleDesktopLyrics=async enabled=>({enabled});
      window.api.setDesktopLyricsLine=async line=>{ desktopLines.push(line); };
    });

    await page.evaluate(async()=>{
      window.api.localAudio=async()=>({url:'file:///silent.mp3',local:true,codecs:'MP3'});
      window.api.playurl=async()=>{ throw new Error('offline playback must not request network audio'); };
      window.api.songLyrics=async()=>({lyric:'[00:00.00]开头\n[00:10.00]第二行\n[00:20.00]第三行',translation:'',source:'模拟曲库'});
      await playTrack({bvid:'BV0000000001',cid:1,title:'测试歌曲',artist:'歌手',split:true,startSec:120,endSec:180});
      audio.currentTime=15; audio.onseeked(); audio.dispatchEvent(new Event('timeupdate'));
    });
    assert.equal(await page.evaluate(()=>playbackTime()),135);
    await page.locator('#desktopLyricsButton').click();
    await page.waitForFunction(()=>desktopLines.some(line=>line.current==='第二行'));
    assert.equal(await page.locator('#lyricsDialog').count(),0);
    await page.locator('#bTitle').click();
    assert.equal(await page.locator('dialog[open]').count(),0);
    await page.evaluate(()=>{audio.currentTime=10.2;emitLyricsOffset(.5);});
    assert.equal(await page.evaluate(()=>desktopLines.at(-1).current),'开头');
    assert.equal(await page.evaluate(()=>desktopLines.at(-1).offset),.5);
    await page.evaluate(()=>emitLyricsOffset(-.5));
    assert.equal(await page.evaluate(()=>desktopLines.at(-1).current),'第二行');
    await page.evaluate(async()=>{
      audio.currentTime=0;
      await playTrack({bvid:'BV0000000002',cid:2,title:'下一首',artist:'歌手',duration:200});
      await new Promise(resolve=>setTimeout(resolve,20));
    });
    assert.equal(await page.evaluate(()=>desktopLines.at(-1).current),'开头');
    await page.locator('#desktopLyricsButton').click();
    assert.equal(await page.locator('#desktopLyricsButton').getAttribute('aria-pressed'),'false');
    assert.deepEqual(errors,[]);

    const wav=Buffer.alloc(44+16000);
    wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
    wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);
    const media=path.join(dir,'silent.wav'),html=path.join(dir,'index.html'),index=path.join(dir,'local.json');
    fs.writeFileSync(media,wav);fs.writeFileSync(html,'<audio id="a"></audio>');
    const item={bvid:'BV0000000001',page:1,split:true,startSec:120,endSec:180};
    createLocalAudioStore(index).remember(item,media);
    const local=await createLocalAudioStore(index).find(item); assert.ok(local.url.startsWith('file:///'));
    const native=await browser.newPage();await native.goto(pathToFileURL(html).href);
    const duration=await native.evaluate(async url=>{
      const a=document.querySelector('audio'); a.volume=0;a.src=url;await a.play();a.pause();return a.duration;
    },local.url);
    assert.equal(duration,1);
    fs.unlinkSync(media);assert.equal(await createLocalAudioStore(index).find(item),null);
    console.log('PASS persisted import resume without duplicates, desktop lyrics timing/offset, split local clock, no network audio, persisted file index, muted Chromium file decoding and deleted file fallback');
  } finally {
    await browser.close();
    // Only individual temporary files created above, inside the verified test directory.
    for(const entry of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir,entry));
    fs.rmdirSync(dir);
  }
}
run().catch(e=>{console.error(e);process.exitCode=1});
