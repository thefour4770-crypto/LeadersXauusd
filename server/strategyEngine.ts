import type {
  Candle,
  CandleDataset,
  Confirmation1MSummary,
  FeedIntegrityReport,
  IndicatorResult,
  MarketQuote,
  ScoreBreakdownItem,
  SelectedIndicatorConfig,
  Setup5MSummary,
  SetupScoreCategory,
  SignalClassification,
  SignalGateCheck,
  StrictSignalAction,
  StrictStrategyEvaluation,
  Structure15MSummary,
  SureSignalStatus,
  Timeframe,
  TradeLevelsAnalysis,
  Trend1HSummary,
} from '../src/types/market.ts';
import {
  atrArray,
  bollingerArrays,
  computeSupportResistance,
  dmiAdxSeries,
  emaArray,
  getEffectiveVolumes,
  lastNonNull,
  macdSeries,
  obvSeries,
  rsiArray,
  smaArray,
  supertrendSeries,
} from './indicators.ts';
import { TIMEFRAME_SECONDS, validateCandleSeriesIntegrity } from './marketData.ts';

export interface StrategyDatasetsInput {
  tf1H: CandleDataset;
  tf15m: CandleDataset;
  tf5m: CandleDataset;
  tf1m: CandleDataset;
}

export interface StrategyEvaluationOptions {
  datasets: StrategyDatasetsInput;
  quote: MarketQuote;
  indicatorConfigs?: SelectedIndicatorConfig[];
  mode: 'ANALYSIS' | 'SURE';
  nowMs?: number;
  maxSpotAgeMs?: number;
  maxFuturesLagSec?: number;
  maxSpotCandleLagSec?: number;
  maxSpreadUsd?: number;
  maxBasisDiffPct?: number;
}

interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

const DEFAULT_MAX_SPOT_AGE_MS = 120_000;
const DEFAULT_MAX_FUTURES_LAG_SEC = 1_500; // COMEX GC=F carries ~10m exchange delay; block if >25m stale
const DEFAULT_MAX_SPOT_CANDLE_LAG_SEC = 240; // Pure Spot 1m/5m bars must stay within 4 minutes
const DEFAULT_MAX_SPREAD_USD = 2.5;
const DEFAULT_MAX_BASIS_PCT = 1.5;

function getParam(
  configs: SelectedIndicatorConfig[] | undefined,
  id: SelectedIndicatorConfig['id'],
  key: string,
  fallback: number
): number {
  const cfg = configs?.find((c) => c.id === id);
  const val = cfg?.params?.[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

/**
 * Ensures unfinished / still-forming bars are never used for final signal confirmation.
 * Any candle whose closing timestamp (time + tfSeconds) exceeds nowSec is excluded.
 */
export function sliceClosedCandles(
  candles: Candle[],
  timeframe: Timeframe,
  nowSec = Math.floor(Date.now() / 1000)
): { closed: Candle[]; droppedUnfinished: boolean } {
  if (!candles || candles.length === 0) {
    return { closed: [], droppedUnfinished: false };
  }
  const tfSec = TIMEFRAME_SECONDS[timeframe];
  const closed = candles.filter((c) => c.time + tfSec <= nowSec);
  return {
    closed,
    droppedUnfinished: closed.length < candles.length,
  };
}

function detectSwings(candles: Candle[], leftRight = 3): SwingPoint[] {
  const swings: SwingPoint[] = [];
  if (candles.length < leftRight * 2 + 1) return swings;

  for (let i = leftRight; i < candles.length - leftRight; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - leftRight; j <= i + leftRight; j++) {
      if (j === i) continue;
      // Break equal-high/equal-low ties by preferring the rightmost bar of a flat pivot
      if (j < i ? candles[j].high > candles[i].high : candles[j].high >= candles[i].high) {
        isHigh = false;
      }
      if (j < i ? candles[j].low < candles[i].low : candles[j].low <= candles[i].low) {
        isLow = false;
      }
    }
    if (isHigh) {
      swings.push({ index: i, time: candles[i].time, price: candles[i].high, type: 'HIGH' });
    }
    if (isLow) {
      swings.push({ index: i, time: candles[i].time, price: candles[i].low, type: 'LOW' });
    }
  }
  return swings.sort((a, b) => a.index - b.index);
}

function detectDemandSupplyZones(
  candles: Candle[],
  atr: number
): { demandZone: [number, number] | null; supplyZone: [number, number] | null } {
  if (candles.length < 10 || atr <= 0) {
    return { demandZone: null, supplyZone: null };
  }

  let demandZone: [number, number] | null = null;
  let supplyZone: [number, number] | null = null;
  const start = Math.max(2, candles.length - 50);

  for (let i = candles.length - 2; i >= start; i--) {
    const base = candles[i];
    const impulse = candles[i + 1];
    const baseBody = Math.abs(base.close - base.open);
    const impulseBody = impulse.close - impulse.open;

    if (!demandZone && impulseBody >= atr * 1.15 && impulse.close > base.high && baseBody <= atr * 1.1) {
      demandZone = [
        Number(Math.min(base.low, base.open, base.close).toFixed(2)),
        Number(Math.max(base.open, base.close).toFixed(2)),
      ];
    }
    if (!supplyZone && -impulseBody >= atr * 1.15 && impulse.close < base.low && baseBody <= atr * 1.1) {
      supplyZone = [
        Number(Math.min(base.open, base.close).toFixed(2)),
        Number(Math.max(base.high, base.open, base.close).toFixed(2)),
      ];
    }
    if (demandZone && supplyZone) break;
  }

  return { demandZone, supplyZone };
}

function detectMarketStructure15m(candles: Candle[]): {
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  bosDetected: 'BULLISH' | 'BEARISH' | 'NONE';
  chochDetected: 'BULLISH' | 'BEARISH' | 'NONE';
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
} {
  const win = candles.slice(-120);
  let swings = detectSwings(win, 3);
  let highs = swings.filter((s) => s.type === 'HIGH');
  let lows = swings.filter((s) => s.type === 'LOW');
  if (highs.length < 2 || lows.length < 2) {
    swings = detectSwings(win, 2);
    highs = swings.filter((s) => s.type === 'HIGH');
    lows = swings.filter((s) => s.type === 'LOW');
  }

  const lastSwingHigh = highs.length > 0 ? highs[highs.length - 1].price : null;
  const prevSwingHigh = highs.length > 1 ? highs[highs.length - 2].price : null;
  const lastSwingLow = lows.length > 0 ? lows[lows.length - 1].price : null;
  const prevSwingLow = lows.length > 1 ? lows[lows.length - 2].price : null;

  if (win.length < 15 || lastSwingHigh == null || lastSwingLow == null) {
    return {
      direction: 'NEUTRAL',
      bosDetected: 'NONE',
      chochDetected: 'NONE',
      lastSwingHigh,
      lastSwingLow,
    };
  }

  const latestClose = win[win.length - 1].close;
  const recentCloses = win.slice(-10).map((c) => c.close);
  const ema20Arr = emaArray(win.map((c) => c.close), 20);
  const ema50Arr = emaArray(win.map((c) => c.close), 50);
  const ema20Last = lastNonNull(ema20Arr).value;
  const ema50Last = lastNonNull(ema50Arr).value;

  const higherHighs = prevSwingHigh != null && lastSwingHigh > prevSwingHigh;
  const higherLows = prevSwingLow != null && lastSwingLow > prevSwingLow;
  const lowerHighs = prevSwingHigh != null && lastSwingHigh < prevSwingHigh;
  const lowerLows = prevSwingLow != null && lastSwingLow < prevSwingLow;

  // Prior trend inference before latest swings
  const priorBearish = lowerHighs || (prevSwingLow != null && lastSwingLow < prevSwingLow);
  const priorBullish = higherLows || (prevSwingHigh != null && lastSwingHigh > prevSwingHigh);

  // Recent structural break check across last 10 closed 15m candles (or newly printed LL/HH swing break)
  const brokeAboveSwingHigh =
    recentCloses.some((c) => c > lastSwingHigh) ||
    latestClose > lastSwingHigh ||
    (prevSwingHigh != null && lastSwingHigh > prevSwingHigh && latestClose > lastSwingLow);
  const brokeBelowSwingLow =
    recentCloses.some((c) => c < lastSwingLow) ||
    latestClose < lastSwingLow ||
    (prevSwingLow != null && lastSwingLow < prevSwingLow && latestClose < lastSwingHigh);

  let bosDetected: 'BULLISH' | 'BEARISH' | 'NONE' = 'NONE';
  let chochDetected: 'BULLISH' | 'BEARISH' | 'NONE' = 'NONE';

  if (brokeAboveSwingHigh && (higherLows || higherHighs)) {
    bosDetected = 'BULLISH';
  } else if (brokeBelowSwingLow && (lowerHighs || lowerLows)) {
    bosDetected = 'BEARISH';
  }

  if (brokeAboveSwingHigh && priorBearish && bosDetected !== 'BULLISH') {
    chochDetected = 'BULLISH';
  } else if (brokeBelowSwingLow && priorBullish && bosDetected !== 'BEARISH') {
    chochDetected = 'BEARISH';
  }

  // Continuation structure: e.g., bearish LL/LH or EMA20<EMA50 holding below lastSwingHigh after a recent break
  const emaBearTrend = ema20Last != null && ema50Last != null && ema20Last < ema50Last && latestClose < lastSwingHigh;
  const emaBullTrend = ema20Last != null && ema50Last != null && ema20Last > ema50Last && latestClose > lastSwingLow;

  if (bosDetected === 'NONE' && (higherHighs || higherLows) && latestClose > lastSwingLow && emaBullTrend) {
    bosDetected = 'BULLISH';
  } else if (bosDetected === 'NONE' && (lowerHighs || lowerLows) && latestClose < lastSwingHigh && emaBearTrend) {
    bosDetected = 'BEARISH';
  }

  let direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (
    bosDetected === 'BULLISH' ||
    chochDetected === 'BULLISH' ||
    (higherHighs && higherLows) ||
    (emaBullTrend && (higherHighs || higherLows))
  ) {
    direction = 'BULLISH';
  } else if (
    bosDetected === 'BEARISH' ||
    chochDetected === 'BEARISH' ||
    (lowerHighs && lowerLows) ||
    (emaBearTrend && (lowerHighs || lowerLows))
  ) {
    direction = 'BEARISH';
  }

  return {
    direction,
    bosDetected,
    chochDetected,
    lastSwingHigh: Number(lastSwingHigh.toFixed(2)),
    lastSwingLow: Number(lastSwingLow.toFixed(2)),
  };
}

function detectSweepAndRetest5m(
  candles: Candle[],
  expectedDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  atr: number,
  nearestSupport: number | null,
  nearestResistance: number | null,
  demandZone: [number, number] | null,
  supplyZone: [number, number] | null
): {
  liquiditySweep: 'BULLISH_SWEEP' | 'BEARISH_SWEEP' | 'NONE';
  retestConfirmed: boolean;
  sweepLevel: number | null;
} {
  if (candles.length < 25 || atr <= 0) {
    return { liquiditySweep: 'NONE', retestConfirmed: false, sweepLevel: null };
  }

  const recentWindow = candles.slice(-12);
  const referenceWindow = candles.slice(-42, -12);
  if (referenceWindow.length < 10) {
    return { liquiditySweep: 'NONE', retestConfirmed: false, sweepLevel: null };
  }

  const refSwings = detectSwings(candles.slice(-50, -6), 2);
  const refSwingLows = refSwings.filter((s) => s.type === 'LOW').map((s) => s.price);
  const refSwingHighs = refSwings.filter((s) => s.type === 'HIGH').map((s) => s.price);

  const priorLow =
    refSwingLows.length > 0
      ? refSwingLows[refSwingLows.length - 1]
      : Math.min(...referenceWindow.map((c) => c.low));
  const priorHigh =
    refSwingHighs.length > 0
      ? refSwingHighs[refSwingHighs.length - 1]
      : Math.max(...referenceWindow.map((c) => c.high));

  const latest = candles[candles.length - 1];
  const ema9 = lastNonNull(emaArray(candles.map((c) => c.close), 9)).value;
  const ema21 = lastNonNull(emaArray(candles.map((c) => c.close), 21)).value;

  let bullishSweep = false;
  let bearishSweep = false;
  let bullSweepIdx = -1;
  let bearSweepIdx = -1;
  let bullSweepLow: number | null = null;
  let bearSweepHigh: number | null = null;

  for (let i = 0; i < recentWindow.length; i++) {
    const c = recentWindow[i];
    const nextClose = i + 1 < recentWindow.length ? recentWindow[i + 1].close : c.close;
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);

    // Swept below local prior swing low (or nearby support/demand edge) and closed/reclaimed back above it
    const supportCandidates = Array.from(
      new Set(
        [
          priorLow,
          refSwingLows.length > 1 ? refSwingLows[refSwingLows.length - 2] : undefined,
          nearestSupport,
          demandZone?.[0],
        ].filter((v): v is number => v != null)
      )
    );
    for (const supportRef of supportCandidates) {
      if (
        c.low < supportRef - atr * 0.02 &&
        (c.close > supportRef || nextClose > supportRef) &&
        lowerWick >= atr * 0.12
      ) {
        bullishSweep = true;
        bullSweepIdx = i;
        bullSweepLow = bullSweepLow == null ? c.low : Math.min(bullSweepLow, c.low);
        break;
      }
    }

    // Swept above local prior swing high (or nearby resistance/supply edge) and closed/reclaimed back below it
    const resistanceCandidates = Array.from(
      new Set(
        [
          priorHigh,
          refSwingHighs.length > 1 ? refSwingHighs[refSwingHighs.length - 2] : undefined,
          nearestResistance,
          supplyZone?.[1],
        ].filter((v): v is number => v != null)
      )
    );
    for (const resRef of resistanceCandidates) {
      if (
        c.high > resRef + atr * 0.02 &&
        (c.close < resRef || nextClose < resRef) &&
        upperWick >= atr * 0.12
      ) {
        bearishSweep = true;
        bearSweepIdx = i;
        bearSweepHigh = bearSweepHigh == null ? c.high : Math.max(bearSweepHigh, c.high);
        break;
      }
    }
  }

  let liquiditySweep: 'BULLISH_SWEEP' | 'BEARISH_SWEEP' | 'NONE' = 'NONE';
  let sweepLevel: number | null = null;
  let sweepBarIdx = -1;

  if (expectedDirection === 'BULLISH' && bullishSweep) {
    liquiditySweep = 'BULLISH_SWEEP';
    sweepLevel = bullSweepLow;
    sweepBarIdx = bullSweepIdx;
  } else if (expectedDirection === 'BEARISH' && bearishSweep) {
    liquiditySweep = 'BEARISH_SWEEP';
    sweepLevel = bearSweepHigh;
    sweepBarIdx = bearSweepIdx;
  } else if (expectedDirection === 'NEUTRAL') {
    if (bullishSweep && !bearishSweep) {
      liquiditySweep = 'BULLISH_SWEEP';
      sweepLevel = bullSweepLow;
      sweepBarIdx = bullSweepIdx;
    } else if (bearishSweep && !bullishSweep) {
      liquiditySweep = 'BEARISH_SWEEP';
      sweepLevel = bearSweepHigh;
      sweepBarIdx = bearSweepIdx;
    }
  }

  // Retest confirmation:
  // A recent bar (last 5 bars, not stale) tested demand/support/EMA9-21 without breaking it,
  // and latest close stays near value (not already overextended far from EMA21).
  let retestConfirmed = false;
  const tolerance = atr * 0.4;
  const pullbackBars = recentWindow.slice(Math.max(0, recentWindow.length - 5));

  if (expectedDirection === 'BULLISH' || liquiditySweep === 'BULLISH_SWEEP') {
    const testedDemand =
      demandZone != null &&
      pullbackBars.some((b) => b.low <= demandZone[1] + tolerance && b.close >= demandZone[0] - tolerance * 0.25);
    const testedSupport =
      nearestSupport != null &&
      pullbackBars.some((b) => b.low <= nearestSupport + tolerance && b.close >= nearestSupport - tolerance * 0.2);
    const testedEma =
      ema9 != null &&
      ema21 != null &&
      pullbackBars.some((b) => b.low <= Math.max(ema9, ema21) + tolerance * 0.45) &&
      latest.close >= ema21;

    const notOverextended = ema21 == null || latest.close - ema21 <= atr * 1.75;

    retestConfirmed =
      (testedDemand || testedSupport || testedEma) &&
      latest.close >= latest.open - atr * 0.15 &&
      notOverextended &&
      (sweepBarIdx === -1 || sweepBarIdx < recentWindow.length);
  } else if (expectedDirection === 'BEARISH' || liquiditySweep === 'BEARISH_SWEEP') {
    const testedSupply =
      supplyZone != null &&
      pullbackBars.some((b) => b.high >= supplyZone[0] - tolerance && b.close <= supplyZone[1] + tolerance * 0.25);
    const testedResistance =
      nearestResistance != null &&
      pullbackBars.some((b) => b.high >= nearestResistance - tolerance && b.close <= nearestResistance + tolerance * 0.2);
    const testedEma =
      ema9 != null &&
      ema21 != null &&
      pullbackBars.some((b) => b.high >= Math.min(ema9, ema21) - tolerance * 0.45) &&
      latest.close <= ema21;

    const notOverextended = ema21 == null || ema21 - latest.close <= atr * 1.75;

    retestConfirmed =
      (testedSupply || testedResistance || testedEma) &&
      latest.close <= latest.open + atr * 0.15 &&
      notOverextended &&
      (sweepBarIdx === -1 || sweepBarIdx < recentWindow.length);
  }

  return { liquiditySweep, retestConfirmed, sweepLevel };
}

