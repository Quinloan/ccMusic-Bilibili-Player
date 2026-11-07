// Existing saved tracks -> actual resolver -> actual renderer, without Electron/audio.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {mockBridge}=require('./test-ui.cjs');
const {createArtworkResolver}=require('../cover-art.cjs');
const root=path.resolve(__dirname,'..');
async function run(){
  const inputs=[];
  const songs=[['Reminder','The Weeknd'],['I Feel It Coming','The Weeknd/Daft Punk'],['The Hills','The Weeknd']]
    .map(([name,artist],i)=>({id:i+1,name,ar:artist.split('/').map(name=>({name})),al:{name:'Studio album',picUrl:`https://art.test/${i+1}.png`}}));
  const resolver=createArtworkResolver({interval:0,request:async()=>Response.json({code:200,result:{songs}})});
  const {chromium}=require(process.env.CCMUSIC_PLAYWRIGHT||'playwright');
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:820},serviceWorkers:'block'}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.host==='art.test')return route.fulfill({body:fs.readFileSync(path.join(root,'assets/icon.png')),contentType:'image/png'});
      if(!/^\/renderer\/[a-z.-]+\.(?:js|css|html)$/.test(url.pathname)&&url.pathname!=='/assets/icon.png')return route.abort();
      const file=path.join(root,url.pathname);if(!fs.existsSync(file))return route.abort();
      return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/javascript; charset=utf-8'});
    });
    await page.exposeFunction('westernMetadata',input=>{inputs.push(input);return resolver.resolveTitle(input);});
    await page.addInitScript(mockBridge);
    await page.addInitScript(()=>{api.resolveSongTitle=input=>westernMetadata(input);});
    await page.goto('http://ccmusic.test/renderer/index.html');await page.locator('#folders .folder').first().waitFor();
    await page.evaluate(()=>{
      S.active=S.folders[0].id;showView('library');
      const parent='【The Weeknd合集|Hi-Res】“如果你也喜欢The Weeknd”';
      folder().items=['Reminder (Explicit)','I Feel It Coming','The Hills (Explicit)'].map((title,i)=>({
        bvid:'BV1MsQdBNExh',cid:101,page:1,title,sourceTitle:title,vtitle:parent,artist:'',identifySource:'description',titleMetaVersion:2,
        split:true,splitBatch:'old-western-batch',startSec:i*240,endSec:(i+1)*240,duration:240,cover:'/assets/icon.png',
      }));
      folder().items.push({bvid:'BV1MsQdBNExh',cid:101,page:1,title:'我修改的歌名',artist:'我的表演者',identifySource:'manual',
        split:true,splitBatch:'old-western-batch',startSec:720,endSec:960,duration:240,cover:'/assets/icon.png',songCover:'https://art.test/manual.png'});
      loadQueue(folder().items,1);playback.current={item:S.queue[1],idx:1};audio.currentTime=300;
      save();renderFolders();renderList();renderQueue();
    });
    await page.waitForFunction(()=>folder().items.slice(0,3).every(item=>item.titleMetaVersion===5&&item.songCover&&item.artist));
    assert.equal(inputs.length,3,'one metadata lookup per saved title, despite library/queue copies');
    assert.deepEqual(await page.evaluate(()=>folder().items.slice(0,3).map(item=>[item.title,item.artist,item.songCover])),[
      ['Reminder','The Weeknd','https://art.test/1.png'],['I Feel It Coming','The Weeknd/Daft Punk','https://art.test/2.png'],['The Hills','The Weeknd','https://art.test/3.png'],
    ]);
    assert.equal(await page.evaluate(()=>S.queue.slice(0,3).every(item=>item.titleMetaVersion===5&&item.songCover)),true);
    assert.equal(await page.locator('#bCover').getAttribute('src'),'https://art.test/2.png');
    assert.equal(await page.locator('#bUp').textContent(),'The Weeknd/Daft Punk');
    assert.equal(await page.evaluate(()=>audio.currentTime),300,'metadata repair must not seek or reload audio');
    assert.equal(await page.evaluate(()=>window.testRecognitionRequests.length+window.testSplitCalls),0,'known source titles need no fingerprints or splitting');
    assert.deepEqual(await page.evaluate(()=>folder().items.map(item=>[item.startSec,item.endSec])),[[0,240],[240,480],[480,720],[720,960]]);
    assert.equal(await page.locator('#list .group img').getAttribute('src'),'/assets/icon.png','collection image stays the video image');
    const imported=await page.evaluate(()=>LibraryModel.importedFolders({folders:[{name:'test',items:folder().items}]})[0].items);
    assert.equal(imported[0].titleMetaVersion,5);assert.equal(imported[3].title,'我修改的歌名');
    assert.equal(await page.evaluate(()=>folder().items[3].songCover),'https://art.test/manual.png');
    await page.evaluate(()=>save());await page.reload();await page.locator('#folders .folder').first().click();
    await page.waitForTimeout(100);
    assert.equal(inputs.length,3,'completed v5 repairs persist, no repeated work after restart');
    assert.equal(await page.evaluate(()=>folder().items[1].artist),'The Weeknd/Daft Punk');
    assert.deepEqual(errors,[]);
    console.log('PASS: legacy v2 timeline tracks repair automatically to v5 with real resolver, artwork/credits library/queue/player sync, no fingerprint/seek/resplit, manual edits/group art retained, import and restart; offline catalog and silent media');
  }finally{await browser.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
