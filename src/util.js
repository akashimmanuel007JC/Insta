import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function writeJSON(path, data) {
  await mkdir(dirname(path), { recursive:true });
  await writeFile(`${path}.tmp`, JSON.stringify(data,null,2)+'\n', {mode:0o600});
  await rename(`${path}.tmp`,path);
}
export function required(name) { if (!process.env[name]) throw new Error(`Missing ${name}`); return process.env[name]; }
export async function request(url, options={}, {attempts=3, fetchImpl=fetch, wait=sleep,timeoutMs=180000}={}) {
  for (let i=0;i<attempts;i++) {
    try {
      const r=await fetchImpl(url,{...options,signal:AbortSignal.timeout(timeoutMs)});
      if (!r.ok) {
        let code, graphDetail='';
        try {
          const body=await r.json(); const value=body.error?.code;
          if(typeof value==='string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) code=value;
          if(['graph.instagram.com','graph.facebook.com'].includes(new URL(url).hostname)) {
            if(Number.isInteger(value)) code=value;
            const subcode=body.error?.error_subcode;
            const message=[body.error?.message,body.error?.error_user_msg].filter(v=>typeof v==='string').join(' ');
            let detail=message;
            const bearer=options.headers?.Authorization?.replace(/^Bearer\s+/i,'');
            if(bearer) detail=detail.replaceAll(bearer,'[REDACTED]');
            graphDetail=`${Number.isInteger(subcode)?` Subcode ${subcode}.`:''}${detail?` ${safeError(new Error(detail))}`:''}`;
          }
        } catch {}
        const hint=code==='DeploymentNotFound' ? ' Check that the configured model/deployment name exists in this Azure resource.' : '';
        const e=new Error(`HTTP ${r.status} from ${new URL(url).hostname}${code !== undefined ? ` (${code})` : ''}.${hint}${graphDetail}`);
        e.retryable=r.status===429||r.status>=500; throw e;
      }
      return await r.json();
    } catch(e) { if (i===attempts-1 || e.retryable===false) throw e; await wait(1000*2**i); }
  }
}
export const jsonHeaders = key => ({'Content-Type':'application/json',Authorization:`Bearer ${key}`});
export function safeError(e) { let s=e.message||String(e); for(const [k,v] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET/.test(k)&&v) s=s.replaceAll(v,'[REDACTED]'); return s.slice(0,500); }
export const stripHTML = s => String(s||'').replace(/<[^>]*>/g,' ').replace(/&[^;]+;/g,' ').replace(/\s+/g,' ').trim();
