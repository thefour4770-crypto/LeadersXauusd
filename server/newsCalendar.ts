import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  Candle,
  EconomicCalendarPayload,
  EconomicNewsEvent,
  MarketQuote,
  NewsCalendarDayGroup,
  NewsFeedStatus,
  NewsMarketStability,
  NewsProtectionConfig,
  NewsProtectionState,
} from '../src/types/market.ts';
import { atrArray, lastNonNull } from './indicators.ts';
import {
  fetchLiveXauUsdQuote,
  fetchPureFuturesCandles,
  getPureSpotCandles,
} from './marketData.ts';

const IST_TIMEZONE = 'Asia/Kolkata';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const NEWS_CACHE_FILE = path.join(DATA_DIR, 'news-calendar-cache.json');

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export const DEFAULT_NEWS_PROTECTION_CONFIG: NewsProtectionConfig = {
  warningLeadMinutes: envNumber('NEWS_WARNING_MINUTES', 60, 5, 240),
  preEventBlockMinutes: envNumber('NEWS_PRE_BLOCK_MINUTES', 15, 5, 120),
  minPostEventBlockMinutes: envNumber('NEWS_MIN_POST_BLOCK_MINUTES', 15, 5, 120),
  maxPostEventBlockMinutes: envNumber('NEWS_MAX_POST_BLOCK_MINUTES', 45, 15, 180),
  maxNewsCacheAgeMinutes: envNumber('NEWS_MAX_CACHE_AGE_MINUTES', 60, 15, 360),
};

const TV_REFRESH_NORMAL_MS = 2 * 60_000;
const TV_REFRESH_NEAR_EVENT_MS = 45_000;
const FF_REFRESH_MIN_MS = 20 * 60_000;
const FF_RATE_LIMIT_BACKOFF_MS = 30 * 60_000;

interface DiskNewsCache {
  lastTvSuccessMs: number | null;
  lastFfSuccessMs: number | null;
  ffBackoffUntilMs: number | null;
  tvEvents: EconomicNewsEvent[];
  ffEvents: EconomicNewsEvent[];
  ffCoveredDateKeys?: string[];
}

const state: {
  loadedFromDisk: boolean;
  lastTvSuccessMs: number | null;
  lastFfSuccessMs: number | null;
  ffBackoffUntilMs: number | null;
  lastTvAttemptMs: number;
  lastFfAttemptMs: number;
  tvEvents: EconomicNewsEvent[];
  ffEvents: EconomicNewsEvent[];
  ffCoveredDateKeys: string[];
  lastError: string | null;
  inFlightRefresh: Promise<void> | null;
} = {
  loadedFromDisk: false,
  lastTvSuccessMs: null,
  lastFfSuccessMs: null,
  ffBackoffUntilMs: null,
  lastTvAttemptMs: 0,
  lastFfAttemptMs: 0,
  tvEvents: [],
  ffEvents: [],
  ffCoveredDateKeys: [],
  lastError: null,
  inFlightRefresh: null,
};

type NewsListener = (event: {
  type: 'news_status';
  protection: NewsProtectionState;
  calendar?: EconomicCalendarPayload;
  justUnblocked: boolean;
}) => void;

const newsListeners = new Set<NewsListener>();
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let lastBroadcastSignature = '';
let lastBlockedFlag: boolean | null = null;

export function subscribeNewsStatusUpdates(listener: NewsListener): () => void {
  newsListeners.add(listener);
  return () => {
    newsListeners.delete(listener);
  };
}

export interface IstDateParts {
  dateKey: string; // YYYY-MM-DD
  year: string;
  dayLabel: string; // e.g. Thursday, November 19
  timeLabel: string; // e.g. 7:00 PM
}

const istDateKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const istYearFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: IST_TIMEZONE,
  year: 'numeric',
});

const istDayLabelFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: IST_TIMEZONE,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

const istTimeLabelFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: IST_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

export function getIstDateParts(timestampMs: number): IstDateParts {
  const d = new Date(timestampMs);
  return {
    dateKey: istDateKeyFmt.format(d),
    year: istYearFmt.format(d),
    dayLabel: istDayLabelFmt.format(d),
    timeLabel: istTimeLabelFmt.format(d),
  };
}

/**
 * Generates an inclusive rolling calendar window in Asia/Kolkata from today (day 0)
 * through today + daysAhead (day 7 = 8 calendar days total), properly handling month
 * lengths, leap years, and Dec->Jan year rollovers regardless of server host timezone.
 */
export function buildRollingIstWindowDays(
  nowMs = Date.now(),
  daysAhead = 7
): Array<{ dateKey: string; dayLabel: string; year: string; isToday: boolean }> {
  const todayParts = getIstDateParts(nowMs);
  const [yStr, mStr, dStr] = todayParts.dateKey.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);

  const days: Array<{ dateKey: string; dayLabel: string; year: string; isToday: boolean }> = [];
  for (let offset = 0; offset <= daysAhead; offset++) {
    // UTC noon avoids any edge-case clock boundary when projecting IST calendar dates
    const probeMs = Date.UTC(y, m - 1, d + offset, 12, 0, 0);
    const p = getIstDateParts(probeMs);
    days.push({
      dateKey: p.dateKey,
      dayLabel: p.dayLabel,
      year: p.year,
      isToday: offset === 0,
    });
  }
  return days;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function formatTvMetric(
  value: unknown,
  unit?: string | null,
  scale?: string | null
): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const trimmedUnit = typeof unit === 'string' ? unit.trim() : '';
  const trimmedScale = typeof scale === 'string' ? scale.trim() : '';

  const numStr = Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(4)));

  if (trimmedUnit === '$') {
    return `$${numStr}${trimmedScale}`;
  }
  if (trimmedUnit) {
    return `${numStr}${trimmedScale}${trimmedUnit}`;
  }
  if (trimmedScale) {
    return `${numStr}${trimmedScale}`;
  }
  return numStr;
}

