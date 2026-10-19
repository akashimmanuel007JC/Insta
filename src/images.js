import {request} from './util.js';
import {provider} from './provider.js';
export async function images(script,config,get=request) {
 const connection=provider(config,'image');
 const result=[];for(const prompt of script.image_prompts){const d=await get(connection.url,{method:'POST',headers:connection.headers,body:JSON.stringify({model:connection.model,n:1,size:'1024x1536',quality:'medium',prompt:`${config.image.style}. ${prompt}. Strictly no text, letters, numbers, logos, or watermarks. When the visual prompt names a person as the main subject, prioritize their face and keep it clearly visible in the upper portion, away from the text overlay. Leave lower portion composed cleanly for a text overlay.`})},{attempts:1});if(!d.data?.[0]?.b64_json)throw new Error('Image API returned no image');result.push(Buffer.from(d.data[0].b64_json,'base64'));}return result;
}
