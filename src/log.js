import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { readJSON, writeJSON } from './util.js';
export function canonicalURL(raw) { const u=new URL(raw); u.hash=''; for(const k of [...u.searchParams.keys()]) if(/^utm_|^(fbclid|gclid)$/.test(k))u.searchParams.delete(k); u.searchParams.sort(); return u.href.replace(/\/$/,''); }
export const storyId = c => createHash('sha256').update(canonicalURL(c.url)).digest('hex').slice(0,20);
export function similarity(a,b) { const tokens=s=>new Set(s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(Boolean)); const x=tokens(a),y=tokens(b); return [...x].filter(t=>y.has(t)).length/Math.max(1,new Set([...x,...y]).size); }
const HISTORY_STOP_WORDS=new Set(['a','about','after','again','all','also','an','and','are','as','at','be','been','before','but','by','can','could','daily','do','for','from','generated','has','have','how','in','into','is','it','its','latest','more','new','news','of','on','or','our','over','report','reported','reports','said','says','source','that','the','their','they','this','to','up','update','was','were','what','when','where','which','who','why','will','with']);
const historyTokens=value=>new Set(String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(token=>token.length>2&&!HISTORY_STOP_WORDS.has(token)));
export function contentSimilarity(a,b) { const x=historyTokens(a),y=historyTokens(b),intersection=[...x].filter(token=>y.has(token)).length;if(intersection<2)return 0;return Math.max(intersection/Math.max(1,Math.min(x.size,y.size)),intersection/Math.max(1,new Set([...x,...y]).size)); }
export function relatedToPostHistory(candidate,posts,threshold=0.2) {
 const title=candidate.title||'',context=`${title} ${(candidate.text||'').slice(0,1500)}`;
 return posts.filter(post=>['posting','published','uncertain'].includes(post.status)).some(post=>{
  const previousTitle=post.headline||'',previous=`${previousTitle} ${post.caption||''}`;
  return contentSimilarity(title,previousTitle)>=threshold||contentSimilarity(context,previous)>=threshold;
 });
}
export function dedupe(candidates,used,config,now=new Date()) {
  const recent=used.filter(x=>now-new Date(x.timestamp)<config.dedupeDays*86400000);
  const result=[];
  for(const c of candidates) if(![...recent,...result].some(x=>canonicalURL(x.url)===canonicalURL(c.url)||similarity(x.title,c.title)>=config.titleSimilarity))result.push(c);
  return result;
}
export async function loadLogs(root='logs') { return {posts:await readJSON(`${root}/posts.json`,[]),used:await readJSON(`${root}/used.json`,[])}; }
export async function saveLogs(logs,root='logs') { await writeJSON(`${root}/posts.json`,logs.posts); await writeJSON(`${root}/used.json`,logs.used); }
export async function claimSlot(slot,root='logs') {
 const lockRoot=`${root}/slot-locks`,lockId=createHash('sha256').update(slot.id).digest('hex');
 await mkdir(lockRoot,{recursive:true});
 try { await mkdir(`${lockRoot}/${lockId}`);return true; }
 catch(error) { if(error.code==='EEXIST')return false;throw error; }
}
const RESERVED_STATUSES=['preparing','posting','published','failed','uncertain'];
export function storyLocked(logs,candidate) { return logs.posts.some(p=>p.story_id===storyId(candidate)&&RESERVED_STATUSES.includes(p.status)); }
export function locked(logs,slot,candidate) { return logs.posts.some(p=>p.slot===slot.id&&RESERVED_STATUSES.includes(p.status)) || Boolean(candidate&&storyLocked(logs,candidate)); }
