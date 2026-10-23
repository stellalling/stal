import { getConfig, timezoneOffsetMinutes } from './config.js';
import { contestStore, db, logStore, pushLog, queueStore } from './store.js';
import { crawlContests, formatInTimezone, dayKey, computeStatus, sleep } from './luogu.js';
import { MailSender } from './mailer.js';
import { renderDigest } from './mailTemplate.js';
import { filterContestsForPrefs, normalizePrefs } from './subscription.js';

const HISTORY_RETENTION_DAYS = 30;
let crawlRunning = false;
let sendRunning = false;
let lastTickMinute = null;

function previousContestMap() {
  return new Map(contestStore.data.contests.map((c) => [c.id, c]));
}

/** 把抓取结果合并进本地库，保留 firstSeenAt，并刷新所有比赛的状态。 */
export function mergeCrawlIntoStore(result) {
  const map = previousContestMap();
  const nowSeconds = result.serverTime;
  for (const record of result.contests) {
    const prev = map.get(record.id);
    map.set(record.id, {
      ...prev,
      ...record,
      firstSeenAt: prev?.firstSeenAt || record.firstSeenAt,
    });
  }

  const cutoff = nowSeconds - HISTORY_RETENTION_DAYS * 86400;
  const list = [...map.values()]
    .map((c) => ({ ...c, status: computeStatus(c, nowSeconds) }))
    .filter((c) => c.endTime >= cutoff)
    .sort((a, b) => a.startTime - b.startTime);

  contestStore.update((data) => {
    data.contests = list;
    data.updatedAt = new Date().toISOString();
    data.serverTime = nowSeconds;
    data.pagesCrawled = result.pagesCrawled;
    data.totalOnLuogu = result.totalOnLuogu;
  });
  contestStore.save();
  return list;
}

export async function runCrawlJob(options = {}) {
  if (crawlRunning && !options.force) return { skipped: true, reason: '已有抓取任务在运行' };
  crawlRunning = true;
  const startedAt = Date.now();
  try {
    const result = await crawlContests({ previous: previousContestMap() });
    const list = mergeCrawlIntoStore(result);
    const upcoming = list.filter((c) => c.status === 'upcoming');
    pushLog('crawl', {
      ok: true,
      pages: result.pagesCrawled,
      fetched: result.contests.length,
      details: result.detailsFetched,
      stored: list.length,
      upcoming: upcoming.length,
      durationMs: Date.now() - startedAt,
      warnings: result.warnings,
    });
    return { ok: true, ...result, stored: list.length, upcoming: upcoming.length };
  } catch (err) {
    pushLog('crawl', { ok: false, error: err.message, durationMs: Date.now() - startedAt });
    console.error('[crawl] 失败:', err.message);
    if (options.throwOnError) throw err;
    return { ok: false, error: err.message };
  } finally {
    crawlRunning = false;
  }
}

/** 取得某一天需要推送的比赛（默认只取当天开始的比赛）。 */
export function contestsOnDate(dateKey, { matchMode = 'start', includeEnded = false } = {}) {
  const nowSeconds = contestStore.data.serverTime || Math.floor(Date.now() / 1000);
  return contestStore.data.contests.filter((c) => {
    const hit = matchMode === 'overlap'
      ? c.startDate <= dateKey && c.endDate >= dateKey
      : c.startDate === dateKey;
    if (!hit) return false;
    return includeEnded || computeStatus(c, nowSeconds) !== 'ended';
  });
}

export function tomorrowKey(at = Date.now()) {
  const cfg = getConfig();
  const offset = timezoneOffsetMinutes(cfg);
  return formatInTimezone(Math.floor(at / 1000) + 86400, offset).date;
}

function enqueue(items) {
  const ids = new Set(items.map((i) => `${i.userId}:${i.targetDate}`));
  const existing = new Set(queueStore.data.items.filter((i) => i.status === 'pending').map((i) => `${i.userId}:${i.targetDate}`));
  const fresh = items.filter((i) => !existing.has(`${i.userId}:${i.targetDate}`));
  queueStore.update((data) => {
    data.items.push(...fresh);
  });
  return fresh.length;
}

