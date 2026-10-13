import {request,required,jsonHeaders} from './util.js';
export async function llm(config,system,input,schema,get=request) {
 const d=await get(`${config.llm.baseUrl}/chat/completions`,{method:'POST',headers:jsonHeaders(required('LLM_API_KEY')),body:JSON.stringify({model:config.llm.model,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(input)}],response_format:{type:'json_schema',json_schema:{name:'result',strict:true,schema}}})});
 const choice=d.choices?.[0];if(choice?.finish_reason!=='stop'||choice.message?.refusal)throw new Error('LLM refused or returned incomplete output');return JSON.parse(choice.message.content);
}
export const object = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const string={type:'string'};
