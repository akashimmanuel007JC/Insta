import {cp,mkdir,rm,writeFile} from 'node:fs/promises';
await rm('.pages-build',{recursive:true,force:true});await mkdir('.pages-build/logs',{recursive:true});
await cp('public','.pages-build',{recursive:true});await cp('logs/posts.json','.pages-build/logs/posts.json');await writeFile('.pages-build/.nojekyll','');
