import { getConfig, saveConfig, publicConfig, isSmtpConfigured } from './config.js';
import { db, logStore, pushLog } from './store.js';
import {
  SESSION_COOKIE, consumeCode, createSession, defaultPrefs, destroySession, findUserByEmail,
  getUserById, isValidEmail, issueCode, loginUser, normalizeEmail, registerUser, resetPassword,
  sanitizeUser, serializeUserForCookie, userFromToken, pruneSessions,
} from './auth.js';
import { HttpError, clientIp, parseCookies, readJsonBody, sendError, sendJson } from './http.js';
import { computeStatus, formatInTimezone } from './luogu.js';
import { MailSender } from './mailer.js';
import { renderTestMail } from './mailTemplate.js';
import { normalizePrefs, describePrefs, filterContestsForPrefs, SCOPE_DEFINITIONS, METHOD_OPTIONS } from './subscription.js';
import { queueStore, contestStore } from './store.js';
import { runCrawlJob, runDailySend, statusSnapshot, tomorrowKey, contestsForDayKey, processQueue } from './scheduler.js';
import { timezoneOffsetMinutes } from './config.js';

function requireUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const user = userFromToken(token);
  if (!user) throw new HttpError(401, '请先登录');
  return { user, token };
}

function requireAdmin(req) {
  const { user, token } = requireUser(req);
  if (user.role !== 'admin') throw new HttpError(403, '需要管理员权限');
  return { user, token };
}

function nowSeconds() {
  return contestStore.data.serverTime || Math.floor(Date.now() / 1000);
}

function slimContest(contest) {
  const { description, ...rest } = contest;
  return rest;
}

function filterContests(params) {
  const now = nowSeconds();
  let list = contestStore.data.contests.slice();

  const status = params.get('status') || 'all';
  if (['upcoming', 'running', 'ended'].includes(status)) {
    list = list.filter((c) => computeStatus(c, now) === status);
  }

  const category = params.get('category');
  if (category && category !== 'all') list = list.filter((c) => c.category === category);

  if (params.get('rated') === '1') list = list.filter((c) => c.isRated);
  if (params.get('official') === '1') list = list.filter((c) => c.isOfficial);
  if (params.get('team') === '1') list = list.filter((c) => c.isTeam);

  const method = params.get('method');
  if (method && method !== 'all') list = list.filter((c) => String(c.method) === String(method));

  const day = params.get('date');
  if (day) list = list.filter((c) => c.startDate === day);

  const query = String(params.get('q') || '').trim().toLowerCase();
  if (query) {
    list = list.filter((c) => c.name.toLowerCase().includes(query)
      || String(c.id).includes(query)
      || String(c.host?.name || '').toLowerCase().includes(query));
  }

  const sort = params.get('sort') || 'start';
  if (sort === 'start') list.sort((a, b) => a.startTime - b.startTime);
  else if (sort === 'start-desc') list.sort((a, b) => b.startTime - a.startTime);
  else if (sort === 'id') list.sort((a, b) => b.id - a.id);

  const total = list.length;
  const limit = Math.min(Number(params.get('limit')) || 200, 1000);
  list = list.slice(0, limit);
  return { total, contests: list.map(slimContest) };
}

function contestCounts() {
  const now = nowSeconds();
  const counts = { upcoming: 0, running: 0, ended: 0 };
  for (const c of contestStore.data.contests) counts[computeStatus(c, now)] += 1;
  return counts;
}

/**
 * 只有在反向代理明确告知"这一跳是 HTTPS"时才给 Cookie 加 Secure。
 * 本地用 http://127.0.0.1 直连调试时不会加，否则浏览器会直接丢掉这个 Cookie。
 */
function secureFlag(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https' ? '; Secure' : '';
}

function sessionCookie(req, token, expiresAt) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secureFlag(req)}; Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`;
}

function clearCookie(req) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secureFlag(req)}; Max-Age=0`;
}