function validateFeedIntegrity(params: {
  datasets: StrategyDatasetsInput;
  closedSets: Record<'tf1H' | 'tf15m' | 'tf5m' | 'tf1m', Candle[]>;
  quote: MarketQuote;
  nowMs: number;
  maxSpotAgeMs: number;
  maxFuturesLagSec: number;
  maxSpotCandleLagSec: number;
  maxSpreadUsd: number;
  maxBasisDiffPct: number;
}): FeedIntegrityReport {
  const {
    datasets,
    closedSets,
    quote,
    nowMs,
    maxSpotAgeMs,
    maxFuturesLagSec,
    maxSpotCandleLagSec,
    maxSpreadUsd,
    maxBasisDiffPct,
  } = params;
  const nowSec = Math.floor(nowMs / 1000);
  const staleFeeds: string[] = [];
  const ohlcErrors: string[] = [];
  const gapWarnings: string[] = [];
  const blockingReasons: string[] = [];

  const entries: Array<{ key: keyof StrategyDatasetsInput; ds: CandleDataset; candles: Candle[] }> = [
    { key: 'tf1H', ds: datasets.tf1H, candles: closedSets.tf1H },
    { key: 'tf15m', ds: datasets.tf15m, candles: closedSets.tf15m },
    { key: 'tf5m', ds: datasets.tf5m, candles: closedSets.tf5m },
    { key: 'tf1m', ds: datasets.tf1m, candles: closedSets.tf1m },
  ];

  const lastClosed15m = closedSets.tf15m[closedSets.tf15m.length - 1];
  const intradaySessionActive =
    quote.freshness === 'LIVE' &&
    lastClosed15m != null &&
    nowSec - lastClosed15m.time <= 2_700;

  for (const item of entries) {
    const isSpotStream = item.ds.candleSource.toLowerCase().includes('spot');
    const tfSec = TIMEFRAME_SECONDS[item.ds.timeframe];
    const maxDelaySec = isSpotStream
      ? Math.max(maxSpotCandleLagSec, tfSec * 3)
      : item.ds.timeframe === '1H' && intradaySessionActive
      ? Math.max(maxFuturesLagSec, tfSec * 4 + 1_200)
      : Math.max(maxFuturesLagSec, tfSec * 2 + 1_200);

    if (item.candles.length < 30) {
      ohlcErrors.push(`${item.ds.timeframe}: Insufficient closed candles (${item.candles.length}, minimum 30 required)`);
    }

    const integrity = validateCandleSeriesIntegrity(item.candles, item.ds.timeframe, nowSec, maxDelaySec);
    ohlcErrors.push(...integrity.ohlcErrors);
    gapWarnings.push(...integrity.gapWarnings);
    if (integrity.staleReason) {
      staleFeeds.push(integrity.staleReason);
    }
  }

  const spotQuoteValid =
    quote.freshness === 'LIVE' &&
    Number.isFinite(quote.mid) &&
    quote.mid > 0 &&
    quote.bid > 0 &&
    quote.ask >= quote.bid &&
    Math.max(0, nowMs - quote.timestamp) <= maxSpotAgeMs;

  if (!spotQuoteValid) {
    const ageSec = Math.round(Math.max(0, nowMs - quote.timestamp) / 1000);
    staleFeeds.push(
      quote.freshness === 'UNAVAILABLE'
        ? 'Live XAU/USD Spot BBO quote unavailable'
        : `XAU/USD Spot quote is ${quote.freshness} (${ageSec}s old)`
    );
  }

  const spreadUsd =
    Number.isFinite(quote.spread) && quote.spread >= 0
      ? Number(quote.spread.toFixed(3))
      : quote.ask > 0 && quote.bid > 0
      ? Number((quote.ask - quote.bid).toFixed(3))
      : null;

  const atr5m = closedSets.tf5m.length >= 16 ? getLatestAtrSafe(closedSets.tf5m, 14) : null;
  const maxSpreadThreshold = atr5m != null ? Math.min(maxSpreadUsd, Math.max(1.2, atr5m * 0.65)) : maxSpreadUsd;
  const spreadAcceptable = spreadUsd != null && spreadUsd <= maxSpreadThreshold;

  if (spreadUsd != null && !spreadAcceptable) {
    blockingReasons.push(
      `Abnormal Spot spread $${spreadUsd.toFixed(2)} exceeds $${maxSpreadThreshold.toFixed(2)} limit.`
    );
  }

  // Validate futures vs spot basis if any dataset uses futures GC=F (pick finest GC=F dataset, never Spot tf1m)
  const finestFuturesEntry = [...entries].reverse().find((e) => e.ds.candleSource.includes('GC=F')) ?? null;
  const usesFutures = finestFuturesEntry !== null;
  const spotPrice = spotQuoteValid ? Number(quote.mid.toFixed(2)) : null;
  const futuresBar = finestFuturesEntry
    ? finestFuturesEntry.candles[finestFuturesEntry.candles.length - 1]
    : undefined;
  const futuresPrice = usesFutures && futuresBar ? Number(futuresBar.close.toFixed(2)) : null;

  let basisDiffUsd: number | null = null;
  let basisDiffPct: number | null = null;
  if (usesFutures && finestFuturesEntry && spotPrice != null && futuresPrice != null && futuresBar) {
    let refSpotForBasis = spotPrice;
    if (
      finestFuturesEntry.ds.timeframe !== '1m' &&
      !datasets.tf1m.candleSource.includes('GC=F') &&
      closedSets.tf1m.length > 0
    ) {
      const targetSpotTime =
        futuresBar.time + TIMEFRAME_SECONDS[finestFuturesEntry.ds.timeframe] - 60;
      let bestSpotBar: Candle | null = null;
      let bestDiff = 600;
      for (const sBar of closedSets.tf1m) {
        const diff = Math.abs(sBar.time - targetSpotTime);
        if (diff <= bestDiff) {
          bestDiff = diff;
          bestSpotBar = sBar;
        }
      }
      if (bestSpotBar) {
        refSpotForBasis = Number(bestSpotBar.close.toFixed(2));
      }
    }
    basisDiffUsd = Number((futuresPrice - refSpotForBasis).toFixed(2));
    basisDiffPct = Number(((basisDiffUsd / spotPrice) * 100).toFixed(3));
    if (Math.abs(basisDiffPct) > maxBasisDiffPct) {
      blockingReasons.push(
        `COMEX GC=F vs Spot XAU/USD basis anomaly (${basisDiffPct >= 0 ? '+' : ''}${basisDiffPct.toFixed(2)}% = $${basisDiffUsd.toFixed(2)}).`
      );
    }
  }

  const closedCandlesVerified = entries.every((e) => e.candles.length >= 30);

  if (ohlcErrors.length > 0) blockingReasons.push(...ohlcErrors);
  if (staleFeeds.length > 0) blockingReasons.push(...staleFeeds);

  const valid =
    ohlcErrors.length === 0 &&
    staleFeeds.length === 0 &&
    spotQuoteValid &&
    spreadAcceptable &&
    closedCandlesVerified &&
    blockingReasons.length === 0;

  const priceBasis = usesFutures
    ? basisDiffUsd != null
      ? `Structural OHLC: COMEX GC=F (~10m delayed exchange feed, basis ${basisDiffUsd >= 0 ? '+' : ''}$${basisDiffUsd.toFixed(2)} vs Spot) · Execution/Monitoring: Real-time Swissquote Spot XAU/USD BBO`
      : 'Structural OHLC: COMEX GC=F · Execution: Swissquote Spot XAU/USD'
    : 'Pure Real-time Swissquote Spot XAU/USD OHLC & BBO Stream';

  return {
    valid,
    spotSource: quote.source,
    candleSource: datasets.tf1m.candleSource,
    priceBasis,
    spotPrice,
    futuresPrice,
    basisDiffUsd,
    basisDiffPct,
    spreadUsd,
    spreadAcceptable,
    staleFeeds,
    ohlcErrors,
    gapWarnings,
    closedCandlesVerified,
    blockingReasons,
  };
}

