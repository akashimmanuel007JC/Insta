import {randomInt} from 'node:crypto';
import {sleep} from '../src/util.js';
const seconds=randomInt(0,601);console.log(`Schedule jitter: ${seconds}s`);await sleep(seconds*1000);
