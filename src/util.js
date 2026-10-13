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
      if (!r.ok) { const e=new Error(`HTTP ${r.status} from ${new URL(url).hostname}`); e.retryable=r.status===429||r.status>=500; throw e; }
      return await r.json();
    } catch(e) { if (i===attempts-1 || e.retryable===false) throw e; await wait(1000*2**i); }
  }
}
export const jsonHeaders = key => ({'Content-Type':'application/json',Authorization:`Bearer ${key}`});
export function safeError(e) { let s=e.message||String(e); for(const [k,v] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET/.test(k)&&v) s=s.replaceAll(v,'[REDACTED]'); return s.slice(0,500); }
export const stripHTML = s => String(s||'').replace(/<[^>]*>/g,' ').replace(/&[^;]+;/g,' ').replace(/\s+/g,' ').trim();
