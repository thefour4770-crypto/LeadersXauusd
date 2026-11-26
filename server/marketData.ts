import fs from 'node:fs/promises';
import path from 'node:path';
import type { Candle, CandleDataset, FreshnessStatus, MarketQuote, Timeframe } from '../src/types/market.ts';

const YAHOO_TIMEFRAME_MAP: Record<
  Timeframe,
  { interval: string; range: string; maxLiveAgeMs: number; seconds: number; cacheTtlMs: number }
> = {
  '1m': { interval: '1m', range: '2d', maxLiveAgeMs: 180_000, seconds: 60, cacheTtlMs: 45_000 },
  '5m': { interval: '5m', range: '5d', maxLiveAgeMs: 360_000, seconds: 300, cacheTtlMs: 55_000 },
  '15m': { interval: '15m', range: '1mo', maxLiveAgeMs: 960_000, seconds: 900, cacheTtlMs: 120_000 },
  '30m': { interval: '30m', range: '1mo', maxLiveAgeMs: 1_900_000, seconds: 1_800, cacheTtlMs: 180_000 },
  '1H': { interval: '1h', range: '3mo', maxLiveAgeMs: 3_700_000, seconds: 3_600, cacheTtlMs: 300_000 },
  '4H': { interval: '4h', range: '6mo', maxLiveAgeMs: 14_500_000, seconds: 14_400, cacheTtlMs: 900_000 },
  '1D': { interval: '1d', range: '2y', maxLiveAgeMs: 90_000_000, seconds: 86_400, cacheTtlMs: 1_800_000 },
  '1W': { interval: '1wk', range: '5y', maxLiveAgeMs: 605_000_000, seconds: 604_800, cacheTtlMs: 3_600_000 },
};

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const LIVE_SPOT_1M_FILE = path.join(DATA_DIR, 'live-spot-1m.json');
const YAHOO_CANDLE_CACHE_FILE = path.join(DATA_DIR, 'yahoo-candles-cache.json');
const YAHOO_CHART_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'] as const;
const TRADINGVIEW_WS_URL = 'wss://data.tradingview.com/socket.io/websocket';
const TRADINGVIEW_TIMEFRAME_MAP: Record<Timeframe, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1H': '60',
  '4H': '240',
  '1D': '1D',
  '1W': '1W',
};

const quoteCache: { current: CacheEntry<MarketQuote> | null } = { current: null };
const prevCloseCache: { current: CacheEntry<number> | null } = { current: null };
const rawYahooCache = new Map<Timeframe, CacheEntry<CandleDataset>>();
const inFlightYahooPromises = new Map<Timeframe, Promise<CandleDataset>>();
const tvSpotCache = new Map<Timeframe, CacheEntry<CandleDataset>>();
const inFlightTvPromises = new Map<Timeframe, Promise<CandleDataset | null>>();

// Real-time Swissquote Spot 1m bar accumulator persisted across restarts
const liveSpot1mCandles = new Map<number, Candle>();
const MAX_LIVE_SPOT_BARS = 1_440; // Keep last 24 hours of 1m live spot bars

const QUOTE_TTL_MS = 400;
const PREV_CLOSE_TTL_MS = 15 * 60_000;
const COLLECTOR_ACTIVE_MS = 750;
const COLLECTOR_IDLE_MS = 3_000;
const COLLECTOR_IDLE_AFTER_MS = 120_000;
const YAHOO_RATE_LIMIT_DEFAULT_MS = 60_000;
const TV_ERROR_COOLDOWN_MS = 15_000;

let lastClientActivityAt = Date.now();
let collectorTimer: ReturnType<typeof setTimeout> | null = null;
let collectorInFlight = false;
let inFlightQuotePromise: Promise<MarketQuote> | null = null;
let lastEmittedQuoteKey = '';
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let yahooPersistTimer: ReturnType<typeof setTimeout> | null = null;
export interface FuturesRolloverAnchor {
  timeSec: number;
  shiftUsd: number;
}

const detectedRolloverAnchors = new Map<number, number>(); // rolloverTimeSec -> shiftUsd
let spotStoreLoadPromise: Promise<void> | null = null;
let yahooCacheLoadPromise: Promise<void> | null = null;
let yahooRateLimitedUntilMs = 0;
let tvCooldownUntilMs = 0;
let yahooHostIdx = 0;
const IS_TEST_ENV = Boolean(
  process.env.NODE_TEST_CONTEXT || process.argv.some((a) => a.includes('--test'))
);

function roundPrice2(val: number): number {
  return Number(val.toFixed(2));
}

function medianNumber(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isValidCandleRecord(item: unknown): item is Candle {
  if (!item || typeof item !== 'object') return false;
  const c = item as Record<string, unknown>;
  return (
    typeof c.time === 'number' &&
    typeof c.open === 'number' &&
    typeof c.high === 'number' &&
    typeof c.low === 'number' &&
    typeof c.close === 'number' &&
    Number.isFinite(c.time) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    c.time > 0 &&
    c.open > 0 &&
    c.low > 0 &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close)
  );
}

/**
 * Stitches continuous futures (e.g. COMEX GC=F) front-month contract rollovers via back-adjustment
 * so artificial contract-carry jumps & transition-bar spikes do not corrupt EMAs, ATR, Trend, or Volume.
 * Leaves normal volatility, news spikes (where Spot moves alongside Futures), and weekend gaps untouched.
 */