export async function processQueue() {
  if (sendRunning) return { skipped: true };
  sendRunning = true;
  const cfg = getConfig();
  const intervalMs = Math.ceil(60000 / Math.max(1, Number(cfg.mail.perMinute) || 5));
  const dailyLimit = Number(cfg.mail.dailyLimit) || 200;
  const sender = new MailSender(cfg);
  let sent = 0;
  let failed = 0;

  try {
    for (;;) {
      const item = queueStore.data.items.find((i) => i.status === 'pending');
      if (!item) break;

      const usedToday = queueStore.data.dailyDate === item.targetDate
        ? queueStore.data.dailySent + queueStore.data.dailyFailed
        : 0;
      if (usedToday >= dailyLimit) {
        queueStore.update((data) => {
          for (const rest of data.items) {
            if (rest.status === 'pending') {
              rest.status = 'skipped';
              rest.error = '已达每日发送上限';
            }
          }
        });
        break;
      }

      const startedAt = Date.now();
      if (item.dryRun) {
        item.status = 'sent';
        item.response = 'dry-run';
      } else {
        try {
          const result = await sender.send({ recipients: item.recipients, subject: item.subject, html: item.html });
          item.status = 'sent';
          item.sentAt = Date.now();
          item.response = result.response;
          sent += 1;
          pushLog('mail', { type: 'digest', to: item.recipients.join(','), subject: item.subject, ok: true, count: item.contestCount });
        } catch (err) {
          item.status = 'failed';
          item.error = err.message;
          failed += 1;
          pushLog('mail', { type: 'digest', to: item.recipients.join(','), subject: item.subject, ok: false, error: err.message });
          if (/SMTP 未配置|认证|535|535/.test(err.message)) {
            // 认证类错误通常是配置问题，直接中断本轮，避免反复重试触发风控
            queueStore.save();
            break;
          }
        }
      }

      queueStore.update((data) => {
        if (data.dailyDate !== item.targetDate) {
          data.dailyDate = item.targetDate;
          data.dailySent = 0;
          data.dailyFailed = 0;
        }
        if (item.status === 'sent') data.dailySent += item.dryRun ? 0 : 1;
        else if (item.status === 'failed') data.dailyFailed += 1;
      });
      queueStore.save();

      const elapsed = Date.now() - startedAt;
      if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
    }
  } finally {
    sender.dropClient();
    queueStore.update((data) => {
      data.sentCount = sent;
      data.failedCount = failed;
      data.lastRunAt = new Date().toISOString();
    });
    queueStore.save();
    sendRunning = false;
  }
  return { sent, failed };
}

/**
 * 每天 20:00 的推送任务：为每个用户生成"次日比赛"邮件并入队，然后按每分钟 N 封发送。
 */
export async function runDailySend(options = {}) {
  const cfg = getConfig();
  const offset = timezoneOffsetMinutes(cfg);
  const targetDate = options.dateKey || tomorrowKey();
  const matchMode = options.matchMode || cfg.mail.matchMode || 'start';
  const contests = contestsOnDate(targetDate, { matchMode, includeEnded: false });
  const dateLabel = targetDate;

  if (options.resetQueue !== false) {
    queueStore.update((data) => {
      data.items = [];
      data.dailyDate = targetDate;
      data.dailySent = 0;
      data.dailyFailed = 0;
    });
  }

  const pending = [];
  const perUser = [];
  for (const user of db.data.users) {
    const prefs = normalizePrefs(user.prefs, user.prefs);
    if (!prefs.enabled || prefs.recipients.length === 0) continue;
    const matched = filterContestsForPrefs(prefs, contests);
    if (matched.length === 0) {
      perUser.push({ userId: user.id, email: user.email, matched: 0, recipients: prefs.recipients.length });
      continue;
    }
    const { subject, html } = renderDigest({ contests: matched, dateLabel });
    pending.push({
      id: `${user.id}-${targetDate}`,
      userId: user.id,
      userEmail: user.email,
      recipients: prefs.recipients,
      subject,
      html,
      targetDate,
      contestCount: matched.length,
      contestIds: matched.map((c) => c.id),
      status: 'pending',
      createdAt: Date.now(),
      dryRun: Boolean(options.dryRun),
    });
    perUser.push({ userId: user.id, email: user.email, matched: matched.length, recipients: prefs.recipients.length });
  }

  const queued = enqueue(pending);

  // 记下"本次日报推送"的日期与时间（供调度器判断今天是否已经推过；演练不计）
  if (!options.dryRun) {
    queueStore.update((data) => {
      data.lastDigestTargetDate = targetDate;
      data.lastDigestAt = new Date().toISOString();
    });
    queueStore.save();
  }
  const summary = {
    targetDate,
    contestCount: contests.length,
    users: db.data.users.length,
    queued,
    perUser,
    dryRun: Boolean(options.dryRun),
  };
  pushLog('mail', { type: 'daily-schedule', ok: true, ...summary, perUser: undefined });

  if (options.sendNow === false) return { ...summary, sent: 0, failed: 0 };
  const result = await processQueue();
  return { ...summary, ...result };
}

