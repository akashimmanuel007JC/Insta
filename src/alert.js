import {request,safeError} from './util.js';
export async function alert(message) {
 if(process.env.DRY_RUN==='true'){console.error(`Dry-run alert: ${message}`);return;}
 if(!process.env.TELEGRAM_TOKEN||!process.env.TELEGRAM_CHAT_ID){console.error('Alert unavailable: configure Telegram secrets');return;}
 try{await request(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,text:message.slice(0,3500)})});}catch(e){console.error(`Alert delivery failed: ${safeError(e)}`);}
}
