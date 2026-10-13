import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {required,request,readJSON,writeJSON} from './util.js';
import {alert} from './alert.js';
// gh encrypts with GitHub's public key. The token never enters a file or argv.
export function persistSecret(token) {
 return new Promise((resolve,reject)=>{const child=execFile('gh',['secret','set','IG_ACCESS_TOKEN','--repo',required('GITHUB_REPOSITORY')],{env:{...process.env,GH_TOKEN:required('GH_SECRETS_TOKEN')}},e=>e?reject(new Error('Could not persist refreshed GitHub secret')):resolve());child.stdin.end(token);});
}
export async function token(config,{now=new Date(),get=request,save=persistSecret,notify=alert,refresh=true,metadataPath='logs/token.json'}={}) {
 if(process.env.DRY_RUN==='true')throw new Error('Token maintenance is disabled in dry run');
 const current=required('IG_ACCESS_TOKEN');
 if(!refresh)return current;
 const fingerprint=createHash('sha256').update(current).digest('hex');
 let meta=await readJSON(metadataPath,{});if(meta.fingerprint!==fingerprint)meta={};
 if(config.instagram.loginMode==='facebook'){
  const u=new URL(`https://graph.facebook.com/${config.instagram.apiVersion}/debug_token`);u.searchParams.set('input_token',current);
  const d=await get(u,{headers:{Authorization:`Bearer ${required('FB_APP_ID')}|${required('FB_APP_SECRET')}`}});
  if(!d.data?.is_valid)throw new Error('Facebook token is invalid');
  const expiry=d.data.expires_at;if(expiry&&expiry*1000-now<10*86400000)await notify('Facebook token expires in fewer than 10 days. Reauthorize and update IG_ACCESS_TOKEN; Instagram refresh endpoint cannot refresh Facebook tokens.');return current;
 }
 if(!meta.expires_at)await notify('Instagram token expiry is unknown; attempting refresh. Initial token must be long-lived and at least 24 hours old.');
 else if(Date.parse(meta.expires_at)-now<10*86400000)await notify('Instagram token has fewer than 10 days remaining; automatic refresh is due.');
 if(meta.refreshed_at&&now-Date.parse(meta.refreshed_at)<7*86400000)return current;
 required('GH_SECRETS_TOKEN');
 const u=new URL('https://graph.instagram.com/refresh_access_token');u.search=new URLSearchParams({grant_type:'ig_refresh_token',access_token:current});
 const d=await get(u);if(!d.access_token||!Number.isFinite(d.expires_in))throw new Error('Invalid token refresh result');
 if(process.env.GITHUB_ACTIONS==='true')console.log(`::add-mask::${d.access_token}`);
 await save(d.access_token);await writeJSON(metadataPath,{fingerprint:createHash('sha256').update(d.access_token).digest('hex'),refreshed_at:now.toISOString(),expires_at:new Date(+now+d.expires_in*1000).toISOString()});return d.access_token;
}