function getLatestAtrSafe(candles: Candle[], period = 14): number | null {
  return lastNonNull(atrArray(candles, period)).value;
}

function computeAll11IndicatorsSnapshot(
  candles5m: Candle[],
  candles1m: Candle[],
  configs?: SelectedIndicatorConfig[]
): {
  indicators: IndicatorResult[];
  trendClusterBias: SignalClassification;
  trendClusterScore: number;
} {
  const evalCandles = candles5m.length >= 205 ? candles5m : candles1m.length >= 60 ? candles1m : candles5m;
  const closes = evalCandles.map((c) => c.close);
  const price = closes[closes.length - 1];

  const emaPeriodCfg = getParam(configs, 'ema', 'period', 21);
  const smaPeriodCfg = getParam(configs, 'sma', 'period', 50);
  const stPeriod = getParam(configs, 'supertrend', 'period', 10);
  const stMult = getParam(configs, 'supertrend', 'multiplier', 3);
  const adxPeriod = getParam(configs, 'adx', 'period', 14);
  const dmiPeriod = getParam(configs, 'dmi', 'period', 14);
  const rsiPeriod = getParam(configs, 'rsi', 'period', 14);
  const macdFast = getParam(configs, 'macd', 'fast', 12);
  const macdSlow = getParam(configs, 'macd', 'slow', 26);
  const macdSignal = getParam(configs, 'macd', 'signal', 9);
  const bbPeriod = getParam(configs, 'bollinger_bands', 'period', 20);
  const bbStd = getParam(configs, 'bollinger_bands', 'stdDev', 2);
  const atrPeriod = getParam(configs, 'atr', 'period', 14);

  const ema9 = lastNonNull(emaArray(closes, 9)).value;
  const ema21 = lastNonNull(emaArray(closes, emaPeriodCfg)).value;
  const ema50 = lastNonNull(emaArray(closes, 50)).value;
  const ema200 = lastNonNull(emaArray(closes, 200)).value;

  const sma20 = lastNonNull(smaArray(closes, 20)).value;
  const sma50 = lastNonNull(smaArray(closes, smaPeriodCfg)).value;
  const sma200 = lastNonNull(smaArray(closes, 200)).value;

  const st = supertrendSeries(evalCandles, stPeriod, stMult);
  const stLine = lastNonNull(st.line).value;
  const stDir = st.dir[st.dir.length - 1] ?? 0;

  const dmiAdx = dmiAdxSeries(evalCandles, adxPeriod);
  const adxVal = lastNonNull(dmiAdx.adx).value;
  const dmiOnly = dmiAdxSeries(evalCandles, dmiPeriod);
  const plusDI = lastNonNull(dmiOnly.plusDI).value;
  const minusDI = lastNonNull(dmiOnly.minusDI).value;

  const rsiVal = lastNonNull(rsiArray(closes, rsiPeriod)).value;
  const macd = macdSeries(closes, macdFast, macdSlow, macdSignal);
  const bb = bollingerArrays(closes, bbPeriod, bbStd);
  const bbU = lastNonNull(bb.upper).value;
  const bbM = lastNonNull(bb.mid).value;
  const bbL = lastNonNull(bb.lower).value;
  const atrVal = lastNonNull(atrArray(evalCandles, atrPeriod)).value;

  const { volumes, volumeType } = getEffectiveVolumes(evalCandles);
  const volSma20 = lastNonNull(smaArray(volumes, 20)).value;
  const latestVol = volumes[volumes.length - 1] ?? 0;
  const obv = obvSeries(evalCandles, 20);

  // Trend cluster evaluation (EMA + SMA + Supertrend unified into 1 non-redundant trend cluster vote)
  let emaDir = 0;
  if (ema9 != null && ema21 != null && ema50 != null) {
    if (price > ema9 && ema9 > ema21 && ema21 > ema50 && (ema200 == null || ema50 >= ema200)) emaDir = 1;
    else if (price < ema9 && ema9 < ema21 && ema21 < ema50 && (ema200 == null || ema50 <= ema200)) emaDir = -1;
    else if (price > ema21 && ema9 > ema21) emaDir = 0.5;
    else if (price < ema21 && ema9 < ema21) emaDir = -0.5;
  }
  let smaDir = 0;
  if (sma20 != null && sma50 != null) {
    if (price > sma20 && sma20 > sma50 && (sma200 == null || sma50 >= sma200)) smaDir = 1;
    else if (price < sma20 && sma20 < sma50 && (sma200 == null || sma50 <= sma200)) smaDir = -1;
    else if (price > sma20) smaDir = 0.4;
    else if (price < sma20) smaDir = -0.4;
  }

  const trendClusterScore = Number(((emaDir + smaDir + stDir) / 3).toFixed(3));
  const trendClusterBias: SignalClassification =
    trendClusterScore >= 0.35 ? 'BUY' : trendClusterScore <= -0.35 ? 'SELL' : 'HOLD';

  const emaBias: SignalClassification = emaDir >= 0.4 ? 'BUY' : emaDir <= -0.4 ? 'SELL' : 'HOLD';
  const smaBias: SignalClassification = smaDir >= 0.4 ? 'BUY' : smaDir <= -0.4 ? 'SELL' : 'HOLD';
  const stBias: SignalClassification = stDir > 0 ? 'BUY' : stDir < 0 ? 'SELL' : 'HOLD';

  const diDiff = plusDI != null && minusDI != null ? plusDI - minusDI : 0;
  const adxStrong = adxVal != null && adxVal >= 20;
  const adxBias: SignalClassification =
    adxStrong && diDiff >= 3 ? 'BUY' : adxStrong && diDiff <= -3 ? 'SELL' : 'HOLD';
  const dmiBias: SignalClassification =
    plusDI != null && minusDI != null
      ? plusDI > minusDI + 2
        ? 'BUY'
        : minusDI > plusDI + 2
        ? 'SELL'
        : 'HOLD'
      : 'HOLD';

  const rsiBias: SignalClassification =
    rsiVal == null ? 'HOLD' : rsiVal >= 54 && rsiVal <= 74 ? 'BUY' : rsiVal <= 46 && rsiVal >= 26 ? 'SELL' : 'HOLD';
  const macdBias: SignalClassification =
    macd.macd != null && macd.signal != null && macd.hist != null
      ? macd.macd > macd.signal && macd.hist > 0
        ? 'BUY'
        : macd.macd < macd.signal && macd.hist < 0
        ? 'SELL'
        : 'HOLD'
      : 'HOLD';

  let bbBias: SignalClassification = 'HOLD';
  let bbPctB = 0.5;
  if (bbU != null && bbL != null && bbU > bbL) {
    bbPctB = (price - bbL) / (bbU - bbL);
    if (bbPctB > 0.55 && bbPctB <= 0.92) bbBias = 'BUY';
    else if (bbPctB < 0.45 && bbPctB >= 0.08) bbBias = 'SELL';
  }

  const volRatio = volSma20 && volSma20 > 0 ? latestVol / volSma20 : 1;
  const candleUp = price >= evalCandles[evalCandles.length - 1].open;
  const volBias: SignalClassification = volRatio >= 1.05 ? (candleUp ? 'BUY' : 'SELL') : 'HOLD';
  const obvBias: SignalClassification =
    obv.obv != null && obv.signal != null
      ? obv.obv > obv.signal
        ? 'BUY'
        : obv.obv < obv.signal
        ? 'SELL'
        : 'HOLD'
      : 'HOLD';

  const indicators: IndicatorResult[] = [
    {
      id: 'ema',
      name: 'EMA Stack (9/21/50/200)',
      category: 'TREND',
      bias: emaBias,
      primaryValue: ema21 != null ? `$${ema21.toFixed(2)}` : 'N/A',
      secondaryValues: {
        EMA9: ema9 != null ? ema9.toFixed(2) : 'N/A',
        EMA50: ema50 != null ? ema50.toFixed(2) : 'N/A',
        EMA200: ema200 != null ? ema200.toFixed(2) : 'Warmup',
        ClusterWeight: 'Unified Trend Cluster',
      },
      explanation: `EMA 9/21/50/200 alignment (${emaBias}) grouped into unified Trend Cluster to prevent duplicate confidence inflation.`,
      score: Number(emaDir.toFixed(2)),
    },
    {
      id: 'sma',
      name: 'SMA Stack (20/50/200)',
      category: 'TREND',
      bias: smaBias,
      primaryValue: sma50 != null ? `$${sma50.toFixed(2)}` : 'N/A',
      secondaryValues: {
        SMA20: sma20 != null ? sma20.toFixed(2) : 'N/A',
        SMA200: sma200 != null ? sma200.toFixed(2) : 'Warmup',
        ClusterWeight: 'Unified Trend Cluster',
      },
      explanation: `SMA 20/50/200 baseline trend (${smaBias}), deduplicated alongside EMA & Supertrend.`,
      score: Number(smaDir.toFixed(2)),
    },
    {
      id: 'supertrend',
      name: `Supertrend (${stPeriod}, ${stMult})`,
      category: 'TREND',
      bias: stBias,
      primaryValue: stLine != null ? `$${stLine.toFixed(2)} (${stDir > 0 ? 'Bull' : 'Bear'})` : 'N/A',
      secondaryValues: { Direction: stDir > 0 ? 'BULLISH' : stDir < 0 ? 'BEARISH' : 'FLAT' },
      explanation: `ATR trailing band indicates ${stDir > 0 ? 'bullish' : 'bearish'} trend posture.`,
      score: stDir,
    },
    {
      id: 'adx',
      name: `ADX (${adxPeriod})`,
      category: 'TREND',
      bias: adxBias,
      primaryValue: adxVal != null ? `${adxVal.toFixed(1)}` : 'N/A',
      secondaryValues: { Strength: adxVal != null && adxVal >= 25 ? 'Strong' : adxStrong ? 'Trending' : 'Weak/Chop' },
      explanation: `Measures trend intensity (${adxVal != null ? adxVal.toFixed(1) : 'N/A'}), non-directional below 20.`,
      score: adxBias === 'BUY' ? 0.8 : adxBias === 'SELL' ? -0.8 : 0,
    },
    {
      id: 'dmi',
      name: `DMI (+DI / -DI ${dmiPeriod})`,
      category: 'TREND',
      bias: dmiBias,
      primaryValue: plusDI != null && minusDI != null ? `+${plusDI.toFixed(1)} / -${minusDI.toFixed(1)}` : 'N/A',
      secondaryValues: { Spread: `${diDiff >= 0 ? '+' : ''}${diDiff.toFixed(1)}` },
      explanation: `Directional movement comparison (+DI vs -DI) indicates ${dmiBias} pressure.`,
      score: dmiBias === 'BUY' ? 0.75 : dmiBias === 'SELL' ? -0.75 : 0,
    },
    {
      id: 'rsi',
      name: `RSI (${rsiPeriod})`,
      category: 'MOMENTUM',
      bias: rsiBias,
      primaryValue: rsiVal != null ? rsiVal.toFixed(1) : 'N/A',
      secondaryValues: { Regime: rsiVal == null ? 'N/A' : rsiVal > 72 ? 'Overbought' : rsiVal < 28 ? 'Oversold' : 'Balanced' },
      explanation: `RSI(${rsiPeriod}) measures momentum balance and overbought/oversold exhaustion.`,
      score: rsiBias === 'BUY' ? 0.7 : rsiBias === 'SELL' ? -0.7 : 0,
    },
    {
      id: 'macd',
      name: `MACD (${macdFast},${macdSlow},${macdSignal})`,
      category: 'MOMENTUM',
      bias: macdBias,
      primaryValue: macd.hist != null ? `Hist ${macd.hist >= 0 ? '+' : ''}${macd.hist.toFixed(2)}` : 'N/A',
      secondaryValues: {
        MACD: macd.macd != null ? macd.macd.toFixed(2) : 'N/A',
        Signal: macd.signal != null ? macd.signal.toFixed(2) : 'N/A',
      },
      explanation: `MACD line vs signal & histogram slope reflect ${macdBias} momentum.`,
      score: macdBias === 'BUY' ? 0.75 : macdBias === 'SELL' ? -0.75 : 0,
    },
    {
      id: 'bollinger_bands',
      name: `Bollinger Bands (${bbPeriod}, ${bbStd})`,
      category: 'VOLATILITY',
      bias: bbBias,
      primaryValue: bbM != null ? `Mid $${bbM.toFixed(2)} (%B ${Math.round(bbPctB * 100)}%)` : 'N/A',
      secondaryValues: {
        Upper: bbU != null ? bbU.toFixed(2) : 'N/A',
        Lower: bbL != null ? bbL.toFixed(2) : 'N/A',
      },
      explanation: `Price %B position relative to upper/mid/lower volatility envelope.`,
      score: bbBias === 'BUY' ? 0.5 : bbBias === 'SELL' ? -0.5 : 0,
    },
    {
      id: 'atr',
      name: `ATR (${atrPeriod})`,
      category: 'VOLATILITY',
      bias: 'HOLD',
      primaryValue: atrVal != null ? `$${atrVal.toFixed(2)}` : 'N/A',
      secondaryValues: { Pct: atrVal != null ? `${((atrVal / price) * 100).toFixed(3)}%` : 'N/A' },
      explanation: `True-range volatility gauge used strictly for stop distance, targets, and regime checks.`,
      score: 0,
    },
    {
      id: 'volume',
      name: 'Volume (vs 20-MA)',
      category: 'VOLUME',
      bias: volBias,
      primaryValue: `${volRatio.toFixed(2)}× Avg`,
      secondaryValues: { Source: volumeType === 'EXCHANGE' ? 'Exchange' : 'Tick Proxy' },
      explanation: `Participation strength relative to 20-bar moving average (${volumeType}).`,
      score: volBias === 'BUY' ? 0.6 : volBias === 'SELL' ? -0.6 : 0,
      volumeType,
    },
    {
      id: 'obv',
      name: 'OBV (Cumulative vs 20-EMA)',
      category: 'VOLUME',
      bias: obvBias,
      primaryValue: obv.obv != null ? `${Math.round(obv.obv).toLocaleString()}` : 'N/A',
      secondaryValues: { EMA20: obv.signal != null ? Math.round(obv.signal).toLocaleString() : 'N/A' },
      explanation: `Cumulative volume flow relative to its 20-EMA (${obv.volumeType}).`,
      score: obvBias === 'BUY' ? 0.65 : obvBias === 'SELL' ? -0.65 : 0,
      volumeType: obv.volumeType,
    },
  ];

  return { indicators, trendClusterBias, trendClusterScore };
}