export function stitchFuturesContractRollovers(
  candles: Candle[],
  timeframe: Timeframe,
  options?: {
    externalAnchors?: FuturesRolloverAnchor[];
    spot1mCandles?: Candle[];
    liveSpotQuoteMid?: number;
  }
): { candles: Candle[]; rollovers: FuturesRolloverAnchor[] } {
  if (!Array.isArray(candles) || candles.length < 20) {
    return { candles: Array.isArray(candles) ? candles.map((c) => ({ ...c })) : [], rollovers: [] };
  }

  const tfSec = TIMEFRAME_SECONDS[timeframe];
  const isIntraday = tfSec < 86_400;
  const out = candles.map((c) => ({ ...c }));
  const rollovers: FuturesRolloverAnchor[] = [];

  const externalAnchors = options?.externalAnchors ?? [];
  const spot1m = options?.spot1mCandles ?? [];

  const findSpotCloseNear = (targetSec: number, maxDiffSec: number): number | null => {
    if (spot1m.length === 0) return null;
    let best: Candle | null = null;
    let bestDiff = maxDiffSec;
    for (let s = spot1m.length - 1; s >= 0; s--) {
      const bar = spot1m[s];
      const diff = Math.abs(bar.time - targetSec);
      if (diff <= bestDiff) {
        bestDiff = diff;
        best = bar;
      }
      if (bar.time < targetSec - maxDiffSec) break;
    }
    return best ? best.close : null;
  };

  for (let i = 15; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    const dt = cur.time - prev.time;
    const isWeekendOrHoliday = isIntraday && dt >= 6 * 3_600;
    if (isWeekendOrHoliday) continue;

    const winStart = Math.max(0, i - 24);
    const win = out.slice(winStart, i);
    const trList: number[] = [];
    const volList: number[] = [];
    for (let w = 0; w < win.length; w++) {
      const b = win[w];
      const tr =
        w === 0
          ? b.high - b.low
          : Math.max(b.high - b.low, Math.abs(b.high - win[w - 1].close), Math.abs(b.low - win[w - 1].close));
      if (Number.isFinite(tr) && tr >= 0) trList.push(tr);
      if (Number.isFinite(b.volume) && b.volume > 0) volList.push(b.volume);
    }
    const medTR = Math.max(0.5, medianNumber(trList));
    const medVol = volList.length > 0 ? medianNumber(volList) : 0;

    const gap = cur.open - prev.close;
    const body = cur.close - cur.open;
    const absGap = Math.abs(gap);
    const absBody = Math.abs(body);
    const volRatio = medVol > 0 ? cur.volume / medVol : 0;

    const postBars = out.slice(i + 1, Math.min(out.length, i + 4));
    const medPostClose = postBars.length > 0 ? medianNumber(postBars.map((b) => b.close)) : cur.close;

    const matchedAnchor = externalAnchors.find(
      (a) => a.timeSec >= cur.time && a.timeSec < cur.time + tfSec && Math.abs(a.shiftUsd) >= 8
    );

    let detectedMode: 'STEP_GAP' | 'HYBRID' | null = null;
    let shiftUsd = 0;

    if (matchedAnchor && (absGap >= 8 || absBody >= 8 || (medVol > 0 && cur.volume >= medVol * 4))) {
      shiftUsd = matchedAnchor.shiftUsd;
      // Anchor at bar start means clean step gap; mid-bar anchor means hybrid transition bar
      detectedMode = matchedAnchor.timeSec === cur.time && absGap >= Math.abs(shiftUsd) * 0.5 ? 'STEP_GAP' : 'HYBRID';
    } else if (
      absGap >= Math.max(10, medTR * 3.8) &&
      (medVol === 0 || cur.volume >= Math.max(800, medVol * 6)) &&
      (postBars.length > 0
        ? Math.abs(medPostClose - cur.open) <= absGap * 0.55 &&
          Math.abs(medPostClose - prev.close) >= absGap * 0.55
        : typeof options?.liveSpotQuoteMid === 'number' &&
          Number.isFinite(options.liveSpotQuoteMid) &&
          cur.volume >= Math.max(2000, medVol * 15) &&
          Math.abs(cur.open - options.liveSpotQuoteMid) >= Math.max(12, Math.abs(prev.close - options.liveSpotQuoteMid) + 10))
    ) {
      detectedMode = 'STEP_GAP';
      shiftUsd = gap;
    } else if (
      postBars.length > 0 &&
      absBody >= Math.max(15, medTR * 3.5) &&
      medVol > 0 &&
      cur.volume >= Math.max(4000, medVol * 20) &&
      Math.abs(medPostClose - cur.close) <= absBody * 0.45 &&
      Math.abs(medPostClose - cur.open) >= absBody * 0.55
    ) {
      detectedMode = 'HYBRID';
      shiftUsd = body;
    } else if (
      spot1m.length > 0 &&
      (absGap >= 12 || (absBody >= 15 && medVol > 0 && cur.volume >= Math.max(2000, medVol * 8)))
    ) {
      // Cross-check against Spot 1m history: real news moves both Spot & Futures together;
      // contract rollovers shift Futures while Spot stays flat -> Spot/Futures basis jumps sharply.
      const spotBefore = findSpotCloseNear(prev.time + tfSec - 60, Math.max(900, tfSec));
      const spotAfter =
        i < out.length - 1
          ? findSpotCloseNear(out[i + 1].time, Math.max(900, tfSec))
          : typeof options?.liveSpotQuoteMid === 'number' && options.liveSpotQuoteMid > 0
          ? options.liveSpotQuoteMid
          : findSpotCloseNear(cur.time + tfSec - 60, Math.max(900, tfSec));

      if (spotBefore != null && spotAfter != null) {
        const basisBefore = prev.close - spotBefore;
        const basisAfter = cur.close - spotAfter;
        const basisJump = basisAfter - basisBefore;
        const moveRef = absGap >= 12 ? gap : body;
        if (Math.abs(basisJump) >= 12 && Math.sign(basisJump) === Math.sign(moveRef)) {
          detectedMode = absGap >= Math.abs(basisJump) * 0.55 ? 'STEP_GAP' : 'HYBRID';
          shiftUsd = basisJump;
        }
      }
    }

    if (detectedMode && Number.isFinite(shiftUsd) && Math.abs(shiftUsd) >= 8) {
      const cleanShift = roundPrice2(shiftUsd);
      for (let j = 0; j < i; j++) {
        out[j] = {
          ...out[j],
          open: roundPrice2(out[j].open + cleanShift),
          high: roundPrice2(out[j].high + cleanShift),
          low: roundPrice2(out[j].low + cleanShift),
          close: roundPrice2(out[j].close + cleanShift),
        };
      }

      if (detectedMode === 'HYBRID') {
        const nextOpen = roundPrice2(cur.open + cleanShift);
        const nextClose = roundPrice2(cur.close);
        let nextHigh = cur.high;
        let nextLow = cur.low;
        if (cleanShift > 0) {
          nextLow = roundPrice2(Math.min(nextOpen, nextClose, cur.low + cleanShift));
          nextHigh = roundPrice2(Math.max(nextOpen, nextClose, cur.high));
        } else {
          nextHigh = roundPrice2(Math.max(nextOpen, nextClose, cur.high + cleanShift));
          nextLow = roundPrice2(Math.min(nextOpen, nextClose, cur.low));
        }
        out[i] = {
          ...cur,
          open: nextOpen,
          high: nextHigh,
          low: nextLow,
          close: nextClose,
          volume: medVol > 0 && volRatio >= 3 ? Math.round(medVol) : cur.volume,
        };
      } else if (medVol > 0 && volRatio >= 3) {
        out[i] = {
          ...cur,
          volume: Math.round(medVol),
        };
      }

      rollovers.push({ timeSec: cur.time, shiftUsd: cleanShift });
    }
  }

  return { candles: out, rollovers };
}

