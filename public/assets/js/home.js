import {
  api, contestBadges, countdownText, debounce, escapeHtml, renderFooter, renderNav, relativeTime, $, toast,
} from './common.js';

const state = {
  boot: null,
  user: null,
  contests: [],
  status: 'upcoming',
  prefs: null,
};

document.addEventListener('click', (event) => {
  if (event.target.matches('[data-close-modal]') || event.target.classList.contains('modal-backdrop')) {
    closeModal();
  }
});

function closeModal() {
  $('#modal-host').innerHTML = '';
  document.body.style.overflow = '';
}

function openModal(html) {
  $('#modal-host').innerHTML = `<div class="modal-backdrop" style="position:fixed;inset:0;background:rgba(25,23,29,.45);z-index:60;display:grid;place-items:center;padding:20px;overflow:auto">
    <div class="card" style="max-width:680px;width:100%;max-height:86vh;overflow:auto">${html}</div>
  </div>`;
  document.body.style.overflow = 'hidden';
}

/* ---------- 渲染：统计与状态 ---------- */

function renderStats(counts, stats) {
  const items = [
    { label: '未开始', value: counts.upcoming, accent: true },
    { label: '进行中', value: counts.running },
    { label: '已结束（近 30 天）', value: counts.ended },
    { label: '本地已收录', value: stats.storeTotal },
    { label: '洛谷列表总数', value: stats.crawl.totalOnLuogu || '-' },
  ];
  $('#stats').innerHTML = items.map((item) => `
    <div class="stat">
      <div class="stat-label">${escapeHtml(item.label)}</div>
      <div class="stat-value ${item.accent ? 'accent' : ''}">${escapeHtml(item.value)}</div>
    </div>`).join('');
}

