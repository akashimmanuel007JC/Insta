import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,cp,readdir,rm} from 'node:fs/promises';
import {basename} from 'node:path';
import {sleep,required} from './util.js';
const exec=promisify(execFile);
export async function checkpoint(message='Update carousel state') {
 if(process.env.DRY_RUN==='true')throw new Error('Dry run cannot commit');
 if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Live state writes require GitHub Actions');
 await exec('git',['add','--','logs','public/images']);
 const {stdout}=await exec('git',['diff','--cached','--name-only']);if(!stdout.trim())return;
 await exec('git',['commit','-m',message]);
 await exec('git',['push','origin',`HEAD:${(process.env.STATE_BRANCH||required('GITHUB_REF_NAME'))}`]);
}
export async function stageImages(paths,id,config,now=new Date()) {
 const folder=`${now.toISOString().slice(0,10)}-${id}`,dir=`public/images/${folder}`;
 await mkdir(dir,{recursive:true});for(const p of paths)await cp(p,`${dir}/${basename(p)}`);
 for(const entry of await readdir('public/images',{withFileTypes:true}))if(entry.isDirectory()&&/^\d{4}-\d{2}-\d{2}-/.test(entry.name)&&now-Date.parse(entry.name.slice(0,10))>config.hosting.retentionDays*86400000)await rm(`public/images/${entry.name}`,{recursive:true});
 await checkpoint('Stage carousel JPEGs');
 const base=required('PAGES_BASE_URL').replace(/\/$/,'');if(!base.startsWith('https://'))throw new Error('Pages URL must use HTTPS');
 return paths.map(p=>`${base}/images/${folder}/${basename(p)}`);
}
export async function verifyURLs(urls,{fetchImpl=fetch,wait=sleep,attempts=60}={}) {
 for(const url of urls){let ok=false;for(let i=0;i<attempts;i++){try{const r=await fetchImpl(url,{signal:AbortSignal.timeout(10000),cache:'no-store'});ok=r.status===200&&/^image\/jpeg/i.test(r.headers.get('content-type')||'');await r.body?.cancel();if(ok)break;}catch{}await wait(5000);}if(!ok)throw new Error('Hosted JPEG did not become publicly available');}
}
