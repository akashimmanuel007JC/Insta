import {request} from './util.js';
import {provider} from './provider.js';
export async function llm(config,system,input,schema,get=request) {
 const connection=provider(config,'llm');
 const format=config.llm.responseFormat==='json_object'?{type:'json_object'}:{type:'json_schema',json_schema:{name:'result',strict:true,schema}};
 const d=await get(connection.url,{method:'POST',headers:connection.headers,body:JSON.stringify({model:connection.model,messages:[{role:'system',content:system+' Return JSON matching this schema: '+JSON.stringify(schema)},{role:'user',content:JSON.stringify(input)}],response_format:format})});
 const choice=d.choices?.[0];if(choice?.finish_reason!=='stop'||choice.message?.refusal)throw new Error('LLM refused or returned incomplete output');return JSON.parse(choice.message.content);
}
export const object = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const string={type:'string'};
