// Expanded player with real DOM/canvas and deterministic silent IPC/audio mocks.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname,'..');
function silentGraph() {
  window.testAudioReadyState=4; window.spectrumReads=0; window.lyricRequests=[]; window.desktopLines=[];
  window.hiddenFixture=false;
  Object.defineProperty(document,'hidden',{get:()=>window.hiddenFixture});
  class Param { constructor(){this.value=1;} cancelScheduledValues(){} cancelAndHoldAtTime(){} setValueAtTime(v){this.value=v;} setTargetAtTime(v){this.value=v;} }
  class Node {
    constructor(){this.connections=new Set();this.fftSize=2048;for(const key of ['gain','frequency','Q','threshold','knee','ratio','attack','release'])this[key]=new Param();}
    get frequencyBinCount(){return this.fftSize/2;}
    connect(node){this.connections.add(node);return node;}
    disconnect(node){if(node)this.connections.delete(node);else this.connections.clear();}
    getFloatTimeDomainData(data){data.fill(.1);}
    getByteFrequencyData(data){window.spectrumReads++;for(let i=0;i<data.length;i++)data[i]=(i*17)%170+30;}
  }
  window.AudioContext=class {
    constructor(){this.state='running';this.sampleRate=48000;this.destination=new Node();}
    get currentTime(){return performance.now()/1000;}
    createMediaElementSource(){return new Node();} createGain(){return new Node();} createIIRFilter(){return new Node();}
    createChannelSplitter(){return new Node();} createAnalyser(){return new Node();} createWaveShaper(){return new Node();}
    async resume(){this.state='running';}
  };
  api.songLyrics=input=>new Promise(resolve=>lyricRequests.push({input,resolve}));
  api.localAudio=async()=>({url:'file:///test-track.mp3',local:true,codecs:'MP3'});
  api.toggleDesktopLyrics=async enabled=>({enabled});
  api.setDesktopLyricsLine=async line=>{desktopLines.push(line);};
  api.winMini=async mini=>({mini,layout:'compact',pinned:true,revision:(window.nativeRevision=(window.nativeRevision||0)+1)});
}
(async()=>{
  const {chromium}=require(process.env.CCMUSIC_PLAYWRIGHT||'playwright');
  const browser=await chromium.launch({executablePath:process.env.CCMUSIC_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:820}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{
      const name=new URL(route.request().url()).pathname;
      if(!/^\/renderer\/[a-z.-]+\.(?:js|css|html)$/.test(name)&&name!=='/assets/icon.png')return route.abort();
      const file=path.join(root,name);return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/javascript; charset=utf-8'});
    });
    await page.addInitScript(mockBridge);await page.addInitScript(silentGraph);
    await page.goto('http://now.test/renderer/index.html');await page.locator('#folders .folder').first().waitFor();
    await page.locator('#bCover').click();assert(await page.locator('#nowPlaying').isHidden());
    await page.evaluate(async()=>{
      const cover='data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="#25465e"/><circle cx="250" cy="210" r="130" fill="#b1885c"/><circle cx="250" cy="210" r="85" fill="#163044"/><text x="250" y="417" text-anchor="middle" fill="#eadcc8" font-size="46" font-family="sans-serif">CC MUSIC</text></svg>');
      const first={bvid:'BV0000000001',cid:1,page:1,title:'第一首测试歌曲',artist:'测试歌手',split:true,startSec:120,endSec:400,duration:280,cover,identifySource:'manual'};
      const next={bvid:'BV0000000002',cid:2,page:1,title:'第二首测试歌曲',artist:'另一位歌手',duration:200,cover,identifySource:'manual'};
      loadQueue([first,next],0);await playQueueAt(0);audio.onseeked();audio.currentTime=45;audio.dispatchEvent(new Event('timeupdate'));
      window.originalNowAudio=audio;window.originalNowSequence=playback.sequence;window.originalNowSource=audio.src;window.originalSourceConnections=srcNode.connections.size;
    });
    await page.locator('#bCover').click();await page.locator('#nowPlaying').waitFor();
    assert(await page.evaluate(()=>audio===originalNowAudio&&playback.sequence===originalNowSequence&&audio.src===originalNowSource&&audio.currentTime===45));
    assert.equal(await page.evaluate(()=>lyricRequests.length),1);
    await page.locator('#desktopLyricsButton').click();assert.equal(await page.evaluate(()=>lyricRequests.length),1,'desktop and expanded lyrics share one lookup');
    await page.evaluate(()=>lyricRequests[0].resolve({lyric:'[00:00.00]第一句测试歌词\n[00:10.00]第二句测试歌词\n[00:20.00]第三句测试歌词\n[00:40.00]正在播放的第四句\n[01:00.00]第五句测试歌词',source:'测试歌词源'}));
    await page.waitForFunction(()=>document.querySelector('#nowLyrics .current')?.textContent==='正在播放的第四句');
    assert.equal(await page.evaluate(()=>desktopLines.at(-1).current),'正在播放的第四句');
    await page.locator('#nowOptions').click();
    await page.locator('#nowShowSpectrum').check();
    await page.locator('#nowOptions').click();
    await page.waitForFunction(()=>spectrumReads>1);
    await page.screenshot({path:path.join(root,'validation/ui-now-playing-lyrics.png')});
    await page.locator('#nowLike').click();assert.equal(await page.locator('#likeButton').getAttribute('aria-pressed'),'true');
    await page.locator('#nowOptions').click();
    assert.equal(await page.locator('.now-header').evaluate(el=>getComputedStyle(el).webkitAppRegion),'drag');
    assert(await page.locator('#nowSettings, #nowSettings *').evaluateAll(elements=>elements.every(el=>getComputedStyle(el).webkitAppRegion==='no-drag')),'entire popup must be excluded from Electron native dragging');
    await page.locator('#nowShowLyrics').locator('xpath=ancestor::label').click({position:{x:40,y:20}});
    assert(await page.locator('#nowLyricsPane').isHidden(),'label text also toggles lyrics');
    await page.locator('#nowShowLyrics').check();
    assert(await page.locator('#nowSettings').evaluate(el=>{const b=el.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth;}));
    await page.screenshot({path:path.join(root,'validation/ui-now-playing-settings.png')});
    await page.locator('#nowShowSpectrum').uncheck();const reads=await page.evaluate(()=>spectrumReads);
    await page.waitForTimeout(120);assert.equal(await page.evaluate(()=>spectrumReads),reads);assert.equal(await page.evaluate(()=>nowSpectrumFrame),null);
    await page.locator('#nowShowLyrics').uncheck();assert(await page.locator('#nowLyricsPane').isHidden());
    await page.locator('#nowShowCover').uncheck();assert(await page.locator('#nowTextOnly').isVisible());
    await page.locator('#nowShowBlur').uncheck();assert.equal(await page.locator('#nowBackdrop').evaluate(el=>getComputedStyle(el).display),'none');
    await page.locator('#nowShowCover').check();await page.locator('#nowShowBlur').check();
    await page.locator('#nowLyricsColor').fill('#fff2cc');await page.locator('#nowSpectrumColor').fill('#ffaa55');
    await page.locator('#nowFontSize').fill('34');
    await page.locator('#nowHeading').click();assert(await page.locator('#nowSettings').isHidden());
    await page.screenshot({path:path.join(root,'validation/ui-now-playing-cover.png')});
    await page.locator('#nowOptions').click();await page.locator('#nowShowLyrics').check();await page.locator('#nowShowSpectrum').check();
    await page.locator('#nowHeading').click();
    await page.locator('#nowLyrics [data-line="1"]').click();assert(Math.abs(await page.evaluate(()=>playbackTime())-130.01)<.02);
    await page.locator('#nowOptions').click();await page.locator('#nowOffsetPlus').click();
    assert.equal(await page.evaluate(()=>lyricsOffset),.5);assert((await page.locator('#nowOffsetLabel').textContent()).includes('0.5'));
    await page.keyboard.press('Escape');assert(await page.locator('#nowSettings').isHidden());assert(await page.locator('#nowPlaying').isVisible());
    await page.locator('#play').click();assert.equal(await page.evaluate(()=>nowSpectrumFrame),null,'pause stops animation');
    await page.locator('#play').click();await page.waitForFunction(()=>nowSpectrumFrame!==null);
    await page.evaluate(()=>{hiddenFixture=true;document.dispatchEvent(new Event('visibilitychange'));});assert.equal(await page.evaluate(()=>nowSpectrumFrame),null);
    await page.evaluate(()=>{hiddenFixture=false;document.dispatchEvent(new Event('visibilitychange'));});await page.waitForFunction(()=>nowSpectrumFrame!==null);
    // An old request completing after the next song must not overwrite its lyrics.
    await page.evaluate(()=>{void loadSongLyrics(true);});await page.locator('#next').click();
    await page.waitForFunction(()=>lyricRequests.length===3);
    await page.evaluate(()=>lyricRequests[2].resolve({lyric:'[00:00]下一首的新歌词',source:'新来源'}));
    await page.waitForFunction(()=>document.querySelector('#nowLyrics .current')?.textContent==='下一首的新歌词');
    await page.evaluate(()=>lyricRequests[1].resolve({lyric:'[00:00]迟到的旧歌词'}));
    assert.equal(await page.locator('#nowLyrics .current').textContent(),'下一首的新歌词');
    assert.equal(await page.locator('#nowTitle').textContent(),'第二首测试歌曲');
    await page.setViewportSize({width:900,height:600});
    const bounds=await page.evaluate(()=>['#nowCollapse','#nowOptions','#nowMini','#nowClose','#nowCover','#nowLyricsPane','#seek','#play','#volumeButton'].map(id=>{const b=document.querySelector(id).getBoundingClientRect();return{id,left:b.left,right:b.right,top:b.top,bottom:b.bottom};}));
    assert(bounds.every(b=>b.left>=0&&b.right<=900&&b.top>=0&&b.bottom<=600),JSON.stringify(bounds));
    await page.screenshot({path:path.join(root,'validation/ui-now-playing-small.png')});
    await page.locator('#qBtn').click();assert(await page.locator('#queuePanel').isVisible());await page.locator('#qClose').click();
    const beforeClose=await page.evaluate(()=>({sequence:playback.sequence,time:audio.currentTime,source:audio.src}));
    await page.locator('#nowCollapse').click();assert(await page.locator('#nowPlaying').isHidden());
    assert.deepEqual(await page.evaluate(()=>({sequence:playback.sequence,time:audio.currentTime,source:audio.src})),beforeClose);
    assert.equal(await page.evaluate(()=>srcNode.connections.size),await page.evaluate(()=>originalSourceConnections),'all spectrum taps disconnected');
    await page.locator('#bCover').click();await page.locator('#nowMini').click();await page.waitForFunction(()=>miniModeState.mini);
    assert(await page.locator('#nowPlaying').isHidden());await page.locator('#miniRestore').click();await page.waitForFunction(()=>!miniModeState.mini);
    await page.reload();await page.locator('#folders .folder').first().waitFor();
    assert.equal(await page.evaluate(()=>nowPreferences.fontSize),34);assert.equal(await page.evaluate(()=>nowPreferences.spectrumColor),'#ffaa55');
    assert(await page.locator('#nowPlaying').isHidden(),'startup never opens immersive playback automatically');
    assert.deepEqual(errors,[]);
    console.log('PASS shared player/source/clock, lyrics timing/seek/offset and stale-request isolation, shared desktop lookup, six persistent visual options, real spectrum tap/lifecycle, 900px layout, queue, mini transition and restart');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
