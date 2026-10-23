import crypto from 'node:crypto';
import { db, randomId, pushLog } from './store.js';
import { getConfig, isSmtpConfigured } from './config.js';
import { HttpError } from './http.js';
import { MailSender } from './mailer.js';
import { renderCodeMail } from './mailTemplate.js';

export const SESSION_COOKIE = 'stal_session';
const MAX_CODE_ATTEMPTS = 5;

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || ''));
}

export function defaultPrefs() {
  return {
    enabled: true,
    recipients: [],
    notifyOfficial: true,
    notifyRated: true,
    notifyTeam: false,
    notifyPersonal: false,
    notifyOther: false,
    methods: { oi: true, ioi: true, acm: false },
    includeKeywords: '',
    excludeKeywords: '',
  };
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}

export function verifyPassword(password, user) {
  if (!user?.salt || !user?.hash) return false;
  const candidate = Buffer.from(crypto.scryptSync(String(password), user.salt, 64).toString('hex'), 'hex');
  const expected = Buffer.from(user.hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function findUserByEmail(email) {
  const target = normalizeEmail(email);
  return db.data.users.find((u) => u.email === target) || null;
}

export function getUserById(id) {
  return db.data.users.find((u) => u.id === id) || null;
}

export function createSession(userId, meta = {}) {
  const cfg = getConfig();
  const token = randomId(32);
  const now = Date.now();
  const expiresAt = now + (cfg.auth.sessionDays || 14) * 86400000;
  db.update((data) => {
    data.sessions = data.sessions.filter((s) => s.expiresAt > now);
    data.sessions.push({ token, userId, createdAt: now, expiresAt, ...meta });
  });
  return { token, expiresAt };
}

export function destroySession(token) {
  if (!token) return;
  db.update((data) => {
    data.sessions = data.sessions.filter((s) => s.token !== token);
  });
}

export function userFromToken(token) {
  if (!token) return null;
  const now = Date.now();
  const session = db.data.sessions.find((s) => s.token === token);
  if (!session || session.expiresAt <= now) return null;
  return getUserById(session.userId);
}

export function pruneSessions() {
  const now = Date.now();
  db.update((data) => {
    data.sessions = data.sessions.filter((s) => s.expiresAt > now);
    data.codes = data.codes.filter((c) => c.expiresAt > now - 86400000);
  });
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function assertPassword(password) {
  const cfg = getConfig();
  const min = cfg.auth.minPasswordLength || 8;
  const value = String(password || '');
  if (value.length < min) throw new HttpError(400, `密码长度至少为 ${min} 位`);
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) {
    throw new HttpError(400, '密码需要同时包含字母和数字');
  }
}

/**
 * 生成并通过 SMTP 发送验证码。
 *
 * 安全约定：只有把 config.json 的 auth.showCodeInResponse 显式设为 true（本地调试时用），
 * 接口才会把验证码回显到响应体里；默认情况下验证码只出现在服务器控制台。
 * 否则任何人只要发现站点还没配 SMTP，就能替别人拿到验证码。
 */
export async function issueCode(rawEmail, purpose) {
  const cfg = getConfig();
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) throw new HttpError(400, '邮箱格式不正确');
  if (!['register', 'reset'].includes(purpose)) throw new HttpError(400, '未知的验证码用途');

  const user = findUserByEmail(email);
  if (purpose === 'register') {
    if (!cfg.auth.allowRegistration) throw new HttpError(403, '当前已关闭注册');
    if (user) throw new HttpError(409, '该邮箱已经注册，请直接登录');
  }
  if (purpose === 'reset' && !user) {
    throw new HttpError(404, '该邮箱尚未注册');
  }

  const now = Date.now();
  const history = db.data.codes.filter((c) => c.email === email && c.purpose === purpose);
  const latest = history.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
  const cooldown = (cfg.auth.codeCooldownSeconds || 60) * 1000;
  if (latest && now - latest.createdAt < cooldown) {
    throw new HttpError(429, `请求过于频繁，请 ${Math.ceil((cooldown - (now - latest.createdAt)) / 1000)} 秒后再试`);
  }
  if (history.filter((c) => now - c.createdAt < 3600000).length >= (cfg.auth.codeMaxPerHour || 6)) {
    throw new HttpError(429, '该邮箱一小时内获取验证码次数过多，请稍后再试');
  }

  const code = generateCode();
  const ttl = (cfg.auth.codeTtlMinutes || 10) * 60000;
  db.update((data) => {
    data.codes = data.codes.filter((c) => c.expiresAt > now);
    data.codes.push({ id: randomId(8), email, purpose, code, createdAt: now, expiresAt: now + ttl, attempts: 0, usedAt: null });
  });

  if (!isSmtpConfigured()) {
    const echo = cfg.auth.showCodeInResponse === true;
    console.warn(`[auth] SMTP 未配置，${email} 的${purpose}验证码为: ${code}`);
    pushLog('mail', { type: 'code', to: email, purpose, ok: false, error: 'SMTP 未配置，验证码仅输出到服务器控制台' });
    return {
      delivered: false,
      ...(echo ? { devCode: code } : {}),
      message: echo
        ? 'SMTP 尚未配置，验证码已打印到服务器控制台并回显在此（仅用于本地调试）。'
        : 'SMTP 尚未配置，验证码无法通过邮件发送。请联系站点管理员配置发件邮箱。',
    };
  }

  const { subject, html } = renderCodeMail({ code, purpose, ttlMinutes: cfg.auth.codeTtlMinutes || 10 });
  const sender = new MailSender();
  try {
    await sender.send({ recipients: [email], subject, html });
    pushLog('mail', { type: 'code', to: email, purpose, ok: true });
    return { delivered: true, message: '验证码已发送，请查收邮件（含垃圾箱）。' };
  } finally {
    sender.dropClient();
  }
}

export function consumeCode(rawEmail, purpose, rawCode) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode || '').trim();
  const now = Date.now();
  const entry = db.data.codes
    .filter((c) => c.email === email && c.purpose === purpose && !c.usedAt)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  if (!entry) throw new HttpError(400, '请先获取验证码');
  if (entry.expiresAt < now) throw new HttpError(400, '验证码已过期，请重新获取');
  if (entry.attempts >= MAX_CODE_ATTEMPTS) throw new HttpError(429, '验证码错误次数过多，请重新获取');
  if (entry.code !== code) {
    entry.attempts += 1;
    db.schedule();
    throw new HttpError(400, '验证码不正确');
  }
  entry.usedAt = now;
  db.schedule();
  return true;
}