export function statusSnapshot() {
  const cfg = getConfig();
  const offset = timezoneOffsetMinutes(cfg);
  const nowSeconds = contestStore.data.serverTime || Math.floor(Date.now() / 1000);
  const list = contestStore.data.contests;
  const counts = { upcoming: 0, running: 0, ended: 0 };
  for (const c of list) counts[computeStatus(c, nowSeconds)] += 1;
  return {
    crawl: {
      lastRunAt: logStore.data.crawl[0]?.at || null,
      lastOk: logStore.data.crawl[0]?.ok ?? null,
      intervalMinutes: cfg.crawl.intervalMinutes,
      updatedAt: contestStore.data.updatedAt,
      totalOnLuogu: contestStore.data.totalOnLuogu,
    },
    counts,
    storeTotal: list.length,
    today: formatInTimezone(nowSeconds, offset).date,
    tomorrow: tomorrowKey(),
    queue: {
      pending: queueStore.data.items.filter((i) => i.status === 'pending').length,
      sent: queueStore.data.items.filter((i) => i.status === 'sent').length,
      failed: queueStore.data.items.filter((i) => i.status === 'failed').length,
      lastRunAt: queueStore.data.lastRunAt,
      dailyDate: queueStore.data.dailyDate,
      dailySent: queueStore.data.dailySent,
      dailyFailed: queueStore.data.dailyFailed,
      lastDigestTargetDate: queueStore.data.lastDigestTargetDate || null,
      lastDigestAt: queueStore.data.lastDigestAt || null,
    },
  };
}

export function startScheduler() {
  const cfg = getConfig();
  const crawlEveryMs = Math.max(1, Number(cfg.crawl.intervalMinutes) || 60) * 60000;

  setTimeout(() => {
    runCrawlJob().catch((err) => console.error('[scheduler] 首次抓取失败:', err.message));
  }, 1500);

  setInterval(() => {
    runCrawlJob().catch((err) => console.error('[scheduler] 定时抓取失败:', err.message));
  }, crawlEveryMs).unref();

  setInterval(() => {
    const conf = getConfig();
    const offset = timezoneOffsetMinutes(conf);
    const now = formatInTimezone(Math.floor(Date.now() / 1000), offset);
    const minuteKey = `${now.date} ${now.time}`;
    if (lastTickMinute === minuteKey) return;
    lastTickMinute = minuteKey;

    const [hour, minute] = now.time.split(':').map(Number);
    if (hour === Number(conf.mail.sendHour) && minute === Number(conf.mail.sendMinute)) {
      // 只认「日报推送」自己的记账（lastDigestTargetDate/lastDigestAt）。
      // 以前用 lastRunAt 判断是错的：那个字段被每 30 秒的队列线程不断覆写，
      // 结果只要当天手动推过一次同目标日期的邮件，20:00 的定时推送就会被静默跳过。
      const targetDate = tomorrowKey();
      const lastPushLocalDate = queueStore.data.lastDigestAt
        ? formatInTimezone(Math.floor(new Date(queueStore.data.lastDigestAt).getTime() / 1000), offset).date
        : null;
      const already = queueStore.data.lastDigestTargetDate === targetDate && lastPushLocalDate === now.date;
      if (already) {
        console.log(`[scheduler] ${minuteKey}：今天已为 ${targetDate} 推送过（${queueStore.data.lastDigestAt}），跳过本次定时推送`);
        return;
      }
      console.log(`[scheduler] ${minuteKey} 触发每日推送（目标日期 ${targetDate}）`);
      runDailySend().catch((err) => console.error('[scheduler] 每日推送失败:', err.message));
    }
  }, 20000).unref();

  setInterval(() => {
    processQueue().catch((err) => console.error('[scheduler] 队列发送失败:', err.message));
  }, 30000).unref();

  console.log(`[scheduler] 已启动：每 ${cfg.crawl.intervalMinutes} 分钟抓取一次，每天 ${cfg.mail.sendHour}:${String(cfg.mail.sendMinute).padStart(2, '0')} 推送次日比赛，限速 ${cfg.mail.perMinute} 封/分钟`);
}

export function contestsForDayKey(key) {
  return contestsOnDate(key, { matchMode: getConfig().mail.matchMode || 'start' });
}

export { dayKey };
