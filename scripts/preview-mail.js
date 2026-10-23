/**
 * 生成邮件预览（不动 SMTP、不发信）。
 *
 * 用法：
 *   node scripts/preview-mail.js            # 次日日报（默认）
 *   node scripts/preview-mail.js digest 2026-10-17
 *   node scripts/preview-mail.js test       # 测试邮件
 *   node scripts/preview-mail.js code       # 验证码邮件
 *
 * 结果写入项目根目录的 email-preview.html，用浏览器打开即可看到邮件长什么样。
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderDigest, renderTestMail, renderCodeMail } from '../src/mailTemplate.js';
import { contestsForDayKey, tomorrowKey } from '../src/scheduler.js';

const kind = (process.argv[2] || 'digest').toLowerCase();
const dateKey = process.argv[3] || tomorrowKey();

let subject;
let html;
let note = '';

if (kind === 'test') {
  ({ subject, html } = renderTestMail({ email: 'you@example.com' }));
} else if (kind === 'code') {
  ({ subject, html } = renderCodeMail({ code: '123456', purpose: 'register', ttlMinutes: 10 }));
} else {
  const contests = contestsForDayKey(dateKey);
  ({ subject, html } = renderDigest({ contests, dateLabel: dateKey }));
  note = `${dateKey} 命中 ${contests.length} 场`;
}

const out = path.join(process.cwd(), 'email-preview.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`类型：${kind}`);
console.log(`主题：${subject}`);
if (note) console.log(note);
console.log(`预览已写入：${out}`);
