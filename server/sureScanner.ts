import crypto from 'node:crypto';
import {
  AUTO_PERFECT_TIMEFRAMES,
  createAutoPerfectIndicators,
} from '../src/constants/indicators.ts';
import type {
  MarketQuote,
  SureSignalCheckItem,
  SureSignalEntry,
  SureSignalScanStatus,
  SureSignalStatus,
} from '../src/types/market.ts';
import { fetchStrategyDatasets } from './analyzer.ts';
import {
  fetchLiveXauUsdQuote,
  getRecordedSpot1mCandlesSince,
  subscribeLiveQuotes,
} from './marketData.ts';
import { evaluateCurrentNewsProtection } from './newsCalendar.ts';
import {
  evaluateCandleOutcome,
  evaluateStrictMultiTimeframeStrategy,
  evaluateTickOutcome,
} from './strategyEngine.ts';
import {
  computeSureHistoryStats,
  listSureSignals,
  saveSureSignal,
  updateSureSignal,
} from './sureSignalsStore.ts';
import { sendSureOutcomeWebPush, sendSureSignalWebPush } from './webPushStore.ts';

export const SURE_SCAN_INTERVAL_MS = 60_000;
const POST_TP_COOLDOWN_MS = 5 * 60_000; // Wait 5m after TP hit before re-entering same direction
const POST_SL_SAME_DIR_COOLDOWN_MS = 30 * 60_000; // Wait 30m (6x 5m candles) after SL hit before same-direction re-entry
const POST_SL_ANY_COOLDOWN_MS = 15 * 60_000; // Wait 15m after any SL hit for whipsaw volatility to settle
const CONSECUTIVE_SL_COOLDOWN_MS = 60 * 60_000; // Pause 60m after 2 consecutive SL hits to avoid choppy whipsaw

type SureSignalListener = (event: {
  type: 'sure_signal' | 'sure_status' | 'sure_outcome';
  status: SureSignalScanStatus;
  newSignal?: SureSignalEntry;
  closedSignal?: SureSignalEntry;
}) => void;

const listeners = new Set<SureSignalListener>();
let scannerTimer: NodeJS.Timeout | null = null;
let quoteUnsubscribe: (() => void) | null = null;
let inFlightScan: Promise<SureSignalScanStatus> | null = null;
let outcomeCheckPromise: Promise<boolean> | null = null;
let pendingOutcomeCheck: { price: number; nowMs: number } | null = null;

let latestStatus: SureSignalScanStatus = {
  scanning: false,
  tradeLocked: false,
  lastScannedAt: null,
  nextScanAt: null,
  scanIntervalMs: SURE_SCAN_INTERVAL_MS,
  monitoringMode: 'REALTIME_SPOT_BBO',
  marketState: 'NO_SURE_SIGNAL',
  latestPrice: null,
  latestConfidencePct: 0,
  latestScore: 0,
  latestSetupScore: 0,
  latestAdx: null,
  reason: 'SCANNING FOR HIGH-QUALITY SETUP',
  checks: [],
  activeSignal: null,
  history: [],
  stats: {
    totalSignals: 0,
    tpHits: 0,
    slHits: 0,
    ambiguousOutcomes: 0,
    activeSignals: 0,
    winRatePct: null,
    avgRiskReward: null,
    avgDurationMs: null,
  },
};