function normalizeTitleForDedup(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(m\/m|q\/q|y\/y|mom|qoq|yoy|prelim|preliminary|prel|final|rev|revised|est|2nd|3rd|adv|advance|flash)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenJaccard(a: string, b: string): number {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const tok of sa) {
    if (sb.has(tok)) inter++;
  }
  return inter / (sa.size + sb.size - inter);
}

/**
 * Parses Forex Factory XML timestamp fields (`MM-DD-YYYY` + `h:mmam/pm` in UTC)
 * into epoch ms. Returns null for "Tentative" / "All Day" entries without clock time.
 */
export function parseFfXmlUtcTimestamp(dateStr: string, timeStr: string): number | null {
  const dm = /^(\d{2})-(\d{2})-(\d{4})$/.exec(dateStr.trim());
  if (!dm) return null;
  const month = Number(dm[1]);
  const day = Number(dm[2]);
  const year = Number(dm[3]);

  const tm = /^(\d{1,2}):(\d{2})(am|pm)$/i.exec(timeStr.trim());
  if (!tm) return null;
  let hour = Number(tm[1]);
  const minute = Number(tm[2]);
  const ampm = tm[3].toLowerCase();

  if (ampm === 'am' && hour === 12) hour = 0;
  else if (ampm === 'pm' && hour < 12) hour += 12;

  const ms = Date.UTC(year, month - 1, day, hour, minute, 0);
  return Number.isFinite(ms) ? ms : null;
}

export function buildNewsEvent(params: {
  id: string;
  title: string;
  timestampMs: number;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  source: string;
}): EconomicNewsEvent {
  const ist = getIstDateParts(params.timestampMs);
  return {
    id: params.id,
    title: params.title.trim(),
    currency: 'USD',
    impact: 'HIGH',
    timestampMs: params.timestampMs,
    isoUtc: new Date(params.timestampMs).toISOString(),
    istDateKey: ist.dateKey,
    istDateLabel: ist.dayLabel,
    istYear: ist.year,
    istTimeLabel: ist.timeLabel,
    actual: params.actual && params.actual.trim() ? params.actual.trim() : null,
    forecast: params.forecast && params.forecast.trim() ? params.forecast.trim() : null,
    previous: params.previous && params.previous.trim() ? params.previous.trim() : null,
    source: params.source,
  };
}

/**
 * Matches only USD events that Forex Factory classifies as RED (High Impact).
 * TradingView flags several Forex Factory Medium/Orange releases (e.g. Personal Spending,
 * Personal Income, Durable Goods Orders, Housing Starts, Building Permits) with importance=1.
 */
export function isForexFactoryUsdRedTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  if (!t) return false;

  // Explicit exclusions for releases Forex Factory rates Medium (Orange) or Low (Yellow)
  if (
    /\b(personal\s+spending|personal\s+income|durable\s+goods|housing\s+starts|building\s+permits|new\s+home\s+sales|existing\s+home\s+sales|pending\s+home\s+sales|trade\s+balance|gdp\s+price\s+index|gdp\s+deflator|gdp\s+sales|factory\s+orders|business\s+inventories|wholesale\s+inventories|industrial\s+production|capacity\s+utilization|consumer\s+credit|inflation\s+expectations|composite\s+pmi|crude\s+oil\s+inventories|natural\s+gas\s+storage|bond\s+auction|note\s+auction|bill\s+auction|jobless\s+claims)\b/i.test(
      t
    )
  ) {
    return false;
  }

  // Headline PCE Price Index (without Core) is Medium/Orange on Forex Factory
  if (/\bpce\s+price\s+index\b/i.test(t) && !/\bcore\s+pce\b/i.test(t)) {
    return false;
  }

  // ISM sub-indices (Prices / Employment / New Orders) are Medium/Orange on Forex Factory
  if (/\bism\b/i.test(t) && /\b(prices|employment|new\s+orders|inventories|backlog)\b/i.test(t)) {
    return false;
  }

  // Final/Revised PMI & Michigan Consumer Sentiment readings are Medium/Low on Forex Factory
  if (/\b(pmi|consumer\s+sentiment)\b/i.test(t) && /\b(final|revised|rev)\b/i.test(t)) {
    return false;
  }

  // Core Forex Factory USD RED (High Impact) events
  return (
    /\bcore\s+pce\b/i.test(t) ||
    /\b(core\s+)?cpi\b/i.test(t) ||
    /\b(core\s+)?ppi\b/i.test(t) ||
    /\b(core\s+)?retail\s+sales\b/i.test(t) ||
    /\bgdp\b/i.test(t) ||
    /\b(non[\s-]?farm|nfp)\b/i.test(t) ||
    /\badp\s+(non[\s-]?farm|employment)\b/i.test(t) ||
    /\bunemployment\s+rate\b/i.test(t) ||
    /\baverage\s+hourly\s+earnings\b/i.test(t) ||
    /\bjolts\s+job\s+openings\b/i.test(t) ||
    /\bism\s+(manufacturing|services|non-manufacturing)\s+pmi\b/i.test(t) ||
    /\b(flash|s&p\s+global)\s+(manufacturing|services)\s+pmi\b/i.test(t) ||
    /\bcb\s+consumer\s+confidence\b/i.test(t) ||
    /\b(uom|michigan)\s+consumer\s+sentiment\b/i.test(t) ||
    /\bfomc\b/i.test(t) ||
    /\bfed(eral)?\s+(funds\s+rate|interest\s+rate)\b/i.test(t) ||
    /\bfed\s+chair(?:man)?\b/i.test(t) ||
    /\bjackson\s+hole\b/i.test(t)
  );
}