async function ensureSpotStoreLoaded(): Promise<void> {
  if (spotStoreLoadPromise) return spotStoreLoadPromise;
  spotStoreLoadPromise = (async () => {
    try {
      const raw = await fs.readFile(LIVE_SPOT_1M_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const cutoff = Math.floor(Date.now() / 1000) - MAX_LIVE_SPOT_BARS * 60;
      for (const item of parsed) {
        if (
          item &&
          typeof item.time === 'number' &&
          Number.isFinite(item.time) &&
          item.time >= cutoff &&
          typeof item.open === 'number' &&
          typeof item.high === 'number' &&
          typeof item.low === 'number' &&
          typeof item.close === 'number' &&
          Number.isFinite(item.open) &&
          Number.isFinite(item.high) &&
          Number.isFinite(item.low) &&
          Number.isFinite(item.close) &&
          item.open > 0 &&
          item.low > 0 &&
          item.high >= Math.max(item.open, item.close) &&
          item.low <= Math.min(item.open, item.close) &&
          !liveSpot1mCandles.has(item.time)
        ) {
          liveSpot1mCandles.set(item.time, {
            time: item.time,
            open: Number(item.open.toFixed(2)),
            high: Number(item.high.toFixed(2)),
            low: Number(item.low.toFixed(2)),
            close: Number(item.close.toFixed(2)),
            volume: 0,
          });
        }
      }
    } catch {
      // Store file may not exist yet on first run
    }
  })();
  return spotStoreLoadPromise;
}

async function ensureYahooCacheLoaded(): Promise<void> {
  if (IS_TEST_ENV) return;
  if (yahooCacheLoadPromise) return yahooCacheLoadPromise;
  yahooCacheLoadPromise = (async () => {
    try {
      await ensureSpotStoreLoaded();
      const raw = await fs.readFile(YAHOO_CANDLE_CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, CacheEntry<CandleDataset>>;
      if (!parsed || typeof parsed !== 'object') return;
      const orderedKeys = Object.keys(parsed).sort((a, b) => (a === '1m' ? -1 : b === '1m' ? 1 : 0));
      const spot1m = Array.from(liveSpot1mCandles.values()).sort((a, b) => a.time - b.time);

      for (const tf of orderedKeys) {
        const entry = parsed[tf];
        if (
          tf in YAHOO_TIMEFRAME_MAP &&
          entry &&
          typeof entry.fetchedAt === 'number' &&
          Number.isFinite(entry.fetchedAt) &&
          entry.data &&
          Array.isArray(entry.data.candles) &&
          !rawYahooCache.has(tf as Timeframe)
        ) {
          const validCandles = entry.data.candles
            .filter(isValidCandleRecord)
            .sort((a, b) => a.time - b.time);
          if (validCandles.length < 30) continue;

          const anchors = Array.from(detectedRolloverAnchors.entries()).map(([timeSec, shiftUsd]) => ({
            timeSec,
            shiftUsd,
          }));
          const stitched =
            typeof entry.data.candleSource === 'string' && entry.data.candleSource.includes('GC=F')
              ? stitchFuturesContractRollovers(validCandles, tf as Timeframe, {
                  externalAnchors: anchors,
                  spot1mCandles: spot1m,
                })
              : { candles: validCandles, rollovers: [] };

          if (tf === '1m') {
            for (const r of stitched.rollovers) {
              detectedRolloverAnchors.set(r.timeSec, r.shiftUsd);
            }
          }

          rawYahooCache.set(tf as Timeframe, {
            fetchedAt: entry.fetchedAt,
            data: {
              ...entry.data,
              candles: stitched.candles,
            },
          });
        }
      }
    } catch {
      // Cache file may not exist on first boot
    }
  })();
  return yahooCacheLoadPromise;
}

function schedulePersistYahooCache(): void {
  if (IS_TEST_ENV || yahooPersistTimer !== null) return;
  yahooPersistTimer = setTimeout(async () => {
    yahooPersistTimer = null;
    const tmp = `${YAHOO_CANDLE_CACHE_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const payload: Record<string, CacheEntry<CandleDataset>> = {};
      for (const [tf, entry] of rawYahooCache.entries()) {
        payload[tf] = {
          fetchedAt: entry.fetchedAt,
          data: {
            ...entry.data,
            candles: entry.data.candles.slice(-400),
          },
        };
      }
      await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
      await fs.rename(tmp, YAHOO_CANDLE_CACHE_FILE);
    } catch {
      await fs.unlink(tmp).catch(() => {});
    }
  }, 5_000);
  yahooPersistTimer.unref?.();
}

function schedulePersistSpotCandles(): void {
  if (IS_TEST_ENV || persistTimer !== null) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    const tmp = `${LIVE_SPOT_1M_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
    try {
      await ensureSpotStoreLoaded();
      await fs.mkdir(DATA_DIR, { recursive: true });
      const sorted = Array.from(liveSpot1mCandles.values())
        .sort((a, b) => a.time - b.time)
        .slice(-MAX_LIVE_SPOT_BARS);
      await fs.writeFile(tmp, JSON.stringify(sorted), 'utf8');
      await fs.rename(tmp, LIVE_SPOT_1M_FILE);
    } catch {
      await fs.unlink(tmp).catch(() => {});
    }
  }, 4_000);
  persistTimer.unref?.();
}

type QuoteSubscriber = (quote: MarketQuote) => void;
const quoteSubscribers = new Set<QuoteSubscriber>();

export function subscribeLiveQuotes(subscriber: QuoteSubscriber): () => void {
  quoteSubscribers.add(subscriber);
  touchLiveSpotCollector();
  if (quoteCache.current && quoteCache.current.data.freshness !== 'UNAVAILABLE') {
    subscriber(quoteCache.current.data);
  }
  return () => {
    quoteSubscribers.delete(subscriber);
  };
}

function notifyQuoteSubscribers(quote: MarketQuote) {
  if (quoteSubscribers.size === 0 || quote.freshness === 'UNAVAILABLE') return;
  const key = `${quote.bid}|${quote.ask}|${quote.timestamp}`;
  if (key === lastEmittedQuoteKey) return;
  lastEmittedQuoteKey = key;
  for (const sub of quoteSubscribers) {
    try {
      sub(quote);
    } catch {
      // Ignore closed subscriber errors
    }
  }
}

function recordLiveSpotTick(price: number, timestampMs: number) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestampMs)) return;
  const rounded = Number(price.toFixed(2));
  const minuteBucket = Math.floor(Math.floor(timestampMs / 1000) / 60) * 60;
  const existing = liveSpot1mCandles.get(minuteBucket);
  if (existing) {
    existing.high = Math.max(existing.high, rounded);
    existing.low = Math.min(existing.low, rounded);
    existing.close = rounded;
  } else {
    const prevMinute = liveSpot1mCandles.get(minuteBucket - 60);
    const openPrice = prevMinute ? prevMinute.close : rounded;
    liveSpot1mCandles.set(minuteBucket, {
      time: minuteBucket,
      open: openPrice,
      high: Math.max(openPrice, rounded),
      low: Math.min(openPrice, rounded),
      close: rounded,
      volume: 0,
    });
    if (liveSpot1mCandles.size > MAX_LIVE_SPOT_BARS) {
      let oldestKey: number | undefined;
      for (const k of liveSpot1mCandles.keys()) {
        if (oldestKey === undefined || k < oldestKey) {
          oldestKey = k;
        }
      }
      if (oldestKey !== undefined) {
        liveSpot1mCandles.delete(oldestKey);
      }
    }
  }
  schedulePersistSpotCandles();
}

function scheduleNextCollectorTick() {
  if (IS_TEST_ENV || collectorTimer !== null) return;
  const isActive =
    quoteSubscribers.size > 0 || Date.now() - lastClientActivityAt < COLLECTOR_IDLE_AFTER_MS;
  const delay = isActive ? COLLECTOR_ACTIVE_MS : COLLECTOR_IDLE_MS;

  collectorTimer = setTimeout(async () => {
    collectorTimer = null;
    if (!collectorInFlight) {
      collectorInFlight = true;
      try {
        await fetchLiveXauUsdQuote({ internalCollector: true });
      } catch {
        // Non-fatal background collector error
      } finally {
        collectorInFlight = false;
      }
    }
    scheduleNextCollectorTick();
  }, delay);
  collectorTimer.unref?.();
}

function touchLiveSpotCollector() {
  if (IS_TEST_ENV) return;
  lastClientActivityAt = Date.now();
  if (collectorTimer === null) {
    scheduleNextCollectorTick();
  }
}

// Start background recorder immediately on server boot (skip side-effect under test context)
if (!IS_TEST_ENV) {
  void ensureSpotStoreLoaded().then(() => {
    scheduleNextCollectorTick();
  });
}

async function fetchPreviousCloseCached(): Promise<number | undefined> {
  const now = Date.now();
  if (prevCloseCache.current && now - prevCloseCache.current.fetchedAt < PREV_CLOSE_TTL_MS) {
    return prevCloseCache.current.data;
  }

  // Prefer real Spot XAU/USD 1D previous daily bar close so daily % change matches Swissquote Spot XAU/USD scale
  const cachedTv1D = tvSpotCache.get('1D')?.data;
  if (cachedTv1D && cachedTv1D.candles.length >= 2) {
    const prevSpotBar = cachedTv1D.candles[cachedTv1D.candles.length - 2];
    if (prevSpotBar && prevSpotBar.close > 0) {
      prevCloseCache.current = { data: prevSpotBar.close, fetchedAt: now };
      return prevSpotBar.close;
    }
  }

  if (!IS_TEST_ENV) {
    const tv1D = await fetchTradingViewSpotCandles('1D').catch(() => null);
    if (tv1D && tv1D.candles.length >= 2) {
      const prevSpotBar = tv1D.candles[tv1D.candles.length - 2];
      if (prevSpotBar && prevSpotBar.close > 0) {
        prevCloseCache.current = { data: prevSpotBar.close, fetchedAt: now };
        return prevSpotBar.close;
      }
    }
  }

  // Reuse 1D Yahoo dataset close only if Spot 1D is unavailable
  const cached1D = rawYahooCache.get('1D')?.data;
  if (cached1D && cached1D.candles.length >= 2) {
    const prevBar = cached1D.candles[cached1D.candles.length - 2];
    if (prevBar && prevBar.close > 0) {
      prevCloseCache.current = { data: prevBar.close, fetchedAt: now };
      return prevBar.close;
    }
  }

  if (now < yahooRateLimitedUntilMs) {
    return prevCloseCache.current?.data;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const host = YAHOO_CHART_HOSTS[yahooHostIdx % YAHOO_CHART_HOSTS.length];
    const res = await fetch(
      `${host}/v8/finance/chart/GC=F?interval=1d&range=5d`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
        signal: controller.signal,
      }
    );
    if (res.status === 429) {
      yahooRateLimitedUntilMs = Date.now() + YAHOO_RATE_LIMIT_DEFAULT_MS;
      yahooHostIdx = (yahooHostIdx + 1) % YAHOO_CHART_HOSTS.length;
      return prevCloseCache.current?.data;
    }
    if (!res.ok) return prevCloseCache.current?.data;
    const yJson = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: { previousClose?: number };
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = yJson?.chart?.result?.[0];
    const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter(
      (c): c is number => typeof c === 'number' && Number.isFinite(c) && c > 0
    );
    const prevCandleClose = closes.length >= 2 ? Number(closes[closes.length - 2].toFixed(2)) : undefined;
    const prev = result?.meta?.previousClose ?? prevCandleClose;
    if (typeof prev === 'number' && Number.isFinite(prev) && prev > 0) {
      prevCloseCache.current = { data: prev, fetchedAt: now };
      return prev;
    }
  } catch {
    // Ignore optional previous-close enrichment errors
  } finally {
    clearTimeout(timer);
  }
  return prevCloseCache.current?.data;
}

