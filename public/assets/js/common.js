/* STAL 前端公共工具 */

export async function api(path, { method = 'GET', body, headers } = {}) {
  const init = {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(headers || {}) },
    credentials: 'same-origin',
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || (data && data.ok === false)) {
    const message = (data && data.error) || `请求失败（HTTP ${res.status}）`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data || {};
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

let toastHost = null;

export function toast(message, type = 'info', timeout = 4200) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'err' : type === 'success' ? 'ok' : ''}`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(12px)';
    el.style.transition = 'all 200ms ease';
    setTimeout(() => el.remove(), 220);
  }, timeout);
}

/* ---------- 徽标 ---------- */

const STATUS_CLASS = { upcoming: 'badge-amber', running: 'badge-green', ended: 'badge-gray' };
export const STATUS_TEXT = { upcoming: '未开始', running: '进行中', ended: '已结束' };

export function statusBadge(status) {
  return `<span class="badge ${STATUS_CLASS[status] || 'badge-gray'}">${STATUS_TEXT[status] || status}</span>`;
}

export function contestBadges(contest) {
  const out = [statusBadge(contest.status)];
  out.push(`<span class="badge badge-solid">${escapeHtml(contest.methodLabel)}</span>`);
  if (contest.isOfficial) out.push('<span class="badge badge-red">官方比赛</span>');
  else out.push(`<span class="badge badge-purple">${escapeHtml(contest.categoryLabel)}</span>`);
  out.push(contest.isRated
    ? '<span class="badge badge-green">Rated</span>'
    : '<span class="badge badge-gray">Unrated</span>');
  if (contest.isTeam) out.push('<span class="badge badge-amber">组队赛</span>');
  return out.join('');
}

/* ---------- 时间 ---------- */

export function countdownText(startTimeSeconds) {
  const diff = startTimeSeconds - Math.floor(Date.now() / 1000);
  if (diff <= 0) return '';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟后开始`;
  if (diff < 86400) return `${(diff / 3600).toFixed(1)} 小时后开始`;
  return `${(diff / 86400).toFixed(1)} 天后开始`;
}

export function relativeTime(iso) {
  if (!iso) return '-';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '-';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/* ---------- 导航 ---------- */

export function renderNav({ site, user, active = 'home', showAdmin = false }) {
  const nav = document.createElement('header');
  nav.className = 'nav';
  nav.innerHTML = `
    <div class="container">
      <a class="brand" href="${user ? '/home.html' : '/'}">
        <img class="brand-mark" src="/assets/img/logo.svg" alt="${escapeHtml(site?.name || 'STAL')}" width="30" height="30">
        <span>${escapeHtml(site?.name || 'STAL')}</span>
      </a>
      <nav class="nav-links">
        ${user ? `
          <a class="nav-link ${active === 'home' ? 'active' : ''}" href="/home.html">主页</a>
          <a class="nav-link ${active === 'tomorrow' ? 'active' : ''}" href="/home.html#tomorrow">明日预告</a>
          ${showAdmin ? `<a class="nav-link ${active === 'admin' ? 'active' : ''}" href="/admin.html">管理后台</a>` : ''}
          <span class="nav-link muted small nowrap" title="${escapeHtml(user.email)}">${escapeHtml(user.email.split('@')[0])}${user.role === 'admin' ? ' · 管理员' : ''}</span>
          <button class="btn btn-ghost btn-sm" id="nav-logout">退出</button>
        ` : '<a class="nav-link" href="/">登录 / 注册</a>'}
      </nav>
    </div>`;
  document.body.prepend(nav);
  const logout = nav.querySelector('#nav-logout');
  if (logout) {
    logout.addEventListener('click', async () => {
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch { /* 忽略 */ }
      location.href = '/';
    });
  }
  return nav;
}

export function renderFooter(site) {
  const footer = document.createElement('footer');
  footer.className = 'footer';
  footer.innerHTML = `<div class="container row-between">
    <span>${escapeHtml(site?.footer || '')}</span>
    <span class="small">数据来源：<a href="https://www.luogu.com.cn/contest/list" target="_blank" rel="noopener">洛谷比赛列表</a> · 本站与洛谷官方无关联</span>
  </div>`;
  document.body.appendChild(footer);
}

export function debounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