export function parseTradingViewEvents(rawList: unknown[]): EconomicNewsEvent[] {
  const out: EconomicNewsEvent[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const currency = typeof row.currency === 'string' ? row.currency.toUpperCase() : '';
    const country = typeof row.country === 'string' ? row.country.toUpperCase() : '';
    const importance = typeof row.importance === 'number' ? row.importance : -1;
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const dateStr = typeof row.date === 'string' ? row.date : '';

    // Strict filter: USD + HIGH IMPACT ONLY (importance >= 1) + Forex Factory USD RED alignment
    if (currency !== 'USD' && country !== 'US') continue;
    if (currency && currency !== 'USD') continue;
    if (importance < 1 || !title || !dateStr) continue;
    if (!isForexFactoryUsdRedTitle(title)) continue;

    const ts = Date.parse(dateStr);
    if (!Number.isFinite(ts)) continue;

    const unit = typeof row.unit === 'string' ? row.unit : null;
    const scale = typeof row.scale === 'string' ? row.scale : null;

    out.push(
      buildNewsEvent({
        id: `tv-${String(row.id ?? `${ts}-${title}`)}`,
        title,
        timestampMs: ts,
        actual: formatTvMetric(row.actual, unit, scale),
        forecast: formatTvMetric(row.forecast, unit, scale),
        previous: formatTvMetric(row.previous, unit, scale),
        source: 'TradingView Calendar',
      })
    );
  }
  return out;
}

export function parseForexFactoryXml(xml: string): EconomicNewsEvent[] {
  const out: EconomicNewsEvent[] = [];
  const matches = xml.matchAll(/<event>([\s\S]*?)<\/event>/g);
  for (const m of matches) {
    const body = m[1];
    const readTag = (tag: string): string => {
      const mm = body.match(
        new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i')
      );
      return mm ? decodeHtmlEntities(mm[1]) : '';
    };

    const country = readTag('country').toUpperCase();
    const impact = readTag('impact').toLowerCase();
    const title = readTag('title');
    const dateStr = readTag('date');
    const timeStr = readTag('time');

    // Strict filter: USD + HIGH IMPACT ONLY
    if (country !== 'USD' || impact !== 'high' || !title) continue;

    const ts = parseFfXmlUtcTimestamp(dateStr, timeStr);
    if (ts == null) continue;

    out.push(
      buildNewsEvent({
        id: `ff-${ts}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        title,
        timestampMs: ts,
        actual: readTag('actual') || null,
        forecast: readTag('forecast') || null,
        previous: readTag('previous') || null,
        source: 'Forex Factory',
      })
    );
  }
  return out;
}

export function parseForexFactoryJson(rawList: unknown[]): EconomicNewsEvent[] {
  const out: EconomicNewsEvent[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const country = typeof row.country === 'string' ? row.country.toUpperCase() : '';
    const impact = typeof row.impact === 'string' ? row.impact.toLowerCase() : '';
    const title = typeof row.title === 'string' ? decodeHtmlEntities(row.title) : '';
    const dateStr = typeof row.date === 'string' ? row.date : '';

    if (country !== 'USD' || impact !== 'high' || !title || !dateStr) continue;
    const ts = Date.parse(dateStr);
    if (!Number.isFinite(ts)) continue;

    out.push(
      buildNewsEvent({
        id: `ff-${ts}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        title,
        timestampMs: ts,
        actual: typeof row.actual === 'string' && row.actual.trim() ? row.actual.trim() : null,
        forecast: typeof row.forecast === 'string' && row.forecast.trim() ? row.forecast.trim() : null,
        previous: typeof row.previous === 'string' && row.previous.trim() ? row.previous.trim() : null,
        source: 'Forex Factory',
      })
    );
  }
  return out;
}

export function extractFfCoveredIstDateKeysFromXml(xml: string): string[] {
  const keys = new Set<string>();
  const matches = xml.matchAll(/<event>([\s\S]*?)<\/event>/g);
  for (const m of matches) {
    const body = m[1];
    const readTag = (tag: string): string => {
      const mm = body.match(
        new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i')
      );
      return mm ? decodeHtmlEntities(mm[1]) : '';
    };
    const dateStr = readTag('date');
    const timeStr = readTag('time');
    const ts =
      parseFfXmlUtcTimestamp(dateStr, timeStr) ??
      parseFfXmlUtcTimestamp(dateStr, '12:00pm');
    if (ts != null) {
      keys.add(getIstDateParts(ts).dateKey);
    }
  }
  return Array.from(keys);
}

export function extractFfCoveredIstDateKeysFromJson(rawList: unknown[]): string[] {
  const keys = new Set<string>();
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const dateStr = typeof row.date === 'string' ? row.date : '';
    if (!dateStr) continue;
    const ts = Date.parse(dateStr);
    if (Number.isFinite(ts)) {
      keys.add(getIstDateParts(ts).dateKey);
    }
  }
  return Array.from(keys);
}

/**
 * Merges and deduplicates events across providers without inventing fields.
 * - `ffEvents` are always authoritative Forex Factory USD RED events.
 * - `tvEvents` are strictly filtered to Forex Factory USD RED equivalents, and on
 *   dates already covered by Forex Factory feeds (`ffCoveredDateKeys`), TradingView
 *   events only enrich existing matching Forex Factory events (never adding extra rows).
 */
