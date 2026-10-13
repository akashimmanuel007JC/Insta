'use strict';
const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('en-IN', {maximumFractionDigits: 1});
const date = new Intl.DateTimeFormat('en-IN', {timeZone:'Asia/Kolkata', day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false});
const time = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hour12:false});
let allPosts = [];
const metric = (post, key) => Number.isFinite(post.insights?.[key]) && post.insights[key] >= 0 ? post.insights[key] : null;
const fmt = value => value === null ? '—' : number.format(value);
function node(tag, text, cls) { const el=document.createElement(tag); if(text !== undefined) el.textContent=String(text); if(cls) el.className=cls; return el; }
function validDate(raw) {const d=new Date(raw);return raw && Number.isFinite(d.getTime())?d:null;}
function empty(id, text, columns) {const tr=node('tr'),td=node('td',text,'empty');td.colSpan=columns;tr.append(td);$(id).append(tr);}
function notice(title, body) {$('notice').replaceChildren(node('strong',title),node('span',body));$('notice').hidden=false;}
function aggregate(posts, key) {const values=posts.map(p=>metric(p,key)).filter(v=>v!==null);return {total:values.length?values.reduce((a,b)=>a+b,0):null,count:values.length};}
function performance(posts, key, target) {
 const groups=new Map();for(const post of posts){const label=key(post);if(!groups.has(label))groups.set(label,[]);groups.get(label).push(post);}
 const rows=[...groups].map(([label,items])=>{const reach=aggregate(items,'reach'),engagement=items.filter(p=>metric(p,'saves')!==null&&metric(p,'shares')!==null);return {label,total:items.length,n:reach.count,reach:reach.count?reach.total/reach.count:null,engagement:engagement.length?engagement.reduce((s,p)=>s+p.insights.saves+p.insights.shares,0)/engagement.length:null,en:engagement.length};}).sort((a,b)=>(b.reach??-1)-(a.reach??-1)||(b.engagement??-1)-(a.engagement??-1)||a.label.localeCompare(b.label));
 if(!rows.length){empty(target,'Published stories will reveal the pattern here.',4);return;}
 for(const row of rows){const tr=node('tr');tr.append(node('td',row.label),node('td',`${row.n} / ${row.total}`),node('td',fmt(row.reach)));const engagement=node('td',fmt(row.engagement));if(row.en!==row.n)engagement.append(node('small',` · n=${row.en}`));tr.append(engagement);$(target).append(tr);}
}
function render() {
 const posts=allPosts.filter(p=>!$('category').value||p.category===$('category').value),published=posts.filter(p=>p.status==='published');
 for(const id of ['categories','slots','posts'])$(id).replaceChildren();
 $('notice').hidden=true;
 if(!allPosts.length)notice('The first story is still ahead.','Published carousels and their results will appear here automatically. There is no performance data yet.');
 const measured=aggregate(published,'reach');$('published').textContent=number.format(published.length);$('coverage').textContent=`${measured.count} with reach · ${published.length-measured.count} unmeasured`;
 for(const key of ['reach','saves','shares']){const summary=aggregate(published,key);$(key).textContent=fmt(summary.total);if($(key+'-count'))$(key+'-count').textContent=`${summary.count} measured ${summary.count===1?'post':'posts'}`;}
 performance(published,p=>p.category||'Uncategorized','categories');
 performance(published,p=>{const d=validDate(p.slot);return d?time.format(d):'Unknown slot';},'slots');
 $('record-count').textContent=`${posts.length} ${posts.length===1?'record':'records'}`;
 if(!posts.length)empty('posts','No activity recorded yet.',7);
 for(const p of [...posts].sort((a,b)=>(validDate(b.timestamp)?.getTime()??0)-(validDate(a.timestamp)?.getTime()??0))){
  const tr=node('tr'),stamp=validDate(p.timestamp),story=node('td');story.append(node('span',p.headline||'No story selected','story'));
  const sourceName=p.source?.name||'Source unavailable';let url;try{const candidate=new URL(p.source?.url);if(candidate.protocol==='https:')url=candidate.href;}catch{}
  const source=node(url?'a':'span',sourceName,'source');if(url){source.href=url;source.target='_blank';source.rel='noopener noreferrer';}story.append(source);
  const status=node('td'),known=['published','posting','preparing','failed','uncertain','dry_run','skipped'];const state=known.includes(p.status)?p.status:'unknown';status.append(node('span',state.replaceAll('_',' '),`badge ${state}`));
  if(p.error)status.append(node('span',p.error,'detail'));
  if(p.insights_error)status.append(node('span',`Insights unavailable: ${p.insights_error}`,'detail'));
  else if(p.status==='published'&&!p.insights){const age=stamp?Date.now()-stamp.getTime():null;status.append(node('span',age!==null&&age>48*3600000?'Insights not collected':'Awaiting insights','detail'));}
  tr.append(node('td',stamp?date.format(stamp):'Unknown time'),story,node('td',p.category||'—'),status,...['reach','saves','shares'].map(k=>node('td',fmt(metric(p,k)))));$('posts').append(tr);
 }
}
async function load() {
 try {const response=await fetch(new URL('logs/posts.json',document.baseURI),{cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);const data=await response.json();if(!Array.isArray(data)||data.some(p=>!p||typeof p!=='object'||Array.isArray(p)))throw new Error('Invalid post log format');allPosts=data;
 for(const category of [...new Set(data.map(p=>p.category).filter(v=>typeof v==='string'&&v))].sort()){$('category').append(node('option',category));}
 $('category').disabled=false;$('category').addEventListener('change',render);$('sync').textContent=`Log loaded ${date.format(new Date())} IST · all recorded activity`;render();
 }catch(error){$('sync').textContent='Post log unavailable';notice('The log could not be read.',`${error.message}. Reload to try again. For local viewing, serve the built Pages directory over HTTP.`);for(const id of ['categories','slots','posts'])empty(id,'Data unavailable.',id==='posts'?7:4);$('coverage').textContent='Data unavailable';}
}
load();
