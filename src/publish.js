import {request,required,sleep} from './util.js';
export function graph(config,token,get=request) {
 const host=config.instagram.loginMode==='facebook'?'graph.facebook.com':'graph.instagram.com';
 return async(path,params={},method='GET',retry={})=>{
 const url=new URL(`https://${host}/${config.instagram.apiVersion}/${path}`);
 const options={method,headers:{Authorization:`Bearer ${token}`}};
 if(method==='GET')url.search=new URLSearchParams(params);else options.body=new URLSearchParams(params);
 // Never automatically repeat mutating Graph calls: their outcomes can be ambiguous.
 const d=await get(url,options,{...retry,attempts:method==='GET'?(retry.attempts??3):1});if(d.error)throw new Error(`Graph error ${d.error.code||'unknown'}`);return d;
 };
}
export async function waitFinished(id,api,{wait=sleep,now=()=>Date.now(),timeout=300000}={}) {
 const end=now()+timeout;while(now()<end){const d=await api(id,{fields:'status_code'},'GET',{attempts:1,timeoutMs:Math.max(1,Math.min(10000,end-now()))});if(d.status_code==='FINISHED')return;if(['ERROR','EXPIRED'].includes(d.status_code))throw new Error(`Container ${d.status_code}`);await wait(Math.min(5000,Math.max(0,end-now())));}throw new Error('Container processing timed out');
}
export async function publishingLimit(api,user) {
 const d=await api(`${user}/content_publishing_limit`,{fields:'quota_usage,config'});const q=d.data?.[0];
 if(!Number.isFinite(q?.quota_usage)||!Number.isFinite(q?.config?.quota_total))throw new Error('Publishing quota unavailable');
 if(q.quota_usage>=q.config.quota_total)throw new Error('Publishing limit reached');
}
export async function publish(urls,script,api,{user=required('IG_USER_ID'),persist=async()=>{},waitOptions}={}) {
 await publishingLimit(api,user);const children=[];
 for(const image_url of urls){const child=await api(`${user}/media`,{image_url,is_carousel_item:'true'},'POST');if(!child.id)throw new Error('Missing child container id');children.push(child.id);await persist({children:[...children]});await waitFinished(child.id,api,waitOptions);}
 const parent=await api(`${user}/media`,{media_type:'CAROUSEL',children:children.join(','),caption:`${script.caption}\n\n${script.hashtags.join(' ')}`},'POST');if(!parent.id)throw new Error('Missing parent container id');await persist({container_id:parent.id});
 await waitFinished(parent.id,api,waitOptions);await publishingLimit(api,user);
 await persist({publish_requested_at:new Date().toISOString()});
 const result=await api(`${user}/media_publish`,{creation_id:parent.id},'POST');if(!result.id)throw new Error('Publish outcome unknown');return result.id;
}