export function isGoldMarketWeekendClosed(nowMs = Date.now()): boolean {
  const d = new Date(nowMs);
  const day = d.getUTCDay(); // 0 = Sun, 5 = Fri, 6 = Sat
  const minsUtc = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (day === 6) return true; // Saturday all day UTC
  if (day === 0 && minsUtc < 23 * 60) return true; // Sunday before 23:00 UTC open
  if (day === 5 && minsUtc >= 22 * 60 + 5) return true; // Friday after 22:05 UTC close
  return false;
}

function scoreCategoryFromScore(score: number): SetupScoreCategory {
  if (score >= 85) return 'STRONG SIGNAL';
  if (score >= 75) return 'VALID SIGNAL';
  if (score >= 60) return 'WAIT';
  return 'NO TRADE';
}

export function evaluateStrictMultiTimeframeStrategy(
  options: StrategyEvaluationOptions
): { evaluation: StrictStrategyEvaluation; tradeLevels?: TradeLevelsAnalysis } {
  const {
    datasets,
    quote,
    indicatorConfigs,
    mode,
    nowMs = Date.now(),
    maxSpotAgeMs = DEFAULT_MAX_SPOT_AGE_MS,
    maxFuturesLagSec = DEFAULT_MAX_FUTURES_LAG_SEC,
    maxSpotCandleLagSec = DEFAULT_MAX_SPOT_CANDLE_LAG_SEC,
    maxSpreadUsd = DEFAULT_MAX_SPREAD_USD,
    maxBasisDiffPct = DEFAULT_MAX_BASIS_PCT,
  } = options;

  const nowSec = Math.floor(nowMs / 1000);
  const generatedAt = new Date(nowMs).toISOString();
  const validUntil = new Date(nowMs + (mode === 'SURE' ? 30 : 15) * 60_000).toISOString();

  // Strictly slice ONLY closed candles across all 4 timeframes (never use forming bars)
  const closed1H = sliceClosedCandles(datasets.tf1H.candles, '1H', nowSec).closed;
  const closed15m = sliceClosedCandles(datasets.tf15m.candles, '15m', nowSec).closed;
  const closed5m = sliceClosedCandles(datasets.tf5m.candles, '5m', nowSec).closed;
  const closed1m = sliceClosedCandles(datasets.tf1m.candles, '1m', nowSec).closed;

  const feedIntegrity = validateFeedIntegrity({
    datasets,
    closedSets: { tf1H: closed1H, tf15m: closed15m, tf5m: closed5m, tf1m: closed1m },
    quote,
    nowMs,
    maxSpotAgeMs,
    maxFuturesLagSec,
    maxSpotCandleLagSec,
    maxSpreadUsd,
    maxBasisDiffPct,
  });

  // Fallback summaries when data integrity fails
  if (!feedIntegrity.valid) {
    const emptyIndicators =
      closed5m.length >= 30 && closed1m.length >= 20
        ? computeAll11IndicatorsSnapshot(closed5m, closed1m, indicatorConfigs).indicators
        : [];

    const weekendClosed =
      feedIntegrity.staleFeeds.length > 0 && isGoldMarketWeekendClosed(nowMs);
    const primaryReason = feedIntegrity.blockingReasons[0] ?? 'Market data integrity check failed';
    const blockers = [
      weekendClosed
        ? `DATA UNAVAILABLE: Weekend Market Closed (XAU/USD reopens Sunday 23:00 UTC / Mon 04:30 IST). ${primaryReason}`
        : `DATA UNAVAILABLE: ${primaryReason}`,
      ...feedIntegrity.blockingReasons.slice(1, 5),
    ];

    const emptyTrend1H: Trend1HSummary = {
      bias: 'NEUTRAL',
      emaAlignment: 'Unavailable',
      smaAlignment: 'Unavailable',
      supertrendDir: 'NEUTRAL',
      adxValue: null,
      plusDI: null,
      minusDI: null,
      summary: '1H data unavailable or failed integrity validation.',
    };
    const empty15m: Structure15MSummary = {
      direction: 'NEUTRAL',
      bosDetected: 'NONE',
      chochDetected: 'NONE',
      lastSwingHigh: null,
      lastSwingLow: null,
      agreesWith1H: false,
      rsiValue: null,
      macdHist: null,
      bollingerContext: 'Unavailable',
      summary: '15M structure validation skipped due to feed integrity failure.',
    };
    const empty5m: Setup5MSummary = {
      direction: 'NEUTRAL',
      liquiditySweep: 'NONE',
      retestConfirmed: false,
      nearestSupport: null,
      nearestResistance: null,
      demandZone: null,
      supplyZone: null,
      volatilityRegime: 'TOO_LOW',
      atrValue: null,
      volumeConfirmed: false,
      obvAligned: false,
      setupComplete: false,
      summary: '5M entry setup blocked due to feed integrity failure.',
    };
    const empty1m: Confirmation1MSummary = {
      direction: 'WAIT',
      closedCandleTime: null,
      closedCandleBullish: null,
      emaAligned: false,
      supertrendAligned: false,
      rsiMomentumOk: false,
      macdMomentumOk: false,
      dmiAligned: false,
      volumeOk: false,
      confirmed: false,
      summary: '1M closed-candle confirmation blocked due to feed integrity failure.',
    };

    const gates: SignalGateCheck[] = [
      {
        label: 'Market Data & Feed Integrity',
        passed: false,
        detail: blockers.join(' '),
      },
    ];

    return {
      evaluation: {
        mode,
        action: 'NO TRADE',
        direction: 'NONE',
        totalScore: 0,
        scoreCategory: 'NO TRADE',
        scoreBreakdown: [
          { category: '1H Trend Confirmation', score: 0, maxScore: 15, detail: 'Feed blocked', passed: false },
          { category: '15M Market Structure', score: 0, maxScore: 20, detail: 'Feed blocked', passed: false },
          { category: '5M Entry Setup', score: 0, maxScore: 25, detail: 'Feed blocked', passed: false },
          { category: 'Liquidity Sweep & Retest', score: 0, maxScore: 15, detail: 'Feed blocked', passed: false },
          { category: '1M Entry Confirmation', score: 0, maxScore: 15, detail: 'Feed blocked', passed: false },
          { category: 'Volume & OBV Confirmation', score: 0, maxScore: 5, detail: 'Feed blocked', passed: false },
          { category: 'Momentum Confirmation', score: 0, maxScore: 5, detail: 'Feed blocked', passed: false },
        ],
        overallDirection: 'NEUTRAL',
        trend1H: emptyTrend1H,
        structure15M: empty15m,
        setup5M: empty5m,
        confirmation1M: empty1m,
        all11Indicators: emptyIndicators,
        mandatoryGates: gates,
        confirmations: [],
        blockers,
        generatedAt,
        validUntil,
        feedIntegrity,
      },
    };
  }

  // Basis adjustment helper: translate any GC=F structural levels to Spot XAU/USD scale
  const translateToSpot = (tfDataset: CandleDataset, level: number): number => {
    if (tfDataset.candleSource.includes('GC=F') && feedIntegrity.basisDiffUsd != null) {
      return Number((level - feedIntegrity.basisDiffUsd).toFixed(2));
    }
    return Number(level.toFixed(2));
  };

  // =========================================================================
  // 1. 1H — MAJOR MARKET TREND (15 points max; EMA+SMA+ST merged into 1 Trend Cluster)
  // =========================================================================
  const c1H = closed1H.map((c) => c.close);
  const price1H = c1H[c1H.length - 1];
  const ema9_1H = lastNonNull(emaArray(c1H, 9)).value;
  const ema21_1H = lastNonNull(emaArray(c1H, 21)).value;
  const ema50_1H = lastNonNull(emaArray(c1H, 50)).value;
  const ema200_1H = lastNonNull(emaArray(c1H, 200)).value;
  const sma20_1H = lastNonNull(smaArray(c1H, 20)).value;
  const sma50_1H = lastNonNull(smaArray(c1H, 50)).value;
  const sma200_1H = lastNonNull(smaArray(c1H, 200)).value;
  const st1H = supertrendSeries(closed1H, 10, 3);
  const stDir1H = st1H.dir[st1H.dir.length - 1] ?? 0;
  const adx1H = dmiAdxSeries(closed1H, 14);
  const adxVal1H = lastNonNull(adx1H.adx).value;
  const plusDI1H = lastNonNull(adx1H.plusDI).value;
  const minusDI1H = lastNonNull(adx1H.minusDI).value;

  const emaBull1H =
    ema9_1H != null && ema21_1H != null && ema50_1H != null && price1H > ema21_1H && ema9_1H > ema21_1H && ema21_1H >= ema50_1H;
  const emaBear1H =
    ema9_1H != null && ema21_1H != null && ema50_1H != null && price1H < ema21_1H && ema9_1H < ema21_1H && ema21_1H <= ema50_1H;
  const smaBull1H = sma20_1H != null && sma50_1H != null && price1H > sma20_1H && sma20_1H >= sma50_1H;
  const smaBear1H = sma20_1H != null && sma50_1H != null && price1H < sma20_1H && sma20_1H <= sma50_1H;
  const longTermBull1H = (ema200_1H == null || price1H > ema200_1H) && (sma200_1H == null || price1H > sma200_1H);
  const longTermBear1H = (ema200_1H == null || price1H < ema200_1H) && (sma200_1H == null || price1H < sma200_1H);

  // Deduplicated Trend Cluster for 1H: Supertrend + MA alignment OR dual EMA+SMA stack alignment
  const bullCluster1H = ((emaBull1H || smaBull1H) && stDir1H > 0) || (emaBull1H && smaBull1H);
  const bearCluster1H = ((emaBear1H || smaBear1H) && stDir1H < 0) || (emaBear1H && smaBear1H);
  const fullClusterBull1H = emaBull1H && smaBull1H && stDir1H > 0 && longTermBull1H;
  const fullClusterBear1H = emaBear1H && smaBear1H && stDir1H < 0 && longTermBear1H;

  const minAdx1H = mode === 'SURE' ? 22 : 18;
  const adxOk1H = adxVal1H != null && adxVal1H >= minAdx1H;
  const dmiBull1H = plusDI1H != null && minusDI1H != null && plusDI1H > minusDI1H + 1.5;
  const dmiBear1H = plusDI1H != null && minusDI1H != null && minusDI1H > plusDI1H + 1.5;

  let bias1H: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (bullCluster1H && dmiBull1H && adxOk1H) bias1H = 'BULLISH';
  else if (bearCluster1H && dmiBear1H && adxOk1H) bias1H = 'BEARISH';

  let score1H = 0;
  if (bias1H !== 'NEUTRAL') {
    const fullStack = bias1H === 'BULLISH' ? fullClusterBull1H : fullClusterBear1H;
    // Unified Trend Cluster contributes up to 8 pts (never double-counted per MA)
    score1H += fullStack ? 8 : 6;
    // ADX & DMI directional strength contributes up to 7 pts
    score1H += adxVal1H != null && adxVal1H >= 25 ? 4 : 3;
    score1H += 3; // DMI alignment confirmed
  } else if (bullCluster1H || bearCluster1H) {
    score1H += 5;
    if (dmiBull1H || dmiBear1H) score1H += 2;
  }

  const trend1H: Trend1HSummary = {
    bias: bias1H,
    emaAlignment: emaBull1H ? '9 > 21 >= 50 Bullish' : emaBear1H ? '9 < 21 <= 50 Bearish' : 'Mixed/Flat',
    smaAlignment: smaBull1H ? 'Price > SMA20 >= SMA50' : smaBear1H ? 'Price < SMA20 <= SMA50' : 'Mixed/Flat',
    supertrendDir: stDir1H > 0 ? 'BULLISH' : stDir1H < 0 ? 'BEARISH' : 'NEUTRAL',
    adxValue: adxVal1H != null ? Number(adxVal1H.toFixed(1)) : null,
    plusDI: plusDI1H != null ? Number(plusDI1H.toFixed(1)) : null,
    minusDI: minusDI1H != null ? Number(minusDI1H.toFixed(1)) : null,
    summary:
      bias1H !== 'NEUTRAL'
        ? `1H major trend ${bias1H}: EMA/SMA/Supertrend cluster aligned, ADX ${adxVal1H?.toFixed(1)}, DMI (+${plusDI1H?.toFixed(1)}/-${minusDI1H?.toFixed(1)}).`
        : `1H trend NEUTRAL (${stDir1H > 0 ? 'ST Bull' : 'ST Bear'}, ADX ${adxVal1H?.toFixed(1) ?? 'N/A'} — awaiting clear aligned trend).`,
  };

  // =========================================================================
  // 2. 15M — MARKET STRUCTURE (20 points max)
  // =========================================================================
  const struct15m = detectMarketStructure15m(closed15m);
  const c15m = closed15m.map((c) => c.close);
  const rsi15m = lastNonNull(rsiArray(c15m, 14)).value;
  const macd15m = macdSeries(c15m, 12, 26, 9);
  const bb15m = bollingerArrays(c15m, 20, 2);
  const bbU15m = lastNonNull(bb15m.upper).value;
  const bbL15m = lastNonNull(bb15m.lower).value;
  const bbM15m = lastNonNull(bb15m.mid).value;
  const price15m = c15m[c15m.length - 1];

  const bbWidth15mPct = bbU15m && bbL15m && bbM15m ? ((bbU15m - bbL15m) / bbM15m) * 100 : 0;
  const bbPos15m = bbU15m && bbL15m && bbU15m > bbL15m ? (price15m - bbL15m) / (bbU15m - bbL15m) : 0.5;
  const bbContext15m =
    bbWidth15mPct < 0.12
      ? 'Tight Volatility Squeeze'
      : bbPos15m > 0.96
      ? 'Extended Upper Band'
      : bbPos15m < 0.04
      ? 'Extended Lower Band'
      : `Healthy Envelope (${Math.round(bbPos15m * 100)}%B)`;

  const agreesWith1H = bias1H !== 'NEUTRAL' && struct15m.direction === bias1H;
  const hasBosOrChoch15m =
    (bias1H === 'BULLISH' && (struct15m.bosDetected === 'BULLISH' || struct15m.chochDetected === 'BULLISH')) ||
    (bias1H === 'BEARISH' && (struct15m.bosDetected === 'BEARISH' || struct15m.chochDetected === 'BEARISH'));

  const rsi15mMinBull = mode === 'SURE' ? 45 : 44;
  const rsi15mMaxBull = mode === 'SURE' ? 74 : 78;
  const rsi15mMinBear = mode === 'SURE' ? 26 : 22;
  const rsi15mMaxBear = mode === 'SURE' ? 55 : 58;

  const rsi15mOk =
    bias1H === 'BULLISH'
      ? rsi15m != null && rsi15m >= rsi15mMinBull && rsi15m <= rsi15mMaxBull
      : bias1H === 'BEARISH'
      ? rsi15m != null && rsi15m >= rsi15mMinBear && rsi15m <= rsi15mMaxBear
      : false;
  const macd15mOk =
    bias1H === 'BULLISH'
      ? macd15m.hist != null && (macd15m.hist > 0 || (macd15m.prevHist != null && macd15m.hist > macd15m.prevHist))
      : bias1H === 'BEARISH'
      ? macd15m.hist != null && (macd15m.hist < 0 || (macd15m.prevHist != null && macd15m.hist < macd15m.prevHist))
      : false;
  const bbNotOverextended =
    bbWidth15mPct >= 0.12 &&
    (bias1H === 'BULLISH'
      ? bbPos15m <= (mode === 'SURE' ? 0.94 : 0.96)
      : bias1H === 'BEARISH'
      ? bbPos15m >= (mode === 'SURE' ? 0.06 : 0.04)
      : false);

  let score15m = 0;
  if (agreesWith1H) {
    score15m += 7;
    if (hasBosOrChoch15m) score15m += 5;
    if (rsi15mOk) score15m += 3;
    if (macd15mOk) score15m += 3;
    if (bbNotOverextended) score15m += 2;
  } else if (struct15m.direction !== 'NEUTRAL') {
    score15m += 4;
  }

  const structure15M: Structure15MSummary = {
    direction: struct15m.direction,
    bosDetected: struct15m.bosDetected,
    chochDetected: struct15m.chochDetected,
    lastSwingHigh:
      struct15m.lastSwingHigh != null ? translateToSpot(datasets.tf15m, struct15m.lastSwingHigh) : null,
    lastSwingLow:
      struct15m.lastSwingLow != null ? translateToSpot(datasets.tf15m, struct15m.lastSwingLow) : null,
    agreesWith1H,
    rsiValue: rsi15m != null ? Number(rsi15m.toFixed(1)) : null,
    macdHist: macd15m.hist != null ? Number(macd15m.hist.toFixed(2)) : null,
    bollingerContext: bbContext15m,
    summary: agreesWith1H
      ? `15M agrees with 1H (${struct15m.direction}) — BOS:${struct15m.bosDetected} CHoCH:${struct15m.chochDetected}, RSI ${rsi15m?.toFixed(1)}, ${bbContext15m}.`
      : `15M structure (${struct15m.direction}) conflicts or lacks confirmation vs 1H (${bias1H}).`,
  };

  // =========================================================================
  // 3. 5M — ENTRY SETUP & LIQUIDITY SWEEP / RETEST (25 pts + 15 pts)
  // =========================================================================
  const atr5mRaw = getLatestAtrSafe(closed5m, 14) ?? 2.5;
  const price5m = closed5m[closed5m.length - 1].close;
  const atr5mPct = (atr5mRaw / price5m) * 100;
  const volatilityRegime5m: Setup5MSummary['volatilityRegime'] =
    atr5mPct < 0.025 ? 'TOO_LOW' : atr5mPct > 1.3 ? 'TOO_HIGH' : 'VALID';

  const sr5m = computeSupportResistance(closed5m);
  const nearestSupportRaw = sr5m.supportLevels[0] ?? null;
  const nearestResistanceRaw = sr5m.resistanceLevels[0] ?? null;
  const zones5m = detectDemandSupplyZones(closed5m, atr5mRaw);
  const sweepRetest5m = detectSweepAndRetest5m(
    closed5m,
    bias1H,
    atr5mRaw,
    nearestSupportRaw,
    nearestResistanceRaw,
    zones5m.demandZone,
    zones5m.supplyZone
  );

  const volInfo5m = getEffectiveVolumes(closed5m);
  const volMa5m = lastNonNull(smaArray(volInfo5m.volumes, 20)).value ?? 1;
  const volRatio5m = volInfo5m.volumes[volInfo5m.volumes.length - 1] / Math.max(1, volMa5m);
  const obv5m = obvSeries(closed5m, 20);
  const obvBull5m = obv5m.obv != null && obv5m.signal != null && obv5m.obv >= obv5m.signal;
  const obvBear5m = obv5m.obv != null && obv5m.signal != null && obv5m.obv <= obv5m.signal;

  const volumeConfirmed5m = volRatio5m >= 0.85;
  const obvAligned5m =
    bias1H === 'BULLISH' ? obvBull5m : bias1H === 'BEARISH' ? obvBear5m : false;

  const c5m = closed5m.map((c) => c.close);
  const ema9_5m = lastNonNull(emaArray(c5m, 9)).value;
  const ema21_5m = lastNonNull(emaArray(c5m, 21)).value;
  const ema50_5m = lastNonNull(emaArray(c5m, 50)).value;
  const rsi5m = lastNonNull(rsiArray(c5m, 14)).value;
  const bb5m = bollingerArrays(c5m, 20, 2);
  const bbU5m = lastNonNull(bb5m.upper).value;
  const bbL5m = lastNonNull(bb5m.lower).value;
  const bbPos5m = bbU5m != null && bbL5m != null && bbU5m > bbL5m ? (price5m - bbL5m) / (bbU5m - bbL5m) : 0.5;
  const st5m = supertrendSeries(closed5m, 10, 3);
  const stDir5m = st5m.dir[st5m.dir.length - 1] ?? 0;

  const sweepMatchesDir =
    (bias1H === 'BULLISH' && sweepRetest5m.liquiditySweep === 'BULLISH_SWEEP') ||
    (bias1H === 'BEARISH' && sweepRetest5m.liquiditySweep === 'BEARISH_SWEEP');

  const spotEma21_5m = ema21_5m != null ? translateToSpot(datasets.tf5m, ema21_5m) : null;
  const spotEntryProbe = Number(quote.mid.toFixed(2));
  const emaDist5mInAtr =
    spotEma21_5m != null && atr5mRaw > 0
      ? bias1H === 'BULLISH'
        ? (spotEntryProbe - spotEma21_5m) / atr5mRaw
        : bias1H === 'BEARISH'
        ? (spotEma21_5m - spotEntryProbe) / atr5mRaw
        : 0
      : 0;
  const notChasing5m =
    mode === 'ANALYSIS' ||
    (emaDist5mInAtr <= 1.65 &&
      (bias1H === 'BULLISH'
        ? (rsi5m == null || (rsi5m >= 40 && rsi5m <= 74)) && bbPos5m <= 0.94
        : bias1H === 'BEARISH'
        ? (rsi5m == null || (rsi5m >= 28 && rsi5m <= 60)) && bbPos5m >= 0.06
        : false));

  const retestTouchTol = atr5mRaw * 0.18;
  const setup5mBull =
    bias1H === 'BULLISH' &&
    volatilityRegime5m === 'VALID' &&
    ema9_5m != null &&
    ema21_5m != null &&
    (price5m > ema21_5m ||
      ((sweepMatchesDir || sweepRetest5m.retestConfirmed) &&
        price5m >= Math.min(ema9_5m, ema21_5m) - retestTouchTol)) &&
    (stDir5m > 0 || ema9_5m >= ema21_5m * 0.9995 || (ema50_5m != null && ema21_5m > ema50_5m));
  const setup5mBear =
    bias1H === 'BEARISH' &&
    volatilityRegime5m === 'VALID' &&
    ema9_5m != null &&
    ema21_5m != null &&
    (price5m < ema21_5m ||
      ((sweepMatchesDir || sweepRetest5m.retestConfirmed) &&
        price5m <= Math.max(ema9_5m, ema21_5m) + retestTouchTol)) &&
    (stDir5m < 0 || ema9_5m <= ema21_5m * 1.0005 || (ema50_5m != null && ema21_5m < ema50_5m));

  const direction5m: Setup5MSummary['direction'] = setup5mBull
    ? 'BULLISH'
    : setup5mBear
    ? 'BEARISH'
    : 'NEUTRAL';

  const st5mMatchesDir =
    (bias1H === 'BULLISH' && stDir5m > 0) || (bias1H === 'BEARISH' && stDir5m < 0);

  // Strict SURE mode never bypasses liquidity sweep confirmation or anti-chasing distance
  const setupComplete =
    direction5m !== 'NEUTRAL' &&
    volatilityRegime5m === 'VALID' &&
    notChasing5m &&
    (mode === 'SURE'
      ? sweepMatchesDir && sweepRetest5m.retestConfirmed
      : sweepRetest5m.retestConfirmed || sweepMatchesDir || st5mMatchesDir);

  let score5mSetup = 0;
  if (direction5m !== 'NEUTRAL') score5mSetup += 10;
  if (volatilityRegime5m === 'VALID') score5mSetup += 5;
  if (
    (bias1H === 'BULLISH' && (nearestSupportRaw != null || zones5m.demandZone != null)) ||
    (bias1H === 'BEARISH' && (nearestResistanceRaw != null || zones5m.supplyZone != null))
  ) {
    score5mSetup += 5;
  }
  if (volumeConfirmed5m && obvAligned5m) score5mSetup += 5;
  else if (obvAligned5m || volumeConfirmed5m) score5mSetup += 2;

  let scoreSweepRetest = 0;
  if (sweepMatchesDir) scoreSweepRetest += 8;
  else if (sweepRetest5m.retestConfirmed && direction5m !== 'NEUTRAL') scoreSweepRetest += 3;
  if (sweepRetest5m.retestConfirmed && direction5m !== 'NEUTRAL') scoreSweepRetest += 7;

  const setup5M: Setup5MSummary = {
    direction: direction5m,
    liquiditySweep: sweepRetest5m.liquiditySweep,
    retestConfirmed: sweepRetest5m.retestConfirmed,
    nearestSupport: nearestSupportRaw != null ? translateToSpot(datasets.tf5m, nearestSupportRaw) : null,
    nearestResistance: nearestResistanceRaw != null ? translateToSpot(datasets.tf5m, nearestResistanceRaw) : null,
    demandZone: zones5m.demandZone
      ? [
          translateToSpot(datasets.tf5m, zones5m.demandZone[0]),
          translateToSpot(datasets.tf5m, zones5m.demandZone[1]),
        ]
      : null,
    supplyZone: zones5m.supplyZone
      ? [
          translateToSpot(datasets.tf5m, zones5m.supplyZone[0]),
          translateToSpot(datasets.tf5m, zones5m.supplyZone[1]),
        ]
      : null,
    volatilityRegime: volatilityRegime5m,
    atrValue: Number(atr5mRaw.toFixed(2)),
    volumeConfirmed: volumeConfirmed5m,
    obvAligned: obvAligned5m,
    setupComplete,
    summary: setupComplete
      ? `5M ${direction5m} setup validated (Sweep:${sweepRetest5m.liquiditySweep}, Retest:${sweepRetest5m.retestConfirmed ? 'YES' : 'NO'}, ATR $${atr5mRaw.toFixed(2)}).`
      : `5M setup incomplete (${direction5m}, Volatility:${volatilityRegime5m}, Sweep:${sweepRetest5m.liquiditySweep}, Retest:${sweepRetest5m.retestConfirmed ? 'YES' : 'NO'}).`,
  };

  // =========================================================================
  // 4. 1M — FINAL CLOSED-CANDLE ENTRY CONFIRMATION (15 points max)
  // =========================================================================
  const c1m = closed1m.map((c) => c.close);
  const lastClosed1m = closed1m[closed1m.length - 1];
  const ema9_1m = lastNonNull(emaArray(c1m, 9)).value;
  const ema21_1m = lastNonNull(emaArray(c1m, 21)).value;
  const st1m = supertrendSeries(closed1m, 10, 3);
  const stDir1m = st1m.dir[st1m.dir.length - 1] ?? 0;
  const rsi1m = lastNonNull(rsiArray(c1m, 14)).value;
  const macd1m = macdSeries(c1m, 12, 26, 9);
  const dmi1m = dmiAdxSeries(closed1m, 14);
  const plusDI1m = lastNonNull(dmi1m.plusDI).value;
  const minusDI1m = lastNonNull(dmi1m.minusDI).value;
  const volInfo1m = getEffectiveVolumes(closed1m);
  const volMa1m = lastNonNull(smaArray(volInfo1m.volumes, 20)).value ?? 1;
  const volRatio1m = volInfo1m.volumes[volInfo1m.volumes.length - 1] / Math.max(1, volMa1m);

  const barRange1m = Math.max(0.01, lastClosed1m.high - lastClosed1m.low);
  const bodyRatio1m = Math.abs(lastClosed1m.close - lastClosed1m.open) / barRange1m;
  const minBodyRatio1m = mode === 'SURE' ? 0.3 : 0.25;
  const closedBullCandle = lastClosed1m.close > lastClosed1m.open && bodyRatio1m >= minBodyRatio1m;
  const closedBearCandle = lastClosed1m.close < lastClosed1m.open && bodyRatio1m >= minBodyRatio1m;

  const emaAligned1m =
    bias1H === 'BULLISH'
      ? ema9_1m != null && ema21_1m != null && lastClosed1m.close > ema9_1m && ema9_1m >= ema21_1m
      : bias1H === 'BEARISH'
      ? ema9_1m != null && ema21_1m != null && lastClosed1m.close < ema9_1m && ema9_1m <= ema21_1m
      : false;
  const supertrendAligned1m =
    bias1H === 'BULLISH' ? stDir1m > 0 : bias1H === 'BEARISH' ? stDir1m < 0 : false;
  const rsiMomentumOk1m =
    bias1H === 'BULLISH'
      ? rsi1m != null && rsi1m >= (mode === 'SURE' ? 42 : 44) && rsi1m <= (mode === 'SURE' ? 74 : 80)
      : bias1H === 'BEARISH'
      ? rsi1m != null && rsi1m >= (mode === 'SURE' ? 28 : 20) && rsi1m <= (mode === 'SURE' ? 58 : 56)
      : false;
  const macdMomentumOk1m =
    bias1H === 'BULLISH'
      ? macd1m.hist != null && (macd1m.hist > 0 || (macd1m.prevHist != null && macd1m.hist > macd1m.prevHist))
      : bias1H === 'BEARISH'
      ? macd1m.hist != null && (macd1m.hist < 0 || (macd1m.prevHist != null && macd1m.hist < macd1m.prevHist))
      : false;
  const dmiAligned1m =
    bias1H === 'BULLISH'
      ? plusDI1m != null && minusDI1m != null && plusDI1m > minusDI1m
      : bias1H === 'BEARISH'
      ? plusDI1m != null && minusDI1m != null && minusDI1m > plusDI1m
      : false;
  const volumeOk1m =
    lastClosed1m.volume === 0 || volInfo1m.volumeType === 'TICK_PROXY'
      ? barRange1m >= atr5mRaw * 0.1 || volRatio5m >= 0.65
      : volRatio1m >= 0.55 || volRatio5m >= 0.7;
  const candleDirMatches =
    (bias1H === 'BULLISH' && closedBullCandle) || (bias1H === 'BEARISH' && closedBearCandle);

  // If 1m candles come from delayed futures (GC=F), verify live Spot hasn't already bolted far ahead
  const spot1mClose = translateToSpot(datasets.tf1m, lastClosed1m.close);
  const futuresSpotDriftOk =
    mode === 'ANALYSIS' ||
    !datasets.tf1m.candleSource.includes('GC=F') ||
    Math.abs(spotEntryProbe - spot1mClose) <= atr5mRaw * 2.0;

  const confirmed1m =
    bias1H !== 'NEUTRAL' &&
    candleDirMatches &&
    futuresSpotDriftOk &&
    (emaAligned1m || supertrendAligned1m) &&
    dmiAligned1m &&
    (mode === 'ANALYSIS'
      ? rsiMomentumOk1m || macdMomentumOk1m
      : rsiMomentumOk1m &&
        macdMomentumOk1m &&
        ((emaAligned1m && supertrendAligned1m) || emaAligned1m) &&
        volumeOk1m);

  let score1m = 0;
  if (candleDirMatches) score1m += 4;
  if (emaAligned1m && supertrendAligned1m) score1m += 4;
  else if (emaAligned1m || supertrendAligned1m) score1m += 3;
  if (rsiMomentumOk1m && macdMomentumOk1m) score1m += 4;
  else if (rsiMomentumOk1m || macdMomentumOk1m) score1m += 2;
  if (dmiAligned1m) score1m += 2;
  if (volumeOk1m) score1m += 1;

  const confirmation1M: Confirmation1MSummary = {
    direction: confirmed1m ? (bias1H === 'BULLISH' ? 'BUY' : 'SELL') : 'WAIT',
    closedCandleTime: lastClosed1m.time * 1000,
    closedCandleBullish: lastClosed1m.close >= lastClosed1m.open,
    emaAligned: emaAligned1m,
    supertrendAligned: supertrendAligned1m,
    rsiMomentumOk: rsiMomentumOk1m,
    macdMomentumOk: macdMomentumOk1m,
    dmiAligned: dmiAligned1m,
    volumeOk: volumeOk1m,
    confirmed: confirmed1m,
    summary: confirmed1m
      ? `1M closed bar (${new Date(lastClosed1m.time * 1000).toISOString()}) confirmed ${bias1H === 'BULLISH' ? 'BUY' : 'SELL'} with EMA/Supertrend, DMI, RSI/MACD & Volume.`
      : `1M closed bar waiting (${candleDirMatches ? 'candle OK' : 'closed candle direction unconfirmed'}, EMA:${emaAligned1m ? 'OK' : 'NO'}, ST:${supertrendAligned1m ? 'OK' : 'NO'}, DMI:${dmiAligned1m ? 'OK' : 'NO'}, Mom:${rsiMomentumOk1m && macdMomentumOk1m ? 'OK' : 'NO'}, Vol:${volumeOk1m ? 'OK' : 'NO'}, Drift:${futuresSpotDriftOk ? 'OK' : 'NO'}).`,
  };

  // =========================================================================
  // 5. VOLUME/OBV (5 pts) + MOMENTUM (5 pts) + ALL 11 INDICATORS SNAPSHOT
  // =========================================================================
  const obv1m = obvSeries(closed1m, 20);
  const obvAligned1m =
    bias1H === 'BULLISH'
      ? obv1m.obv != null && obv1m.signal != null && obv1m.obv >= obv1m.signal
      : bias1H === 'BEARISH'
      ? obv1m.obv != null && obv1m.signal != null && obv1m.obv <= obv1m.signal
      : false;

  let scoreVolumeObv = 0;
  if (obvAligned5m && volumeConfirmed5m) scoreVolumeObv += 3;
  else if (obvAligned5m || volumeConfirmed5m) scoreVolumeObv += 1;
  if (obvAligned1m && volumeOk1m) scoreVolumeObv += 2;
  else if (obvAligned1m || volumeOk1m) scoreVolumeObv += 1;

  let scoreMomentum = 0;
  if (rsi15mOk && macd15mOk) scoreMomentum += 3;
  else if (rsi15mOk || macd15mOk) scoreMomentum += 1;
  if (rsiMomentumOk1m && macdMomentumOk1m) scoreMomentum += 2;
  else if (rsiMomentumOk1m || macdMomentumOk1m) scoreMomentum += 1;

  const { indicators: all11Indicators } = computeAll11IndicatorsSnapshot(
    closed5m,
    closed1m,
    indicatorConfigs
  );

  // =========================================================================
  // 6. RISK MANAGEMENT & SINGLE TAKE PROFIT (ONE TP ONLY!)
  // =========================================================================
  const spotEntry = Number(quote.mid.toFixed(2));
  const candidateDirection: 'BUY' | 'SELL' | 'NONE' =
    bias1H === 'BULLISH' ? 'BUY' : bias1H === 'BEARISH' ? 'SELL' : 'NONE';

  let tradeLevels: TradeLevelsAnalysis | undefined;
  let riskGatePass = false;
  let riskGateDetail = 'No clear directional bias for stop/target sizing.';

  if (candidateDirection !== 'NONE') {
    const minStopDist = Math.max(0.8, Number((atr5mRaw * (mode === 'SURE' ? 1.15 : 0.85)).toFixed(2)));
    const maxStopDist = Math.max(minStopDist + 1, Number((atr5mRaw * 3.9).toFixed(2)));
    const sr15m = computeSupportResistance(closed15m);
    const sr1H = computeSupportResistance(closed1H);
    const spotSupports5m = sr5m.supportLevels.map((s) => translateToSpot(datasets.tf5m, s)).sort((a, b) => b - a);
    const spotResistances5m = sr5m.resistanceLevels.map((r) => translateToSpot(datasets.tf5m, r)).sort((a, b) => a - b);
    const majorSupports = [
      ...sr15m.supportLevels.map((s) => translateToSpot(datasets.tf15m, s)),
      ...sr1H.supportLevels.map((s) => translateToSpot(datasets.tf1H, s)),
    ].sort((a, b) => b - a);
    const majorResistances = [
      ...sr15m.resistanceLevels.map((r) => translateToSpot(datasets.tf15m, r)),
      ...sr1H.resistanceLevels.map((r) => translateToSpot(datasets.tf1H, r)),
    ].sort((a, b) => a - b);

    const recent5mLows = detectSwings(closed5m.slice(-36), 2)
      .filter((s) => s.type === 'LOW')
      .map((s) => translateToSpot(datasets.tf5m, s.price))
      .sort((a, b) => b - a);
    const recent5mHighs = detectSwings(closed5m.slice(-36), 2)
      .filter((s) => s.type === 'HIGH')
      .map((s) => translateToSpot(datasets.tf5m, s.price))
      .sort((a, b) => a - b);
    const spotSweepLevel =
      sweepRetest5m.sweepLevel != null ? translateToSpot(datasets.tf5m, sweepRetest5m.sweepLevel) : null;

    if (candidateDirection === 'BUY') {
      const sweepFloor =
        sweepMatchesDir &&
        spotSweepLevel != null &&
        spotSweepLevel < spotEntry - atr5mRaw * 0.4 &&
        spotSweepLevel >= spotEntry - atr5mRaw * 3.3
          ? spotSweepLevel
          : null;
      const demandFloor =
        setup5M.demandZone?.[0] != null &&
        setup5M.demandZone[0] < spotEntry - atr5mRaw * 0.6 &&
        setup5M.demandZone[0] >= spotEntry - atr5mRaw * 3.3
          ? setup5M.demandZone[0]
          : null;
      const structuralSupport =
        sweepFloor ??
        demandFloor ??
        spotSupports5m.find((s) => s < spotEntry - atr5mRaw * 0.6 && s >= spotEntry - atr5mRaw * 3.3) ??
        recent5mLows.find((s) => s < spotEntry - atr5mRaw * 0.6 && s >= spotEntry - atr5mRaw * 3.3) ??
        majorSupports.find((s) => s < spotEntry - atr5mRaw * 0.8 && s >= spotEntry - atr5mRaw * 3.4) ??
        null;
      const rawStop =
        structuralSupport != null
          ? Number(
              Math.min(
                structuralSupport - atr5mRaw * 0.35,
                spotEntry - atr5mRaw * (mode === 'SURE' ? 1.35 : 0.95)
              ).toFixed(2)
            )
          : Number((spotEntry - atr5mRaw * (mode === 'SURE' ? 2.0 : 1.6)).toFixed(2));
      const stopDistance = Number((spotEntry - rawStop).toFixed(2));
      const validStop = stopDistance >= minStopDist && stopDistance <= maxStopDist;

      // Single Take Profit: anchored to clear resistance if >= 1.5R and <= 2.8R, else 1.80R ATR structure target
      const minTarget = spotEntry + stopDistance * 1.55;
      const maxTarget = spotEntry + stopDistance * 2.8;
      const targetPool = Array.from(new Set([...spotResistances5m, ...majorResistances])).sort((a, b) => a - b);
      const structuralTarget = targetPool.find((r) => r >= minTarget && r <= maxTarget);
      // Reject only if a major 15m/1H opposing wall blocks clear upside before 1.15R
      const blockingWall = majorResistances.find(
        (r) => r > spotEntry + atr5mRaw * 0.85 && r < spotEntry + stopDistance * 1.15
      );
      const singleTp = Number((structuralTarget ?? spotEntry + stopDistance * 1.8).toFixed(2));
      const rrNum = stopDistance > 0 ? (singleTp - spotEntry) / stopDistance : 0;
      const rrValid = rrNum >= 1.5 && blockingWall == null;

      riskGatePass = validStop && rrValid && feedIntegrity.spreadAcceptable;
      riskGateDetail = !validStop
        ? `Stop distance $${stopDistance.toFixed(2)} outside valid [$${minStopDist.toFixed(2)}–$${maxStopDist.toFixed(2)}] volatility corridor.`
        : blockingWall != null
        ? `Major resistance at $${blockingWall.toFixed(2)} blocks 1:1.5 minimum R:R.`
        : `Entry $${spotEntry.toFixed(2)} · SL $${rawStop.toFixed(2)} · Single TP $${singleTp.toFixed(2)} (1:${rrNum.toFixed(2)} R:R, Spread $${feedIntegrity.spreadUsd?.toFixed(2)}).`;

      if (riskGatePass) {
        const rrText = `1 : ${rrNum.toFixed(2)}`;
        tradeLevels = {
          referencePrice: spotEntry,
          atrValue: Number(atr5mRaw.toFixed(2)),
          referenceTimeframe: '5m',
          stopLoss: rawStop,
          takeProfit1: singleTp,
          takeProfit2: singleTp,
          riskPoints: stopDistance,
          rewardRiskRatio1: rrText,
          rewardRiskRatio2: rrText,
          methodology: `Single TP anchored to ${
            structuralTarget ? `Spot resistance $${structuralTarget.toFixed(2)}` : '1.80R structural ATR projection'
          }; SL anchored below ${structuralSupport ? `sweep/support $${structuralSupport.toFixed(2)}` : '2.0×ATR(5m)'}.`,
        };
      }
    } else {
      const sweepCeiling =
        sweepMatchesDir &&
        spotSweepLevel != null &&
        spotSweepLevel > spotEntry + atr5mRaw * 0.4 &&
        spotSweepLevel <= spotEntry + atr5mRaw * 3.3
          ? spotSweepLevel
          : null;
      const supplyCeiling =
        setup5M.supplyZone?.[1] != null &&
        setup5M.supplyZone[1] > spotEntry + atr5mRaw * 0.6 &&
        setup5M.supplyZone[1] <= spotEntry + atr5mRaw * 3.3
          ? setup5M.supplyZone[1]
          : null;
      const structuralResistance =
        sweepCeiling ??
        supplyCeiling ??
        spotResistances5m.find((r) => r > spotEntry + atr5mRaw * 0.6 && r <= spotEntry + atr5mRaw * 3.3) ??
        recent5mHighs.find((r) => r > spotEntry + atr5mRaw * 0.6 && r <= spotEntry + atr5mRaw * 3.3) ??
        majorResistances.find((r) => r > spotEntry + atr5mRaw * 0.8 && r <= spotEntry + atr5mRaw * 3.4) ??
        null;
      const rawStop =
        structuralResistance != null
          ? Number(
              Math.max(
                structuralResistance + atr5mRaw * 0.35,
                spotEntry + atr5mRaw * (mode === 'SURE' ? 1.35 : 0.95)
              ).toFixed(2)
            )
          : Number((spotEntry + atr5mRaw * (mode === 'SURE' ? 2.0 : 1.6)).toFixed(2));
      const stopDistance = Number((rawStop - spotEntry).toFixed(2));
      const validStop = stopDistance >= minStopDist && stopDistance <= maxStopDist;

      const minTarget = spotEntry - stopDistance * 1.55;
      const maxTarget = spotEntry - stopDistance * 2.8;
      const targetPool = Array.from(new Set([...spotSupports5m, ...majorSupports])).sort((a, b) => b - a);
      const structuralTarget = targetPool.find((s) => s <= minTarget && s >= maxTarget);
      const blockingWall = majorSupports.find(
        (s) => s < spotEntry - atr5mRaw * 0.85 && s > spotEntry - stopDistance * 1.15
      );
      const singleTp = Number((structuralTarget ?? spotEntry - stopDistance * 1.8).toFixed(2));
      const rrNum = stopDistance > 0 ? (spotEntry - singleTp) / stopDistance : 0;
      const rrValid = rrNum >= 1.5 && blockingWall == null;

      riskGatePass = validStop && rrValid && feedIntegrity.spreadAcceptable;
      riskGateDetail = !validStop
        ? `Stop distance $${stopDistance.toFixed(2)} outside valid [$${minStopDist.toFixed(2)}–$${maxStopDist.toFixed(2)}] volatility corridor.`
        : blockingWall != null
        ? `Major support at $${blockingWall.toFixed(2)} blocks 1:1.5 minimum R:R.`
        : `Entry $${spotEntry.toFixed(2)} · SL $${rawStop.toFixed(2)} · Single TP $${singleTp.toFixed(2)} (1:${rrNum.toFixed(2)} R:R, Spread $${feedIntegrity.spreadUsd?.toFixed(2)}).`;

      if (riskGatePass) {
        const rrText = `1 : ${rrNum.toFixed(2)}`;
        tradeLevels = {
          referencePrice: spotEntry,
          atrValue: Number(atr5mRaw.toFixed(2)),
          referenceTimeframe: '5m',
          stopLoss: rawStop,
          takeProfit1: singleTp,
          takeProfit2: singleTp,
          riskPoints: stopDistance,
          rewardRiskRatio1: rrText,
          rewardRiskRatio2: rrText,
          methodology: `Single TP anchored to ${
            structuralTarget ? `Spot support $${structuralTarget.toFixed(2)}` : '1.80R structural ATR projection'
          }; SL anchored above ${structuralResistance ? `sweep/resistance $${structuralResistance.toFixed(2)}` : '2.0×ATR(5m)'}.`,
        };
      }
    }
  }

  // =========================================================================
  // 7. 100-POINT SCORING & MANDATORY STRICT GATES
  // =========================================================================
  const totalScore = Math.min(
    100,
    Math.max(
      0,
      Math.round(
        score1H + score15m + score5mSetup + scoreSweepRetest + score1m + scoreVolumeObv + scoreMomentum
      )
    )
  );
  const scoreCategory = scoreCategoryFromScore(totalScore);
  const minScoreRequired = mode === 'SURE' ? 90 : 75;

  const scoreBreakdown: ScoreBreakdownItem[] = [
    {
      category: '1H Trend Confirmation',
      score: score1H,
      maxScore: 15,
      detail: trend1H.summary,
      passed: bias1H !== 'NEUTRAL' && score1H >= 11,
    },
    {
      category: '15M Market Structure',
      score: score15m,
      maxScore: 20,
      detail: structure15M.summary,
      passed: agreesWith1H && (mode === 'ANALYSIS' || hasBosOrChoch15m),
    },
    {
      category: '5M Entry Setup',
      score: score5mSetup,
      maxScore: 25,
      detail: setup5M.summary,
      passed: direction5m !== 'NEUTRAL' && volatilityRegime5m === 'VALID',
    },
    {
      category: 'Liquidity Sweep & Retest',
      score: scoreSweepRetest,
      maxScore: 15,
      detail: `Sweep: ${sweepRetest5m.liquiditySweep} · Retest: ${sweepRetest5m.retestConfirmed ? 'Confirmed' : 'Pending'}`,
      passed: mode === 'SURE' ? sweepMatchesDir && sweepRetest5m.retestConfirmed : sweepMatchesDir || sweepRetest5m.retestConfirmed,
    },
    {
      category: '1M Entry Confirmation',
      score: score1m,
      maxScore: 15,
      detail: confirmation1M.summary,
      passed: confirmed1m,
    },
    {
      category: 'Volume & OBV Confirmation',
      score: scoreVolumeObv,
      maxScore: 5,
      detail: `5M Vol ${volRatio5m.toFixed(2)}× (OBV ${obvAligned5m ? 'aligned' : 'flat/opposing'}) · 1M Vol ${volRatio1m.toFixed(2)}×`,
      passed: obvAligned5m && (volumeConfirmed5m || volumeOk1m),
    },
    {
      category: 'Momentum Confirmation',
      score: scoreMomentum,
      maxScore: 5,
      detail: `15M RSI ${rsi15m?.toFixed(1) ?? 'N/A'} / MACD ${macd15m.hist?.toFixed(2) ?? 'N/A'} · 1M RSI ${rsi1m?.toFixed(1) ?? 'N/A'}`,
      passed: (rsi15mOk || macd15mOk) && (rsiMomentumOk1m || macdMomentumOk1m),
    },
  ];

  const volumeObvNonContradictory =
    bias1H !== 'NEUTRAL' &&
    (mode === 'ANALYSIS'
      ? obvAligned5m || obvAligned1m
      : (obvAligned5m || obvAligned1m) && (volumeConfirmed5m || volumeOk1m));
  const momentumGatePass =
    bias1H !== 'NEUTRAL' &&
    (mode === 'ANALYSIS'
      ? (rsi15mOk || macd15mOk) && (rsiMomentumOk1m || macdMomentumOk1m)
      : rsi15mOk && macd15mOk && rsiMomentumOk1m && macdMomentumOk1m && notChasing5m);

  const mandatoryGates: SignalGateCheck[] = [
    {
      label: 'Market Data & Feed Integrity',
      passed: feedIntegrity.valid,
      detail: feedIntegrity.valid
        ? `Closed candles verified across 1H/15M/5M/1M; Spot spread $${feedIntegrity.spreadUsd?.toFixed(2)}.`
        : feedIntegrity.blockingReasons.join(' '),
    },
    {
      label: `1H Major Trend Established (ADX >= ${minAdx1H})`,
      passed: bias1H !== 'NEUTRAL',
      detail: trend1H.summary,
    },
    {
      label: mode === 'SURE' ? '15M BOS/CHoCH & Trend Agreement with 1H' : '15M Market Structure Agreement with 1H',
      passed: agreesWith1H && (mode === 'ANALYSIS' || hasBosOrChoch15m),
      detail: structure15M.summary,
    },
    {
      label: mode === 'SURE' ? '5M Sweep + Retest & Anti-Chasing Setup' : '5M Entry Setup & Volatility Regime',
      passed: setupComplete,
      detail: notChasing5m
        ? setup5M.summary
        : emaDist5mInAtr > 1.65
        ? `Price extended ${emaDist5mInAtr.toFixed(2)}×ATR from 5m EMA21 (RSI ${rsi5m?.toFixed(1) ?? 'N/A'}) — awaiting pullback.`
        : `5M momentum/band outside safe entry window (RSI ${rsi5m?.toFixed(1) ?? 'N/A'}, %B ${Math.round(bbPos5m * 100)}%, EMA dist ${emaDist5mInAtr.toFixed(2)}×ATR) — awaiting alignment.`,
    },
    {
      label: '1M Closed-Candle Final Confirmation',
      passed: confirmed1m,
      detail: confirmation1M.summary,
    },
    {
      label: 'Volume/OBV & Momentum Non-Contradiction',
      passed: volumeObvNonContradictory && momentumGatePass,
      detail:
        volumeObvNonContradictory && momentumGatePass
          ? 'Volume, OBV, RSI & MACD momentum support trade direction without exhaustion.'
          : 'Blocked: Volume/OBV or RSI/MACD momentum diverges, is overextended, or lacks confirmation.',
    },
    {
      label: 'Risk Management & Single TP (>= 1:1.5 R:R)',
      passed: riskGatePass,
      detail: riskGateDetail,
    },
    {
      label: `Setup Quality Score (>= ${minScoreRequired}/100)`,
      passed: totalScore >= minScoreRequired,
      detail: `Calculated score ${totalScore}/100 (${scoreCategory}) vs ${minScoreRequired}/100 ${mode} threshold.`,
    },
  ];

  const allGatesPassed = mandatoryGates.every((g) => g.passed);
  const confirmations = mandatoryGates.filter((g) => g.passed).map((g) => `${g.label}: ${g.detail}`);
  const blockers = mandatoryGates.filter((g) => !g.passed).map((g) => `${g.label} — ${g.detail}`);

  let action: StrictSignalAction;
  let direction: 'BUY' | 'SELL' | 'NONE' = 'NONE';
  if (allGatesPassed && tradeLevels && candidateDirection !== 'NONE') {
    action = candidateDirection;
    direction = candidateDirection;
  } else if (totalScore >= 60 && bias1H !== 'NEUTRAL' && agreesWith1H) {
    action = 'WAIT';
  } else {
    action = 'NO TRADE';
  }

  return {
    evaluation: {
      mode,
      action,
      direction,
      totalScore,
      scoreCategory,
      scoreBreakdown,
      overallDirection: bias1H,
      trend1H,
      structure15M,
      setup5M,
      confirmation1M,
      all11Indicators,
      mandatoryGates,
      confirmations,
      blockers,
      generatedAt,
      validUntil,
      feedIntegrity,
    },
    tradeLevels: direction !== 'NONE' ? tradeLevels : undefined,
  };
}

