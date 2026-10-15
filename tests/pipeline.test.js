import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {getSlot} from '../src/schedule.js';
import {dedupe,locked,storyId} from '../src/log.js';
import {script,validateScript} from '../src/script.js';
import {candidate,mockScript,mockImages} from '../src/mock.js';
import {compose} from '../src/compose.js';
import {publish,waitFinished,graph} from '../src/publish.js';
import {verifyURLs} from '../src/host.js';
import {request} from '../src/util.js';
import {collectInsights} from '../src/insights.js';
import {fetchCandidates} from '../src/sources/index.js';
import {select} from '../src/select.js';
import {intensityScore,selectByIntensity} from '../src/intensity.js';
const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url)));
config.llm.provider='openai';config.llm.responseFormat='json_schema';config.image.provider='openai';
test('slots run across all categories and omitted times rotate daily',()=>{
 const skipped=new Set();for(let d=1;d<=56;d++){let count=0;for(let h=config.schedule.startHour;h<=config.schedule.endHour;h+=config.schedule.intervalHours){const now=new Date(Date.UTC(2026,0,d,h-6,30));const slot=getSlot(config,now);if(slot){count++;assert.equal(slot.category,'All categories');}else skipped.add(h);}assert.equal(count,config.schedule.dailyPosts);}assert.ok(skipped.size>1);
 assert.equal(getSlot(config,new Date('2026-01-01T18:00:00Z')),null);
});
test('canonical URLs, similar titles and 30-day expiry',()=>{
 const now=new Date('2026-10-13');const used=[{...candidate,url:candidate.url+'?utm_source=x',timestamp:now.toISOString()}];assert.equal(dedupe([candidate],used,config,now).length,0);
 assert.equal(dedupe([{...candidate,url:'https://example.com/new',title:candidate.title+' today'}],used,config,now).length,0);
 used[0].timestamp='2026-01-01';assert.equal(dedupe([candidate],used,config,now).length,1);
});
test('uncertain locks survive both reruns and future slots',()=>{const logs={posts:[{slot:'old',story_id:storyId(candidate),status:'uncertain'}]};assert.ok(locked(logs,{id:'old'}));assert.ok(locked(logs,{id:'new'},candidate));});
test('schema, word limits, unsupported numbers and one correction',async()=>{
 const s=mockScript('Space');assert.equal(validateScript(s,candidate,'Space'),s);
 assert.throws(()=>validateScript({...s,extra:true},candidate,'Space'));
 const bad=structuredClone(s);bad.slides[0].body='There are 999 planets.';assert.throws(()=>validateScript(bad,candidate,'Space'),/numeric/);
 let calls=0;await script(candidate,'Space',config,async()=>++calls===1?bad:s);assert.equal(calls,2);
 calls=0;await assert.rejects(script(candidate,'Space',config,async()=>{calls++;return bad;}));assert.equal(calls,2);
});
test('compositing produces one real 1080x1350 JPEGs',async()=>{const dir=await mkdtemp(join(tmpdir(),'carousel-test-'));try{const s=mockScript('Space');const files=await compose(await mockImages(s),s,config,dir);assert.equal(files.length,1);for(const file of files){const m=await sharp(file).metadata();assert.equal(m.format,'jpeg');assert.equal(m.width,1080);assert.equal(m.height,1350);}}finally{await rm(dir,{recursive:true,force:true});}});
test('single image, durable intent and quota check before publish',async()=>{const events=[];let n=0;const api=async(path,params,method)=>{events.push(path);if(path.endsWith('content_publishing_limit'))return {data:[{quota_usage:0,config:{quota_total:100}}]};if(path.endsWith('media_publish'))return {id:'published'};if(method==='POST'){assert.equal(params.image_url,'https://x/1.jpg');assert.equal(params.media_type,undefined);assert.equal(params.is_carousel_item,undefined);assert.ok(params.caption);return {id:String(++n)};}return {status_code:'FINISHED'};};const id=await publish(['https://x/1.jpg'],mockScript('Space'),api,{user:'ig',persist:async p=>events.push(p.publish_requested_at?'intent':'state')});assert.equal(id,'published');assert.equal(events.at(-2),'intent');assert.equal(events.at(-1),'ig/media_publish');assert.equal(events.filter(e=>e==='ig/content_publishing_limit').length,2);});
test('quota exhaustion and ERROR prevent publication',async()=>{await assert.rejects(publish(['https://x/1.jpg'],{},async()=>({data:[{quota_usage:100,config:{quota_total:100}}]}),{user:'ig'}),/limit/);await assert.rejects(waitFinished('c',async()=>({status_code:'ERROR'})),/ERROR/);let now=0;await assert.rejects(waitFinished('c',async()=>({status_code:'IN_PROGRESS'}),{now:()=>now,wait:async()=>{now+=5000;},timeout:10000}),/timed out/);});
test('Graph mutations are never automatically retried',async()=>{let attempts;await graph(config,'fake',async(u,o,retry)=>{attempts=retry.attempts;return {id:'x'};})('ig/media_publish',{},'POST');assert.equal(attempts,1);});
test('image URL must return HTTP 200 and JPEG content',async()=>{await assert.rejects(verifyURLs(['https://x/a'],{attempts:1,wait:async()=>{},fetchImpl:async()=>new Response('html',{status:200,headers:{'Content-Type':'text/html'}})}));await verifyURLs(['https://x/a'],{fetchImpl:async()=>new Response('jpeg',{headers:{'Content-Type':'image/jpeg'}})});});
test('transient requests retry; auth errors do not',async()=>{let n=0;await request('https://x',{},{wait:async()=>{},fetchImpl:async()=>++n===1?new Response('',{status:503}):Response.json({ok:true})});assert.equal(n,2);n=0;await assert.rejects(request('https://x',{},{wait:async()=>{},fetchImpl:async()=>{n++;return new Response('',{status:401});}}));assert.equal(n,1);});
test('insights only sample published posts aged 24 to 48h',async()=>{const now=new Date('2026-10-13T12:00Z');const posts=[25,10,49].map((h,i)=>({timestamp:new Date(now-h*3600000).toISOString(),status:'published',ig_media_id:String(i)}));let calls=0;const errors=await collectInsights(posts,async()=>{calls++;return {data:['reach','saved','shares','likes','comments'].map(name=>({name,values:[{value:5}]}))};},now);assert.equal(calls,1);assert.equal(posts[0].insights.saves,5);assert.equal(errors.length,0);});
test('Guardian source uses article text and never publisher images',async()=>{const old=process.env.GUARDIAN_KEY;process.env.GUARDIAN_KEY='test';try{const cfg=structuredClone(config);cfg.sources.Space.providers=['guardian'];const {candidates}=await fetchCandidates('Space',cfg,{now:new Date('2026-10-13'),get:async()=>({response:{results:[{webTitle:candidate.title,webUrl:candidate.url,webPublicationDate:'2026-10-12',fields:{bodyText:candidate.text}}]}})});assert.equal(candidates[0].text,candidate.text);assert.equal(candidates[0].image,undefined);}finally{if(old===undefined)delete process.env.GUARDIAN_KEY;else process.env.GUARDIAN_KEY=old;}});
test('ranking rejects missing or duplicate scores',async()=>{await assert.rejects(select([candidate,candidate],config,async()=>({scores:[{index:0,visual:8,surprise:8,shareability:8},{index:0,visual:9,surprise:9,shareability:9}]})));});
test('intensity favors fresh independently corroborated urgent news',()=>{
 const now=new Date('2026-10-15T12:00:00Z');
 const routine={...candidate,title:'Museum announces a new autumn exhibition',url:'https://example.com/culture',source:'Source A',published:'2026-10-15T11:30:00Z',category:'Cinemas'};
 const urgent={...candidate,title:'Major earthquake prompts nationwide emergency response',url:'https://example.com/quake-a',source:'Source A',published:'2026-10-15T11:00:00Z',category:'World'};
 const corroborating={...urgent,url:'https://second.example/quake',source:'Source B',title:'Major earthquake prompts nationwide emergency response today'};
 const urgentScore=intensityScore(urgent,[routine,urgent,corroborating],config,now);
 assert.equal(urgentScore.independentSources,2);
 assert.ok(urgentScore.score>intensityScore(routine,[routine,urgent,corroborating],config,now).score);
 assert.equal(selectByIntensity([routine,urgent],[routine,urgent,corroborating],config,now).url,urgent.url);
});
test('offline end-to-end dry run is repeatable and never creates public or live state',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {writeFile,readdir}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'carousel-e2e-'));try{await writeFile(join(dir,'config.json'),JSON.stringify(config));for(let i=0;i<2;i++)await promisify(execFile)(process.execPath,[new URL('../src/main.js',import.meta.url).pathname],{cwd:dir,env:{...process.env,DRY_RUN:'true',MOCK_APIS:'true'}});const result=JSON.parse(await readFile(join(dir,'output/result.json')));assert.equal(result.status,'dry_run');assert.equal(result.paths.length,1);assert.deepEqual((await readdir(dir)).sort(),['config.json','output']);}finally{await rm(dir,{recursive:true,force:true});}
});
test('token refresh persists secret before metadata and reuses fresh token next run',async()=>{
 const {token}=await import('../src/token.js');const {createHash}=await import('node:crypto');const dir=await mkdtemp(join(tmpdir(),'carousel-token-'));const original={DRY_RUN:process.env.DRY_RUN,IG_ACCESS_TOKEN:process.env.IG_ACCESS_TOKEN,GH_SECRETS_TOKEN:process.env.GH_SECRETS_TOKEN};process.env.DRY_RUN='false';process.env.IG_ACCESS_TOKEN='old-test-token';process.env.GH_SECRETS_TOKEN='fake';const metadataPath=join(dir,'token.json');let saved,calls=0;const events=[];
 try{const now=new Date('2026-10-13');const result=await token(config,{now,metadataPath,notify:async x=>events.push(x),get:async url=>{calls++;assert.equal(new URL(url).pathname,'/refresh_access_token');return {access_token:'new-test-token',expires_in:60*86400};},save:async t=>{saved=t;}});assert.equal(result,saved);const meta=JSON.parse(await readFile(metadataPath));assert.equal(meta.fingerprint,createHash('sha256').update(saved).digest('hex'));assert.ok(!JSON.stringify(meta).includes(saved));process.env.IG_ACCESS_TOKEN=saved;await token(config,{now:new Date(+now+86400000),metadataPath,get:async()=>{throw new Error('should not refresh');},notify:async()=>{}});assert.equal(calls,1);
 }finally{for(const [k,v]of Object.entries(original))if(v===undefined)delete process.env[k];else process.env[k]=v;await rm(dir,{recursive:true,force:true});}
});
test('failed slots cannot be retried, and an in-progress local record does not self-block',()=>{assert.ok(locked({posts:[{slot:'slot',status:'failed'}]},{id:'slot'}));assert.equal(locked({posts:[{slot:'slot',status:'preparing'}]},{id:'slot'},candidate),false);});
test('LLM adapter requests strict structured output and rejects refusals',async()=>{const {llm}=await import('../src/llm.js');const previous=process.env.LLM_API_KEY;process.env.LLM_API_KEY='fake-test-key';try{let payload;const response=await llm(config,'Return JSON',{}, {type:'object'},async(url,opts)=>{payload=JSON.parse(opts.body);return {choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]};});assert.equal(response.ok,true);assert.equal(payload.response_format.json_schema.strict,true);await assert.rejects(llm(config,'x',{}, {},async()=>({choices:[{finish_reason:'stop',message:{refusal:'No'}}]})),/refused/);}finally{if(previous===undefined)delete process.env.LLM_API_KEY;else process.env.LLM_API_KEY=previous;}});
test('image adapter makes one request per slide with visual constraints',async()=>{const {images}=await import('../src/images.js');const previous=process.env.IMAGE_API_KEY;process.env.IMAGE_API_KEY='fake-image-key';try{let calls=0;const result=await images(mockScript('Space'),config,async(url,opts)=>{calls++;const body=JSON.parse(opts.body);assert.equal(body.n,1);assert.match(body.prompt,/no text, letters/);assert.match(body.prompt,/watermarks/);return {data:[{b64_json:Buffer.from('image').toString('base64')}]};});assert.equal(calls,1);assert.equal(result.length,1);assert.equal(result[0].toString(),'image');}finally{if(previous===undefined)delete process.env.IMAGE_API_KEY;else process.env.IMAGE_API_KEY=previous;}});
test('Azure adapter uses deployment routes and api-key authentication',async()=>{
 const {provider}=await import('../src/provider.js');
 const vars={AZURE_OPENAI_ENDPOINT:'https://test.openai.azure.com/',AZURE_OPENAI_DEPLOYMENT:'my-text',AZURE_OPENAI_API_VERSION:'2024-02-15-preview',AZURE_OPENAI_API_KEY:'fake'};
 const before=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));
 try {Object.assign(process.env,vars);const c=structuredClone(config);c.llm.provider='azure';const result=provider(c,'llm');assert.match(result.url,/deployments\/my-text\/chat\/completions\?api-version=2024-02-15-preview/);assert.equal(result.headers['api-key'],'fake');assert.equal(result.headers.Authorization,undefined);delete process.env.AZURE_OPENAI_DEPLOYMENT;assert.equal(provider(c,'llm').model,c.llm.model);process.env.AZURE_OPENAI_DEPLOYMENT='  ';assert.equal(provider(c,'llm').model,c.llm.model);delete c.llm.model;assert.throws(()=>provider(c,'llm'),/Set llm.model/);}finally{for(const [k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('Graph failures retain diagnostic codes and redact bearer tokens without retrying',async()=>{
 let calls=0;
 await assert.rejects(request('https://graph.instagram.com/v25.0/test/media',{headers:{Authorization:'Bearer private-test-token'}},{fetchImpl:async()=>{
  calls++;
  return Response.json({error:{code:100,error_subcode:2207052,message:'Cannot fetch media private-test-token',error_user_msg:'Check image URL'}},{status:400});
 }}),e=>{
  assert.match(e.message,/\(100\)/);
  assert.match(e.message,/Subcode 2207052/);
  assert.match(e.message,/Cannot fetch media \[REDACTED\]/);
  assert.match(e.message,/Check image URL/);
  assert.ok(!e.message.includes('private-test-token'));
  return true;
 });
 assert.equal(calls,1);
});