export function mergeAndDeduplicateEvents(
  ffEvents: EconomicNewsEvent[],
  tvEvents: EconomicNewsEvent[],
  ffCoveredDateKeys?: ReadonlySet<string> | string[]
): EconomicNewsEvent[] {
  const merged: EconomicNewsEvent[] = [];
  const coveredSet =
    ffCoveredDateKeys instanceof Set
      ? ffCoveredDateKeys
      : Array.isArray(ffCoveredDateKeys)
      ? new Set(ffCoveredDateKeys)
      : null;

  const pushOrMerge = (candidate: EconomicNewsEvent, allowInsertNew = true) => {
    const normCand = normalizeTitleForDedup(candidate.title);
    const existing = merged.find((e) => {
      const dtMin = Math.abs(e.timestampMs - candidate.timestampMs) / 60_000;
      if (dtMin > 10) return false;
      const normEx = normalizeTitleForDedup(e.title);
      if (normEx === normCand) return true;
      return tokenJaccard(normEx, normCand) >= 0.78;
    });

    if (!existing) {
      if (allowInsertNew) {
        merged.push({ ...candidate });
      }
      return;
    }

    if (!existing.actual && candidate.actual) existing.actual = candidate.actual;
    if (!existing.forecast && candidate.forecast) existing.forecast = candidate.forecast;
    if (!existing.previous && candidate.previous) existing.previous = candidate.previous;
    if (!existing.source.includes(candidate.source)) {
      existing.source = `${existing.source} + ${candidate.source}`;
    }
  };

  for (const e of ffEvents) pushOrMerge(e, true);
  for (const e of tvEvents) {
    if (!isForexFactoryUsdRedTitle(e.title)) continue;
    const isDateCoveredByFf = coveredSet != null && coveredSet.has(e.istDateKey);
    pushOrMerge(e, !isDateCoveredByFf);
  }

  return merged.sort((a, b) => a.timestampMs - b.timestampMs || a.title.localeCompare(b.title));
}

function isValidDiskNewsEvent(item: unknown): item is EconomicNewsEvent {
  if (!item || typeof item !== 'object') return false;
  const e = item as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.title === 'string' &&
    e.title.length > 0 &&
    typeof e.timestampMs === 'number' &&
    Number.isFinite(e.timestampMs) &&
    typeof e.istDateKey === 'string'
  );
}

async function ensureDiskCacheLoaded(): Promise<void> {
  if (state.loadedFromDisk) return;
  state.loadedFromDisk = true;
  try {
    const raw = await fs.readFile(NEWS_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as DiskNewsCache;
    if (parsed && typeof parsed === 'object') {
      state.lastTvSuccessMs =
        typeof parsed.lastTvSuccessMs === 'number' && Number.isFinite(parsed.lastTvSuccessMs)
          ? parsed.lastTvSuccessMs
          : null;
      state.lastFfSuccessMs =
        typeof parsed.lastFfSuccessMs === 'number' && Number.isFinite(parsed.lastFfSuccessMs)
          ? parsed.lastFfSuccessMs
          : null;
      state.ffBackoffUntilMs =
        typeof parsed.ffBackoffUntilMs === 'number' && Number.isFinite(parsed.ffBackoffUntilMs)
          ? parsed.ffBackoffUntilMs
          : null;
      if (Array.isArray(parsed.tvEvents)) {
        state.tvEvents = parsed.tvEvents.filter(
          (e) => isValidDiskNewsEvent(e) && isForexFactoryUsdRedTitle(e.title)
        );
      }
      if (Array.isArray(parsed.ffEvents)) {
        state.ffEvents = parsed.ffEvents.filter(isValidDiskNewsEvent);
      }
      if (Array.isArray(parsed.ffCoveredDateKeys)) {
        state.ffCoveredDateKeys = parsed.ffCoveredDateKeys.filter(
          (k): k is string => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k)
        );
      }
    }
  } catch {
    // Cache file may not exist on first launch
  }
}