/**
 * Evaluates live Spot tick against an ACTIVE SURE signal.
 */
export function evaluateTickOutcome(
  direction: 'BUY' | 'SELL',
  entryPrice: number,
  stopLoss: number,
  takeProfit: number,
  tickPrice: number
): { status: SureSignalStatus; closePrice: number; pnlPoints: number } | null {
  if (!Number.isFinite(tickPrice) || tickPrice <= 0) return null;
  const rounded = Number(tickPrice.toFixed(2));

  if (direction === 'BUY') {
    if (tickPrice <= stopLoss) {
      return {
        status: 'SL_HIT',
        closePrice: rounded,
        pnlPoints: Number((rounded - entryPrice).toFixed(2)),
      };
    }
    if (tickPrice >= takeProfit) {
      return {
        status: 'TP_HIT',
        closePrice: rounded,
        pnlPoints: Number((rounded - entryPrice).toFixed(2)),
      };
    }
  } else {
    if (tickPrice >= stopLoss) {
      return {
        status: 'SL_HIT',
        closePrice: rounded,
        pnlPoints: Number((entryPrice - rounded).toFixed(2)),
      };
    }
    if (tickPrice <= takeProfit) {
      return {
        status: 'TP_HIT',
        closePrice: rounded,
        pnlPoints: Number((entryPrice - rounded).toFixed(2)),
      };
    }
  }
  return null;
}

