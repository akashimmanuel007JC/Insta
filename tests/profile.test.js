import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {profilePrompt,generateBio,redesignImage,decodeEditImage,editSizeForDimensions} from '../src/profile.js';

test('profile prompts reject empty and oversized instructions',()=>{
 for(const prompt of ['',null,' '.repeat(20),'a'.repeat(2001)])assert.throws(()=>profilePrompt(prompt));
 assert.equal(profilePrompt('  Friendly news bio  '),'Friendly news bio');
});
test('bio retries an oversized response and preserves editable line breaks',async()=>{
 let calls=0;
 const result=await generateBio('Explain world news',{brand:{name:'News'}},async()=>({bio:++calls===1?'a'.repeat(151):'World news, explained.\nStay curious.'}));
 assert.equal(calls,2);assert.equal(result.bio,'World news, explained.\nStay curious.');
 await assert.rejects(generateBio('News',{},async()=>({bio:'a'.repeat(151)})),/150/);
});
test('image redesign validates source images',async()=>{
 assert.throws(()=>decodeEditImage('not-an-image'),/PNG, JPEG, or WebP/);
 assert.throws(()=>decodeEditImage(`data:image/png;base64,${Buffer.alloc(10*1024*1024+1).toString('base64')}`),/10 MB/);
 assert.equal(editSizeForDimensions(1200,600),'1536x1024');
 assert.equal(editSizeForDimensions(600,1200),'1024x1536');
 assert.equal(editSizeForDimensions(1000,1000),'1024x1024');
});
test('image redesign sends the source as a multipart edit and returns a JPEG',async()=>{
 const previous=process.env.IMAGE_API_KEY;process.env.IMAGE_API_KEY='test-only';
 try {
 const png=await sharp({create:{width:48,height:24,channels:3,background:'#123456'}}).png().toBuffer();
 const input=`data:image/png;base64,${png.toString('base64')}`;
 const result=await redesignImage('Make it blue',input,{image:{baseUrl:'https://example.test',model:'test'}},async(url,opts,retry)=>{
 assert.equal(url,'https://example.test/images/edits');assert.equal(opts.headers['Content-Type'],undefined);assert.equal(retry.attempts,1);
 assert.ok(opts.body instanceof FormData);assert.equal(opts.body.get('model'),'test');assert.equal(opts.body.get('size'),'1536x1024');assert.match(opts.body.get('prompt'),/Make it blue/);assert.match(opts.body.get('prompt'),/48:24 aspect ratio/);assert.equal(opts.body.get('image').type,'image/png');
 return {data:[{b64_json:png.toString('base64')}]};
 });
 const metadata=await sharp(Buffer.from(result.imageUrl.split(',')[1],'base64')).metadata();
 assert.equal(metadata.format,'jpeg');assert.equal(metadata.width,48);assert.equal(metadata.height,24);
 }finally{if(previous===undefined)delete process.env.IMAGE_API_KEY;else process.env.IMAGE_API_KEY=previous;}
});
