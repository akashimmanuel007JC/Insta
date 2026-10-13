import sharp from 'sharp';
import {mkdir} from 'node:fs/promises';
const esc=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
async function textLayer(text,font,size,bold=false){
 return sharp({text:{text:`<span foreground="#ffffff">${bold?'<b>':''}${esc(text)}${bold?'</b>':''}</span>`,font:`${font} ${size}`,width:920,rgba:true,spacing:14,wrap:'word'}}).png().toBuffer({resolveWithObject:true});
}
export async function compose(buffers,script,config,dir) {
 await mkdir(dir,{recursive:true});const paths=[];
 if(buffers.length!==script.slides.length)throw new Error('Missing slide image');
 for(let i=0;i<buffers.length;i++){
  const slide=script.slides[i];
  const head=await textLayer(slide.headline,config.brand.font,60,true),body=await textLayer(slide.body,config.brand.font,36);
  const bodyTop=660+head.info.height+36;
  if(bodyTop+body.info.height>1190)throw new Error('Text cannot fit safe margins');
  const svg=`<svg width="1080" height="1350" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0c1423" stop-opacity="0"/><stop offset="0.35" stop-color="#0c1423" stop-opacity="0.95"/><stop offset="1" stop-color="#0c1423"/></linearGradient></defs><rect y="350" width="1080" height="1000" fill="url(#shade)"/><g font-family="${esc(config.brand.font)}"><rect x="64" y="64" width="952" height="64" rx="12" fill="#0c1423" opacity=".9"/><text x="88" y="107" font-size="26" fill="#ffab91">${esc(config.brand.name)} / ${esc(script.category.toUpperCase())}</text><text x="80" y="1260" font-size="25" fill="#ffab91">${esc(config.brand.watermark)} · AI illustration</text><text x="970" y="1260" text-anchor="end" font-size="25" fill="#fff">${i+1}/${buffers.length}</text></g></svg>`;
  const path=`${dir}/${String(i+1).padStart(2,'0')}.jpg`;
  await sharp(buffers[i]).resize(1080,1350,{fit:'cover'}).composite([{input:Buffer.from(svg)},{input:head.data,left:80,top:660},{input:body.data,left:80,top:bodyTop}]).jpeg({quality:90,mozjpeg:true}).toFile(path);paths.push(path);
 }return paths;
}
