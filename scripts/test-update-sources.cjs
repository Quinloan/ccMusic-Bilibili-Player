const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
const {createAppUpdates,createUpdateFeeds}=require('../app-updates.cjs');
const feeds=createUpdateFeeds({domestic:{repository:'quinloan/ccmusic'},github:{owner:'Quinloan',repo:'ccMusic-Bilibili-Player'}});
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
async function run(){
  const directory=fs.mkdtempSync(path.join(__dirname,'../validation/update-sources-')),file=path.join(directory,'settings.json');
  let service;
  try{
    assert.equal(feeds.domestic.url,'https://cnb.cool/quinloan/ccmusic/-/git/raw/main/updates/');
    assert.equal(feeds.domestic.useMultipleRangeRequest,false);
    for(const repository of ['../repo','org/../repo','a/b?token=secret','a:b/c','https://evil.test/repo']) assert.throws(()=>createUpdateFeeds({domestic:{repository},github:{owner:'owner',repo:'repo'}}));
    fs.writeFileSync(file,JSON.stringify({autoCheck:false}));
    const updater=new EventEmitter(),checks=[],downloads=[],selected=[];
    updater.setFeedURL=feed=>selected.push(feed);
    updater.checkForUpdates=()=>{const gate=deferred();checks.push(gate);return gate.promise;};
    updater.downloadUpdate=()=>{const gate=deferred();downloads.push(gate);return gate.promise;};
    service=createAppUpdates({updater,version:'1.8.0',preferences:file,feeds});
    assert.equal(service.snapshot().source,'domestic','legacy preferences default to domestic');
    const first=service.check();await Promise.resolve();
    assert.equal(selected[0].provider,'generic');assert.equal(updater.disableDifferentialDownload,true);
    assert.throws(()=>service.setSource('github'),/完成/);
    updater.emit('update-available',{version:'1.8.1',releaseNotes:'国内说明'});checks[0].resolve();await first;
    service.setSource('github');assert.equal(service.snapshot().latest,'');assert.equal(service.snapshot().notes,'');
    await service.download();assert.equal(downloads.length,0,'an old source result cannot start a new-source download');
    const second=service.check();await Promise.resolve();assert.equal(selected[1].provider,'github');
    checks[1].reject(Error('GitHub暂时不可达'));await second;assert.equal(service.snapshot().errorStage,'check');
    service.setSource('domestic');
    const third=service.check();await Promise.resolve();
    updater.emit('update-available',{version:'1.8.1'});checks[2].resolve();await third;
    await service.download();await Promise.resolve();assert.throws(()=>service.setSource('github'),/完成/);
    downloads[0].reject(Error('下载中断'));await new Promise(setImmediate);
    service.setSource('github');updater.emit('update-downloaded',{version:'1.8.1'});updater.emit('error',Error('old transport error'));
    assert.equal(service.snapshot().status,'idle','late old-source completion/errors cannot revive discarded metadata');
    service.configure(true);service.configure(false);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)),{autoCheck:false,source:'github'});
    assert.throws(()=>service.setSource('__proto__'),/无效/);
    service.dispose();service=null;
    const reopened=createAppUpdates({updater:null,version:'1.8.0',preferences:file,feeds});
    assert.equal(reopened.snapshot().source,'github');reopened.setSource('domestic');reopened.dispose();
    assert.equal(JSON.parse(fs.readFileSync(file)).source,'domestic');
    console.log('PASS: domestic default, validated public feeds, source/auto-check persistence, GitHub selection, check/download guards, source-specific metadata reset, retry and stale-event safety; no network/Electron/installers');
  }finally{service?.dispose();if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(directory);}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
