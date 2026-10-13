import {pathToFileURL} from 'node:url';
import {readJSON,safeError} from './util.js';
import {loadLogs,saveLogs} from './log.js';
import {graph} from './publish.js';
import {token} from './token.js';
import {checkpoint} from './host.js';
import {alert} from './alert.js';
export async function collectInsights(posts,api,now=new Date()) {
 const errors=[];for(const post of posts){const age=now-new Date(post.timestamp);if(post.status!=='published'||post.insights||age<24*3600000||age>48*3600000)continue;
 try{const d=await api(`${post.ig_media_id}/insights`,{metric:'reach,saved,shares,likes,comments'});const result={};for(const name of ['reach','saved','shares','likes','comments']){const row=d.data?.find(r=>r.name===name);const value=row?.total_value?.value??row?.values?.[0]?.value;if(!Number.isFinite(value))throw new Error(`Missing insight ${name}`);result[name==='saved'?'saves':name]=value;}post.insights={...result,collected_at:now.toISOString()};delete post.insights_error;}catch(e){post.insights_error=safeError(e);errors.push(post.insights_error);}}
 return errors;
}
async function main(){if(process.env.DRY_RUN==='true')throw new Error('Insights writes disabled in dry run');const config=await readJSON('config.json'),logs=await loadLogs();const errors=await collectInsights(logs.posts,graph(config,await token(config)));await saveLogs(logs);await checkpoint('Update daily Instagram insights');if(errors.length){await alert(`Insights failures: ${errors.join('; ')}`);process.exitCode=1;}}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(async e=>{await alert(`Insights failed: ${safeError(e)}`);process.exitCode=1;});
