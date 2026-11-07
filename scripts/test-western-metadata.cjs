// Screenshot regression: collection decorations, Explicit advisory, guest credits.
const assert=require('node:assert/strict');
const {songTitleIntent}=require('../renderer/library-model.js');
const {createArtworkResolver,sameSong}=require('../cover-art.cjs');
const parentTitle='【The Weeknd合集|Hi-Res】“如果你也喜欢The Weeknd”';
const song=(name,artist,id,album='Starboy')=>({id,name,ar:artist.split('/').map(name=>({name})),al:{name:album,picUrl:`https://art.test/${id}.jpg`}});
const catalog=[song('Reminder (Remix)','The Weeknd/A$AP Rocky',10),song('Reminder','The Weeknd',1),
  song('I Feel It Coming','J.Fla',11),song('I Feel It Coming (Live)','The Weeknd',12),song('I Feel It Coming','The Weeknd/Daft Punk',2),
  song('The Hills','The Weeknd',3,'Beauty Behind The Madness')];
async function run(){
  for(const title of ['Reminder (Explicit)','I Feel It Coming','The Hills (Explicit)']){
    const intent=songTitleIntent({title,parentTitle});
    assert.equal(intent.parentArtist,'The Weeknd');assert.equal(intent.artistFromParent,true);assert.equal(intent.metadataVersion,5);
    assert(!intent.query.includes('Explicit'));assert(intent.query.endsWith('The Weeknd'));
  }
  assert.equal(songTitleIntent({title:'Reminder',parentTitle:'周杰伦 | 陶喆 合集'}).parentArtist,'','internal separators must not invent a single artist');
  assert(sameSong({name:'Reminder (Explicit)',artist:'The Weeknd'},'Reminder','The Weeknd'));
  for(const name of ['Reminder (Remix)','Reminder (Live)','Reminder (Clean)','Reminder (Instrumental)']) assert(!sameSong({name:'Reminder (Explicit)',artist:'The Weeknd'},name,'The Weeknd'));
  let calls=0;
  const resolver=createArtworkResolver({interval:0,request:async()=>{calls++;return Response.json({code:200,result:{songs:catalog}});}});
  const names=['Reminder (Explicit)','I Feel It Coming','The Hills (Explicit)'];
  for(let i=0;i<names.length;i++){
    const result=await resolver.resolveTitle({title:names[i],parentTitle});
    assert.equal(result.matched,true);assert.equal(result.neteaseId,String(i+1));assert.equal(result.cover,`https://art.test/${i+1}.jpg`);
    assert.equal(result.artist,i===1?'The Weeknd/Daft Punk':'The Weeknd');
  }
  assert.equal(calls,3,'each screenshot case resolves with one catalog request');
  assert.equal(await resolver.resolve({name:'I Feel It Coming',artist:'The Weeknd'}),'','explicit artist identity still rejects different credit sets');
  assert.equal(await resolver.resolve({name:'Reminder (Explicit)',artist:'The Weeknd'}),'https://art.test/1.jpg','cover-only lookup accepts the advisory spelling too');
  const solo=createArtworkResolver({interval:0,request:async()=>Response.json({code:200,result:{songs:[song('I Feel It Coming','The Weeknd/Guest',6),song('I Feel It Coming','The Weeknd',7)]}})});
  assert.equal((await solo.resolveTitle({title:'I Feel It Coming',parentTitle})).neteaseId,'7','exact complete artist match outranks parent-only collaboration evidence');
  const ambiguous=createArtworkResolver({interval:0,request:async()=>Response.json({code:200,result:{songs:[song('I Feel It Coming','The Weeknd/Guest A',6),song('I Feel It Coming','The Weeknd/Guest B',7)]}})});
  assert.equal((await ambiguous.resolveTitle({title:'I Feel It Coming',parentTitle})).matched,false,'conflicting collaboration credits stay unresolved');
  const clean=createArtworkResolver({interval:0,request:async()=>Response.json({code:200,result:{songs:[song('Reminder','The Weeknd',8,'Starboy (Clean)'),song('Reminder','The Weeknd',1)]}})});
  assert.equal((await clean.resolveTitle({title:'Reminder (Explicit)',parentTitle})).neteaseId,'1','Explicit must not select a clean edit');
  console.log('PASS: screenshot songs/artist/art, decoration migration v5, Explicit advisory search/matching, contextual guest credits, exact/ambiguous artist safety, clean/live/remix preservation; no network/audio/Electron');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
