import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {scheduleOverview,getSlot} from '../src/schedule.js';
const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url)));
test('monitor shows only active publishing slots and honors IST day boundaries',()=>{
 const result=scheduleOverview(config,[],new Date('2026-10-14T20:00:00Z'));
 assert.equal(result.localDate,'2026-10-15');
 assert.equal(result.slots.length,config.schedule.dailyPosts*2);
 assert.equal(result.localAutoPublishing,false);
 for(const slot of result.slots)assert.equal(getSlot(config,new Date(slot.id)).category,slot.category);
 assert.equal(result.next,result.slots[0]);
});
test('monitor reports recorded outcomes and advances next slot into tomorrow',()=>{
 const now=new Date('2026-10-15T18:00:00Z');
 const initial=scheduleOverview(config,[],now);
 const first=initial.slots[0];
 const result=scheduleOverview(config,[{slot:first.id,status:'published'}],now);
 assert.equal(result.slots[0].status,'published');
 assert.equal(result.slots[1].status,'elapsed');
 assert.equal(result.next.day,'2026-10-16');
});
test('monitor reports the configured Render scheduler',()=>{
 const result=scheduleOverview(config,[],new Date('2026-10-15T00:00:00Z'),{runner:'render',localAutoPublishing:true});
 assert.equal(result.runner,'render');
 assert.equal(result.localAutoPublishing,true);
});
