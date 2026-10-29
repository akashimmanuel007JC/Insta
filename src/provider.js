import { required, jsonHeaders } from './util.js';
export function provider(config, kind, operation = 'generations') {
 const section = config[kind];
 if (kind === 'image' && !['generations', 'edits'].includes(operation)) throw new Error(`Unsupported image operation: ${operation}`);
 if (!section.provider || section.provider === 'openai') {
  const headers=jsonHeaders(required(kind === 'llm' ? 'LLM_API_KEY' : 'IMAGE_API_KEY'));
  if(kind==='image'&&operation==='edits')delete headers['Content-Type'];
  return {url:`${section.baseUrl}/${kind === 'llm' ? 'chat/completions' : `images/${operation}`}`,headers, model:section.model};
 }
 if (section.provider !== 'azure') throw new Error(`Unsupported provider: ${section.provider}`);
 const image = kind === 'image';
 const endpoint = required(image ? 'AZURE_OPENAI_IMAGE_ENDPOINT_1' : 'AZURE_OPENAI_ENDPOINT');
 const deployment = process.env[image ? 'AZURE_OPENAI_IMAGE_DEPLOYMENT' : 'AZURE_OPENAI_DEPLOYMENT']?.trim() || section.model?.trim();
 if (!deployment) throw new Error(`Set ${kind}.model in config.json`);
 const version = required(image ? 'AZURE_OPENAI_IMAGE_API_VERSION_1' : 'AZURE_OPENAI_API_VERSION');
 const url = new URL(endpoint);
 if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw new Error('Azure endpoint must be an HTTPS resource root');
 url.pathname = `/openai/deployments/${encodeURIComponent(deployment)}/${image ? `images/${operation}` : 'chat/completions'}`;
 url.searchParams.set('api-version',version);
 const headers={'Content-Type':'application/json','api-key':required(image ? 'AZURE_OPENAI_IMAGE_API_KEY_1' : 'AZURE_OPENAI_API_KEY')};
 if(image&&operation==='edits')delete headers['Content-Type'];
 return {url:url.href, headers,model:deployment};
}
