import { METHOD_LABELS } from './luogu.js';

export const SCOPE_DEFINITIONS = [
  { key: 'notifyOfficial', label: '接收官方比赛通知', hint: '洛谷官方团队举办的比赛' },
  { key: 'notifyRated', label: '接收 Rated 比赛通知', hint: '任何计算等级分（Rated）的比赛' },
  { key: 'notifyTeam', label: '接收团队公开赛通知', hint: '出题组 / 团队举办的公开赛' },
  { key: 'notifyPersonal', label: '接收个人公开赛通知', hint: '个人举办的公开赛' },
  { key: 'notifyOther', label: '接收其它公开赛通知', hint: '未归类的公开比赛' },
];

export const METHOD_OPTIONS = [
  { key: 'oi', label: 'OI 赛制', method: 1 },
  { key: 'ioi', label: 'IOI 赛制', method: 4 },
  { key: 'acm', label: 'ACM 赛制', method: 2 },
];

export function methodKey(method) {
  const value = Number(method);
  const found = METHOD_OPTIONS.find((m) => m.method === value);
  return found ? found.key : 'other';
}

function parseKeywords(value) {
  return String(value || '')
    .split(/[\s,，;；]+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

export function normalizePrefs(raw, base) {
  const prefs = { ...(base || {}), ...(raw || {}) };
  const methods = { ...(base?.methods || {}), ...(raw?.methods || {}) };
  const recipients = Array.isArray(prefs.recipients)
    ? [...new Set(prefs.recipients.map((r) => String(r).trim()).filter((r) => /.+@.+\..+/.test(r)))]
    : [];
  return {
    enabled: prefs.enabled !== false,
    recipients,
    notifyOfficial: Boolean(prefs.notifyOfficial),
    notifyRated: Boolean(prefs.notifyRated),
    notifyTeam: Boolean(prefs.notifyTeam),
    notifyPersonal: Boolean(prefs.notifyPersonal),
    notifyOther: Boolean(prefs.notifyOther),
    methods: {
      oi: methods.oi !== false,
      ioi: methods.ioi !== false,
      acm: methods.acm !== false,
    },
    includeKeywords: String(prefs.includeKeywords || '').slice(0, 200),
    excludeKeywords: String(prefs.excludeKeywords || '').slice(0, 200),
  };
}

export function activeScopes(prefs) {
  return SCOPE_DEFINITIONS.filter((s) => prefs?.[s.key]).map((s) => s.label);
}

export function activeMethods(prefs) {
  const methods = prefs?.methods || {};
  const labels = METHOD_OPTIONS.filter((m) => methods[m.key]).map((m) => m.label);
  if (labels.length === METHOD_OPTIONS.length) return ['全部赛制'];
  return labels.length ? labels : ['不限制'];
}

export function describePrefs(prefs) {
  const scopes = activeScopes(prefs);
  return {
    scopes: scopes.length ? scopes : ['（未选择任何范围，不会收到邮件）'],
    methods: activeMethods(prefs),
  };
}

/** 判断一场比赛是否命中用户的订阅条件：范围之间取「或」，赛制与关键词取「与」。 */
export function contestMatches(prefs, contest) {
  if (!prefs || prefs.enabled === false) return false;
  if (!Array.isArray(prefs.recipients) || prefs.recipients.length === 0) return false;

  const predicates = [];
  if (prefs.notifyOfficial) predicates.push((c) => c.isOfficial);
  if (prefs.notifyRated) predicates.push((c) => c.isRated);
  if (prefs.notifyTeam) predicates.push((c) => c.category === 'team');
  if (prefs.notifyPersonal) predicates.push((c) => c.category === 'personal');
  if (prefs.notifyOther) predicates.push((c) => c.category === 'other');

  if (predicates.length === 0) return false;
  if (!predicates.some((fn) => fn(contest))) return false;

  const methods = prefs.methods || {};
  const selected = METHOD_OPTIONS.filter((m) => methods[m.key]);
  if (selected.length > 0 && selected.length < METHOD_OPTIONS.length) {
    const key = methodKey(contest.method);
    if (key !== 'other' && !selected.some((m) => m.key === key)) return false;
  }

  const name = String(contest.name || '').toLowerCase();
  const include = parseKeywords(prefs.includeKeywords);
  if (include.length && !include.some((k) => name.includes(k))) return false;
  const exclude = parseKeywords(prefs.excludeKeywords);
  if (exclude.length && exclude.some((k) => name.includes(k))) return false;

  return true;
}

export function filterContestsForPrefs(prefs, contests) {
  return (contests || []).filter((contest) => contestMatches(prefs, contest));
}

export function methodLabel(method) {
  return METHOD_LABELS[method] || '未知赛制';
}