export async function fetchLiveXauUsdQuote(options?: { internalCollector?: boolean }): Promise<MarketQuote> {
  await ensureSpotStoreLoaded();
  if (!options?.internalCollector) {
    touchLiveSpotCollector();
  }

  const now = Date.now();
  if (quoteCache.current && now - quoteCache.current.fetchedAt < QUOTE_TTL_MS) {
    return quoteCache.current.data;
  }

  if (inFlightQuotePromise) {
    return inFlightQuotePromise;
  }

  inFlightQuotePromise = (async (): Promise<MarketQuote> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_500);
    try {
      const [sqRes, prevClose] = await Promise.all([
        fetch('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD', {
          headers: { 'User-Agent': 'LEADERS-XAUUSD/1.0' },
          signal: controller.signal,
        }),
        fetchPreviousCloseCached(),
      ]);

      if (!sqRes.ok) {
        throw new Error(`Spot quote HTTP ${sqRes.status}`);
      }

      const sqJson = (await sqRes.json()) as Array<{
        ts?: number;
        spreadProfilePrices?: Array<{ spreadProfile?: string; bid?: number; ask?: number }>;
      }>;

      const first = sqJson?.[0];
      const profiles = first?.spreadProfilePrices ?? [];
      const chosen = profiles.find((p) => p.spreadProfile === 'prime') ?? profiles[0];

      if (
        !first ||
        typeof first.ts !== 'number' ||
        !chosen ||
        typeof chosen.bid !== 'number' ||
        typeof chosen.ask !== 'number' ||
        !Number.isFinite(chosen.bid) ||
        !Number.isFinite(chosen.ask) ||
        chosen.bid <= 0 ||
        chosen.ask <= 0
      ) {
        throw new Error('Invalid spot quote payload');
      }

      const mid = Number(((chosen.bid + chosen.ask) / 2).toFixed(3));
      const spread = Number((chosen.ask - chosen.bid).toFixed(3));
      const ageMs = Math.max(0, Date.now() - first.ts);

      let freshness: FreshnessStatus = 'LIVE';
      if (ageMs > 120_000 && ageMs <= 4 * 24 * 3600 * 1000) {
        freshness = 'DELAYED';
      } else if (ageMs > 4 * 24 * 3600 * 1000) {
        freshness = 'UNAVAILABLE';
      }

      if (freshness === 'LIVE') {
        recordLiveSpotTick(mid, first.ts);
      }

      let changeAbs: number | undefined;
      let changePct: number | undefined;
      if (typeof prevClose === 'number' && prevClose > 0) {
        changeAbs = Number((mid - prevClose).toFixed(2));
        changePct = Number((((mid - prevClose) / prevClose) * 100).toFixed(2));
      }

      const quote: MarketQuote = {
        symbol: 'XAU/USD',
        bid: Number(chosen.bid.toFixed(3)),
        ask: Number(chosen.ask.toFixed(3)),
        mid,
        spread,
        timestamp: first.ts,
        freshness,
        source: 'Swissquote Spot XAU/USD BBO',
        previousClose: prevClose,
        changeAbs,
        changePct,
      };

      quoteCache.current = { data: quote, fetchedAt: Date.now() };
      notifyQuoteSubscribers(quote);
      return quote;
    } catch {
      if (quoteCache.current && Date.now() - quoteCache.current.fetchedAt < 10_000) {
        return quoteCache.current.data;
      }
      return {
        symbol: 'XAU/USD',
        bid: 0,
        ask: 0,
        mid: 0,
        spread: 0,
        timestamp: Date.now(),
        freshness: 'UNAVAILABLE',
        source: 'Swissquote Spot XAU/USD BBO',
      };
    } finally {
      clearTimeout(timer);
      inFlightQuotePromise = null;
    }
  })();

  return inFlightQuotePromise;
}

function refreshDatasetFreshness(dataset: CandleDataset, nowMs = Date.now()): CandleDataset {
  const lastCandleMs = dataset.candles[dataset.candles.length - 1]?.time
    ? dataset.candles[dataset.candles.length - 1].time * 1000
    : dataset.latestTimestamp;
  const ageMs = Math.max(0, nowMs - Math.max(dataset.latestTimestamp, lastCandleMs));
  let freshness: FreshnessStatus = 'LIVE';
  if (ageMs > 180_000 && ageMs <= 4 * 24 * 3600 * 1000) {
    freshness = 'DELAYED';
  } else if (ageMs > 4 * 24 * 3600 * 1000) {
    freshness = 'UNAVAILABLE';
  }
  return freshness === dataset.freshness ? dataset : { ...dataset, freshness };
}

function getStaleFallbackDataset(timeframe: Timeframe, maxFallbackAgeMs: number): CandleDataset | null {
  const cached = rawYahooCache.get(timeframe);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > maxFallbackAgeMs) return null;
  const refreshed = refreshDatasetFreshness(cached.data);
  return refreshed.freshness !== 'UNAVAILABLE' ? refreshed : null;
}

