import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {profilePrompt,generateBio,generateProfilePicture} from '../src/profile.js';

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
test('profile picture uses square generation and returns a JPEG',async()=>{
 const previous=process.env.IMAGE_API_KEY;process.env.IMAGE_API_KEY='test-only';
 try {
 const png=await sharp({create:{width:32,height:32,channels:3,background:'#123456'}}).png().toBuffer();
 const result=await generateProfilePicture('Blue globe',{image:{baseUrl:'https://example.test',model:'test'}},async(url,opts)=>{
 const body=JSON.parse(opts.body);assert.equal(body.size,'1024x1024');assert.equal(body.n,1);assert.match(body.prompt,/Blue globe/);
 return {data:[{b64_json:png.toString('base64')}]};
 });
 const metadata=await sharp(Buffer.from(result.imageUrl.split(',')[1],'base64')).metadata();
 assert.equal(metadata.format,'jpeg');assert.equal(metadata.width,1024);assert.equal(metadata.height,1024);
 }finally{if(previous===undefined)delete process.env.IMAGE_API_KEY;else process.env.IMAGE_API_KEY=previous;}
});
