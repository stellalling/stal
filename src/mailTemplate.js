import { getConfig } from './config.js';
import { METHOD_LABELS } from './luogu.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function badge(text, bg, fg = '#ffffff') {
  return `<span style="display:inline-block;padding:2px 8px;margin:0 4px 4px 0;border-radius:4px;background:${bg};color:${fg};font-size:12px;line-height:18px;">${escapeHtml(text)}</span>`;
}

function badgesFor(contest) {
  const out = [];
  out.push(badge(contest.methodLabel, '#7557d8'));
  if (contest.isOfficial) out.push(badge('官方比赛', '#c0392b'));
  else out.push(badge(contest.categoryLabel, '#5d40bd'));
  if (contest.isRated) out.push(badge('Rated', '#267a55'));
  else out.push(badge('Unrated', '#8a8792'));
  if (contest.isTeam) out.push(badge('组队赛', '#b8860b'));
  return out.join('');
}

function contestCard(contest) {
  const participants = contest.totalParticipants == null ? '' : ` · 报名 ${contest.totalParticipants} 人`;
  const problems = contest.problemCount ? ` · ${contest.problemCount} 题` : '';
  return `
  <tr><td style="padding:0 0 12px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dedce3;border-radius:6px;background:#ffffff;">
      <tr><td style="padding:14px 16px;">
        <div style="margin-bottom:6px;">${badgesFor(contest)}</div>
        <div style="font-size:16px;font-weight:600;color:#19171d;line-height:22px;margin-bottom:8px;">
          <a href="${escapeHtml(contest.url)}" style="color:#19171d;text-decoration:none;">${escapeHtml(contest.name)}</a>
        </div>
        <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;color:#46424c;line-height:20px;">
          <tr><td style="padding-right:8px;color:#625d68;">比赛编号</td><td>${contest.id}</td></tr>
          <tr><td style="padding-right:8px;color:#625d68;">举办者</td><td>${escapeHtml(contest.host?.name || '未知')}</td></tr>
          <tr><td style="padding-right:8px;color:#625d68;">开始时间</td><td>${escapeHtml(contest.startDateTime)}（${escapeHtml(contest.startWeekday)}）</td></tr>
          <tr><td style="padding-right:8px;color:#625d68;">结束时间</td><td>${escapeHtml(contest.endDateTime)}</td></tr>
          <tr><td style="padding-right:8px;color:#625d68;">比赛时长</td><td>${escapeHtml(contest.durationText)}${problems}${participants}</td></tr>
        </table>
        <div style="margin-top:10px;">
          <a href="${escapeHtml(contest.url)}" style="display:inline-block;padding:7px 14px;border-radius:4px;background:#7557d8;color:#ffffff;font-size:13px;text-decoration:none;">查看比赛 →</a>
        </div>
      </td></tr>
    </table>
  </td></tr>`;
}

export function renderDigest({ contests, dateLabel, recipientHint = '' }) {
  const cfg = getConfig();
  const count = contests.length;
  const subject = String(cfg.mail.subjectTemplate || '【洛谷比赛提醒】{date} 共 {count} 场比赛')
    .replace('{date}', dateLabel)
    .replace('{count}', String(count));

  const rows = contests.map(contestCard).join('');
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f7f9;font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;color:#19171d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f9;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">
    <tr><td style="background:#7557d8;border-radius:6px 6px 0 0;padding:20px 24px;">
      <div style="font-size:18px;font-weight:700;color:#ffffff;">${escapeHtml(cfg.site.name)}</div>
      <div style="font-size:13px;color:#e9e3ff;margin-top:4px;">${escapeHtml(dateLabel)} 的比赛提醒 · 共 ${count} 场</div>
    </td></tr>
    <tr><td style="background:#ffffff;padding:20px 24px;border:1px solid #dedce3;border-top:none;">
      <div style="font-size:14px;color:#46424c;line-height:22px;margin-bottom:8px;">
        以下是${escapeHtml(dateLabel)}（明天）即将开始的洛谷比赛，共 <strong>${count}</strong> 场。祝你上分顺利！
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    </td></tr>
    <tr><td style="background:#ffffff;border:1px solid #dedce3;border-top:none;border-radius:0 0 6px 6px;padding:16px 24px;">
      <div style="font-size:12px;color:#625d68;line-height:20px;">
        数据来源：<a href="https://www.luogu.com.cn/contest/list" style="color:#7557d8;">洛谷比赛列表</a>。本邮件通过 Bcc 密送发送，其他收件人不可见。
        ${recipientHint ? `<br>${escapeHtml(recipientHint)}` : ''}
      </div>
      <div style="font-size:12px;color:#8a8792;line-height:20px;margin-top:10px;">
        订阅设置可在 ${escapeHtml(cfg.site.name)} 主页调整。${escapeHtml(cfg.site.footer || '')}
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  return { subject, html, count };
}

export function renderTestMail({ email }) {
  const cfg = getConfig();
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f7f7f9;font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;color:#19171d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #dedce3;border-radius:6px;">
    <tr><td style="background:#7557d8;border-radius:6px 6px 0 0;padding:18px 24px;color:#ffffff;font-size:17px;font-weight:700;">
      ${escapeHtml(cfg.site.name)} · 测试邮件
    </td></tr>
    <tr><td style="padding:20px 24px;font-size:14px;line-height:22px;color:#46424c;">
      <p>很好，系统并没有出现问题。</p>
      <p>当你收到这份邮件，说明推送通道正常。系统会在每天 <strong>${cfg.mail.sendHour}:${String(cfg.mail.sendMinute).padStart(2, '0')}</strong> 发送次日比赛提醒，收信可能稍有延迟。</p>
      <p style="color:#625d68;font-size:13px;">收件地址：${escapeHtml(email)}</p>
    </td></tr>
    <tr><td style="padding:14px 24px;border-top:1px solid #efeff3;font-size:12px;color:#8a8792;">
      ${escapeHtml(cfg.site.footer || '')}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
  return { subject: `【${cfg.site.name}】测试邮件`, html };
}

export function methodLabelOf(method) {
  return METHOD_LABELS[method] || '未知赛制';
}

export function renderCodeMail({ code, purpose, ttlMinutes }) {
  const cfg = getConfig();
  const purposeLabel = purpose === 'reset' ? '找回密码' : '注册账号';
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f7f7f9;font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;color:#19171d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #dedce3;border-radius:6px;">
    <tr><td style="background:#7557d8;border-radius:6px 6px 0 0;padding:18px 24px;color:#ffffff;font-size:17px;font-weight:700;">
      ${escapeHtml(cfg.site.name)} · 邮箱验证码
    </td></tr>
    <tr><td style="padding:22px 24px;font-size:14px;line-height:22px;color:#46424c;">
      <p style="margin:0 0 14px;">你正在进行<strong>${escapeHtml(purposeLabel)}</strong>操作，验证码为：</p>
      <div style="text-align:center;padding:14px;background:#f0ecff;border-radius:6px;font-size:30px;font-weight:700;letter-spacing:8px;color:#5d40bd;">
        ${escapeHtml(code)}
      </div>
      <p style="margin:16px 0 0;color:#625d68;font-size:13px;">验证码 ${ttlMinutes} 分钟内有效，请勿转发给他人。</p>
    </td></tr>
    <tr><td style="padding:14px 24px;border-top:1px solid #efeff3;font-size:12px;color:#8a8792;">
      ${escapeHtml(cfg.site.footer || '')}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
  return { subject: `【${cfg.site.name}】${purposeLabel}验证码`, html };
}
