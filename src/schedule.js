export function getSlot(config, now=new Date(), explicit) {
  const s=config.schedule;
  if(s.timezone!=='Asia/Kolkata') throw new Error('Cron and slot calculation require Asia/Kolkata');
  if(!Number.isInteger(s.dailyPosts)||s.dailyPosts<1||s.dailyPosts>8||s.startHour<7||s.endHour>21||s.intervalHours!==2||s.startHour%2!==1||s.endHour%2!==1) throw new Error('Schedule must fit the eight configured cron wakeups');
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
  const category=config.categories[((dayIndex+Math.floor(dayIndex/hours.length)+index)%config.categories.length+config.categories.length)%config.categories.length];
  if(!category||!config.sources[category]) throw new Error('Category/source configuration is incomplete');
  return {id:`${day}T${String(hour).padStart(2,'0')}:00+05:30`,day,time:`${String(hour).padStart(2,'0')}:00`,category};
}
