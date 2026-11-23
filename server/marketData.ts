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

const quoteCache: { current: CacheEntry<MarketQuote> | null } = { current: null };
const prevCloseCache: { current: CacheEntry<number> | null } = { current: null };
const rawYahooCache = new Map<Timeframe, CacheEntry<CandleDataset>>();
const inFlightYahooPromises = new Map<Timeframe, Promise<CandleDataset>>();

// Real-time Swissquote Spot 1m bar accumulator persisted across restarts
const liveSpot1mCandles = new Map<number, Candle>();
const MAX_LIVE_SPOT_BARS = 1_440; // Keep last 24 hours of 1m live spot bars

const QUOTE_TTL_MS = 400;
const PREV_CLOSE_TTL_MS = 15 * 60_000;
const COLLECTOR_ACTIVE_MS = 750;
const COLLECTOR_IDLE_MS = 3_000;
const COLLECTOR_IDLE_AFTER_MS = 120_000;
const YAHOO_RATE_LIMIT_DEFAULT_MS = 60_000;

let lastClientActivityAt = Date.now();
let collectorTimer: ReturnType<typeof setTimeout> | null = null;
let collectorInFlight = false;
let inFlightQuotePromise: Promise<MarketQuote> | null = null;
let lastEmittedQuoteKey = '';
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let yahooPersistTimer: ReturnType<typeof setTimeout> | null = null;
let spotStoreLoadPromise: Promise<void> | null = null;
let yahooCacheLoadPromise: Promise<void> | null = null;
let yahooRateLimitedUntilMs = 0;
let yahooHostIdx = 0;
const IS_TEST_ENV = Boolean(
  process.env.NODE_TEST_CONTEXT || process.argv.some((a) => a.includes('--test'))
);

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
          item.time >= cutoff &&
          typeof item.open === 'number' &&
          typeof item.high === 'number' &&
          typeof item.low === 'number' &&
          typeof item.close === 'number' &&
          item.open > 0 &&
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
      const raw = await fs.readFile(YAHOO_CANDLE_CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, CacheEntry<CandleDataset>>;
      if (!parsed || typeof parsed !== 'object') return;
      for (const [tf, entry] of Object.entries(parsed)) {
        if (
          tf in YAHOO_TIMEFRAME_MAP &&
          entry &&
          typeof entry.fetchedAt === 'number' &&
          entry.data &&
          Array.isArray(entry.data.candles) &&
          entry.data.candles.length >= 30 &&
          !rawYahooCache.has(tf as Timeframe)
        ) {
          rawYahooCache.set(tf as Timeframe, entry);
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
      const tmp = `${YAHOO_CANDLE_CACHE_FILE}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
      await fs.rename(tmp, YAHOO_CANDLE_CACHE_FILE);
    } catch {
      // Non-fatal disk cache write error
    }
  }, 5_000);
  yahooPersistTimer.unref?.();
}

function schedulePersistSpotCandles(): void {
  if (IS_TEST_ENV || persistTimer !== null) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await ensureSpotStoreLoaded();
      await fs.mkdir(DATA_DIR, { recursive: true });
      const sorted = Array.from(liveSpot1mCandles.values())
        .sort((a, b) => a.time - b.time)
        .slice(-MAX_LIVE_SPOT_BARS);
      const tmp = `${LIVE_SPOT_1M_FILE}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(sorted), 'utf8');
      await fs.rename(tmp, LIVE_SPOT_1M_FILE);
    } catch {
      // Non-fatal persistence error
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

  // Reuse 1D dataset close if already cached to avoid redundant Yahoo API traffic
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

  try {
    const host = YAHOO_CHART_HOSTS[yahooHostIdx % YAHOO_CHART_HOSTS.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
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
    clearTimeout(timer);
    if (res.status === 429) {
      yahooRateLimitedUntilMs = Date.now() + YAHOO_RATE_LIMIT_DEFAULT_MS;
      yahooHostIdx = (yahooHostIdx + 1) % YAHOO_CHART_HOSTS.length;
      return prevCloseCache.current?.data;
    }
    if (!res.ok) return prevCloseCache.current?.data;
    const yJson = (await res.json()) as {
      chart?: { result?: Array<{ meta?: { chartPreviousClose?: number; previousClose?: number } }> };
    };
    const meta = yJson?.chart?.result?.[0]?.meta;
    const prev = meta?.previousClose ?? meta?.chartPreviousClose;
    if (typeof prev === 'number' && Number.isFinite(prev) && prev > 0) {
      prevCloseCache.current = { data: prev, fetchedAt: now };
      return prev;
    }
  } catch {
    // Ignore optional previous-close enrichment errors
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
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_500);

      const [sqRes, prevClose] = await Promise.all([
        fetch('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD', {
          headers: { 'User-Agent': 'LEADERS-XAUUSD/1.0' },
          signal: controller.signal,
        }),
        fetchPreviousCloseCached(),
      ]);
      clearTimeout(timer);

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
  if (cached && now - cached.fetchedAt < cfg.cacheTtlMs) {
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

    const candles = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    // Drop Yahoo Finance's partial trailing regularMarketTime 0-volume snapshot bar
    // so closed-bar volume/body indicators aren't corrupted by a 0-volume snapshot stub.
    if (isIntraday && candles.length > 35) {
      const tailLast = candles[candles.length - 1];
      const prevThreeHaveVol = candles.slice(-4, -1).every((c) => c.volume > 0);
      if (tailLast.volume === 0 && prevThreeHaveVol) {
        candles.pop();
      }
    }
    if (candles.length < 30) {
      throw new Error(`Insufficient valid candles (${candles.length}) for ${timeframe}`);
    }

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
  return fetchYahooCandlesBase(timeframe);
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
    // Flag intra-session gaps larger than 4 intervals (but < 4 hours which may be weekend/maintenance)
    if (dt > tfSec * 4 && dt < 4 * 3_600) {
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

  const [baseDataset, liveQuote] = await Promise.all([
    fetchYahooCandlesBase(timeframe).catch(async (err) => {
      const spotFallback = await getPureSpotCandles(timeframe);
      if (spotFallback && spotFallback.candles.length >= 20) {
        return spotFallback;
      }
      throw err;
    }),
    fetchLiveXauUsdQuote(),
  ]);

  const tfSeconds = cfg.seconds;
  const mergedByTime = new Map<number, Candle>();
  for (const c of baseDataset.candles) {
    mergedByTime.set(c.time, { ...c });
  }
  const lastBaseTime = baseDataset.candles[baseDataset.candles.length - 1]?.time ?? 0;
  let mergedLiveSpot = false;

  // Aggregate real recorded live Swissquote Spot 1m bars into the requested timeframe for live chart continuity
  if (liveSpot1mCandles.size > 0) {
    const aggregatedSpot = new Map<number, Candle>();
    const sorted1m = Array.from(liveSpot1mCandles.values()).sort((a, b) => a.time - b.time);

    for (const bar1m of sorted1m) {
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
      } else {
        mergedByTime.set(spotBar.time, { ...spotBar });
        mergedLiveSpot = true;
      }
    }
  }

  const candles = Array.from(mergedByTime.values()).sort((a, b) => a.time - b.time);

  // Reflect latest live Swissquote tick on the active forming bar on the chart
  if (liveQuote.freshness === 'LIVE' && liveQuote.mid > 0) {
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

  const latestCandleMs = candles[candles.length - 1].time * 1000;
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
      ? 'Yahoo Finance GC=F + Live Swissquote Spot XAU/USD'
      : baseDataset.candleSource,
  };
}

export function __resetMarketDataCachesForTest(): void {
  if (!IS_TEST_ENV) return;
  rawYahooCache.clear();
  inFlightYahooPromises.clear();
  liveSpot1mCandles.clear();
  quoteCache.current = null;
  prevCloseCache.current = null;
  yahooRateLimitedUntilMs = 0;
  yahooHostIdx = 0;
}

