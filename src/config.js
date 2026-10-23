import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const publicDir = path.join(rootDir, 'public');
export const dataDir = process.env.STAL_DATA_DIR
  ? path.resolve(process.env.STAL_DATA_DIR)
  : path.join(rootDir, 'data');
export const configPath = process.env.STAL_CONFIG
  ? path.resolve(process.env.STAL_CONFIG)
  : path.join(rootDir, 'config.json');
const examplePath = path.join(rootDir, 'config.example.json');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const FALLBACK_CONFIG = {
  server: { host: '127.0.0.1', port: 3000, sessionSecret: '' },
  site: { name: 'STAL 洛谷比赛订阅', tagline: '', footer: '' },
  smtp: { host: 'smtp.qq.com', port: 465, user: '', pass: '', fromName: '洛谷比赛订阅', bccToSender: false, timeoutMs: 30000 },
  mail: {
    timezoneOffsetMinutes: 480, sendHour: 20, sendMinute: 0, perMinute: 5, dailyLimit: 200,
    onlyTomorrow: true, matchMode: 'start', subjectTemplate: '【洛谷比赛提醒】{date} 共 {count} 场比赛',
  },
  crawl: {
    intervalMinutes: 60, maxPages: 4, detailLimit: 80, requestIntervalMs: 400, timeoutMs: 20000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    officialHostIds: [1000],
  },
  auth: {
    codeTtlMinutes: 10, codeCooldownSeconds: 60, codeMaxPerHour: 6, sessionDays: 14,
    minPasswordLength: 8, allowRegistration: true, showCodeInResponse: false,
  },
};

function applyEnvOverrides(cfg) {
  if (process.env.STAL_PORT) cfg.server.port = Number(process.env.STAL_PORT);
  if (process.env.STAL_HOST) cfg.server.host = process.env.STAL_HOST;
  if (process.env.STAL_SESSION_SECRET) cfg.server.sessionSecret = process.env.STAL_SESSION_SECRET;
  if (process.env.STAL_SMTP_USER) cfg.smtp.user = process.env.STAL_SMTP_USER;
  if (process.env.STAL_SMTP_PASS) cfg.smtp.pass = process.env.STAL_SMTP_PASS;
  if (process.env.STAL_SMTP_HOST) cfg.smtp.host = process.env.STAL_SMTP_HOST;
  if (process.env.STAL_SMTP_PORT) cfg.smtp.port = Number(process.env.STAL_SMTP_PORT);
  return cfg;
}

let current = null;

export function loadConfig() {
  const base = readJson(examplePath) || FALLBACK_CONFIG;
  const fromFile = readJson(configPath);
  const cfg = applyEnvOverrides(deepMerge(base, fromFile || {}));

  let dirty = false;
  if (!cfg.server.sessionSecret || typeof cfg.server.sessionSecret !== 'string') {
    cfg.server.sessionSecret = crypto.randomBytes(32).toString('hex');
    dirty = true;
  }
  if (!fromFile) dirty = true;

  current = cfg;
  fs.mkdirSync(dataDir, { recursive: true });
  if (dirty) writeConfigFile(cfg);
  return cfg;
}

export function getConfig() {
  return current || loadConfig();
}

function writeConfigFile(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, configPath);
  } catch (err) {
    console.warn(`[config] 无法写入 ${configPath}: ${err.message}`);
  }
}

export function saveConfig(patch) {
  current = deepMerge(getConfig(), patch || {});
  writeConfigFile(current);
  return current;
}

export function publicConfig() {
  const cfg = getConfig();
  return {
    site: { ...cfg.site },
    smtp: {
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      user: cfg.smtp.user,
      fromName: cfg.smtp.fromName,
      configured: isSmtpConfigured(cfg),
    },
    mail: {
      timezoneOffsetMinutes: cfg.mail.timezoneOffsetMinutes,
      sendHour: cfg.mail.sendHour,
      sendMinute: cfg.mail.sendMinute,
      perMinute: cfg.mail.perMinute,
      onlyTomorrow: cfg.mail.onlyTomorrow,
    },
    crawl: { intervalMinutes: cfg.crawl.intervalMinutes, maxPages: cfg.crawl.maxPages },
    auth: {
      allowRegistration: cfg.auth.allowRegistration,
      minPasswordLength: cfg.auth.minPasswordLength,
      codeTtlMinutes: cfg.auth.codeTtlMinutes,
    },
  };
}

export function isSmtpConfigured(cfg = getConfig()) {
  const user = String(cfg.smtp.user || '').trim();
  const pass = String(cfg.smtp.pass || '').trim();
  return Boolean(user && pass && user.includes('@') && !user.startsWith('请填写'));
}

export function timezoneOffsetMinutes(cfg = getConfig()) {
  const n = Number(cfg.mail.timezoneOffsetMinutes);
  return Number.isFinite(n) ? n : 480;
}
