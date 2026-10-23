import https from 'node:https';
import zlib from 'node:zlib';
import { getConfig, timezoneOffsetMinutes } from './config.js';

export const LUOGU_BASE = 'https://www.luogu.com.cn';
export const LIST_URL = `${LUOGU_BASE}/contest/list`;

export const METHOD_LABELS = {
  0: '未知赛制',
  1: 'OI',
  2: 'ACM',
  3: '特殊赛制',
  4: 'IOI',
};

export const STATUS_LABELS = {
  upcoming: '未开始',
  running: '进行中',
  ended: '已结束',
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 洛谷的 CDN 会对未携带 cookie 的请求返回 302，并在 Set-Cookie 里下发校验 cookie，
 * 重定向目标又是同一个地址。这里维护一个简易 cookie 罐，收到 cookie 后下次请求带上即可通过。
 */
const COOKIE_FALLBACK_TTL_MS = 10 * 60 * 1000;
const cookieJar = new Map(); // `${host}|${name}` -> { value, expiresAt }

function jarKey(host, name) {
  return `${host}|${name}`;
}

function absorbSetCookies(host, setCookie) {
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const now = Date.now();
  for (const raw of list) {
    const [pair, ...attrs] = String(raw).split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const key = jarKey(host, name);
    if (!value) {
      cookieJar.delete(key);
      continue;
    }
    let expiresAt = now + COOKIE_FALLBACK_TTL_MS;
    for (const attr of attrs) {
      const maxAge = attr.trim().match(/^max-age=(\d+)$/i);
      if (maxAge) expiresAt = now + Number(maxAge[1]) * 1000;
    }
    cookieJar.set(key, { value, expiresAt });
  }
}

function cookieHeaderFor(host) {
  const now = Date.now();
  const parts = [];
  for (const [key, entry] of cookieJar) {
    if (entry.expiresAt <= now) {
      cookieJar.delete(key);
      continue;
    }
    if (key.startsWith(`${host}|`)) parts.push(`${key.slice(host.length + 1)}=${entry.value}`);
  }
  return parts.join('; ');
}

export function clearCookieJar() {
  cookieJar.clear();
}

function rawRequest(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      stream.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时 (${timeoutMs}ms)`)));
    req.on('error', reject);
  });
}

export async function luoguGetJson(url, options = {}) {
  const conf = getConfig();
  const timeoutMs = options.timeoutMs || conf.crawl.timeoutMs || 20000;
  const retries = options.retries ?? 2;
  const maxRedirects = options.maxRedirects ?? 5;
  const baseHeaders = {
    'x-lentille-request': 'content-only',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'accept-encoding': 'gzip, deflate',
    'user-agent': options.userAgent || conf.crawl.userAgent,
    referer: LIST_URL,
    ...(options.headers || {}),
  };

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      let current = url;
      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const target = new URL(current);
        const headers = { ...baseHeaders };
        const cookie = cookieHeaderFor(target.host);
        if (cookie) headers.cookie = cookie;

        const res = await rawRequest(current, headers, timeoutMs);
        absorbSetCookies(target.host, res.headers['set-cookie']);

        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (hop === maxRedirects) throw new Error(`重定向次数过多（>${maxRedirects}），目标 ${current}`);
          current = new URL(res.headers.location, current).toString();
          continue;
        }
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        try {
          return JSON.parse(res.body);
        } catch {
          throw new Error(`响应不是合法 JSON（可能是 CDN 拦截页）：${res.body.slice(0, 120).replace(/\s+/g, ' ')}`);
        }
      }
      throw new Error(`重定向次数过多（>${maxRedirects}），目标 ${url}`);
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastError;
}

export async function fetchContestList(page = 1, options = {}) {
  const payload = await luoguGetJson(`${LIST_URL}?page=${page}`, options);
  const contests = payload?.data?.contests || {};
  return {
    serverTime: typeof payload?.time === 'number' ? payload.time : null,
    perPage: contests.perPage || 0,
    count: contests.count || 0,
    result: Array.isArray(contests.result) ? contests.result : [],
  };
}

export async function fetchContestDetail(id, options = {}) {
  const payload = await luoguGetJson(`${LUOGU_BASE}/contest/${id}`, options);
  return payload?.data?.contest || null;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 把 unix 秒转换成指定时区（默认 +08:00）的展示字段。 */
export function formatInTimezone(epochSeconds, offsetMinutes = 480) {
  const shifted = new Date(epochSeconds * 1000 + offsetMinutes * 60000);
  const date = `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
  const time = `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][shifted.getUTCDay()];
  return { date, time, weekday, dateTime: `${date} ${time}` };
}

export function dayKey(epochSeconds, offsetMinutes = 480) {
  return formatInTimezone(epochSeconds, offsetMinutes).date;
}

export function localDayKey(offsetMinutes = 480, at = Date.now()) {
  return formatInTimezone(Math.floor(at / 1000), offsetMinutes).date;
}

export function computeStatus(contest, nowSeconds) {
  const start = Number(contest.startTime) || 0;
  const end = Number(contest.endTime) || 0;
  if (nowSeconds < start) return 'upcoming';
  if (nowSeconds <= end) return 'running';
  return 'ended';
}

export function classify(contest, cfg = getConfig()) {
  const officialHostIds = (cfg.crawl.officialHostIds || [1000]).map((n) => Number(n));
  const host = contest.host || {};
  const hostId = Number(host.id ?? host.uid ?? 0);
  const hostName = String(host.name || '');
  const isOfficial = officialHostIds.includes(hostId) || hostName.includes('洛谷官方');
  const isRated = Number(contest.rated) !== 0;
  const method = Number(contest.method);
  const methodLabel = METHOD_LABELS[method] || `未知赛制(${method})`;

  let category = 'other';
  let categoryLabel = '公开赛';
  if (isOfficial) {
    category = 'official';
    categoryLabel = '官方比赛';
  } else if (Number(contest.visibility) === 2) {
    category = 'team';
    categoryLabel = '团队公开赛';
  } else if (Number(contest.visibility) === 4) {
    category = 'personal';
    categoryLabel = '个人公开赛';
  }

  return {
    isOfficial,
    isRated,
    method,
    methodLabel,
    category,
    categoryLabel,
    isTeam: Boolean(contest.squad),
    hostId,
    hostName: hostName || '未知',
  };
}

export function excerptDescription(description, maxLength = 160) {
  if (!description || typeof description !== 'string') return '';
  const text = description
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/::::?[a-zA-Z]*\[[^\]]*\]/g, ' ')
    .replace(/[#>*`|_-]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function buildContestRecord(raw, extra = {}, cfg = getConfig()) {
  const offset = timezoneOffsetMinutes(cfg);
  const nowSeconds = extra.nowSeconds ?? Math.floor(Date.now() / 1000);
  const info = classify(raw, cfg);
  const start = formatInTimezone(Number(raw.startTime) || 0, offset);
  const end = formatInTimezone(Number(raw.endTime) || 0, offset);
  const durationHours = Math.max(0, ((Number(raw.endTime) || 0) - (Number(raw.startTime) || 0)) / 3600);

  return {
    id: Number(raw.id),
    name: String(raw.name || ''),
    url: `${LUOGU_BASE}/contest/${raw.id}`,
    startTime: Number(raw.startTime) || 0,
    endTime: Number(raw.endTime) || 0,
    startDate: start.date,
    startTimeText: start.time,
    startWeekday: start.weekday,
    startDateTime: start.dateTime,
    endDate: end.date,
    endTimeText: end.time,
    endDateTime: end.dateTime,
    durationHours: Number(durationHours.toFixed(2)),
    durationText: `${durationHours.toFixed(2)}h`,
    method: info.method,
    methodLabel: info.methodLabel,
    rated: Number(raw.rated) || 0,
    isRated: info.isRated,
    isOfficial: info.isOfficial,
    isTeam: info.isTeam,
    category: info.category,
    categoryLabel: info.categoryLabel,
    visibility: Number(raw.visibility) || 0,
    invitationCodeType: Number(raw.invitationCodeType) || 0,
    problemCount: Number(raw.problemCount) || 0,
    host: {
      id: info.hostId,
      name: info.hostName,
      isPremium: Boolean(raw.host?.isPremium),
      avatar: raw.host?.avatar || null,
    },
    status: computeStatus(raw, nowSeconds),
    totalParticipants: extra.totalParticipants ?? null,
    eloThreshold: extra.eloThreshold ?? null,
    description: extra.description || '',
    descriptionExcerpt: extra.descriptionExcerpt || '',
    detailFetched: Boolean(extra.detailFetched),
    firstSeenAt: extra.firstSeenAt || new Date().toISOString(),
    crawledAt: new Date().toISOString(),
  };
}

/**
 * 抓取洛谷比赛列表。
 * 列表接口按 startTime 倒序返回，因此遇到整页都早于当前时间即可停止翻页。
 */
export async function crawlContests(options = {}) {
  const cfg = getConfig();
  const maxPages = options.maxPages || cfg.crawl.maxPages || 4;
  const detailLimit = options.detailLimit ?? cfg.crawl.detailLimit ?? 80;
  const delay = options.requestIntervalMs ?? cfg.crawl.requestIntervalMs ?? 400;
  const previous = options.previous || new Map();

  const raw = new Map();
  let serverTime = null;
  let totalOnLuogu = 0;
  let pagesCrawled = 0;
  const warnings = [];

  for (let page = 1; page <= maxPages; page += 1) {
    let payload;
    try {
      payload = await fetchContestList(page, options);
    } catch (err) {
      // 首页失败说明整体不可用，直接抛出；后续页失败保留已抓到的数据继续处理
      if (page === 1) throw err;
      warnings.push(`第 ${page} 页抓取失败: ${err.message}`);
      break;
    }
    pagesCrawled = page;
    if (payload.serverTime) serverTime = payload.serverTime;
    if (payload.count) totalOnLuogu = payload.count;
    if (payload.result.length === 0) break;
    for (const item of payload.result) {
      if (!raw.has(Number(item.id))) raw.set(Number(item.id), item);
    }
    const now = serverTime ?? Math.floor(Date.now() / 1000);
    const oldest = payload.result[payload.result.length - 1];
    if (Number(oldest.startTime) < now) break;
    if (page < maxPages) await sleep(delay);
  }

  const nowSeconds = serverTime ?? Math.floor(Date.now() / 1000);
  const records = [];
  let detailsFetched = 0;

  for (const item of raw.values()) {
    const id = Number(item.id);
    const prev = previous.get(id);
    const status = computeStatus(item, nowSeconds);
    const needDetail = status !== 'ended' && detailsFetched < detailLimit && !prev?.detailFetched;
    let extra = {
      firstSeenAt: prev?.firstSeenAt,
      nowSeconds,
    };

    if (needDetail && options.withDetails !== false) {
      try {
        const detail = await fetchContestDetail(id, options);
        if (detail) {
          extra = {
            ...extra,
            totalParticipants: detail.totalParticipants ?? null,
            eloThreshold: detail.eloThreshold ?? null,
            description: detail.description || '',
            descriptionExcerpt: excerptDescription(detail.description),
            detailFetched: true,
          };
          detailsFetched += 1;
        }
      } catch (err) {
        warnings.push(`比赛 ${id} 详情抓取失败: ${err.message}`);
      }
      await sleep(delay);
    } else if (prev) {
      extra = {
        ...extra,
        totalParticipants: prev.totalParticipants ?? null,
        eloThreshold: prev.eloThreshold ?? null,
        description: prev.description || '',
        descriptionExcerpt: prev.descriptionExcerpt || '',
        detailFetched: Boolean(prev.detailFetched),
      };
    }

    records.push(buildContestRecord(item, extra, cfg));
  }

  records.sort((a, b) => a.startTime - b.startTime);

  return {
    serverTime: nowSeconds,
    totalOnLuogu,
    pagesCrawled,
    detailsFetched,
    warnings,
    contests: records,
  };
}
