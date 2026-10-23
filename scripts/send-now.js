import { runDailySend } from '../src/scheduler.js';
import { flushAll } from '../src/store.js';

const dryRun = process.argv.includes('--dry-run');
const dateArg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const result = await runDailySend({ dryRun, dateKey: dateArg });
console.log(JSON.stringify(result, null, 2));
flushAll();
process.exit(0);