/**
 * Evaluates closed OHLC candles against an ACTIVE SURE signal (used when recovering missed bars).
 * If both TP and SL are crossed inside the same candle without tick-level ordering, returns AMBIGUOUS.
 */
export function evaluateCandleOutcome(
  direction: 'BUY' | 'SELL',
  entryPrice: number,
  stopLoss: number,
  takeProfit: number,
  candles: Candle[]
): { status: SureSignalStatus; closePrice: number; pnlPoints: number; candleTime: number } | null {
  for (const c of candles) {
    if (direction === 'BUY') {
      const hitSL = c.low <= stopLoss;
      const hitTP = c.high >= takeProfit;
      if (hitSL && hitTP) {
        return {
          status: 'AMBIGUOUS',
          closePrice: Number(c.close.toFixed(2)),
          pnlPoints: 0,
          candleTime: c.time,
        };
      }
      if (hitTP) {
        return {
          status: 'TP_HIT',
          closePrice: Number(takeProfit.toFixed(2)),
          pnlPoints: Number((takeProfit - entryPrice).toFixed(2)),
          candleTime: c.time,
        };
      }
      if (hitSL) {
        return {
          status: 'SL_HIT',
          closePrice: Number(stopLoss.toFixed(2)),
          pnlPoints: Number((stopLoss - entryPrice).toFixed(2)),
          candleTime: c.time,
        };
      }
    } else {
      const hitSL = c.high >= stopLoss;
      const hitTP = c.low <= takeProfit;
      if (hitSL && hitTP) {
        return {
          status: 'AMBIGUOUS',
          closePrice: Number(c.close.toFixed(2)),
          pnlPoints: 0,
          candleTime: c.time,
        };
      }
      if (hitTP) {
        return {
          status: 'TP_HIT',
          closePrice: Number(takeProfit.toFixed(2)),
          pnlPoints: Number((entryPrice - takeProfit).toFixed(2)),
          candleTime: c.time,
        };
      }
      if (hitSL) {
        return {
          status: 'SL_HIT',
          closePrice: Number(stopLoss.toFixed(2)),
          pnlPoints: Number((entryPrice - stopLoss).toFixed(2)),
          candleTime: c.time,
        };
      }
    }
  }
  return null;
}