export function subscribeSureSignalUpdates(listener: SureSignalListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function broadcast(
  type: 'sure_signal' | 'sure_status' | 'sure_outcome',
  payload?: { newSignal?: SureSignalEntry; closedSignal?: SureSignalEntry }
): void {
  for (const listener of listeners) {
    try {
      listener({
        type,
        status: latestStatus,
        newSignal: payload?.newSignal,
        closedSignal: payload?.closedSignal,
      });
    } catch {
      // Ignore closed client listener errors
    }
  }
}

function findActiveTrade(history: SureSignalEntry[]): SureSignalEntry | null {
  return history.find((item) => item.status === 'ACTIVE') ?? null;
}

function pickSpotlightSignal(history: SureSignalEntry[]): SureSignalEntry | null {
  const active = findActiveTrade(history);
  if (active) return active;
  return history[0] ?? null;
}

function formatOutcomeBanner(status: SureSignalStatus): string {
  if (status === 'TP_HIT') return 'TP HIT';
  if (status === 'SL_HIT') return 'SL HIT';
  if (status === 'AMBIGUOUS') return 'AMBIGUOUS';
  return 'ACTIVE';
}

/**
 * Checks if any missed closed 1m Spot candles occurred while server was offline/restarting
 * and settles the active trade accurately (TP_HIT, SL_HIT, or AMBIGUOUS).
 */
export async function reconcileMissedSpotCandlesForActiveTrade(): Promise<SureSignalEntry | null> {
  const history = await listSureSignals();
  const active = findActiveTrade(history);
  if (!active) return null;

  const startSec = Math.floor(new Date(active.createdAt).getTime() / 1000);
  const candlesSince = await getRecordedSpot1mCandlesSince(startSec);
  if (candlesSince.length === 0) return null;

  const outcome = evaluateCandleOutcome(
    active.direction,
    active.tradeLevels.referencePrice,
    active.tradeLevels.stopLoss,
    active.tradeLevels.takeProfit1,
    candlesSince
  );

  if (!outcome) return null;

  const closedAtMs = Math.max(Date.now(), (outcome.candleTime + 60) * 1000);
  const closedAt = new Date(closedAtMs).toISOString();
  const durationMs = Math.max(0, closedAtMs - new Date(active.createdAt).getTime());

  const updated = await updateSureSignal(active.id, {
    status: outcome.status,
    closedAt,
    closePrice: outcome.closePrice,
    pnlPoints: outcome.pnlPoints,
    durationMs,
    lastCheckedAt: closedAt,
    lastCheckedPrice: outcome.closePrice,
  });

  if (updated) {
    const nextHistory = await listSureSignals();
    latestStatus = {
      ...latestStatus,
      tradeLocked: false,
      marketState: 'NO_SURE_SIGNAL',
      latestPrice: outcome.closePrice,
      reason: `${formatOutcomeBanner(outcome.status)} recorded on recovery for SURE ${
        updated.direction
      } at $${outcome.closePrice.toFixed(2)}.`,
      activeSignal: updated,
      history: nextHistory,
      stats: computeSureHistoryStats(nextHistory),
    };
    broadcast('sure_outcome', { closedSignal: updated });
    void sendSureOutcomeWebPush(updated);
  }

  return updated;
}

async function executeOutcomeCheckAtPrice(
  price: number,
  nowMs: number
): Promise<boolean> {
  if (!Number.isFinite(price) || price <= 0) return false;

  const history = await listSureSignals();
  const active = findActiveTrade(history);
  if (!active) return false;

  const hit = evaluateTickOutcome(
    active.direction,
    active.tradeLevels.referencePrice,
    active.tradeLevels.stopLoss,
    active.tradeLevels.takeProfit1,
    price
  );
  if (!hit) return false;

  const closedAt = new Date(nowMs).toISOString();
  const durationMs = Math.max(0, nowMs - new Date(active.createdAt).getTime());
  const updated = await updateSureSignal(active.id, {
    status: hit.status,
    closedAt,
    closePrice: hit.closePrice,
    pnlPoints: hit.pnlPoints,
    durationMs,
    lastCheckedAt: closedAt,
    lastCheckedPrice: hit.closePrice,
  });

  if (!updated) return false;

  const nextHistory = await listSureSignals();
  const outcomeText = formatOutcomeBanner(hit.status);
  const pnlSign = hit.pnlPoints >= 0 ? '+' : '';

  latestStatus = {
    ...latestStatus,
    scanning: false,
    tradeLocked: false,
    nextScanAt: new Date(nowMs + 3_500).toISOString(),
    marketState: 'NO_SURE_SIGNAL',
    latestPrice: hit.closePrice,
    reason: `${outcomeText} on SURE ${updated.direction} at $${hit.closePrice.toFixed(
      2
    )} (${pnlSign}${hit.pnlPoints.toFixed(2)} pts). Scanner unlocked for next high-quality setup.`,
    activeSignal: updated,
    history: nextHistory,
    stats: computeSureHistoryStats(nextHistory),
  };

  broadcast('sure_outcome', { closedSignal: updated });
  void sendSureOutcomeWebPush(updated);

  setTimeout(() => {
    void runSureSignalScan();
  }, 3_500);

  return true;
}

function consumePendingOutcomeCheck(): { price: number; nowMs: number } | null {
  const next = pendingOutcomeCheck;
  pendingOutcomeCheck = null;
  return next;
}

export async function checkAndCloseActiveSignalAtPrice(
  price: number,
  nowMs = Date.now()
): Promise<boolean> {
  if (!Number.isFinite(price) || price <= 0) return false;
  if (outcomeCheckPromise) {
    pendingOutcomeCheck = { price, nowMs };
    return outcomeCheckPromise;
  }

  outcomeCheckPromise = (async () => {
    let closed = false;
    let currentPrice = price;
    let currentNowMs = nowMs;

    try {
      while (true) {
        pendingOutcomeCheck = null;
        const didClose = await executeOutcomeCheckAtPrice(currentPrice, currentNowMs);
        if (didClose) {
          closed = true;
          break;
        }
        const nextPending = consumePendingOutcomeCheck();
        if (!nextPending) break;
        currentPrice = nextPending.price;
        currentNowMs = nextPending.nowMs;
      }
      return closed;
    } finally {
      outcomeCheckPromise = null;
      pendingOutcomeCheck = null;
    }
  })();

  return outcomeCheckPromise;
}

export async function getSureSignalStatus(): Promise<SureSignalScanStatus> {
  const history = await listSureSignals();
  const active = findActiveTrade(history);
  const spotlight = pickSpotlightSignal(history);
  const quote = await fetchLiveXauUsdQuote().catch(() => null);
  const newsProtection = await evaluateCurrentNewsProtection({ quote }).catch(() => null);

  const isNewsBlocked = newsProtection?.blocked === true;

  latestStatus = {
    ...latestStatus,
    scanning: isNewsBlocked ? false : latestStatus.scanning,
    tradeLocked: Boolean(active),
    marketState: isNewsBlocked
      ? newsProtection?.safeFallbackActive
        ? 'UNAVAILABLE'
        : 'NEWS_PAUSED'
      : active
      ? active.direction === 'BUY'
        ? 'SURE_BUY'
        : 'SURE_SELL'
      : latestStatus.marketState === 'SURE_BUY' ||
        latestStatus.marketState === 'SURE_SELL' ||
        latestStatus.marketState === 'NEWS_PAUSED'
      ? 'NO_SURE_SIGNAL'
      : latestStatus.marketState,
    latestPrice:
      quote && quote.freshness !== 'UNAVAILABLE' && quote.mid > 0
        ? quote.mid
        : latestStatus.latestPrice,
    reason: isNewsBlocked
      ? newsProtection?.safeFallbackActive
        ? `NEWS DATA UNVERIFIED — ${newsProtection.subtext}`
        : `HIGH IMPACT NEWS — TRADING PAUSED. Because High Impact News Coming (${newsProtection?.activeEvent?.title ?? 'USD Red Event'}).`
      : latestStatus.reason,
    history,
    stats: computeSureHistoryStats(history),
    activeSignal: isNewsBlocked ? null : spotlight,
    checks: isNewsBlocked ? [] : latestStatus.checks,
    strategyEvaluation: isNewsBlocked ? undefined : latestStatus.strategyEvaluation,
    newsProtection: newsProtection ?? latestStatus.newsProtection,
  };
  return latestStatus;
}

export async function handleSureSignalDeleted(deletedId: string): Promise<SureSignalScanStatus> {
  const wasActive = latestStatus.activeSignal?.id === deletedId;
  const status = await getSureSignalStatus();
  if (wasActive && !status.tradeLocked) {
    latestStatus = {
      ...latestStatus,
      reason: 'Active SURE trade cleared. SCANNING FOR HIGH-QUALITY SETUP',
    };
    broadcast('sure_status');
    setTimeout(() => {
      void runSureSignalScan();
    }, 500);
  }
  return status;
}

export async function runSureSignalScan(): Promise<SureSignalScanStatus> {
  if (inFlightScan) {
    return inFlightScan;
  }

  inFlightScan = (async () => {
    const indicators = createAutoPerfectIndicators();
    const scanStartedMs = Date.now();
    const nextScanIso = new Date(scanStartedMs + SURE_SCAN_INTERVAL_MS).toISOString();

    try {
      // Step 1: Settle any active trade on missed candles or latest quote before considering any new scan
      await reconcileMissedSpotCandlesForActiveTrade();

      const quote = await fetchLiveXauUsdQuote();
      if (quote.freshness !== 'UNAVAILABLE' && quote.mid > 0) {
        await checkAndCloseActiveSignalAtPrice(quote.mid);
      }

      const preHistory = await listSureSignals();
      const lockedTrade = findActiveTrade(preHistory);
      if (lockedTrade) {
        const lockedNewsProtection = await evaluateCurrentNewsProtection({ quote }).catch(() => null);
        const lockedNewsBlocked = lockedNewsProtection?.blocked === true;
        latestStatus = {
          ...latestStatus,
          scanning: false,
          tradeLocked: true,
          nextScanAt: null,
          monitoringMode: quote.freshness === 'LIVE' ? 'REALTIME_SPOT_BBO' : 'UNAVAILABLE',
          marketState: lockedNewsBlocked
            ? lockedNewsProtection?.safeFallbackActive
              ? 'UNAVAILABLE'
              : 'NEWS_PAUSED'
            : lockedTrade.direction === 'BUY'
            ? 'SURE_BUY'
            : 'SURE_SELL',
          latestPrice:
            quote.freshness !== 'UNAVAILABLE' && quote.mid > 0
              ? quote.mid
              : latestStatus.latestPrice ?? lockedTrade.spotPrice,
          reason: lockedNewsBlocked
            ? `HIGH IMPACT NEWS — TRADING PAUSED. Because High Impact News Coming (${lockedNewsProtection?.activeEvent?.title ?? 'USD High Impact Event'}).`
            : `Monitoring ACTIVE SURE ${lockedTrade.direction} (Entry $${lockedTrade.tradeLevels.referencePrice.toFixed(
                2
              )} · SL $${lockedTrade.tradeLevels.stopLoss.toFixed(
                2
              )} · TP $${lockedTrade.tradeLevels.takeProfit1.toFixed(
                2
              )}). New scan paused until SL or TP hits.`,
          checks: lockedNewsBlocked ? [] : lockedTrade.checks,
          activeSignal: lockedNewsBlocked ? null : lockedTrade,
          history: preHistory,
          stats: computeSureHistoryStats(preHistory),
          newsProtection: lockedNewsProtection ?? latestStatus.newsProtection,
        };
        broadcast('sure_status');
        return latestStatus;
      }

      latestStatus = { ...latestStatus, scanning: true, tradeLocked: false };

      const [datasets, existingHistory] = await Promise.all([
        fetchStrategyDatasets(),
        listSureSignals(),
      ]);

      // Centralized high-impact news protection check before directional SURE evaluation
      const newsProtection = await evaluateCurrentNewsProtection({
        quote,
        candles5m: datasets.tf5m.candles,
        candles1m: datasets.tf1m.candles,
        nowMs: scanStartedMs,
      });

      if (newsProtection.blocked) {
        latestStatus = {
          ...latestStatus,
          scanning: false,
          tradeLocked: false,
          lastScannedAt: new Date(scanStartedMs).toISOString(),
          nextScanAt: nextScanIso,
          scanIntervalMs: SURE_SCAN_INTERVAL_MS,
          monitoringMode:
            quote.freshness === 'LIVE'
              ? 'REALTIME_SPOT_BBO'
              : quote.freshness === 'DELAYED'
              ? 'DELAYED_POLL'
              : 'UNAVAILABLE',
          marketState: newsProtection.safeFallbackActive ? 'UNAVAILABLE' : 'NEWS_PAUSED',
          latestPrice:
            quote.freshness !== 'UNAVAILABLE' && quote.mid > 0
              ? quote.mid
              : latestStatus.latestPrice,
          latestConfidencePct: 0,
          latestScore: 0,
          latestSetupScore: 0,
          latestAdx: null,
          reason: newsProtection.safeFallbackActive
            ? `NEWS DATA UNVERIFIED — ${newsProtection.subtext}`
            : `HIGH IMPACT NEWS — TRADING PAUSED. Because High Impact News Coming (${newsProtection.activeEvent?.title ?? 'USD High Impact Event'}).`,
          checks: [],
          activeSignal: null,
          history: existingHistory,
          stats: computeSureHistoryStats(existingHistory),
          strategyEvaluation: undefined,
          newsProtection,
        };
        broadcast('sure_status');
        return latestStatus;
      }

      const { evaluation, tradeLevels } = evaluateStrictMultiTimeframeStrategy({
        datasets,
        quote,
        indicatorConfigs: indicators,
        mode: 'SURE',
        nowMs: scanStartedMs,
      });

      const checks: SureSignalCheckItem[] = evaluation.mandatoryGates.map((g) => ({
        label: g.label,
        passed: g.passed,
        detail: g.detail,
      }));

      const adxValue = evaluation.trend1H.adxValue;
      const monitoringMode: SureSignalScanStatus['monitoringMode'] = !evaluation.feedIntegrity.valid
        ? 'UNAVAILABLE'
        : quote.freshness === 'LIVE'
        ? 'REALTIME_SPOT_BBO'
        : 'DELAYED_POLL';

      let updatedHistory = existingHistory;
      let emittedNewSignal: SureSignalEntry | undefined;
      let cooldownBlockedReason: string | null = null;
      let spotlight = pickSpotlightSignal(existingHistory);

      if (
        (evaluation.action === 'BUY' || evaluation.action === 'SELL') &&
        tradeLevels &&
        evaluation.totalScore >= 90
      ) {
        const lastClosed = existingHistory.find((h) => h.status !== 'ACTIVE' && h.closedAt != null) ?? null;
        const closedAgeMs =
          lastClosed?.closedAt != null
            ? scanStartedMs - new Date(lastClosed.closedAt).getTime()
            : Number.POSITIVE_INFINITY;
        const recentDecided = existingHistory.filter(
          (h) => h.status === 'TP_HIT' || h.status === 'SL_HIT'
        );
        const twoConsecutiveSl =
          recentDecided.length >= 2 &&
          recentDecided[0].status === 'SL_HIT' &&
          recentDecided[1].status === 'SL_HIT';

        const requiredCooldownMs = twoConsecutiveSl
          ? CONSECUTIVE_SL_COOLDOWN_MS
          : lastClosed?.status === 'SL_HIT'
          ? lastClosed.direction === evaluation.action
            ? POST_SL_SAME_DIR_COOLDOWN_MS
            : POST_SL_ANY_COOLDOWN_MS
          : lastClosed?.direction === evaluation.action
          ? POST_TP_COOLDOWN_MS
          : 0;

        const inPostCloseCooldown = lastClosed != null && closedAgeMs < requiredCooldownMs;

        if (inPostCloseCooldown) {
          const remainMin = Math.max(1, Math.ceil((requiredCooldownMs - closedAgeMs) / 60_000));
          cooldownBlockedReason =
            lastClosed?.status === 'SL_HIT'
              ? `Post-SL Capital Protection Active (${remainMin}m remaining cooldown after prior SL hit before next ${evaluation.action}).`
              : `Post-TP Cooldown Active (${remainMin}m wait before repeating ${evaluation.action}).`;
        } else {
          const newEntry: SureSignalEntry = {
            id: crypto.randomUUID(),
            createdAt: new Date(scanStartedMs).toISOString(),
            direction: evaluation.action,
            spotPrice: tradeLevels.referencePrice,
            confidencePct: evaluation.totalScore,
            combinedScore: Number(((evaluation.totalScore / 100) * (evaluation.action === 'BUY' ? 1 : -1)).toFixed(3)),
            setupScore: evaluation.totalScore,
            scoreCategory: evaluation.scoreCategory,
            adxValue: adxValue ?? 0,
            timeframes: [...AUTO_PERFECT_TIMEFRAMES],
            tradeLevels,
            riskRewardRatio: tradeLevels.rewardRiskRatio1,
            summary: `${evaluation.action} confirmed (${evaluation.totalScore}/100 · ${evaluation.scoreCategory}) across 1H Trend -> 15M BOS/CHoCH -> 5M Sweep/Retest -> 1M Closed Candle.`,
            checks,
            status: 'ACTIVE',
            lastCheckedAt: new Date(scanStartedMs).toISOString(),
            lastCheckedPrice: tradeLevels.referencePrice,
          };

          const saveResult = await saveSureSignal(newEntry);
          if (saveResult.saved) {
            updatedHistory = [saveResult.entry, ...existingHistory].slice(0, 200);
            spotlight = saveResult.entry;
            emittedNewSignal = saveResult.entry;
          } else {
            updatedHistory = await listSureSignals();
            spotlight = pickSpotlightSignal(updatedHistory);
          }
        }
      }

      const activeAfter = findActiveTrade(updatedHistory);
      const marketState: SureSignalScanStatus['marketState'] = !evaluation.feedIntegrity.valid
        ? 'UNAVAILABLE'
        : activeAfter
        ? activeAfter.direction === 'BUY'
          ? 'SURE_BUY'
          : 'SURE_SELL'
        : 'NO_SURE_SIGNAL';

      const firstBlocker = evaluation.blockers[0] ?? 'Market data integrity check failed.';
      const reason = !evaluation.feedIntegrity.valid
        ? firstBlocker.startsWith('DATA UNAVAILABLE')
          ? firstBlocker
          : `DATA UNAVAILABLE — ${firstBlocker}`
        : emittedNewSignal
        ? `SURE ${emittedNewSignal.direction} ACTIVE (Score ${emittedNewSignal.setupScore}/100, R:R ${emittedNewSignal.riskRewardRatio}). Tracking live XAU/USD Spot until TP HIT or SL HIT.`
        : cooldownBlockedReason
        ? cooldownBlockedReason
        : `SCANNING FOR HIGH-QUALITY SETUP — ${evaluation.blockers[0] ?? `Score ${evaluation.totalScore}/100 (< 90/100 SURE minimum)`}`;

      latestStatus = {
        scanning: false,
        tradeLocked: Boolean(activeAfter),
        lastScannedAt: new Date(scanStartedMs).toISOString(),
        nextScanAt: activeAfter ? null : nextScanIso,
        scanIntervalMs: SURE_SCAN_INTERVAL_MS,
        monitoringMode,
        marketState,
        latestPrice: quote.freshness !== 'UNAVAILABLE' && quote.mid > 0 ? quote.mid : latestStatus.latestPrice,
        latestConfidencePct: evaluation.totalScore,
        latestScore: Number((evaluation.totalScore / 100).toFixed(3)),
        latestSetupScore: evaluation.totalScore,
        latestAdx: adxValue,
        reason,
        checks,
        activeSignal: spotlight,
        history: updatedHistory,
        stats: computeSureHistoryStats(updatedHistory),
        feedIntegrity: evaluation.feedIntegrity,
        strategyEvaluation: {
          ...evaluation,
          newsProtection,
        },
        newsProtection,
      };

      broadcast(emittedNewSignal ? 'sure_signal' : 'sure_status', { newSignal: emittedNewSignal });
      if (emittedNewSignal) {
        void sendSureSignalWebPush(emittedNewSignal);
      }
      return latestStatus;
    } catch (err) {
      const history = await listSureSignals().catch(() => []);
      const active = findActiveTrade(history);
      latestStatus = {
        ...latestStatus,
        scanning: false,
        tradeLocked: Boolean(active),
        lastScannedAt: new Date(scanStartedMs).toISOString(),
        nextScanAt: nextScanIso,
        monitoringMode: 'UNAVAILABLE',
        marketState: active
          ? active.direction === 'BUY'
            ? 'SURE_BUY'
            : 'SURE_SELL'
          : 'UNAVAILABLE',
        reason:
          err instanceof Error
            ? `DATA UNAVAILABLE — ${err.message}`
            : 'DATA UNAVAILABLE — Awaiting live market feed.',
        activeSignal: pickSpotlightSignal(history),
        history,
        stats: computeSureHistoryStats(history),
      };
      broadcast('sure_status');
      return latestStatus;
    } finally {
      inFlightScan = null;
    }
  })();

  return inFlightScan;
}

export async function restoreActiveSureSignal(
  entry: SureSignalEntry
): Promise<SureSignalScanStatus> {
  if (
    !entry ||
    typeof entry.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id) ||
    entry.status !== 'ACTIVE' ||
    (entry.direction !== 'BUY' && entry.direction !== 'SELL') ||
    !entry.tradeLevels ||
    !Number.isFinite(entry.tradeLevels.referencePrice) ||
    !Number.isFinite(entry.tradeLevels.stopLoss) ||
    !Number.isFinite(entry.tradeLevels.takeProfit1)
  ) {
    throw new Error('Invalid active SURE signal payload');
  }

  const levelsValid =
    entry.direction === 'BUY'
      ? entry.tradeLevels.stopLoss < entry.tradeLevels.referencePrice &&
        entry.tradeLevels.takeProfit1 > entry.tradeLevels.referencePrice
      : entry.tradeLevels.stopLoss > entry.tradeLevels.referencePrice &&
        entry.tradeLevels.takeProfit1 < entry.tradeLevels.referencePrice;

  if (!levelsValid) {
    throw new Error('Invalid SL/TP levels for active SURE signal');
  }

  if (inFlightScan) {
    await inFlightScan.catch(() => null);
  }

  const existing = await listSureSignals();
  const alreadyKnown = existing.find((item) => item.id === entry.id);
  const currentActive = findActiveTrade(existing);

  if (!alreadyKnown && !currentActive) {
    await saveSureSignal({ ...entry, status: 'ACTIVE' });
    await reconcileMissedSpotCandlesForActiveTrade().catch(() => null);
    const quote = await fetchLiveXauUsdQuote().catch(() => null);
    if (quote && quote.freshness !== 'UNAVAILABLE' && quote.mid > 0) {
      await checkAndCloseActiveSignalAtPrice(quote.mid);
    }
  } else if (!alreadyKnown && currentActive) {
    // Another ACTIVE signal already holds the server's 1-active lock (e.g. after container restart).
    // Resolve this orphaned Firestore ACTIVE signal cleanly against Spot candles/quote or close as AMBIGUOUS
    // so two ACTIVE signals never coexist across history and Firestore.
    const startSec = Math.floor(new Date(entry.createdAt).getTime() / 1000);
    const candlesSince = await getRecordedSpot1mCandlesSince(startSec).catch(() => []);
    const candleOutcome =
      candlesSince.length > 0
        ? evaluateCandleOutcome(
            entry.direction,
            entry.tradeLevels.referencePrice,
            entry.tradeLevels.stopLoss,
            entry.tradeLevels.takeProfit1,
            candlesSince
          )
        : null;
    const quote = await fetchLiveXauUsdQuote().catch(() => null);
    const validQuotePrice =
      quote && quote.freshness !== 'UNAVAILABLE' && quote.mid > 0 ? quote.mid : null;
    const tickOutcome =
      !candleOutcome && validQuotePrice != null
        ? evaluateTickOutcome(
            entry.direction,
            entry.tradeLevels.referencePrice,
            entry.tradeLevels.stopLoss,
            entry.tradeLevels.takeProfit1,
            validQuotePrice
          )
        : null;

    const nowMs = Date.now();
    const createdMs = new Date(entry.createdAt).getTime();
    const resolvedClosedMs = candleOutcome
      ? Math.max(nowMs, (candleOutcome.candleTime + 60) * 1000)
      : nowMs;
    const closedAt = new Date(resolvedClosedMs).toISOString();
    const durationMs = Number.isFinite(createdMs) ? Math.max(0, resolvedClosedMs - createdMs) : 0;

    const finalizedEntry: SureSignalEntry = candleOutcome
      ? {
          ...entry,
          status: candleOutcome.status,
          closedAt,
          closePrice: candleOutcome.closePrice,
          pnlPoints: candleOutcome.pnlPoints,
          durationMs,
          lastCheckedAt: closedAt,
          lastCheckedPrice: candleOutcome.closePrice,
        }
      : tickOutcome
      ? {
          ...entry,
          status: tickOutcome.status,
          closedAt,
          closePrice: tickOutcome.closePrice,
          pnlPoints: tickOutcome.pnlPoints,
          durationMs,
          lastCheckedAt: closedAt,
          lastCheckedPrice: tickOutcome.closePrice,
        }
      : {
          ...entry,
          status: 'AMBIGUOUS',
          closedAt,
          closePrice: validQuotePrice ?? entry.lastCheckedPrice ?? entry.spotPrice,
          pnlPoints: 0,
          durationMs,
          lastCheckedAt: closedAt,
          lastCheckedPrice: validQuotePrice ?? entry.lastCheckedPrice ?? entry.spotPrice,
        };

    await saveSureSignal(finalizedEntry);
  }

  const status = await getSureSignalStatus();
  if (status.tradeLocked) {
    latestStatus = {
      ...status,
      nextScanAt: null,
    };
  }
  broadcast('sure_status');
  return latestStatus;
}

function handleLiveQuoteForSureLifecycle(quote: MarketQuote): void {
  if (quote.freshness === 'UNAVAILABLE' || !Number.isFinite(quote.mid) || quote.mid <= 0) {
    return;
  }
  latestStatus.latestPrice = quote.mid;
  latestStatus.monitoringMode = quote.freshness === 'LIVE' ? 'REALTIME_SPOT_BBO' : 'DELAYED_POLL';
  if (latestStatus.tradeLocked || latestStatus.activeSignal?.status === 'ACTIVE') {
    void checkAndCloseActiveSignalAtPrice(quote.mid);
  }
}

export function startSureSignalBackgroundScanner(): void {
  if (!quoteUnsubscribe) {
    quoteUnsubscribe = subscribeLiveQuotes(handleLiveQuoteForSureLifecycle);
  }
  if (scannerTimer) return;

  // Recover persistent state & check any missed Spot bars immediately on server startup
  void reconcileMissedSpotCandlesForActiveTrade()
    .then(() => getSureSignalStatus())
    .finally(() => {
      setTimeout(() => {
        void runSureSignalScan();
      }, 3_000);
    });

  scannerTimer = setInterval(() => {
    void runSureSignalScan();
  }, SURE_SCAN_INTERVAL_MS);
}
