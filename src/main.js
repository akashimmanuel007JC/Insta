import {pathToFileURL} from 'node:url';
import {rm} from 'node:fs/promises';
import {readJSON,writeJSON,safeError,required} from './util.js';
import {getSlot} from './schedule.js';
import {fetchCandidates} from './sources/index.js';
import {loadLogs,saveLogs,dedupe,locked,storyId} from './log.js';
import {selectByIntensity} from './intensity.js';
import {script,validateScript} from './script.js';
import {images} from './images.js';
import {compose} from './compose.js';
import {stageImages,checkpoint,verifyURLs} from './host.js';
import {publish,graph} from './publish.js';
import {token} from './token.js';
import {alert} from './alert.js';
export async function prepare({config,now=new Date(),dry=process.env.DRY_RUN==='true',mock=process.env.MOCK_APIS==='true',logRoot=dry?'output/logs':'logs',services={}}={}) {
 config??=await readJSON('config.json');if(mock&&!dry)throw new Error('Mock APIs require DRY_RUN=true');
 const logs=await loadLogs(dry?'logs':logRoot);let record;
 try{
 const slot=getSlot(config,now,process.env.SLOT_HOUR||(dry?String(config.schedule.startHour):undefined));if(!slot)return {status:'skipped',reason:'Inactive slot'};
 if(locked(logs,slot))return {status:'skipped',reason:'Slot already reserved'};
 if(logs.posts.filter(p=>p.slot?.startsWith(slot.day)&&['posting','uncertain','published'].includes(p.status)).length>=config.schedule.dailyPosts)return {status:'skipped',reason:'Daily limit reached'};
 record={timestamp:now.toISOString(),slot:slot.id,category:null,status:'preparing',error:null,ig_media_id:null};logs.posts.push(record);
 let candidates,warnings=[];
 if(mock){const m=await import('./mock.js');candidates=[{...m.candidate,category:config.categories[0]}];}
 else {
  const fetch=services.fetchCandidates||fetchCandidates;
  for(const category of config.categories) {
   try {
    const result=await fetch(category,config,{now});
    candidates.push(...result.candidates.map(candidate=>({...candidate,category})));
    warnings.push(...result.warnings.map(warning=>`${category}: ${warning}`));
   } catch(e) { warnings.push(`${category}: ${safeError(e)}`); }
  }
  if(!candidates.length)throw new Error(`No sufficiently sourced candidates across all categories. ${warnings.join('; ')}`);
 }
 record.warnings=warnings;
 const pool=candidates;
 candidates=dedupe(candidates,logs.used,config,now).filter(c=>!locked(logs,slot,c));if(!candidates.length)throw new Error('No unused candidates');
 const chosen=mock?{...candidates[0],intensity:{score:0,label:'test',independentSources:1,components:{}}}:selectByIntensity(candidates,pool,config,now);
 const category=chosen.category;
 Object.assign(record,{category,story_id:storyId(chosen),source:{name:chosen.source,url:chosen.url},headline:chosen.title,intensity:chosen.intensity});
 const m=mock?await import('./mock.js'):null;
 const copy=mock?validateScript(m.mockScript(category),chosen,category):await (services.script||script)(chosen,category,config);
 const buffers=mock?await m.mockImages(copy):await (services.images||images)(copy,config);
 const paths=await compose(buffers,copy,config,`output/${record.story_id}`);
 if(dry){record.status='dry_run';await saveLogs(logs,logRoot);const result={status:'dry_run',slot,script:copy,paths};await writeJSON('output/result.json',result);return result;}
 if(config.instagram.loginMode==='instagram')required('GH_SECRETS_TOKEN');
 await token(config,{refresh:false}); // Maintenance refresh runs in the separate daily workflow.
 record.status='posting';logs.used.push({url:chosen.url,title:chosen.title,timestamp:now.toISOString()});
 await saveLogs(logs,logRoot);await checkpoint('Reserve story before any Instagram publish');
 const urls=await stageImages(paths,record.story_id,config,now);
 const pending={record_id:record.story_id,slot:slot.id,urls,script:copy};await writeJSON('output/pending.json',pending);return {status:'staged',...pending};
 }catch(e){if(record){record.status=record.status==='posting'?'uncertain':'failed';record.error=safeError(e);await saveLogs(logs,logRoot);}if(!dry)await checkpoint('Record failed slot').catch(()=>{});await alert(`Carousel skipped: ${safeError(e)}`);throw e;}
}
export async function finish(){
 if(process.env.DRY_RUN==='true')throw new Error('Cannot publish in dry run');
 const config=await readJSON('config.json'),pending=await readJSON('output/pending.json'),logs=await loadLogs();
 const record=logs.posts.find(p=>p.story_id===pending.record_id&&p.slot===pending.slot);
 if(!record||record.status!=='posting'||record.publish_requested_at)throw new Error('Missing fresh posting reservation; manual reconciliation required');
 try{await verifyURLs(pending.urls);const accessToken=await token(config,{refresh:false});
 record.ig_media_id=await publish(pending.urls,pending.script,graph(config,accessToken),{persist:async patch=>{Object.assign(record,patch);await saveLogs(logs);await checkpoint('Persist Instagram publish progress');}});
 record.status='published';record.timestamp=new Date().toISOString();await saveLogs(logs);await checkpoint('Record published carousel');
 try{await rm(`output/${record.story_id}`,{recursive:true,force:true});await rm('output/pending.json',{force:true});}catch{}
 return record;
 }catch(e){record.status='uncertain';record.error=safeError(e);await saveLogs(logs);await checkpoint('Record uncertain publish').catch(()=>{});await alert(`Carousel needs review; will not retry: ${safeError(e)}`);throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const result=process.argv[2]==='finish'?await finish():await prepare();console.log(JSON.stringify(result,null,2));}catch(e){console.error(safeError(e));process.exitCode=1;}}