function validRecipients(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((e) => normalizeEmail(e)).filter((e) => isValidEmail(e)))].slice(0, 50);
}

export async function handleApi(req, res, url) {
  const pathname = url.pathname.replace(/\/+$/, '') || '/api';

  try {
    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const user = userFromToken(token);
      sendJson(res, 200, {
        ok: true,
        config: publicConfig(),
        user: sanitizeUser(user),
        scopes: SCOPE_DEFINITIONS,
        methods: METHOD_OPTIONS,
        counts: contestCounts(),
        stats: statusSnapshot(),
        serverTime: nowSeconds(),
        tomorrow: tomorrowKey(),
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/code') {
      const body = await readJsonBody(req);
      const result = await issueCode(body.email, body.purpose === 'reset' ? 'reset' : 'register');
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/register') {
      const body = await readJsonBody(req);
      const user = registerUser({ email: body.email, password: body.password, code: body.code });
      const session = createSession(user.id, { ip: clientIp(req), ua: req.headers['user-agent'] || '' });
      sendJson(res, 200, { ok: true, user: sanitizeUser(user) }, {
        'set-cookie': [sessionCookie(req, session.token, session.expiresAt)],
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJsonBody(req);
      const user = loginUser({ email: body.email, password: body.password });
      const session = createSession(user.id, { ip: clientIp(req), ua: req.headers['user-agent'] || '' });
      sendJson(res, 200, { ok: true, user: sanitizeUser(user) }, {
        'set-cookie': [sessionCookie(req, session.token, session.expiresAt)],
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/reset') {
      const body = await readJsonBody(req);
      const user = resetPassword({ email: body.email, code: body.code, password: body.password });
      sendJson(res, 200, { ok: true, message: '密码已重置，请使用新密码登录。', user: sanitizeUser(user) });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      destroySession(token);
      sendJson(res, 200, { ok: true }, { 'set-cookie': [clearCookie(req)] });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      const { user } = requireUser(req);
      sendJson(res, 200, { ok: true, user: sanitizeUser(user), described: describePrefs(normalizePrefs(user.prefs, user.prefs)) });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/contests') {
      const { total, contests } = filterContests(url.searchParams);
      sendJson(res, 200, {
        ok: true,
        total,
        contests,
        counts: contestCounts(),
        updatedAt: contestStore.data.updatedAt,
        serverTime: nowSeconds(),
      });
      return true;
    }

    const contestMatch = pathname.match(/^\/api\/contests\/(\d+)$/);
    if (req.method === 'GET' && contestMatch) {
      const id = Number(contestMatch[1]);
      const contest = contestStore.data.contests.find((c) => c.id === id);
      if (!contest) throw new HttpError(404, '未找到该比赛，请稍后重试或先执行一次抓取');
      sendJson(res, 200, { ok: true, contest: { ...contest, status: computeStatus(contest, nowSeconds()) } });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/tomorrow') {
      const date = tomorrowKey();
      const contests = contestsForDayKey(date);
      const { user } = requireUser(req);
      const prefs = normalizePrefs(user.prefs, defaultPrefs());
      // 预览用的订阅命中列表：即使用户还没填收件邮箱也先展示效果
      const probePrefs = { ...prefs, recipients: prefs.recipients.length ? prefs.recipients : ['preview@local'] };
      sendJson(res, 200, {
        ok: true,
        date,
        contests: contests.map(slimContest),
        matched: filterContestsForPrefs(probePrefs, contests).map(slimContest),
      });
      return true;
    }

    if (req.method === 'PUT' && pathname === '/api/prefs') {
      const { user } = requireUser(req);
      const body = await readJsonBody(req);
      if (body.recipients !== undefined) body.recipients = validRecipients(body.recipients);
      user.prefs = normalizePrefs(body, { ...defaultPrefs(), ...user.prefs, methods: user.prefs?.methods });
      db.schedule();
      sendJson(res, 200, {
        ok: true,
        user: sanitizeUser(user),
        described: describePrefs(user.prefs),
        message: '订阅设置已保存',
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/mail/test') {
      const { user } = requireUser(req);
      const body = await readJsonBody(req);
      const targets = validRecipients(body.recipients?.length ? body.recipients : user.prefs?.recipients);
      if (targets.length === 0) throw new HttpError(400, '请先填写至少一个收件邮箱');
      if (!isSmtpConfigured()) throw new HttpError(400, 'SMTP 尚未配置：请先在管理后台填写发件邮箱并保存');
      const { subject, html } = renderTestMail({ email: targets.join(', ') });
      const sender = new MailSender();
      try {
        const result = await sender.send({ recipients: targets, subject, html });
        pushLog('mail', { type: 'test', to: targets.join(','), ok: true });
        sendJson(res, 200, { ok: true, message: `测试邮件已通过 Bcc 发送给 ${targets.length} 个地址`, response: result.response });
      } finally {
        sender.dropClient();
      }
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/admin/smtp') {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const patch = { smtp: {} };
      if (typeof body.user === 'string') patch.smtp.user = body.user.trim();
      if (typeof body.pass === 'string' && body.pass.trim()) patch.smtp.pass = body.pass.trim();
      if (typeof body.fromName === 'string') patch.smtp.fromName = body.fromName.trim();
      if (typeof body.sendHour === 'number') patch.mail = { ...(patch.mail || {}), sendHour: Math.max(0, Math.min(23, Math.floor(body.sendHour))) };
      if (typeof body.perMinute === 'number') patch.mail = { ...(patch.mail || {}), perMinute: Math.max(1, Math.min(60, Math.floor(body.perMinute))) };
      const cfg = saveConfig(patch);
      sendJson(res, 200, { ok: true, config: publicConfig(), message: '配置已保存（写入 config.json）', smtp: cfg.smtp.user });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/admin/verify-smtp') {
      requireAdmin(req);
      const sender = new MailSender();
      try {
        const result = await sender.verify();
        sendJson(res, 200, { ok: true, message: `SMTP 登录成功：${result.account}`, result });
      } finally {
        sender.dropClient();
      }
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/admin/crawl') {
      requireAdmin(req);
      const result = await runCrawlJob({ force: true, throwOnError: true });
      sendJson(res, 200, { ok: true, message: `抓取完成：新增/更新 ${result.stored} 条，未开始 ${result.upcoming} 条`, result: { stored: result.stored, upcoming: result.upcoming, detailsFetched: result.detailsFetched } });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/admin/send') {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const result = await runDailySend({
        dateKey: typeof body.dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.dateKey) ? body.dateKey : undefined,
        dryRun: Boolean(body.dryRun),
      });
      sendJson(res, 200, {
        ok: true,
        message: body.dryRun
          ? `演练完成：${result.targetDate} 共 ${result.contestCount} 场比赛，${result.queued} 封邮件待发送`
          : `推送完成：入队 ${result.queued} 封，成功 ${result.sent ?? 0} 封，失败 ${result.failed ?? 0} 封`,
        result,
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/admin/process-queue') {
      requireAdmin(req);
      const result = await processQueue();
      sendJson(res, 200, { ok: true, message: `队列处理完成：成功 ${result.sent ?? 0}，失败 ${result.failed ?? 0}`, result });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/admin/status') {
      const { user: actor } = requireAdmin(req);
      sendJson(res, 200, {
        ok: true,
        stats: statusSnapshot(),
        config: publicConfig(),
        smtpConfigured: isSmtpConfigured(),
        crawlLogs: logStore.data.crawl.slice(0, 20),
        mailLogs: logStore.data.mail.slice(0, 30),
        queue: {
          pending: queueStore.data.items.filter((i) => i.status === 'pending').length,
          items: queueStore.data.items.slice(-20).map((i) => ({
            id: i.id, userEmail: i.userEmail, recipients: i.recipients, status: i.status,
            contestCount: i.contestCount, error: i.error || null, sentAt: i.sentAt || null,
          })),
        },
        users: db.data.users.map((u) => ({
          id: u.id, email: u.email, role: u.role || 'user', createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
          verified: Boolean(u.verified),
          recipients: u.prefs?.recipients || [], described: describePrefs(normalizePrefs(u.prefs, defaultPrefs())),
          isSelf: u.id === actor.id,
        })),
        localTime: formatInTimezone(nowSeconds(), timezoneOffsetMinutes(getConfig())),
      });
      return true;
    }

    const userRoleMatch = pathname.match(/^\/api\/admin\/users\/([A-Za-z0-9_-]+)\/role$/);
    if (req.method === 'POST' && userRoleMatch) {
      const { user: actor } = requireAdmin(req);
      const id = userRoleMatch[1];
      const body = await readJsonBody(req);
      if (!['admin', 'user'].includes(body.role)) throw new HttpError(400, 'role 只能是 admin 或 user');
      const target = getUserById(id);
      if (!target) throw new HttpError(404, '用户不存在或已被删除');
      if (target.id === actor.id) throw new HttpError(400, '不能修改当前登录账号的角色，请用另一个管理员操作');

      const current = target.role || 'user';
      if (current === body.role) {
        sendJson(res, 200, { ok: true, message: `${target.email} 已经是${body.role === 'admin' ? '管理员' : '普通用户'}了` });
        return true;
      }
      if (current === 'admin' && body.role === 'user') {
        const adminCount = db.data.users.filter((u) => (u.role || 'user') === 'admin').length;
        if (adminCount <= 1) throw new HttpError(400, '至少需要保留一个管理员账号');
      }

      db.update((data) => {
        const user = data.users.find((u) => u.id === id);
        if (user) user.role = body.role;
      });
      pushLog('mail', { type: 'user-role', to: target.email, role: body.role, by: actor.email, ok: true });
      sendJson(res, 200, { ok: true, message: `已将 ${target.email} 设为${body.role === 'admin' ? '管理员' : '普通用户'}` });
      return true;
    }

    const userMatch = pathname.match(/^\/api\/admin\/users\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'DELETE' && userMatch) {
      const { user: actor } = requireAdmin(req);
      const id = userMatch[1];
      const target = getUserById(id);
      if (!target) throw new HttpError(404, '用户不存在或已被删除');
      if (target.id === actor.id) throw new HttpError(400, '不能删除当前登录的管理员账号');

      const adminCount = db.data.users.filter((u) => (u.role || 'user') === 'admin').length;
      if ((target.role || 'user') === 'admin' && adminCount <= 1) {
        throw new HttpError(400, '至少需要保留一个管理员账号');
      }

      const email = normalizeEmail(target.email);
      db.update((data) => {
        data.users = data.users.filter((u) => u.id !== id);
        data.sessions = data.sessions.filter((s) => s.userId !== id);
        data.codes = data.codes.filter((c) => normalizeEmail(c.email) !== email);
      });
      queueStore.update((data) => {
        data.items = data.items.filter((i) => i.userId !== id);
      });
      queueStore.save();
      pushLog('mail', { type: 'user-delete', to: email, ok: true, by: actor.email });
      sendJson(res, 200, {
        ok: true,
        message: `已删除用户 ${email}（其会话、验证码与待发队列一并清除）`,
        users: db.data.users.length,
      });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/admin/logs') {
      requireAdmin(req);
      sendJson(res, 200, { ok: true, crawl: logStore.data.crawl.slice(0, 50), mail: logStore.data.mail.slice(0, 50) });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, uptime: process.uptime(), smtpConfigured: isSmtpConfigured(), now: new Date().toISOString() });
      return true;
    }

    sendJson(res, 404, { ok: false, error: '接口不存在' });
    return true;
  } catch (err) {
    sendError(res, err);
    return true;
  }
}

export function bootstrapHousekeeping() {
  pruneSessions();
  setInterval(pruneSessions, 3600000).unref();
}
