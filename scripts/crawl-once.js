import { runCrawlJob, statusSnapshot } from '../src/scheduler.js';
import { flushAll } from '../src/store.js';

const result = await runCrawlJob({ force: true, throwOnError: false });
console.log(JSON.stringify({ ...result, snapshot: statusSnapshot().counts }, null, 2));
flushAll();
process.exit(result.ok ? 0 : 1);
