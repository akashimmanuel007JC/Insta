import { createHash } from 'node:crypto';
import { readJSON, writeJSON } from './util.js';
export function canonicalURL(raw) { const u=new URL(raw); u.hash=''; for(const k of [...u.searchParams.keys()]) if(/^utm_|^(fbclid|gclid)$/.test(k))u.searchParams.delete(k); u.searchParams.sort(); return u.href.replace(/\/$/,''); }
export const storyId = c => createHash('sha256').update(canonicalURL(c.url)).digest('hex').slice(0,20);
export function similarity(a,b) { const tokens=s=>new Set(s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(Boolean)); const x=tokens(a),y=tokens(b); return [...x].filter(t=>y.has(t)).length/Math.max(1,new Set([...x,...y]).size); }
export function dedupe(candidates,used,config,now=new Date()) {
  const recent=used.filter(x=>now-new Date(x.timestamp)<config.dedupeDays*86400000);
  const result=[];
  for(const c of candidates) if(![...recent,...result].some(x=>canonicalURL(x.url)===canonicalURL(c.url)||similarity(x.title,c.title)>=config.titleSimilarity))result.push(c);
  return result;
}
export async function loadLogs(root='logs') { return {posts:await readJSON(`${root}/posts.json`,[]),used:await readJSON(`${root}/used.json`,[])}; }
export async function saveLogs(logs,root='logs') { await writeJSON(`${root}/posts.json`,logs.posts); await writeJSON(`${root}/used.json`,logs.used); }
export function locked(logs,slot,candidate) { return logs.posts.some(p=>p.slot===slot.id && ['failed','posting','published','uncertain'].includes(p.status)) || (candidate && logs.posts.some(p=>p.story_id===storyId(candidate)&&['posting','uncertain'].includes(p.status))); }