function renderCrawlStatus(stats) {
  const rows = [
    ['最后抓取', relativeTime(stats.crawl.lastRunAt)],
    ['抓取间隔', `${stats.crawl.intervalMinutes} 分钟`],
    ['数据更新时间', stats.crawl.updatedAt ? new Date(stats.crawl.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '-'],
    ['比赛总数', `${stats.storeTotal} 条`],
    ['服务器日期', stats.today],
  ];
  $('#crawl-status').innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
}

/* ---------- 渲染：比赛列表 ---------- */

function contestCard(contest) {
  const countdown = contest.status === 'upcoming' ? countdownText(contest.startTime) : '';
  const participants = contest.totalParticipants == null ? '' : `报名 ${contest.totalParticipants} 人`;
  return `
  <article class="contest" data-id="${contest.id}">
    <div class="contest-head">
      <div style="min-width:0">
        <div class="contest-badges">${contestBadges(contest)}</div>
        <a class="contest-title" href="${escapeHtml(contest.url)}" target="_blank" rel="noopener" data-open="${contest.id}">${escapeHtml(contest.name)}</a>
      </div>
      <div class="contest-actions">
        ${countdown ? `<span class="badge badge-purple nowrap">${escapeHtml(countdown)}</span>` : ''}
      </div>
    </div>
    <div class="contest-meta">
      <div><span class="k">比赛编号</span><span class="mono">${contest.id}</span></div>
      <div><span class="k">举办者</span><span>${escapeHtml(contest.host?.name || '未知')}</span></div>
      <div><span class="k">开始时间</span><span><span class="nowrap">${escapeHtml(contest.startDateTime)}</span>（${escapeHtml(contest.startWeekday)}）</span></div>
      <div><span class="k">结束时间</span><span><span class="nowrap">${escapeHtml(contest.endDateTime)}</span></span></div>
      <div><span class="k">比赛时长</span><span>${escapeHtml(contest.durationText)}</span></div>
      <div><span class="k">题目数</span><span>${contest.problemCount || '-'}${participants ? ` · ${escapeHtml(participants)}` : ''}</span></div>
    </div>
    ${contest.descriptionExcerpt ? `<p class="contest-desc">${escapeHtml(contest.descriptionExcerpt)}</p>` : ''}
    <div class="row" style="margin-top:12px;gap:8px">
      <button class="btn btn-soft btn-sm" data-detail="${contest.id}">查看详情</button>
      <a class="btn btn-ghost btn-sm" href="${escapeHtml(contest.url)}" target="_blank" rel="noopener">前往洛谷</a>
    </div>
  </article>`;
}

function renderContests() {
  const host = $('#contest-list');
  if (!state.contests.length) {
    host.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><p>当前筛选条件下没有比赛。</p><p class="small muted">如果是第一次运行，请等待后台完成抓取，或点击右上角「刷新列表」。</p></div>';
    return;
  }
  host.innerHTML = state.contests.map(contestCard).join('');
  $('#list-summary').textContent = `共 ${state.contests.length} 条（筛选后）`;
}

async function loadContests() {
  const host = $('#contest-list');
  host.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  const params = new URLSearchParams({
    status: state.status,
    category: $('#filter-category').value,
    method: $('#filter-method').value,
    rated: $('#filter-rated').value === '1' ? '1' : '0',
    limit: '200',
  });
  const query = $('#search').value.trim();
  if (query) params.set('q', query);
  try {
    const res = await api(`/api/contests?${params.toString()}`);
    state.contests = res.contests;
    renderContests();
    renderStats(res.counts, state.boot.stats);
    $('#list-updated').textContent = `数据更新于 ${relativeTime(res.updatedAt)}`;
    $('#page-sub').textContent = `共收录 ${res.total} 条符合条件的比赛 · 服务器日期 ${state.boot.stats.today}`;
    if (res.counts.upcoming) {
      const names = res.contests.filter((c) => c.status === 'upcoming').slice(0, 2).map((c) => c.name);
      if (names.length) $('#page-sub').textContent += ` · 最近：${names[0]}`;
    }
  } catch (err) {
    if (err.status === 401) {
      location.href = '/';
      return;
    }
    host.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function showDetail(id) {
  openModal('<div class="card-body"><div class="skeleton" style="height:200px"></div></div>');
  try {
    const { contest } = await api(`/api/contests/${id}`);
    openModal(`
      <div class="card-head">
        <div>
          <div class="contest-badges">${contestBadges(contest)}</div>
          <h3 style="margin-top:2px">${escapeHtml(contest.name)}</h3>
        </div>
        <button class="btn btn-ghost btn-sm" data-close-modal>关闭</button>
      </div>
      <div class="card-body stack">
        <dl class="kv" style="grid-template-columns:96px 1fr">
          <dt>比赛编号</dt><dd class="mono">${contest.id}</dd>
          <dt>举办者</dt><dd>${escapeHtml(contest.host?.name || '未知')}</dd>
          <dt>比赛类型</dt><dd>${escapeHtml(contest.methodLabel)} · ${escapeHtml(contest.categoryLabel)} · ${contest.isRated ? 'Rated' : 'Unrated'}</dd>
          <dt>开始时间</dt><dd><span class="nowrap">${escapeHtml(contest.startDateTime)}</span>（${escapeHtml(contest.startWeekday)}）</dd>
          <dt>结束时间</dt><dd><span class="nowrap">${escapeHtml(contest.endDateTime)}</span></dd>
          <dt>比赛时长</dt><dd>${escapeHtml(contest.durationText)}</dd>
          <dt>题目数量</dt><dd>${contest.problemCount || '-'}</dd>
          <dt>报名人数</dt><dd>${contest.totalParticipants ?? '未获取'}</dd>
          <dt>状态</dt><dd>${escapeHtml(contest.status)}</dd>
        </dl>
        ${contest.description ? `<div><div class="label" style="margin-bottom:6px">比赛说明（洛谷原文摘要）</div>
          <div class="small" style="color:var(--ink-soft);background:var(--surface);border:1px solid var(--line-soft);border-radius:6px;padding:12px;max-height:240px;overflow:auto;white-space:pre-wrap">${escapeHtml(contest.description.slice(0, 4000))}</div></div>` : ''}
        <div class="row">
          <a class="btn" href="${escapeHtml(contest.url)}" target="_blank" rel="noopener">在洛谷打开</a>
          <button class="btn btn-ghost" data-close-modal>关闭</button>
        </div>
      </div>`);
  } catch (err) {
    openModal(`<div class="card-body"><p>${escapeHtml(err.message)}</p><div class="row" style="margin-top:12px"><button class="btn btn-ghost" data-close-modal>关闭</button></div></div>`);
  }
}

/* ---------- 渲染：订阅设置 ---------- */

function prefCheckbox({ key, label, hint, checked, group }) {
  return `<label class="check ${checked ? 'on' : ''}" data-group="${group}" data-key="${key}">
    <input type="checkbox" ${checked ? 'checked' : ''} data-pref="${key}" data-group="${group}">
    <span><span class="check-title">${escapeHtml(label)}</span>${hint ? `<span class="check-hint">${escapeHtml(hint)}</span>` : ''}</span>
  </label>`;
}

function renderPrefForm() {
  const { scopes, methods } = state.boot;
  const prefs = state.prefs;
  $('#scope-grid').innerHTML = scopes
    .map((s) => prefCheckbox({ key: s.key, label: s.label, hint: s.hint, checked: Boolean(prefs[s.key]), group: 'scope' }))
    .join('');
  $('#method-grid').innerHTML = methods
    .map((m) => prefCheckbox({ key: m.key, label: m.label, hint: '', checked: prefs.methods?.[m.key] !== false, group: 'method' }))
    .join('');
  $('#prefs-enabled').checked = prefs.enabled !== false;
  $('#prefs-recipients').value = (prefs.recipients || []).join(', ');
  $('#prefs-include').value = prefs.includeKeywords || '';
  $('#prefs-exclude').value = prefs.excludeKeywords || '';

  document.querySelectorAll('#scope-grid input, #method-grid input').forEach((input) => {
    input.addEventListener('change', () => {
      input.closest('.check').classList.toggle('on', input.checked);
    });
  });
}

function collectPrefs() {
  const prefs = { ...state.prefs };
  for (const s of state.boot.scopes) {
    prefs[s.key] = Boolean(document.querySelector(`input[data-pref="${s.key}"]`)?.checked);
  }
  prefs.methods = {};
  for (const m of state.boot.methods) {
    prefs.methods[m.key] = Boolean(document.querySelector(`input[data-pref="${m.key}"]`)?.checked);
  }
  prefs.enabled = $('#prefs-enabled').checked;
  prefs.recipients = $('#prefs-recipients').value.split(/[\s,，;；]+/).filter(Boolean);
  prefs.includeKeywords = $('#prefs-include').value.trim();
  prefs.excludeKeywords = $('#prefs-exclude').value.trim();
  return prefs;
}

function renderSummary(described) {
  $('#summary-scopes').innerHTML = described.scopes.map((s) => `<span class="badge badge-purple">${escapeHtml(s)}</span>`).join('');
  $('#summary-methods').innerHTML = described.methods.map((s) => `<span class="badge badge-gray">${escapeHtml(s)}</span>`).join('');
}

async function loadTomorrow() {
  $('#tomorrow-date').textContent = state.boot.tomorrow;
  try {
    const res = await api('/api/tomorrow');
    const body = $('#tomorrow-body');
    if (!res.contests.length) {
      body.innerHTML = '<div class="empty"><div class="empty-icon">🗓️</div><p class="small">次日暂无已收录的比赛。</p></div>';
      return;
    }
    const matchedIds = new Set(res.matched.map((c) => c.id));
    body.innerHTML = `<div class="stack" style="gap:10px">
      <p class="hint">共 ${res.contests.length} 场，其中 ${res.matched.length} 场符合你的订阅条件。</p>
      ${res.contests.map((c) => `
        <div class="row" style="align-items:flex-start;gap:8px">
          <span class="badge ${matchedIds.has(c.id) ? 'badge-green' : 'badge-gray'}" style="margin-top:2px">${matchedIds.has(c.id) ? '会收到' : '不推送'}</span>
          <div style="min-width:0">
            <a class="small" href="${escapeHtml(c.url)}" target="_blank" rel="noopener" style="font-weight:600">${escapeHtml(c.name)}</a>
            <div class="hint mono">${escapeHtml(c.startTimeText)} – ${escapeHtml(c.endTimeText)} · ${escapeHtml(c.methodLabel)}${c.isRated ? ' · Rated' : ''}</div>
          </div>
        </div>`).join('')}
    </div>`;
  } catch (err) {
    $('#tomorrow-body').innerHTML = `<div class="empty"><p class="small">${escapeHtml(err.message)}</p></div>`;
  }
}

/* ---------- 事件绑定 ---------- */

function bindEvents() {
  $('#status-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    state.status = tab.dataset.status;
    document.querySelectorAll('#status-tabs .tab').forEach((el) => el.classList.toggle('active', el === tab));
    loadContests();
  });

  ['#filter-category', '#filter-method', '#filter-rated'].forEach((sel) => {
    $(sel).addEventListener('change', loadContests);
  });
  $('#search').addEventListener('input', debounce(loadContests, 300));

  $('#contest-list').addEventListener('click', (event) => {
    const detailBtn = event.target.closest('[data-detail]');
    if (detailBtn) {
      showDetail(detailBtn.dataset.detail);
      return;
    }
    const open = event.target.closest('[data-open]');
    if (open) {
      event.preventDefault();
      showDetail(open.dataset.open);
    }
  });

  $('#btn-refresh').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '刷新中…';
    try {
      const res = await api('/api/admin/crawl', { method: 'POST' });
      toast(res.message || '抓取完成', 'success');
      await reloadAll();
    } catch (err) {
      toast(err.status === 403 ? '「立即抓取」需要管理员权限，普通用户请等待每小时自动抓取。' : err.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = '刷新列表';
    }
  });

  $('#btn-jump-prefs').addEventListener('click', () => {
    $('#prefs-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#prefs-enabled').focus();
  });

  $('#btn-save-prefs').addEventListener('click', async () => {
    try {
      const res = await api('/api/prefs', { method: 'PUT', body: collectPrefs() });
      state.prefs = res.user.prefs;
      state.user = res.user;
      renderPrefForm();
      renderSummary(res.described);
      toast(res.message || '已保存', 'success');
      $('#prefs-status').textContent = `已保存 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      loadTomorrow();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-test-mail').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '发送中…';
    try {
      const recipients = $('#prefs-recipients').value.split(/[\s,，;；]+/).filter(Boolean);
      const res = await api('/api/mail/test', { method: 'POST', body: { recipients } });
      toast(res.message || '测试邮件已发送', 'success', 6000);
    } catch (err) {
      toast(err.message, 'error', 8000);
    } finally {
      button.disabled = false;
      button.textContent = '发送测试邮件';
    }
  });

  window.addEventListener('hashchange', () => {
    if (location.hash === '#tomorrow') $('#tomorrow').scrollIntoView({ behavior: 'smooth' });
  });
}

async function reloadAll() {
  const boot = await api('/api/bootstrap');
  state.boot = boot;
  state.user = boot.user;
  state.prefs = boot.user?.prefs || null;
  renderStats(boot.counts, boot.stats);
  renderCrawlStatus(boot.stats);
  renderSummary({ scopes: ['-'], methods: ['-'] });
  await loadContests();
  await loadTomorrow();
}

async function init() {
  let boot;
  try {
    boot = await api('/api/bootstrap');
  } catch (err) {
    toast(`初始化失败：${err.message}`, 'error');
    return;
  }
  if (!boot.user) {
    location.href = '/';
    return;
  }
  state.boot = boot;
  state.user = boot.user;
  state.prefs = boot.user.prefs;

  renderNav({ site: boot.config.site, user: boot.user, active: 'home', showAdmin: boot.user.role === 'admin' });

  renderPrefForm();
  renderCrawlStatus(boot.stats);
  renderStats(boot.counts, boot.stats);
  bindEvents();

  try {
    const me = await api('/api/me');
    renderSummary(me.described);
  } catch {
    renderSummary({ scopes: ['-'], methods: ['-'] });
  }

  await loadContests();
  await loadTomorrow();

  if (location.hash === '#tomorrow') $('#tomorrow').scrollIntoView({ behavior: 'smooth' });

  if (!boot.config.smtp.configured && boot.user.role === 'admin') {
    toast('SMTP 尚未配置：请在管理后台填写发件邮箱，否则无法真正发信。', 'error', 9000);
  }

  renderFooter(boot.config.site);
  setInterval(() => { if (!document.hidden) loadContests(); }, 5 * 60 * 1000);
}

init();
