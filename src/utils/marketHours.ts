import type { FreshnessStatus } from '../types/market.ts';

/**
 * Global spot Gold (XAU/USD) and COMEX Gold Futures (GC=F) weekend closure:
 * Friday 22:05 UTC through Sunday 23:00 UTC.
 */
export function isGoldMarketWeekendClosed(nowMs = Date.now()): boolean {
  const d = new Date(nowMs);
  const day = d.getUTCDay(); // 0 = Sun, 5 = Fri, 6 = Sat
  const minsUtc = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (day === 6) return true;
  if (day === 0 && minsUtc < 23 * 60) return true;
  if (day === 5 && minsUtc >= 22 * 60 + 5) return true;
  return false;
}

/**
 * Determines whether a non-LIVE market status reflects a closed market
 * (weekend closure, daily rollover break, or market holiday halt) rather than a brief feed delay.
 */
export function isMarketClosedStatus(
  freshness: FreshnessStatus | string | undefined,
  latestDataTs?: number | null,
  nowMs = Date.now()
): boolean {
  if (freshness === 'LIVE' || freshness === 'UNAVAILABLE') return false;
  if (isGoldMarketWeekendClosed(nowMs)) return true;
  if (freshness === 'DELAYED' && typeof latestDataTs === 'number' && latestDataTs > 0) {
    return nowMs - latestDataTs >= 15 * 60_000;
  }
  return false;
}
