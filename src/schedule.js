export function getSlot(config, now=new Date(), explicit) {
  const s=config.schedule;
  if(s.timezone!=='Asia/Kolkata') throw new Error('Cron and slot calculation require Asia/Kolkata');
  if(!Number.isInteger(s.dailyPosts)||s.dailyPosts<1||s.dailyPosts>8||s.startHour<0||s.endHour>23||![2,3].includes(s.intervalHours)) throw new Error('Schedule must fit configured cron wakeups');
  const local=new Date(now.getTime()+330*60000), day=local.toISOString().slice(0,10);
  const hours=[]; for(let h=s.startHour;h<=s.endHour;h+=s.intervalHours) hours.push(h);
  if(s.dailyPosts>hours.length) throw new Error('dailyPosts exceeds available slots');
  const dayIndex=Math.floor((Date.parse(day)-Date.parse(s.rotationEpoch))/86400000);
  const minute=local.getUTCHours()*60+local.getUTCMinutes();
  const hour=explicit===undefined ? [...hours].reverse().find(h=>minute>=h*60 && minute-h*60<=s.maxDelayMinutes) : Number(explicit);
  if(!hours.includes(hour)) return null;
  const index=hours.indexOf(hour);
  // Rotate skipped slots daily, so six/day samples all eight times over time.
  if(explicit===undefined && ((index+dayIndex)%hours.length+hours.length)%hours.length>=s.dailyPosts) return null;
  return {id:`${day}T${String(hour).padStart(2,'0')}:00+05:30`,day,time:`${String(hour).padStart(2,'0')}:00`,category:'All categories'};
}

// Use the same rotation rules as the publisher, without explicit-slot overrides.
export function scheduleOverview(config, posts=[], now=new Date()) {
 const localDate=new Date(now.getTime()+330*60000).toISOString().slice(0,10);
 const midnight=Date.parse(`${localDate}T00:00:00+05:30`);
 const slots=[];
 for(let day=0;day<2;day++) {
  for(let hour=config.schedule.startHour;hour<=config.schedule.endHour;hour+=config.schedule.intervalHours) {
   const at=new Date(midnight+day*86400000+hour*3600000);
   const slot=getSlot(config,at);
   if(!slot)continue;
   const record=posts.filter(p=>p.slot===slot.id).at(-1);
   const states=['published','failed','posting','uncertain','preparing'];
   slots.push({...slot,category:record?.category||slot.category,status:states.includes(record?.status)?record.status:(at>now?'upcoming':'elapsed')});
  }
 }
 return {timezone:config.schedule.timezone,now:now.toISOString(),localDate,dailyPosts:config.schedule.dailyPosts,runner:'github_actions',localAutoPublishing:false,next:slots.find(s=>s.status==='upcoming')||null,slots};
}