export function registerUser({ email, password, code }) {
  const target = normalizeEmail(email);
  consumeCode(target, 'register', code);
  if (findUserByEmail(target)) throw new HttpError(409, '该邮箱已经注册');
  assertPassword(password);
  const { salt, hash } = hashPassword(password);
  const adminEmail = String(getConfig().auth.adminEmail || '').trim().toLowerCase();
  const isFirstUser = db.data.users.length === 0;
  const user = {
    id: randomId(12),
    role: isFirstUser || (adminEmail && target === adminEmail) ? 'admin' : 'user',
    email: target,
    salt,
    hash,
    createdAt: Date.now(),
    verified: true,
    // 新账号默认把注册邮箱填成收件人，省得用户自己再输一遍
    prefs: { ...defaultPrefs(), recipients: [target] },
    recipientsInitialized: true,
    lastLoginAt: null,
  };
  db.update((data) => {
    data.users.push(user);
  });
  return user;
}

/**
 * 首次登录时把注册邮箱自动填成默认收件人（只补一次）。
 * 之后用户无论怎么改（包括清空）都不会再被覆盖。
 */
function ensureDefaultRecipient(user) {
  if (user.recipientsInitialized) return;
  user.recipientsInitialized = true;
  if (!Array.isArray(user.prefs?.recipients) || user.prefs.recipients.length === 0) {
    user.prefs = { ...defaultPrefs(), ...(user.prefs || {}), recipients: [user.email] };
  }
  db.schedule();
}

export function loginUser({ email, password }) {
  const user = findUserByEmail(email);
  if (!user || !verifyPassword(password, user)) throw new HttpError(401, '邮箱或密码不正确');
  ensureDefaultRecipient(user);
  user.lastLoginAt = Date.now();
  db.schedule();
  return user;
}

export function resetPassword({ email, code, password }) {
  const target = normalizeEmail(email);
  consumeCode(target, 'reset', code);
  const user = findUserByEmail(target);
  if (!user) throw new HttpError(404, '该邮箱尚未注册');
  assertPassword(password);
  const { salt, hash } = hashPassword(password);
  user.salt = salt;
  user.hash = hash;
  user.passwordChangedAt = Date.now();
  db.update((data) => {
    data.sessions = data.sessions.filter((s) => s.userId !== user.id);
  });
  return user;
}

export function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    role: user.role || 'user',
    email: user.email,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    verified: Boolean(user.verified),
    prefs: user.prefs,
  };
}

export function serializeUserForCookie(user, session) {
  return `${SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((session.expiresAt - Date.now()) / 1000)}`;
}