async function persistDiskCache(): Promise<void> {
  const tmp = `${NEWS_CACHE_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const payload: DiskNewsCache = {
      lastTvSuccessMs: state.lastTvSuccessMs,
      lastFfSuccessMs: state.lastFfSuccessMs,
      ffBackoffUntilMs: state.ffBackoffUntilMs,
      tvEvents: state.tvEvents,
      ffEvents: state.ffEvents,
      ffCoveredDateKeys: state.ffCoveredDateKeys,
    };
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.rename(tmp, NEWS_CACHE_FILE);
  } catch {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function fetchTradingViewCalendar(nowMs: number): Promise<boolean> {
  const fromIso = new Date(nowMs - 24 * 3_600_000).toISOString();
  const toIso = new Date(nowMs + 9 * 86_400_000).toISOString();
  const url = `https://economic-calendar.tradingview.com/events?from=${encodeURIComponent(
    fromIso
  )}&to=${encodeURIComponent(toIso)}&countries=US`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      headers: {
        Origin: 'https://www.tradingview.com',
        Referer: 'https://www.tradingview.com/',
        'User-Agent': 'Mozilla/5.0 (compatible; LEADERS-XAUUSD/1.0)',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`TradingView HTTP ${res.status}`);
    }
    const json = (await res.json()) as { status?: string; result?: unknown[] };
    if (!Array.isArray(json?.result)) {
      throw new Error('TradingView returned invalid calendar payload');
    }
    state.tvEvents = parseTradingViewEvents(json.result);
    state.lastTvSuccessMs = nowMs;
    state.lastError = null;
    return true;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : 'TradingView news fetch error';
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchForexFactoryCalendar(nowMs: number): Promise<boolean> {
  if (state.ffBackoffUntilMs && nowMs < state.ffBackoffUntilMs) {
    return false;
  }

  const urls = [
    'https://nfs.faireconomy.media/ff_calendar_thisweek.xml',
    'https://nfs.faireconomy.media/ff_calendar_nextweek.xml',
  ];

  const collected: EconomicNewsEvent[] = [];
  const coveredDateKeys = new Set<string>();
  let anySuccess = false;

  for (const targetUrl of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7_000);
    try {
      const res = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LEADERS-XAUUSD/1.0)' },
        signal: controller.signal,
      });
      if (res.status === 429) {
        state.ffBackoffUntilMs = nowMs + FF_RATE_LIMIT_BACKOFF_MS;
        break;
      }
      if (res.status === 404) {
        continue;
      }
      if (!res.ok) {
        continue;
      }
      const text = await res.text();
      if (/rate\s*limited/i.test(text) && !text.includes('<event>')) {
        state.ffBackoffUntilMs = nowMs + FF_RATE_LIMIT_BACKOFF_MS;
        break;
      }
      if (text.trim().startsWith('<weeklyevents') || text.includes('<event>')) {
        collected.push(...parseForexFactoryXml(text));
        for (const k of extractFfCoveredIstDateKeysFromXml(text)) {
          coveredDateKeys.add(k);
        }
        anySuccess = true;
      } else if (text.trim().startsWith('[')) {
        const json = JSON.parse(text) as unknown[];
        collected.push(...parseForexFactoryJson(json));
        for (const k of extractFfCoveredIstDateKeysFromJson(json)) {
          coveredDateKeys.add(k);
        }
        anySuccess = true;
      }
    } catch {
      // Ignore transient FF feed failure
    } finally {
      clearTimeout(timer);
    }
  }

  if (anySuccess) {
    state.ffEvents = collected;
    state.ffCoveredDateKeys = Array.from(coveredDateKeys);
    state.lastFfSuccessMs = nowMs;
    state.ffBackoffUntilMs = null;
    return true;
  }
  return false;
}

function hasImminentOrLiveEvent(events: EconomicNewsEvent[], nowMs: number): boolean {
  return events.some((e) => {
    const diff = e.timestampMs - nowMs;
    return diff >= -15 * 60_000 && diff <= 20 * 60_000;
  });
}

export async function refreshNewsCalendarIfNeeded(force = false): Promise<void> {
  await ensureDiskCacheLoaded();

  if (state.inFlightRefresh) {
    return state.inFlightRefresh;
  }

  const nowMs = Date.now();
  const mergedSnapshot = mergeAndDeduplicateEvents(
    state.ffEvents,
    state.tvEvents,
    state.ffCoveredDateKeys
  );
  const tvTtl = hasImminentOrLiveEvent(mergedSnapshot, nowMs)
    ? TV_REFRESH_NEAR_EVENT_MS
    : TV_REFRESH_NORMAL_MS;

  const needTv =
    force || state.lastTvSuccessMs == null || nowMs - state.lastTvAttemptMs >= tvTtl;
  const needFf =
    (force && (!state.ffBackoffUntilMs || nowMs >= state.ffBackoffUntilMs)) ||
    state.lastFfSuccessMs == null ||
    nowMs - state.lastFfAttemptMs >= FF_REFRESH_MIN_MS;

  if (!needTv && !needFf) return;

  state.inFlightRefresh = (async () => {
    const tasks: Promise<boolean>[] = [];
    if (needTv) {
      state.lastTvAttemptMs = nowMs;
      tasks.push(fetchTradingViewCalendar(nowMs));
    }
    if (needFf) {
      state.lastFfAttemptMs = nowMs;
      tasks.push(fetchForexFactoryCalendar(nowMs));
    }
    if (tasks.length > 0) {
      const results = await Promise.all(tasks);
      if (results.some(Boolean)) {
        await persistDiskCache();
      }
    }
  })().finally(() => {
    state.inFlightRefresh = null;
  });

  return state.inFlightRefresh;
}

export function evaluateMarketStabilityAfterNews(params: {
  quote?: MarketQuote | null;
  candles5m?: Candle[] | null;
  candles1m?: Candle[] | null;
  nowMs?: number;
}): NewsMarketStability {
  const { quote, candles5m, candles1m, nowMs = Date.now() } = params;

  const quoteLive =
    quote != null &&
    quote.freshness === 'LIVE' &&
    Number.isFinite(quote.mid) &&
    quote.mid > 0 &&
    Math.max(0, nowMs - quote.timestamp) <= 120_000;

  const spreadUsd =
    quote && Number.isFinite(quote.spread) && quote.spread >= 0
      ? Number(quote.spread.toFixed(3))
      : null;

  const atr5m =
    candles5m && candles5m.length >= 16
      ? lastNonNull(atrArray(candles5m, 14)).value
      : null;
  const atr1m =
    candles1m && candles1m.length >= 16
      ? lastNonNull(atrArray(candles1m, 14)).value
      : null;

  const maxSpreadLimit =
    atr5m != null ? Math.min(2.5, Math.max(1.2, atr5m * 0.65)) : 2.5;
  const spreadOk = spreadUsd != null && spreadUsd <= maxSpreadLimit;

  let volatilityOk = true;
  let volatilityDetail = 'Volatility and spread normalized';

  if (!quoteLive) {
    volatilityOk = false;
    volatilityDetail = 'Awaiting LIVE XAU/USD Spot BBO quote freshness';
  } else if (!spreadOk) {
    volatilityOk = false;
    volatilityDetail = `Spread $${spreadUsd?.toFixed(2) ?? 'N/A'} exceeds $${maxSpreadLimit.toFixed(
      2
    )} stability limit`;
  } else if (candles5m && candles5m.length >= 16 && atr5m != null) {
    const lastClose5m = candles5m[candles5m.length - 1].close;
    const atr5mPct = lastClose5m > 0 ? (atr5m / lastClose5m) * 100 : 0;
    if (atr5mPct > 1.3) {
      volatilityOk = false;
      volatilityDetail = `5m ATR volatility spike (${atr5mPct.toFixed(2)}%) still elevated`;
    }
  }

  if (volatilityOk && candles1m && candles1m.length >= 16 && atr1m != null && atr1m > 0) {
    const last1m = candles1m[candles1m.length - 1];
    const lastRange = last1m.high - last1m.low;
    if (lastRange > atr1m * 2.2) {
      volatilityOk = false;
      volatilityDetail = `1m candle spike range ($${lastRange.toFixed(2)} > 2.2x ATR $${atr1m.toFixed(
        2
      )}) not yet settled`;
    }
  }

  return {
    quoteLive,
    spreadOk,
    spreadUsd,
    volatilityOk,
    volatilityDetail,
  };
}

/**
 * Pure centralized news-blocking & warning evaluator shared by Trade, Sure, Signal, and News.
 */
export function evaluateNewsProtectionFromEvents(params: {
  events: EconomicNewsEvent[];
  feedStatus: NewsFeedStatus;
  lastVerifiedMs: number | null;
  nowMs?: number;
  quote?: MarketQuote | null;
  candles5m?: Candle[] | null;
  candles1m?: Candle[] | null;
  config?: NewsProtectionConfig;
}): NewsProtectionState {
  const {
    events,
    feedStatus,
    lastVerifiedMs,
    nowMs = Date.now(),
    quote = null,
    candles5m = null,
    candles1m = null,
    config = DEFAULT_NEWS_PROTECTION_CONFIG,
  } = params;

  const warningLeadMs = config.warningLeadMinutes * 60_000;
  const preBlockMs = config.preEventBlockMinutes * 60_000;
  const minPostBlockMs = config.minPostEventBlockMinutes * 60_000;
  const maxPostBlockMs = config.maxPostEventBlockMinutes * 60_000;
  const maxAgeMs = config.maxNewsCacheAgeMinutes * 60_000;

  const evaluatedAt = new Date(nowMs).toISOString();
  const stability = evaluateMarketStabilityAfterNews({
    quote,
    candles5m,
    candles1m,
    nowMs,
  });

  const isFeedStaleOrMissing =
    feedStatus === 'UNAVAILABLE' ||
    feedStatus === 'STALE' ||
    lastVerifiedMs == null ||
    nowMs - lastVerifiedMs > maxAgeMs;

  if (isFeedStaleOrMissing) {
    const ageMin =
      lastVerifiedMs != null ? Math.round((nowMs - lastVerifiedMs) / 60_000) : null;
    const warningMsg =
      ageMin != null
        ? `Economic calendar data is ${ageMin}m old (stale) and could not be verified live. Safe fallback paused new BUY/SELL signals.`
        : 'Economic calendar data is currently unavailable and cannot be verified. Safe fallback paused new BUY/SELL signals.';

    return {
      status: 'BLOCKED_UNVERIFIED',
      warningActive: true,
      blocked: true,
      safeFallbackActive: true,
      reasonCode: 'NEWS_DATA_UNVERIFIED',
      headline: 'HIGH IMPACT NEWS',
      subtext: warningMsg,
      activeEvent: null,
      upcomingEvent: events.find((e) => e.timestampMs > nowMs) ?? null,
      minutesToEvent: null,
      minutesSinceEvent: null,
      marketStability: stability,
      feedStatus: lastVerifiedMs == null ? 'UNAVAILABLE' : 'STALE',
      dataStatusWarning: warningMsg,
      evaluatedAt,
      config,
    };
  }

  const sorted = [...events].sort((a, b) => a.timestampMs - b.timestampMs);

  // 1. Pre-event blocking window: [eventTime - preBlockMs, eventTime)
  const preEventMatch = sorted.find(
    (e) => nowMs >= e.timestampMs - preBlockMs && nowMs < e.timestampMs
  );
  if (preEventMatch) {
    const minsTo = Math.max(1, Math.ceil((preEventMatch.timestampMs - nowMs) / 60_000));
    return {
      status: 'BLOCKED_NEWS',
      warningActive: true,
      blocked: true,
      safeFallbackActive: false,
      reasonCode: 'PRE_EVENT_WINDOW',
      headline: 'HIGH IMPACT NEWS',
      subtext: `${preEventMatch.title} (USD High Impact) starts at ${preEventMatch.istTimeLabel} IST (in ${minsTo}m). Normal analysis and SURE signals are paused.`,
      activeEvent: preEventMatch,
      upcomingEvent: preEventMatch,
      minutesToEvent: minsTo,
      minutesSinceEvent: null,
      marketStability: stability,
      feedStatus,
      dataStatusWarning: null,
      evaluatedAt,
      config,
    };
  }

  // 2. Event live & post-event cooldown / volatility check: [eventTime, eventTime + maxPostBlockMs]
  const recentPostMatches = sorted
    .filter((e) => nowMs >= e.timestampMs && nowMs <= e.timestampMs + maxPostBlockMs)
    .sort((a, b) => b.timestampMs - a.timestampMs);

  const postEventMatch = recentPostMatches[0] ?? null;
  if (postEventMatch) {
    const elapsedMs = nowMs - postEventMatch.timestampMs;
    const minsSince = Math.max(0, Math.floor(elapsedMs / 60_000));
    const inMandatoryCooldown = elapsedMs < minPostBlockMs;
    const marketUnstable = !stability.quoteLive || !stability.spreadOk || !stability.volatilityOk;

    if (inMandatoryCooldown || marketUnstable) {
      const reasonCode =
        elapsedMs < 2 * 60_000
          ? 'EVENT_LIVE'
          : inMandatoryCooldown
          ? 'POST_EVENT_COOLDOWN'
          : 'POST_EVENT_VOLATILITY';

      const nextUpcoming = sorted.find((e) => e.timestampMs > nowMs) ?? null;

      return {
        status: 'BLOCKED_NEWS',
        warningActive: true,
        blocked: true,
        safeFallbackActive: false,
        reasonCode,
        headline: 'HIGH IMPACT NEWS',
        subtext: inMandatoryCooldown
          ? `${postEventMatch.title} (${postEventMatch.istTimeLabel} IST) released ${minsSince}m ago. Trading paused during minimum ${config.minPostEventBlockMinutes}m post-news cooldown and volatility check.`
          : `${postEventMatch.title} (${postEventMatch.istTimeLabel} IST) post-news hold active (${minsSince}m elapsed): ${stability.volatilityDetail}.`,
        activeEvent: postEventMatch,
        upcomingEvent: nextUpcoming,
        minutesToEvent: nextUpcoming
          ? Math.max(1, Math.ceil((nextUpcoming.timestampMs - nowMs) / 60_000))
          : null,
        minutesSinceEvent: minsSince,
        marketStability: stability,
        feedStatus,
        dataStatusWarning: null,
        evaluatedAt,
        config,
      };
    }
  }

  // 3. Upcoming warning window: (eventTime - nowMs) <= warningLeadMs
  const upcomingWithinWarning = sorted.find(
    (e) => e.timestampMs > nowMs && e.timestampMs - nowMs <= warningLeadMs
  );

  const nextUpcomingEvent = sorted.find((e) => e.timestampMs > nowMs) ?? null;
  const minsToNext = nextUpcomingEvent
    ? Math.max(1, Math.ceil((nextUpcomingEvent.timestampMs - nowMs) / 60_000))
    : null;

  if (upcomingWithinWarning) {
    const minsTo = Math.max(1, Math.ceil((upcomingWithinWarning.timestampMs - nowMs) / 60_000));
    return {
      status: 'WARNING_UPCOMING',
      warningActive: true,
      blocked: false,
      safeFallbackActive: false,
      reasonCode: 'NONE',
      headline: 'HIGH IMPACT NEWS COMING',
      subtext: `${upcomingWithinWarning.title} (USD High Impact) scheduled at ${upcomingWithinWarning.istTimeLabel} IST (in ${minsTo}m). Signals pause ${config.preEventBlockMinutes}m prior.`,
      activeEvent: null,
      upcomingEvent: upcomingWithinWarning,
      minutesToEvent: minsTo,
      minutesSinceEvent: null,
      marketStability: stability,
      feedStatus,
      dataStatusWarning: null,
      evaluatedAt,
      config,
    };
  }

  return {
    status: 'CLEAR',
    warningActive: false,
    blocked: false,
    safeFallbackActive: false,
    reasonCode: 'NONE',
    headline: 'NO IMMINENT HIGH-IMPACT USD NEWS',
    subtext: nextUpcomingEvent
      ? `Next USD High-Impact event: ${nextUpcomingEvent.title} on ${nextUpcomingEvent.istDateLabel} at ${nextUpcomingEvent.istTimeLabel} IST.`
      : 'No USD High-Impact news scheduled within current warning window.',
    activeEvent: null,
    upcomingEvent: nextUpcomingEvent,
    minutesToEvent: minsToNext,
    minutesSinceEvent: null,
    marketStability: stability,
    feedStatus,
    dataStatusWarning: null,
    evaluatedAt,
    config,
  };
}

function getEffectiveNewsState(nowMs = Date.now()): {
  events: EconomicNewsEvent[];
  feedStatus: NewsFeedStatus;
  lastVerifiedMs: number | null;
  sources: string[];
} {
  const events = mergeAndDeduplicateEvents(
    state.ffEvents,
    state.tvEvents,
    state.ffCoveredDateKeys
  );
  const candidates = [state.lastTvSuccessMs, state.lastFfSuccessMs].filter(
    (v): v is number => typeof v === 'number'
  );
  const newestSuccessMs = candidates.length > 0 ? Math.max(...candidates) : null;
  const maxAgeMs = DEFAULT_NEWS_PROTECTION_CONFIG.maxNewsCacheAgeMinutes * 60_000;

  let feedStatus: NewsFeedStatus = 'UNAVAILABLE';
  if (newestSuccessMs != null) {
    const ageMs = nowMs - newestSuccessMs;
    if (ageMs <= 5 * 60_000 && !state.lastError) {
      feedStatus = 'LIVE';
    } else if (ageMs <= maxAgeMs) {
      feedStatus = 'CACHED';
    } else {
      feedStatus = 'STALE';
    }
  }

  const sources: string[] = [];
  if (state.lastTvSuccessMs != null) sources.push('TradingView Economic Calendar');
  if (state.lastFfSuccessMs != null) sources.push('Forex Factory Weekly Feed');

  return {
    events,
    feedStatus,
    lastVerifiedMs: newestSuccessMs,
    sources,
  };
}

async function resolveMarketContextForNews(options?: {
  quote?: MarketQuote | null;
  candles5m?: Candle[] | null;
  candles1m?: Candle[] | null;
}): Promise<{
  quote: MarketQuote | null;
  candles5m: Candle[] | null;
  candles1m: Candle[] | null;
}> {
  let quote = options?.quote ?? null;
  if (quote == null) {
    quote = await fetchLiveXauUsdQuote().catch(() => null);
  }

  let candles5m = options?.candles5m ?? null;
  let candles1m = options?.candles1m ?? null;

  if (candles5m == null) {
    const spot5 = await getPureSpotCandles('5m').catch(() => null);
    if (spot5 && spot5.candles.length >= 20) {
      candles5m = spot5.candles;
    } else {
      const f5 = await fetchPureFuturesCandles('5m').catch(() => null);
      candles5m = f5?.candles ?? null;
    }
  }

  if (candles1m == null) {
    const spot1 = await getPureSpotCandles('1m').catch(() => null);
    if (spot1 && spot1.candles.length >= 20) {
      candles1m = spot1.candles;
    } else {
      const f1 = await fetchPureFuturesCandles('1m').catch(() => null);
      candles1m = f1?.candles ?? null;
    }
  }

  return { quote, candles5m, candles1m };
}

export async function evaluateCurrentNewsProtection(options?: {
  quote?: MarketQuote | null;
  candles5m?: Candle[] | null;
  candles1m?: Candle[] | null;
  forceRefresh?: boolean;
  nowMs?: number;
}): Promise<NewsProtectionState> {
  await refreshNewsCalendarIfNeeded(Boolean(options?.forceRefresh));
  const nowMs = options?.nowMs ?? Date.now();
  const { events, feedStatus, lastVerifiedMs } = getEffectiveNewsState(nowMs);
  const market = await resolveMarketContextForNews(options);

  return evaluateNewsProtectionFromEvents({
    events,
    feedStatus,
    lastVerifiedMs,
    nowMs,
    quote: market.quote,
    candles5m: market.candles5m,
    candles1m: market.candles1m,
    config: DEFAULT_NEWS_PROTECTION_CONFIG,
  });
}

export async function getEconomicCalendarPayload(options?: {
  quote?: MarketQuote | null;
  forceRefresh?: boolean;
  nowMs?: number;
}): Promise<EconomicCalendarPayload> {
  await refreshNewsCalendarIfNeeded(Boolean(options?.forceRefresh));
  const nowMs = options?.nowMs ?? Date.now();
  const { events, feedStatus, lastVerifiedMs, sources } = getEffectiveNewsState(nowMs);
  const market = await resolveMarketContextForNews({ quote: options?.quote });

  const protection = evaluateNewsProtectionFromEvents({
    events,
    feedStatus,
    lastVerifiedMs,
    nowMs,
    quote: market.quote,
    candles5m: market.candles5m,
    candles1m: market.candles1m,
    config: DEFAULT_NEWS_PROTECTION_CONFIG,
  });

  const windowDays = buildRollingIstWindowDays(nowMs, 7);
  const allowedKeys = new Set(windowDays.map((d) => d.dateKey));

  const groupedMap = new Map<string, EconomicNewsEvent[]>();
  for (const day of windowDays) {
    groupedMap.set(day.dateKey, []);
  }

  let totalEvents = 0;
  for (const ev of events) {
    if (!allowedKeys.has(ev.istDateKey)) continue;
    const bucket = groupedMap.get(ev.istDateKey);
    if (bucket) {
      bucket.push(ev);
      totalEvents++;
    }
  }

  const days: NewsCalendarDayGroup[] = windowDays.map((day) => ({
    dateKey: day.dateKey,
    dayLabel: day.dayLabel,
    year: day.year,
    isToday: day.isToday,
    events: (groupedMap.get(day.dateKey) ?? []).sort((a, b) => a.timestampMs - b.timestampMs),
  }));

  const uniqueYears = Array.from(new Set(windowDays.map((d) => d.year)));
  const yearHeader = uniqueYears.length > 1 ? uniqueYears.join(' — ') : uniqueYears[0] ?? '2026';

  return {
    yearHeader,
    timezone: IST_TIMEZONE,
    timezoneDisplay: 'IST (Asia/Kolkata)',
    currencyFilter: 'USD',
    impactFilter: 'HIGH',
    startDateKey: windowDays[0].dateKey,
    endDateKey: windowDays[windowDays.length - 1].dateKey,
    days,
    eventsCount: totalEvents,
    feedStatus,
    lastUpdatedAt: lastVerifiedMs != null ? new Date(lastVerifiedMs).toISOString() : null,
    sources,
    dataStatusWarning: protection.dataStatusWarning,
    protection,
  };
}

export function startNewsBackgroundMonitor(onUnblocked?: () => void): void {
  if (monitorTimer) return;

  const tick = async () => {
    try {
      const calendar = await getEconomicCalendarPayload();
      const p = calendar.protection;
      const justUnblocked = lastBlockedFlag === true && p.blocked === false;
      lastBlockedFlag = p.blocked;

      const sig = `${p.status}|${p.reasonCode}|${p.blocked}|${p.warningActive}|${
        p.activeEvent?.id ?? ''
      }|${p.upcomingEvent?.id ?? ''}|${p.minutesToEvent ?? ''}|${p.feedStatus}`;

      if (sig !== lastBroadcastSignature || justUnblocked) {
        lastBroadcastSignature = sig;
        for (const listener of newsListeners) {
          try {
            listener({ type: 'news_status', protection: p, calendar, justUnblocked });
          } catch {
            // Ignore closed client stream errors
          }
        }
        if (justUnblocked && onUnblocked) {
          onUnblocked();
        }
      }
    } catch {
      // Non-fatal background monitor error
    }
  };

  void tick();
  monitorTimer = setInterval(() => {
    void tick();
  }, 30_000);
  monitorTimer.unref?.();
}
