import { api, escapeHtml, renderFooter, renderNav, relativeTime, $, toast } from './common.js';

let boot = null;
let status = null;
let logTab = 'mail';

function renderStats() {
  const s = status.stats;
  const items = [
    { label: '未开始', value: s.counts.upcoming, accent: true },
    { label: '进行中', value: s.counts.running },
    { label: '已结束（近 30 天）', value: s.counts.ended },
    { label: '队列待发', value: s.queue.pending },
    { label: '今日已发', value: s.queue.dailySent },
    { label: '今日失败', value: s.queue.dailyFailed },
  ];
  $('#admin-stats').innerHTML = items.map((i) => `
    <div class="stat"><div class="stat-label">${escapeHtml(i.label)}</div>
    <div class="stat-value ${i.accent ? 'accent' : ''}">${escapeHtml(i.value)}</div></div>`).join('');
}

function renderStatus() {
  const s = status.stats;
  const rows = [
    ['服务器日期', s.today],
    ['次日推送日期', s.tomorrow],
    ['本地比赛数', `${s.storeTotal} 条`],
    ['最近抓取', relativeTime(s.crawl.lastRunAt)],
    ['最近抓取结果', s.crawl.lastOk === null ? '-' : s.crawl.lastOk ? '成功' : '失败'],
    ['数据更新时间', s.crawl.updatedAt ? new Date(s.crawl.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '-'],
    ['抓取间隔', `${s.crawl.intervalMinutes} 分钟`],
    ['洛谷列表总数', s.crawl.totalOnLuogu || '-'],
    ['队列最后运行', relativeTime(s.queue.lastRunAt)],
    ['最近日报推送', s.queue.lastDigestAt ? `${new Date(s.queue.lastDigestAt).toLocaleString('zh-CN', { hour12: false })} → 目标 ${s.queue.lastDigestTargetDate || '-'}` : '-'],
    ['发送队列日期', s.queue.dailyDate || '-'],
    ['SMTP', status.smtpConfigured ? '已配置' : '未配置'],
    ['服务器本地时间', status.localTime?.dateTime || '-'],
  ];
  $('#status-kv').innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
}

function renderQueue() {
  const items = status.queue.items.slice().reverse();
  $('#queue-hint').textContent = `待发 ${status.queue.pending} 封`;
  const body = $('#queue-body');
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted small">队列为空（每日推送时才会生成）。</td></tr>';
    return;
  }
  body.innerHTML = items.map((i) => {
    const cls = i.status === 'sent' ? 'badge-green' : i.status === 'failed' ? 'badge-red' : i.status === 'pending' ? 'badge-amber' : 'badge-gray';
    return `<tr>
      <td class="mono small">${escapeHtml(i.userEmail || '-')}</td>
      <td class="small">${escapeHtml((i.recipients || []).join(', '))}</td>
      <td>${i.contestCount ?? '-'}</td>
      <td><span class="badge ${cls}">${escapeHtml(i.status)}</span>${i.error ? `<div class="hint hint-error">${escapeHtml(i.error.slice(0, 80))}</div>` : ''}</td>
      <td class="small mono">${i.sentAt ? new Date(i.sentAt).toLocaleString('zh-CN', { hour12: false }) : '-'}</td>
    </tr>`;
  }).join('');
}

function renderUsers() {
  $('#user-count').textContent = `共 ${status.users.length} 个账号`;
  $('#users-body').innerHTML = status.users.map((u) => `<tr>
    <td class="mono small">${escapeHtml(u.email)}</td>
    <td><span class="badge ${u.role === 'admin' ? 'badge-purple' : 'badge-gray'}">${escapeHtml(u.role)}</span></td>
    <td class="small">${u.recipients?.length ? escapeHtml(u.recipients.join(', ')) : '<span class="muted">未设置</span>'}</td>
    <td class="small nowrap">${u.createdAt ? new Date(u.createdAt).toLocaleDateString('zh-CN') : '-'}</td>
    <td class="small nowrap">${relativeTime(u.lastLoginAt)}</td>
    <td class="nowrap">
      ${u.isSelf
        ? '<span class="hint">当前账号</span>'
        : `<button class="btn btn-ghost btn-sm" data-role-user="${escapeHtml(u.id)}" data-role="${u.role === 'admin' ? 'user' : 'admin'}" data-email="${escapeHtml(u.email)}">${u.role === 'admin' ? '取消管理员' : '设为管理员'}</button>
           <button class="btn btn-ghost btn-sm" data-del-user="${escapeHtml(u.id)}" data-email="${escapeHtml(u.email)}">删除</button>`}
    </td>
  </tr>`).join('') || '<tr><td colspan="6" class="muted small">暂无用户</td></tr>';
}

