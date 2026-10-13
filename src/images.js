import {request,required,jsonHeaders} from './util.js';
export async function images(script,config,get=request) {
 const result=[];for(const prompt of script.image_prompts){const d=await get(`${config.image.baseUrl}/images/generations`,{method:'POST',headers:jsonHeaders(required('IMAGE_API_KEY')),body:JSON.stringify({model:config.image.model,n:1,size:'1024x1536',quality:'medium',prompt:`${config.image.style}. ${prompt}. Strictly no text, letters, numbers, logos, people or photorealistic real-event scenes. Pure conceptual illustration. Leave lower half simple for an overlay.`})});if(!d.data?.[0]?.b64_json)throw new Error('Image API returned no image');result.push(Buffer.from(d.data[0].b64_json,'base64'));}return result;
}
