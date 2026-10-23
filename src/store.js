import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './config.js';

fs.mkdirSync(dataDir, { recursive: true });

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class JsonStore {
  constructor(name, initial) {
    this.file = path.join(dataDir, name);
    this.initial = initial;
    this.data = this.read();
    this.timer = null;
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...clone(this.initial), ...parsed };
      }
    } catch {
      /* 首次运行或文件损坏时回退到初始值 */
    }
    return clone(this.initial);
  }

  save() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[store] 写入 ${this.file} 失败: ${err.message}`);
    }
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 150);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  update(mutator) {
    const result = mutator(this.data);
    this.schedule();
    return result === undefined ? this.data : result;
  }
}

export const db = new JsonStore('db.json', {
  users: [],
  sessions: [],
  codes: [],
  meta: { createdAt: new Date().toISOString() },
});

export const contestStore = new JsonStore('contests.json', {
  updatedAt: null,
  serverTime: null,
  pagesCrawled: 0,
  totalOnLuogu: 0,
  contests: [],
});

export const logStore = new JsonStore('logs.json', {
  crawl: [],
  mail: [],
});

export const queueStore = new JsonStore('queue.json', {
  sendDate: null,
  items: [],
  sentCount: 0,
  failedCount: 0,
  lastRunAt: null,
  // 日报推送专用记账：调度器判断"今天是否已推过"只认这两个字段
  lastDigestTargetDate: null,
  lastDigestAt: null,
});

export function flushAll() {
  for (const store of [db, contestStore, logStore, queueStore]) store.save();
}

export function pushLog(bucket, entry, limit = 200) {
  const list = logStore.data[bucket];
  list.unshift({ at: new Date().toISOString(), ...entry });
  if (list.length > limit) list.length = limit;
  logStore.schedule();
  return list[0];
}