async function fetchYahooChartJson(
  interval: string,
  range: string
): Promise<{
  chart?: {
    error?: { description?: string } | null;
    result?: Array<{
      meta?: {
        symbol?: string;
        regularMarketTime?: number;
        dataGranularity?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
  };
}> {
  let lastError: Error | null = null;
  const startHost = yahooHostIdx % YAHOO_CHART_HOSTS.length;

  for (let attempt = 0; attempt < YAHOO_CHART_HOSTS.length; attempt++) {
    const host = YAHOO_CHART_HOSTS[(startHost + attempt) % YAHOO_CHART_HOSTS.length];
    const url = `${host}/v8/finance/chart/GC=F?interval=${interval}&range=${range}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9_000);

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            attempt === 0
              ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
              : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 429) {
        const retryAfterRaw = Number(res.headers.get('retry-after'));
        const retryMs =
          Number.isFinite(retryAfterRaw) && retryAfterRaw > 0
            ? Math.min(300_000, Math.max(60_000, retryAfterRaw * 1000))
            : YAHOO_RATE_LIMIT_DEFAULT_MS;
        lastError = new Error('Market data API returned HTTP 429');
        yahooHostIdx = (startHost + attempt + 1) % YAHOO_CHART_HOSTS.length;
        // Brief pause before failing over to alternate Yahoo host
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 350));
          continue;
        }
        yahooRateLimitedUntilMs = Date.now() + retryMs;
        break;
      }

      if (!res.ok) {
        lastError = new Error(`Market data API returned HTTP ${res.status}`);
        if (res.status >= 500 && attempt === 0) {
          yahooHostIdx = (startHost + attempt + 1) % YAHOO_CHART_HOSTS.length;
          continue;
        }
        break;
      }

      yahooHostIdx = (startHost + attempt) % YAHOO_CHART_HOSTS.length;
      return (await res.json()) as {
        chart?: {
          error?: { description?: string } | null;
          result?: Array<{
            meta?: {
              symbol?: string;
              regularMarketTime?: number;
              dataGranularity?: string;
            };
            timestamp?: number[];
            indicators?: {
              quote?: Array<{
                open?: Array<number | null>;
                high?: Array<number | null>;
                low?: Array<number | null>;
                close?: Array<number | null>;
                volume?: Array<number | null>;
              }>;
            };
          }>;
        };
      };
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err : new Error('Market data fetch failed');
      yahooHostIdx = (startHost + attempt + 1) % YAHOO_CHART_HOSTS.length;
    }
  }

  throw lastError ?? new Error('Market data fetch failed');
}

async function fetchYahooCandlesBase(timeframe: Timeframe): Promise<CandleDataset> {
  await ensureYahooCacheLoaded();

  const cfg = YAHOO_TIMEFRAME_MAP[timeframe];
  if (!cfg) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }

  const now = Date.now();
  const cached = rawYahooCache.get(timeframe);
  const crossesCandleBoundary =
    (timeframe === '1m' || timeframe === '5m') &&
    cached != null &&
    Math.floor(cached.fetchedAt / (cfg.seconds * 1000)) < Math.floor(now / (cfg.seconds * 1000)) &&
    now % (cfg.seconds * 1000) >= 2_500 &&
    now - cached.fetchedAt >= 8_000;
  if (cached && !crossesCandleBoundary && now - cached.fetchedAt < cfg.cacheTtlMs) {
    return refreshDatasetFreshness(cached.data, now);
  }

  const maxStaleFallbackMs = Math.max(4 * 60 * 60_000, cfg.seconds * 1000 * 12);
  if (now < yahooRateLimitedUntilMs) {
    const staleDuringCooldown = getStaleFallbackDataset(timeframe, maxStaleFallbackMs);
    if (staleDuringCooldown) {
      return staleDuringCooldown;
    }
    const spotDuringCooldown = await getPureSpotCandles(timeframe);
    if (spotDuringCooldown && spotDuringCooldown.candles.length >= 30) {
      return spotDuringCooldown;
    }
    throw new Error('Market data API returned HTTP 429 (cooldown active)');
  }

  const inFlight = inFlightYahooPromises.get(timeframe);
  if (inFlight) {
    return inFlight;
  }

  const task = (async (): Promise<CandleDataset> => {
    try {
      const json = await fetchYahooChartJson(cfg.interval, cfg.range);

    if (json?.chart?.error) {
      throw new Error(json.chart.error.description || 'Upstream chart error');
    }

    const result = json?.chart?.result?.[0];
    const timestamps = result?.timestamp;
    const quote = result?.indicators?.quote?.[0];

    if (!result || !timestamps || !quote || timestamps.length === 0) {
      throw new Error(`No historical candle data available for ${timeframe}`);
    }

    const isIntraday = cfg.seconds < 86_400;
    const byTime = new Map<number, Candle>();
    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i];
      const o = quote.open?.[i];
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      const c = quote.close?.[i];
      const v = quote.volume?.[i];

      if (
        typeof t === 'number' &&
        typeof o === 'number' &&
        typeof h === 'number' &&
        typeof l === 'number' &&
        typeof c === 'number' &&
        Number.isFinite(o) &&
        Number.isFinite(h) &&
        Number.isFinite(l) &&
        Number.isFinite(c) &&
        o > 0 &&
        h > 0 &&
        l > 0 &&
        c > 0
      ) {
        // Bucket-align intraday timestamps so Yahoo's unaligned regularMarketTime snapshot merges cleanly
        const bucketTime = isIntraday ? Math.floor(t / cfg.seconds) * cfg.seconds : t;
        const vol = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
        const existing = byTime.get(bucketTime);
        if (existing) {
          existing.high = Number(Math.max(existing.high, h).toFixed(2));
          existing.low = Number(Math.min(existing.low, l).toFixed(2));
          existing.close = Number(c.toFixed(2));
          existing.volume += vol;
        } else {
          byTime.set(bucketTime, {
            time: bucketTime,
            open: Number(o.toFixed(2)),
            high: Number(h.toFixed(2)),
            low: Number(l.toFixed(2)),
            close: Number(c.toFixed(2)),
            volume: vol,
          });
        }
      }
    }

    const rawCandles = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    // Drop Yahoo Finance's partial trailing regularMarketTime 0-volume snapshot bar
    // so closed-bar volume/body indicators aren't corrupted by a 0-volume snapshot stub.
    if (isIntraday && rawCandles.length > 35) {
      const tailLast = rawCandles[rawCandles.length - 1];
      const prevThreeHaveVol = rawCandles.slice(-4, -1).every((c) => c.volume > 0);
      if (tailLast.volume === 0 && prevThreeHaveVol) {
        rawCandles.pop();
      }
    }
    if (rawCandles.length < 30) {
      throw new Error(`Insufficient valid candles (${rawCandles.length}) for ${timeframe}`);
    }

    await ensureSpotStoreLoaded();
    const spot1m = Array.from(liveSpot1mCandles.values()).sort((a, b) => a.time - b.time);
    const liveSpotMid =
      quoteCache.current &&
      quoteCache.current.data.freshness === 'LIVE' &&
      quoteCache.current.data.mid > 0
        ? quoteCache.current.data.mid
        : undefined;
    const externalAnchors = Array.from(detectedRolloverAnchors.entries()).map(
      ([timeSec, shiftUsd]) => ({ timeSec, shiftUsd })
    );
    const stitched = stitchFuturesContractRollovers(rawCandles, timeframe, {
      externalAnchors,
      spot1mCandles: spot1m,
      liveSpotQuoteMid: liveSpotMid,
    });
    if (timeframe === '1m') {
      for (const r of stitched.rollovers) {
        detectedRolloverAnchors.set(r.timeSec, r.shiftUsd);
      }
    }
    const candles = stitched.candles;

    const regularMarketTimeMs = (result.meta?.regularMarketTime ?? candles[candles.length - 1].time) * 1000;
    const lastCandleMs = candles[candles.length - 1].time * 1000;
    const latestTimestamp = Math.max(regularMarketTimeMs, lastCandleMs);
    const feedAgeMs = Math.max(0, Date.now() - regularMarketTimeMs);

    let freshness: FreshnessStatus = 'LIVE';
    if (feedAgeMs > 180_000 && feedAgeMs <= 4 * 24 * 3600 * 1000) {
      freshness = 'DELAYED';
    } else if (feedAgeMs > 4 * 24 * 3600 * 1000) {
      freshness = 'UNAVAILABLE';
    }

    const nonZeroCount = candles.filter((c) => c.volume > 0).length;
    const nonZeroVolumeRatio = candles.length > 0 ? nonZeroCount / candles.length : 0;
    const hasExchangeVolume = nonZeroVolumeRatio >= 0.4;

    const volumeNote = hasExchangeVolume
      ? nonZeroVolumeRatio < 1
        ? `COMEX GC=F exchange volume (${Math.round(nonZeroVolumeRatio * 100)}% bars populated; zero-volume bars use range proxy only when labeled)`
        : 'COMEX GC=F exchange volume verified across all bars'
      : 'Centralized exchange volume unavailable for this timeframe; tick/range activity proxy labeled explicitly';

    const dataset: CandleDataset = {
      symbol: 'XAU/USD (COMEX GC=F Candles)',
      candleSource: 'Yahoo Finance COMEX Gold (GC=F)',
      timeframe,
      candles,
      latestTimestamp,
      freshness,
      hasExchangeVolume,
      nonZeroVolumeRatio,
      volumeNote,
    };

      rawYahooCache.set(timeframe, { data: dataset, fetchedAt: Date.now() });
      schedulePersistYahooCache();
      return dataset;
    } catch (err) {
      const fallback = getStaleFallbackDataset(timeframe, maxStaleFallbackMs);
      if (fallback) {
        return fallback;
      }
      const spotFallback = await getPureSpotCandles(timeframe);
      if (spotFallback && spotFallback.candles.length >= 30) {
        return spotFallback;
      }
      throw err;
    } finally {
      inFlightYahooPromises.delete(timeframe);
    }
  })();

  inFlightYahooPromises.set(timeframe, task);
  return task;
}

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': YAHOO_TIMEFRAME_MAP['1m'].seconds,
  '5m': YAHOO_TIMEFRAME_MAP['5m'].seconds,
  '15m': YAHOO_TIMEFRAME_MAP['15m'].seconds,
  '30m': YAHOO_TIMEFRAME_MAP['30m'].seconds,
  '1H': YAHOO_TIMEFRAME_MAP['1H'].seconds,
  '4H': YAHOO_TIMEFRAME_MAP['4H'].seconds,
  '1D': YAHOO_TIMEFRAME_MAP['1D'].seconds,
  '1W': YAHOO_TIMEFRAME_MAP['1W'].seconds,
};

/**
 * Pure COMEX Gold Futures (GC=F) historical dataset with zero mixing from Spot feeds.
 */
export async function fetchPureFuturesCandles(timeframe: Timeframe): Promise<CandleDataset> {
  await ensureSpotStoreLoaded();
  touchLiveSpotCollector();
  const base = await fetchYahooCandlesBase(timeframe);
  const cfg = YAHOO_TIMEFRAME_MAP[timeframe];
  if (cfg && cfg.seconds < 86_400 && base.candleSource.includes('GC=F') && base.candles.length > 30) {
    // COMEX GC=F is exchange-delayed; a trailing bar whose closing timestamp exceeds
    // the feed's regularMarketTime (+5s tolerance) is still forming and carries partial
    // stub volume/OHLC (e.g., 2 min into a 5m bar). Keep only fully closed exchange bars.
    const feedCutoffSec = Math.floor(base.latestTimestamp / 1000) + 5;
    const closedOnly = base.candles.filter((c) => c.time + cfg.seconds <= feedCutoffSec);
    if (closedOnly.length >= 30 && closedOnly.length < base.candles.length) {
      return {
        ...base,
        candles: closedOnly,
      };
    }
  }
  return base;
}

/**
 * Fetches real-time Spot XAU/USD OHLC + broker tick volume from TradingView's public OANDA:XAUUSD stream.
 * Used cleanly whenever COMEX GC=F futures candles are halted/stale (e.g. US holidays) while Global Spot FX is live.
 */
export async function fetchTradingViewSpotCandles(
  timeframe: Timeframe,
  barCount = 250
): Promise<CandleDataset | null> {
  const cfg = YAHOO_TIMEFRAME_MAP[timeframe];
  const tvInterval = TRADINGVIEW_TIMEFRAME_MAP[timeframe];
  if (!cfg || !tvInterval) return null;

  const now = Date.now();
  const cached = tvSpotCache.get(timeframe);
  const crossesCandleBoundary =
    (timeframe === '1m' || timeframe === '5m') &&
    cached != null &&
    Math.floor(cached.fetchedAt / (cfg.seconds * 1000)) < Math.floor(now / (cfg.seconds * 1000)) &&
    now % (cfg.seconds * 1000) >= 2_500 &&
    now - cached.fetchedAt >= 8_000;

  if (cached && !crossesCandleBoundary && now - cached.fetchedAt < cfg.cacheTtlMs) {
    return refreshDatasetFreshness(cached.data, now);
  }

  if (now < tvCooldownUntilMs) {
    if (cached && now - cached.fetchedAt <= 15 * 60_000) {
      return refreshDatasetFreshness(cached.data, now);
    }
    return null;
  }

  const inFlight = inFlightTvPromises.get(timeframe);
  if (inFlight) {
    return inFlight;
  }

  const task = (async (): Promise<CandleDataset | null> => {
    try {
      const rawBars = await new Promise<Array<[number, number, number, number, number, number?]>>(
        (resolve, reject) => {
          const NodeWebSocket = WebSocket as unknown as {
            new (url: string, options?: { headers?: Record<string, string> }): WebSocket;
          };
          const ws = new NodeWebSocket(TRADINGVIEW_WS_URL, {
            headers: {
              Origin: 'https://www.tradingview.com',
            },
          });
          const sessionId = `cs_${Math.random().toString(36).slice(2, 10)}`;
          const collected: Array<[number, number, number, number, number, number?]> = [];
          let settled = false;

          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            try {
              ws.close();
            } catch {
              // Ignore socket close error
            }
            if (err) reject(err);
            else resolve(collected);
          };

          const timeout = setTimeout(() => {
            finish(new Error(`TradingView Spot WS timeout (${timeframe})`));
          }, 6_000);

          const sendPacket = (method: string, params: unknown[]) => {
            const payload = JSON.stringify({ m: method, p: params });
            ws.send(`~m~${payload.length}~m~${payload}`);
          };

          ws.onopen = () => {
            try {
              sendPacket('set_auth_token', ['unauthorized_user_token']);
              sendPacket('chart_create_session', [sessionId, '']);
              sendPacket('resolve_symbol', [
                sessionId,
                'sds_sym_1',
                '={"symbol":"OANDA:XAUUSD","adjustment":"splits"}',
              ]);
              sendPacket('create_series', [
                sessionId,
                'sds_1',
                's1',
                'sds_sym_1',
                tvInterval,
                barCount,
              ]);
            } catch (err) {
              finish(err instanceof Error ? err : new Error('TradingView WS send failed'));
            }
          };

          ws.onmessage = (event) => {
            const raw = String(event.data);
            let idx = 0;
            while (idx < raw.length) {
              if (!raw.startsWith('~m~', idx)) break;
              const nextMarker = raw.indexOf('~m~', idx + 3);
              if (nextMarker === -1) break;
              const len = Number(raw.slice(idx + 3, nextMarker));
              if (!Number.isFinite(len) || len <= 0) break;
              const bodyStart = nextMarker + 3;
              const body = raw.slice(bodyStart, bodyStart + len);
              idx = bodyStart + len;

              if (body.startsWith('~h~')) {
                try {
                  ws.send(`~m~${body.length}~m~${body}`);
                } catch {
                  // Ignore heartbeat send failure
                }
                continue;
              }

              try {
                const pkt = JSON.parse(body) as {
                  m?: string;
                  p?: [
                    string,
                    { sds_1?: { s?: Array<{ v?: [number, number, number, number, number, number?] }> } },
                  ];
                };
                if (pkt.m === 'timescale_update') {
                  const series = pkt.p?.[1]?.sds_1?.s;
                  if (Array.isArray(series)) {
                    for (const item of series) {
                      if (Array.isArray(item?.v) && item.v.length >= 5) {
                        collected.push(item.v);
                      }
                    }
                  }
                } else if (pkt.m === 'series_error' || pkt.m === 'symbol_error') {
                  finish(new Error(`TradingView WS ${pkt.m} for ${timeframe}`));
                  return;
                } else if (pkt.m === 'series_completed') {
                  finish();
                  return;
                }
              } catch {
                // Ignore non-JSON control packets
              }
            }
          };

          ws.onerror = () => {
            finish(new Error(`TradingView WS error (${timeframe})`));
          };

          ws.onclose = () => {
            if (!settled) {
              if (collected.length >= 30) finish();
              else finish(new Error(`TradingView WS closed prematurely (${timeframe})`));
            }
          };
        }
      );

      const isIntraday = cfg.seconds < 86_400;
      const byTime = new Map<number, Candle>();
      for (const bar of rawBars) {
        const [t, o, h, l, c, v] = bar;
        const bucketTime = isIntraday ? Math.floor(t / cfg.seconds) * cfg.seconds : Math.floor(t);
        const vol = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
        const candidate: Candle = {
          time: bucketTime,
          open: roundPrice2(o),
          high: roundPrice2(h),
          low: roundPrice2(l),
          close: roundPrice2(c),
          volume: vol,
        };
        if (isValidCandleRecord(candidate)) {
          byTime.set(bucketTime, candidate);
        }
      }

      const candles = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
      if (candles.length < 30) {
        return null;
      }

      const lastCandleMs = candles[candles.length - 1].time * 1000;
      const quoteTs = quoteCache.current?.data.freshness === 'LIVE' ? quoteCache.current.data.timestamp : 0;
      const latestTimestamp = Math.max(lastCandleMs, quoteTs);
      const ageMs = Math.max(0, Date.now() - latestTimestamp);
      let freshness: FreshnessStatus = 'LIVE';
      if (ageMs > Math.max(180_000, cfg.seconds * 1000 * 2) && ageMs <= 4 * 24 * 3600 * 1000) {
        freshness = 'DELAYED';
      } else if (ageMs > 4 * 24 * 3600 * 1000) {
        freshness = 'UNAVAILABLE';
      }

      const nonZeroCount = candles.filter((c) => c.volume > 0).length;
      const nonZeroVolumeRatio = candles.length > 0 ? nonZeroCount / candles.length : 0;
      const hasExchangeVolume = nonZeroVolumeRatio >= 0.4;

      const dataset: CandleDataset = {
        symbol: 'XAU/USD (Live Spot)',
        candleSource: 'OANDA:XAUUSD Spot OHLC Stream',
        timeframe,
        candles,
        latestTimestamp,
        freshness,
        hasExchangeVolume,
        nonZeroVolumeRatio,
        volumeNote: hasExchangeVolume
          ? 'Real-time OANDA XAU/USD Spot OHLC with broker tick volume'
          : 'Real-time OANDA XAU/USD Spot OHLC; range activity proxy used where tick volume is zero',
      };

      if (freshness !== 'UNAVAILABLE') {
        tvSpotCache.set(timeframe, { data: dataset, fetchedAt: Date.now() });
      }
      return dataset;
    } catch {
      tvCooldownUntilMs = Date.now() + TV_ERROR_COOLDOWN_MS;
      if (cached && Date.now() - cached.fetchedAt <= 15 * 60_000) {
        return refreshDatasetFreshness(cached.data);
      }
      return null;
    } finally {
      inFlightTvPromises.delete(timeframe);
    }
  })();

  inFlightTvPromises.set(timeframe, task);
  return task;
}

/**
 * Pure Swissquote Spot XAU/USD candles aggregated solely from recorded real-time Spot BBO ticks.
 * Never fabricates missing intervals or mixes COMEX futures candles.
 */
export async function getPureSpotCandles(timeframe: Timeframe): Promise<CandleDataset | null> {
  await ensureSpotStoreLoaded();
  if (liveSpot1mCandles.size === 0) return null;

  const tfSeconds = TIMEFRAME_SECONDS[timeframe];
  const aggregated = new Map<number, Candle>();
  const sorted1m = Array.from(liveSpot1mCandles.values()).sort((a, b) => a.time - b.time);

  for (const bar1m of sorted1m) {
    const bucket = Math.floor(bar1m.time / tfSeconds) * tfSeconds;
    const existing = aggregated.get(bucket);
    if (existing) {
      existing.high = Number(Math.max(existing.high, bar1m.high).toFixed(2));
      existing.low = Number(Math.min(existing.low, bar1m.low).toFixed(2));
      existing.close = bar1m.close;
    } else {
      aggregated.set(bucket, {
        time: bucket,
        open: bar1m.open,
        high: bar1m.high,
        low: bar1m.low,
        close: bar1m.close,
        volume: 0,
      });
    }
  }

  const candles = Array.from(aggregated.values()).sort((a, b) => a.time - b.time);
  if (candles.length === 0) return null;

  const latestTs = candles[candles.length - 1].time * 1000;
  const quoteFresh = quoteCache.current?.data.freshness;
  const freshness: FreshnessStatus =
    quoteFresh === 'LIVE' && Date.now() - latestTs <= Math.max(120_000, tfSeconds * 1000 * 2)
      ? 'LIVE'
      : 'DELAYED';

  return {
    symbol: 'XAU/USD (Live Spot)',
    candleSource: 'Swissquote Spot XAU/USD BBO Stream',
    timeframe,
    candles,
    latestTimestamp: quoteCache.current?.data.timestamp ?? latestTs,
    freshness,
    hasExchangeVolume: false,
    nonZeroVolumeRatio: 0,
    volumeNote: 'Real-time Spot XAU/USD OHLC; tick activity proxy used where exchange volume is unavailable',
  };
}

export async function getRecordedSpot1mCandlesSince(sinceUnixSec: number): Promise<Candle[]> {
  await ensureSpotStoreLoaded();
  return Array.from(liveSpot1mCandles.values())
    .filter((c) => c.time >= sinceUnixSec)
    .sort((a, b) => a.time - b.time);
}

export interface CandleIntegrityCheck {
  valid: boolean;
  ohlcErrors: string[];
  gapWarnings: string[];
  staleReason: string | null;
}

export function validateCandleSeriesIntegrity(
  candles: Candle[],
  timeframe: Timeframe,
  nowSec = Math.floor(Date.now() / 1000),
  maxDelaySec = Math.max(1_800, TIMEFRAME_SECONDS[timeframe] * 3)
): CandleIntegrityCheck {
  const ohlcErrors: string[] = [];
  const gapWarnings: string[] = [];
  const tfSec = TIMEFRAME_SECONDS[timeframe];

  if (!Array.isArray(candles) || candles.length === 0) {
    return {
      valid: false,
      ohlcErrors: [`${timeframe}: Empty candle dataset`],
      gapWarnings,
      staleReason: `${timeframe}: No candles available`,
    };
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (
      !Number.isFinite(c.time) ||
      c.time <= 0 ||
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close) ||
      c.open <= 0 ||
      c.high <= 0 ||
      c.low <= 0 ||
      c.close <= 0
    ) {
      ohlcErrors.push(`${timeframe}: Invalid numeric OHLC/timestamp at bar index ${i}`);
      break;
    }
    if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.high < c.low) {
      ohlcErrors.push(`${timeframe}: Corrupted OHLC range at timestamp ${c.time}`);
      break;
    }
    if (i > 0 && c.time <= candles[i - 1].time) {
      ohlcErrors.push(`${timeframe}: Non-ascending timestamps (${candles[i - 1].time} -> ${c.time})`);
      break;
    }
  }

  // Check missing bar gaps across the most recent 24 bars (allowing normal ~1h COMEX maintenance or weekend)
  const tail = candles.slice(-24);
  let largeGapCount = 0;
  for (let i = 1; i < tail.length; i++) {
    const dt = tail[i].time - tail[i - 1].time;
    const prevUtcHour = new Date(tail[i - 1].time * 1000).getUTCHours();
    const isWeekendBreak = dt >= 30 * 3_600;
    const isDailyComexMaintenance = dt <= 5_400 && (prevUtcHour === 21 || prevUtcHour === 22);
    // Flag intra-session gaps larger than 4 intervals (including multi-hour Spot gaps while excluding maintenance/weekend)
    if (dt > tfSec * 4 && !isWeekendBreak && !isDailyComexMaintenance) {
      largeGapCount++;
    }
  }
  if (largeGapCount >= 3) {
    gapWarnings.push(`${timeframe}: Detected ${largeGapCount} missing-candle interval gaps in recent session`);
  }

  const lastBarTime = candles[candles.length - 1].time;
  const ageSec = nowSec - lastBarTime;
  const staleReason =
    ageSec > maxDelaySec
      ? `${timeframe}: Latest bar is ${Math.round(ageSec / 60)}m old (exceeds ${Math.round(maxDelaySec / 60)}m threshold)`
      : null;

  return {
    valid: ohlcErrors.length === 0 && staleReason === null,
    ohlcErrors,
    gapWarnings,
    staleReason,
  };
}

export async function fetchCandles(timeframe: Timeframe): Promise<CandleDataset> {
  await ensureSpotStoreLoaded();
  touchLiveSpotCollector();

  const cfg = YAHOO_TIMEFRAME_MAP[timeframe];
  if (!cfg) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }

  const [yahooOrSpot, liveQuote] = await Promise.all([
    fetchYahooCandlesBase(timeframe).catch(async (err) => {
      const tvFallback = await fetchTradingViewSpotCandles(timeframe).catch(() => null);
      if (tvFallback) return tvFallback;
      const spotFallback = await getPureSpotCandles(timeframe);
      if (spotFallback && spotFallback.candles.length >= 20) {
        return spotFallback;
      }
      throw err;
    }),
    fetchLiveXauUsdQuote(),
  ]);

  let baseDataset = yahooOrSpot;
  const isIntraday = cfg.seconds < 86_400;
  const lastBaseBarTime = baseDataset.candles[baseDataset.candles.length - 1]?.time ?? 0;
  const liveQuoteSec = Math.floor(liveQuote.timestamp / 1000);
  if (
    isIntraday &&
    baseDataset.candleSource.includes('GC=F') &&
    liveQuote.freshness === 'LIVE' &&
    liveQuoteSec - lastBaseBarTime > Math.max(2_400, cfg.seconds * 3)
  ) {
    const tvSpot = await fetchTradingViewSpotCandles(timeframe).catch(() => null);
    const tvLastTime = tvSpot?.candles[tvSpot.candles.length - 1]?.time ?? 0;
    if (tvSpot && tvLastTime > lastBaseBarTime) {
      baseDataset = tvSpot;
    }
  }

  const tfSeconds = cfg.seconds;
  const mergedByTime = new Map<number, Candle>();
  const spotSorted1m =
    liveSpot1mCandles.size > 0
      ? Array.from(liveSpot1mCandles.values()).sort((a, b) => a.time - b.time)
      : [];

  // Translate COMEX GC=F candles onto Spot XAU/USD scale before merging live Spot bars
  // so futures-vs-spot carry ($20-$35) never renders as a cliff jump at the chart's right edge.
  let chartBasisOffset = 0;
  if (baseDataset.candleSource.includes('GC=F') && baseDataset.candles.length > 0) {
    if (spotSorted1m.length > 0) {
      for (let i = baseDataset.candles.length - 1; i >= Math.max(0, baseDataset.candles.length - 12); i--) {
        const bBar = baseDataset.candles[i];
        const targetTime = bBar.time + tfSeconds - 60;
        let bestSpot: Candle | null = null;
        let bestDiff = Math.max(300, tfSeconds);
        for (let s = spotSorted1m.length - 1; s >= 0; s--) {
          const sBar = spotSorted1m[s];
          const diff = Math.abs(sBar.time - targetTime);
          if (diff <= bestDiff) {
            bestDiff = diff;
            bestSpot = sBar;
          }
          if (sBar.time < targetTime - bestDiff) break;
        }
        if (bestSpot) {
          chartBasisOffset = bBar.close - bestSpot.close;
          break;
        }
      }
    }
    if (chartBasisOffset === 0 && liveQuote.freshness === 'LIVE' && liveQuote.mid > 0) {
      chartBasisOffset = baseDataset.candles[baseDataset.candles.length - 1].close - liveQuote.mid;
    }
  }

  for (const c of baseDataset.candles) {
    mergedByTime.set(c.time, {
      ...c,
      open: roundPrice2(c.open - chartBasisOffset),
      high: roundPrice2(c.high - chartBasisOffset),
      low: roundPrice2(c.low - chartBasisOffset),
      close: roundPrice2(c.close - chartBasisOffset),
    });
  }
  const lastBaseTime = baseDataset.candles[baseDataset.candles.length - 1]?.time ?? 0;
  let mergedLiveSpot = false;

  // Aggregate real recorded live Swissquote Spot 1m bars into the requested timeframe for live chart continuity
  if (spotSorted1m.length > 0) {
    const aggregatedSpot = new Map<number, Candle>();

    for (const bar1m of spotSorted1m) {
      const bucket = Math.floor(bar1m.time / tfSeconds) * tfSeconds;
      const existing = aggregatedSpot.get(bucket);
      if (existing) {
        existing.high = Math.max(existing.high, bar1m.high);
        existing.low = Math.min(existing.low, bar1m.low);
        existing.close = bar1m.close;
      } else {
        aggregatedSpot.set(bucket, {
          time: bucket,
          open: bar1m.open,
          high: bar1m.high,
          low: bar1m.low,
          close: bar1m.close,
          volume: 0,
        });
      }
    }

    for (const spotBar of aggregatedSpot.values()) {
      const existingAtBucket = mergedByTime.get(spotBar.time);
      if (existingAtBucket) {
        if (spotBar.time >= lastBaseTime) {
          existingAtBucket.high = Math.max(existingAtBucket.high, spotBar.high);
          existingAtBucket.low = Math.min(existingAtBucket.low, spotBar.low);
          existingAtBucket.close = spotBar.close;
          mergedLiveSpot = true;
        }
      } else if (
        spotBar.time >= lastBaseTime &&
        spotBar.time - lastBaseTime < tfSeconds &&
        mergedByTime.has(lastBaseTime)
      ) {
        const activeBase = mergedByTime.get(lastBaseTime)!;
        activeBase.high = Math.max(activeBase.high, spotBar.high);
        activeBase.low = Math.min(activeBase.low, spotBar.low);
        activeBase.close = spotBar.close;
        mergedLiveSpot = true;
      } else if (spotBar.time > lastBaseTime) {
        mergedByTime.set(spotBar.time, { ...spotBar });
        mergedLiveSpot = true;
      }
    }
  }

  const candles = Array.from(mergedByTime.values()).sort((a, b) => a.time - b.time);

  // Reflect latest live Swissquote tick on the active forming bar on the chart
  if (liveQuote.freshness === 'LIVE' && liveQuote.mid > 0 && candles.length > 0) {
    const quoteSec = Math.floor(liveQuote.timestamp / 1000);
    const liveMid = Number(liveQuote.mid.toFixed(2));
    const currentLast = candles[candles.length - 1];

    if (quoteSec >= currentLast.time && quoteSec - currentLast.time < tfSeconds) {
      currentLast.high = Math.max(currentLast.high, liveMid);
      currentLast.low = Math.min(currentLast.low, liveMid);
      currentLast.close = liveMid;
      mergedLiveSpot = true;
    } else if (quoteSec - currentLast.time >= tfSeconds) {
      const bucket = Math.floor(quoteSec / tfSeconds) * tfSeconds;
      const safeTime = bucket > currentLast.time ? bucket : currentLast.time + tfSeconds;
      candles.push({
        time: safeTime,
        open: liveMid,
        high: liveMid,
        low: liveMid,
        close: liveMid,
        volume: 0,
      });
      mergedLiveSpot = true;
    }
  }

  const latestCandleMs = candles.length > 0 ? candles[candles.length - 1].time * 1000 : Date.now();
  const latestTimestamp = Math.max(
    baseDataset.latestTimestamp,
    latestCandleMs,
    liveQuote.freshness === 'LIVE' ? liveQuote.timestamp : 0
  );

  const freshness: FreshnessStatus =
    mergedLiveSpot && liveQuote.freshness === 'LIVE' ? 'LIVE' : baseDataset.freshness;

  return {
    ...baseDataset,
    candles,
    latestTimestamp,
    freshness,
    candleSource: mergedLiveSpot
      ? baseDataset.candleSource.includes('GC=F')
        ? 'Yahoo Finance GC=F (Spot-Aligned) + Live Swissquote Spot XAU/USD'
        : `${baseDataset.candleSource} + Live Swissquote Spot XAU/USD`
      : baseDataset.candleSource,
  };
}

export function __resetMarketDataCachesForTest(): void {
  if (!IS_TEST_ENV) return;
  rawYahooCache.clear();
  inFlightYahooPromises.clear();
  tvSpotCache.clear();
  inFlightTvPromises.clear();
  detectedRolloverAnchors.clear();
  liveSpot1mCandles.clear();
  quoteCache.current = null;
  prevCloseCache.current = null;
  yahooRateLimitedUntilMs = 0;
  tvCooldownUntilMs = 0;
  yahooHostIdx = 0;
}