async function changeRole(button) {
  const email = button.dataset.email;
  const role = button.dataset.role;
  const label = role === 'admin' ? '设为管理员' : '取消管理员';
  if (!window.confirm(`确定把 ${email} ${label}吗？`)) return;
  button.disabled = true;
  try {
    const res = await api(`/api/admin/users/${encodeURIComponent(button.dataset.roleUser)}/role`, {
      method: 'POST',
      body: { role },
    });
    toast(res.message || '已更新', 'success', 6000);
    await load();
  } catch (err) {
    toast(err.message, 'error', 9000);
    button.disabled = false;
  }
}

async function deleteUser(button) {
  const email = button.dataset.email;
  if (!window.confirm(`确定删除账号 ${email} 吗？\n该用户的登录状态、验证码与待发邮件都会一并清除，且无法恢复。`)) return;
  button.disabled = true;
  try {
    const res = await api(`/api/admin/users/${encodeURIComponent(button.dataset.delUser)}`, { method: 'DELETE' });
    toast(res.message || '已删除', 'success', 6000);
    await load();
  } catch (err) {
    toast(err.message, 'error', 9000);
    button.disabled = false;
  }
}

function renderLogs() {
  const list = logTab === 'mail' ? status.mailLogs : status.crawlLogs;
  if (!list.length) {
    $('#log-body').textContent = '（暂无日志）';
    return;
  }
  $('#log-body').textContent = list.map((entry) => `${new Date(entry.at).toLocaleString('zh-CN', { hour12: false })}  ${JSON.stringify(entry, (k, v) => (k === 'at' ? undefined : v))}`).join('\n');
}

function fillConfigForm() {
  const c = status.config;
  $('#smtp-user').value = c.smtp.user || '';
  $('#smtp-pass').value = '';
  $('#smtp-pass').placeholder = status.smtpConfigured ? '留空表示不修改（已配置）' : '例如 abcdefghijklmnop';
  $('#smtp-from').value = c.smtp.fromName || '';
  $('#smtp-hour').value = c.mail.sendHour;
  $('#smtp-rate').value = c.mail.perMinute;
  $('#smtp-hint').innerHTML = status.smtpConfigured
    ? '<div class="notice notice-info"><span>✓</span><div>SMTP 已配置，验证码邮件与每日推送都可以正常发信。</div></div>'
    : '<div class="notice notice-danger"><span>⚠</span><div>SMTP 未配置：验证码邮件与每日推送都无法发出，请先填写发件邮箱与授权码。</div></div>';
}

/* ---------- 主流程 ---------- */

async function load() {
  status = await api('/api/admin/status');
  renderStats();
  renderStatus();
  renderQueue();
  renderUsers();
  renderLogs();
  fillConfigForm();
}

async function runAction(button, label, path, body, successMessage) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '执行中…';
  try {
    const res = await api(path, { method: 'POST', body: body || {} });
    toast(successMessage || res.message || '完成', 'success', 7000);
  } catch (err) {
    toast(err.message, 'error', 9000);
  } finally {
    button.disabled = false;
    button.textContent = original;
    await load();
  }
}

async function init() {
  boot = await api('/api/bootstrap');
  if (!boot.user) { location.href = '/'; return; }
  if (boot.user.role !== 'admin') { location.href = '/home.html'; return; }

  renderNav({ site: boot.config.site, user: boot.user, active: 'admin' });
  renderFooter(boot.config.site);

  await load();

  $('#btn-crawl').addEventListener('click', (e) => runAction(e.currentTarget, '抓取', '/api/admin/crawl', {}));
  $('#btn-dry').addEventListener('click', (e) => runAction(e.currentTarget, '演练', '/api/admin/send', { dryRun: true }));
  $('#btn-send').addEventListener('click', (e) => runAction(e.currentTarget, '推送', '/api/admin/send', { dryRun: false }));
  $('#btn-queue').addEventListener('click', (e) => runAction(e.currentTarget, '处理队列', '/api/admin/process-queue', {}));

  $('#btn-save-smtp').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const res = await api('/api/admin/smtp', {
        method: 'POST',
        body: {
          user: $('#smtp-user').value.trim(),
          pass: $('#smtp-pass').value,
          fromName: $('#smtp-from').value.trim(),
          sendHour: Number($('#smtp-hour').value),
          perMinute: Number($('#smtp-rate').value),
        },
      });
      toast(res.message || '配置已保存', 'success');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('#btn-verify-smtp').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '登录中…';
    try {
      const res = await api('/api/admin/verify-smtp', { method: 'POST' });
      toast(res.message, 'success');
    } catch (err) {
      toast(err.message, 'error', 9000);
    } finally {
      button.disabled = false;
      button.textContent = '测试 SMTP 登录';
    }
  });

  $('#users-body').addEventListener('click', (event) => {
    const del = event.target.closest('[data-del-user]');
    if (del) { deleteUser(del); return; }
    const role = event.target.closest('[data-role-user]');
    if (role) changeRole(role);
  });

  $('#log-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    logTab = tab.dataset.log;
    document.querySelectorAll('#log-tabs .tab').forEach((el) => el.classList.toggle('active', el === tab));
    renderLogs();
  });

  setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 30000);
}

init().catch((err) => toast(`初始化失败：${err.message}`, 'error'));
