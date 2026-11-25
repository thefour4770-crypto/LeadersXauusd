import crypto from 'node:crypto';
import { INDICATOR_CATALOG, MANDATORY_STRATEGY_TIMEFRAMES } from '../src/constants/indicators.ts';
import type {
  AnalysisReport,
  CandleDataset,
  NewsProtectionState,
  SelectedIndicatorConfig,
  SignalClassification,
  SignalGateCheck,
  Timeframe,
  TimeframeAnalysis,
} from '../src/types/market.ts';
import { calculateIndicator, computeSupportResistance, getLatestAdx } from './indicators.ts';
import {
  fetchCandles,
  fetchLiveXauUsdQuote,
  fetchPureFuturesCandles,
  getPureSpotCandles,
} from './marketData.ts';
import { evaluateCurrentNewsProtection } from './newsCalendar.ts';
import { saveReport } from './reportsStore.ts';
import {
  evaluateStrictMultiTimeframeStrategy,
  sliceClosedCandles,
  type StrategyDatasetsInput,
} from './strategyEngine.ts';
import { computeSignalConfidence, computeTimeframeConfidencePct } from '../src/utils/signalConfidence.ts';
import { TIMEFRAME_SECONDS } from './marketData.ts';

const TIMEFRAME_WEIGHTS: Record<Timeframe, number> = {
  '1m': 0.7,
  '5m': 0.85,
  '15m': 1.0,
  '30m': 1.2,
  '1H': 1.4,
  '4H': 1.7,
  '1D': 2.0,
  '1W': 2.2,
};

const TIMEFRAME_ORDER: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 2,
  '15m': 3,
  '30m': 4,
  '1H': 5,
  '4H': 6,
  '1D': 7,
  '1W': 8,
};

const TREND_CLUSTER_IDS = new Set(['ema', 'sma', 'supertrend']);

export class DataUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataUnavailableError';
  }
}

export class NewsBlockedError extends Error {
  protection: NewsProtectionState;
  constructor(protection: NewsProtectionState) {
    super(protection.subtext);
    this.name = 'NewsBlockedError';
    this.protection = protection;
  }
}

export function isFreshSpotDataset(
  ds: CandleDataset | null,
  timeframe: '1m' | '5m' | '15m',
  maxClosedAgeSec: number,
  nowSec = Math.floor(Date.now() / 1000),
  minClosedBars = 60
): ds is CandleDataset {
  if (!ds || ds.freshness !== 'LIVE') return false;
  const { closed } = sliceClosedCandles(ds.candles, timeframe, nowSec);
  if (closed.length < minClosedBars) return false;
  const lastClosed = closed[closed.length - 1];
  if (!lastClosed || nowSec - lastClosed.time > maxClosedAgeSec) return false;

  // Ensure the most recent window is actually contiguous (no server-sleep or multi-hour gaps
  // corrupting EMA/RSI/ATR/OBV calculations inside a fragmented live-spot-1m.json store).
  const tfSec = TIMEFRAME_SECONDS[timeframe];
  const tailCount = Math.min(closed.length, Math.max(30, Math.floor(minClosedBars * 0.6)));
  const tail = closed.slice(-tailCount);
  if (tail.length >= 2) {
    const expectedSpan = (tail.length - 1) * tfSec;
    const actualSpan = tail[tail.length - 1].time - tail[0].time;
    if (actualSpan > expectedSpan * 1.4) return false;
    for (let i = 1; i < tail.length; i++) {
      const dt = tail[i].time - tail[i - 1].time;
      if (dt > tfSec * 4) return false;
    }
  }
  return true;
}

export async function fetchStrategyDatasets(): Promise<StrategyDatasetsInput> {
  const [spot1m, spot5m, spot15m] = await Promise.all([
    getPureSpotCandles('1m'),
    getPureSpotCandles('5m'),
    getPureSpotCandles('15m'),
  ]);

  const nowSec = Math.floor(Date.now() / 1000);
  const max1mAge = Math.max(240, TIMEFRAME_SECONDS['1m'] * 3);
  const max5mAge = TIMEFRAME_SECONDS['5m'] * 3;
  const max15mAge = TIMEFRAME_SECONDS['15m'] * 3;

  const hasFresh1mSpot = isFreshSpotDataset(spot1m, '1m', max1mAge, nowSec, 60);
  const hasFresh5mSpot = isFreshSpotDataset(spot5m, '5m', max5mAge, nowSec, 60);
  const hasFresh15mSpot = isFreshSpotDataset(spot15m, '15m', max15mAge, nowSec, 30);

  const [f1H, f15m, f5m, f1m] = await Promise.all([
    fetchPureFuturesCandles('1H'),
    fetchPureFuturesCandles('15m').catch((err) => {
      if (hasFresh15mSpot && spot15m) return spot15m;
      throw err;
    }),
    hasFresh5mSpot && spot5m
      ? Promise.resolve(spot5m)
      : fetchPureFuturesCandles('5m').catch((err) => {
          if (isFreshSpotDataset(spot5m, '5m', max5mAge, nowSec, 30) && spot5m) {
            return spot5m;
          }
          throw err;
        }),
    hasFresh1mSpot && spot1m
      ? Promise.resolve(spot1m)
      : fetchPureFuturesCandles('1m').catch((err) => {
          if (isFreshSpotDataset(spot1m, '1m', max1mAge, nowSec, 30) && spot1m) {
            return spot1m;
          }
          throw err;
        }),
  ]);

  return {
    tf1H: f1H,
    tf15m: f15m,
    tf5m: f5m,
    tf1m: f1m,
  };
}

function analyzeSingleTimeframe(
  dataset: CandleDataset,
  enabledIndicators: SelectedIndicatorConfig[]
): TimeframeAnalysis {
  const results = enabledIndicators.map((cfg) => calculateIndicator(dataset.candles, cfg));
  const { supportLevels, resistanceLevels } = computeSupportResistance(dataset.candles);

  const trendResults = results.filter((r) => r.category === 'TREND');
  const momentumResults = results.filter((r) => r.category === 'MOMENTUM');
  const volatilityResults = results.filter((r) => r.category === 'VOLATILITY');
  const volumeResults = results.filter((r) => r.category === 'VOLUME');

  // Collapse EMA / SMA / Supertrend into one Trend Cluster weight so they do not triple-count
  const directionalRaw = results.filter((r) => r.id !== 'atr' && r.id !== 'bollinger_width');
  const clusterItems = directionalRaw.filter((r) => TREND_CLUSTER_IDS.has(r.id));
  const nonClusterItems = directionalRaw.filter((r) => !TREND_CLUSTER_IDS.has(r.id));

  const clusterAvgScore =
    clusterItems.length > 0
      ? clusterItems.reduce((sum, r) => sum + r.score, 0) / clusterItems.length
      : null;

  const dedupedScores: number[] = [];
  if (clusterAvgScore !== null) dedupedScores.push(clusterAvgScore);
  for (const item of nonClusterItems) dedupedScores.push(item.score);

  const combinedScore =
    dedupedScores.length > 0
      ? dedupedScores.reduce((sum, s) => sum + s, 0) / dedupedScores.length
      : 0;

  const trendScoresDeduped: number[] = [];
  if (clusterAvgScore !== null) trendScoresDeduped.push(clusterAvgScore);
  for (const r of trendResults) {
    if (!TREND_CLUSTER_IDS.has(r.id)) trendScoresDeduped.push(r.score);
  }
  const trendScore =
    trendScoresDeduped.length > 0
      ? trendScoresDeduped.reduce((sum, s) => sum + s, 0) / trendScoresDeduped.length
      : 0;
  const momentumScore =
    momentumResults.length > 0
      ? momentumResults.reduce((sum, r) => sum + r.score, 0) / momentumResults.length
      : 0;

  let buyVotes = 0;
  let sellVotes = 0;
  let holdVotes = 0;

  if (clusterAvgScore !== null) {
    if (clusterAvgScore >= 0.35) buyVotes++;
    else if (clusterAvgScore <= -0.35) sellVotes++;
    else holdVotes++;
  }
  for (const r of nonClusterItems) {
    if (r.bias === 'BUY') buyVotes++;
    else if (r.bias === 'SELL') sellVotes++;
    else holdVotes++;
  }

  const adxState = getLatestAdx(dataset.candles, 14);
  const adxVal = adxState.adx;

  let classification: SignalClassification = 'HOLD';
  const totalPool = buyVotes + sellVotes + holdVotes;
  const totalDir = buyVotes + sellVotes;
  const majorityRatio = totalDir > 0 && totalPool > 0 ? Math.max(buyVotes, sellVotes) / totalPool : 0;
  const trendMomentumAligned =
    trendResults.length === 0 ||
    momentumResults.length === 0 ||
    (!(trendScore > 0.2 && momentumScore < -0.15) &&
      !(trendScore < -0.2 && momentumScore > 0.15));
  const adxStrongEnough = adxVal == null || adxVal >= 18 || Math.abs(combinedScore) >= 0.65;

  if (
    combinedScore >= 0.35 &&
    buyVotes >= Math.max(1, sellVotes * 2) &&
    majorityRatio >= 0.5 &&
    trendMomentumAligned &&
    adxStrongEnough
  ) {
    classification = 'BUY';
  } else if (
    combinedScore <= -0.35 &&
    sellVotes >= Math.max(1, buyVotes * 2) &&
    majorityRatio >= 0.5 &&
    trendMomentumAligned &&
    adxStrongEnough
  ) {
    classification = 'SELL';
  }

  const agreements: string[] = [];
  const conflicts: string[] = [];

  if (buyVotes > 0 && sellVotes === 0) {
    agreements.push(`Directional signals align upward (${buyVotes} bullish vote(s), trend cluster deduplicated).`);
  } else if (sellVotes > 0 && buyVotes === 0) {
    agreements.push(`Directional signals align downward (${sellVotes} bearish vote(s), trend cluster deduplicated).`);
  } else if (buyVotes > 0 && sellVotes > 0) {
    conflicts.push(`Split readings: ${buyVotes} bullish vs ${sellVotes} bearish votes.`);
  }

  if (holdVotes > 0) {
    agreements.push(`${holdVotes} vote(s) currently register neutral/non-directional.`);
  }

  if (trendScore > 0.2 && momentumScore < -0.15) {
    conflicts.push('Trend cluster points upward while Momentum oscillators warn of cooling or pullback pressure.');
  } else if (trendScore < -0.2 && momentumScore > 0.15) {
    conflicts.push('Trend cluster points downward while Momentum oscillators show counter-trend bounce.');
  }

  if (adxVal != null && adxVal < 18) {
    conflicts.push(`ADX(14) at ${adxVal.toFixed(1)} (< 18) flags low-conviction / choppy range conditions.`);
  }

  const atrRes = volatilityResults.find((r) => r.id === 'atr');
  const bbWidthRes = volatilityResults.find((r) => r.id === 'bollinger_width');
  const volatilityState = atrRes
    ? `${atrRes.primaryValue} (${atrRes.secondaryValues?.State ?? 'Active'})`
    : bbWidthRes
    ? `BB Width ${bbWidthRes.primaryValue}`
    : volatilityResults[0]?.primaryValue ?? 'Not selected';

  const volRes = volumeResults[0];
  const volumeState = volRes
    ? `${volRes.primaryValue}${volRes.volumeType === 'TICK_PROXY' ? ' [Tick Proxy]' : ''}`
    : dataset.hasExchangeVolume
    ? 'Exchange volume available (not selected)'
    : 'Centralized volume unavailable';

  const latestClose = dataset.candles[dataset.candles.length - 1].close;
  const freshness = dataset.freshness === 'UNAVAILABLE' ? 'DELAYED' : dataset.freshness;

  const summary =
    classification === 'BUY'
      ? `${dataset.timeframe} aligns upward (score ${combinedScore.toFixed(2)}, ${buyVotes} BUY vs ${sellVotes} SELL).`
      : classification === 'SELL'
      ? `${dataset.timeframe} aligns downward (score ${combinedScore.toFixed(2)}, ${sellVotes} SELL vs ${buyVotes} BUY).`
      : `${dataset.timeframe} filtered to HOLD (score ${combinedScore.toFixed(2)}).`;

  const confidencePct = computeTimeframeConfidencePct(
    classification,
    buyVotes,
    sellVotes,
    holdVotes
  );

  return {
    timeframe: dataset.timeframe,
    classification,
    confidencePct,
    candleCount: dataset.candles.length,
    latestClose,
    latestTimestamp: dataset.latestTimestamp,
    freshness,
    candleSource: dataset.candleSource,
    volumeNote: dataset.volumeNote,
    combinedScore: Number(combinedScore.toFixed(3)),
    trendScore: Number(trendScore.toFixed(3)),
    momentumScore: Number(momentumScore.toFixed(3)),
    volatilityState,
    volumeState,
    supportLevels,
    resistanceLevels,
    indicatorResults: results,
    agreements,
    conflicts,
    summary,
  };
}

export async function runFullAnalysis(
  rawTimeframes: Timeframe[],
  rawIndicators: SelectedIndicatorConfig[],
  options: { persistReport?: boolean } = {}
): Promise<AnalysisReport> {
  // Always ensure the 4 strict strategy timeframes (1m, 5m, 15m, 1H) are covered alongside user selections
  const uniqueTimeframes = Array.from(
    new Set([...MANDATORY_STRATEGY_TIMEFRAMES, ...rawTimeframes])
  ).sort((a, b) => TIMEFRAME_ORDER[a] - TIMEFRAME_ORDER[b]);

  const enabledIndicators = rawIndicators.filter((i) => i.enabled);
  if (enabledIndicators.length === 0) {
    throw new Error('At least one technical indicator must be enabled for analysis.');
  }

  const [quote, strategyDatasets, displayDatasets] = await Promise.all([
    fetchLiveXauUsdQuote(),
    fetchStrategyDatasets().catch((err) => {
      throw new DataUnavailableError(
        `Unable to load strict 1H/15m/5m/1m market datasets: ${
          err instanceof Error ? err.message : 'Network failure'
        }`
      );
    }),
    Promise.all(
      uniqueTimeframes.map(async (tf) => {
        try {
          return await fetchCandles(tf);
        } catch (err) {
          throw new DataUnavailableError(
            `Unable to fetch real XAUUSD candle history for ${tf}: ${
              err instanceof Error ? err.message : 'Network failure'
            }`
          );
        }
      })
    ),
  ]);

  if (displayDatasets.some((d) => d.freshness === 'UNAVAILABLE' || d.candles.length < 20)) {
    throw new DataUnavailableError('Market candle feed returned stale or unavailable data. Analysis aborted.');
  }

  // Enforce centralized high-impact USD news block & unverified feed safe fallback
  const newsProtection = await evaluateCurrentNewsProtection({
    quote,
    candles5m: strategyDatasets.tf5m.candles,
    candles1m: strategyDatasets.tf1m.candles,
  });

  if (newsProtection.blocked) {
    throw new NewsBlockedError(newsProtection);
  }

  // Execute Strict Multi-Timeframe Strategy Engine (1H -> 15m -> 5m -> 1m closed candles + 100-pt scoring + ONE TP)
  const { evaluation: strategyEvaluation, tradeLevels } = evaluateStrictMultiTimeframeStrategy({
    datasets: strategyDatasets,
    quote,
    indicatorConfigs: enabledIndicators,
    mode: 'ANALYSIS',
  });

  const timeframeAnalyses = displayDatasets.map((ds) => analyzeSingleTimeframe(ds, enabledIndicators));

  let weightedSum = 0;
  let weightTotal = 0;
  for (const tfAnalysis of timeframeAnalyses) {
    const w = TIMEFRAME_WEIGHTS[tfAnalysis.timeframe] ?? 1;
    weightedSum += tfAnalysis.combinedScore * w;
    weightTotal += w;
  }
  const combinedScore = weightTotal > 0 ? weightedSum / weightTotal : 0;

  // Classification obeys strict strategy engine: WAIT and NO TRADE map to HOLD classification while action preserves BUY/SELL/WAIT/NO TRADE
  const classification: SignalClassification =
    strategyEvaluation.direction === 'BUY'
      ? 'BUY'
      : strategyEvaluation.direction === 'SELL'
      ? 'SELL'
      : 'HOLD';

  const signalQualityChecks: SignalGateCheck[] = strategyEvaluation.mandatoryGates;
  const signalConfidence = computeSignalConfidence({
    classification,
    timeframeAnalyses,
    signalQualityChecks,
  });

  const shortTfs = timeframeAnalyses.filter((t) => ['1m', '5m', '15m', '30m'].includes(t.timeframe));
  const longTfs = timeframeAnalyses.filter((t) => ['1H', '4H', '1D', '1W'].includes(t.timeframe));
  const shortAvg = shortTfs.length > 0 ? shortTfs.reduce((s, t) => s + t.combinedScore, 0) / shortTfs.length : 0;
  const longAvg = longTfs.length > 0 ? longTfs.reduce((s, t) => s + t.combinedScore, 0) / longTfs.length : 0;

  const shortVsLongComparison =
    strategyEvaluation.trend1H.bias === strategyEvaluation.structure15M.direction &&
    strategyEvaluation.trend1H.bias !== 'NEUTRAL'
      ? `1H major trend (${strategyEvaluation.trend1H.bias}) and 15M/5M intraday structure agree (${shortAvg.toFixed(2)} vs ${longAvg.toFixed(2)}).`
      : `1H major trend (${strategyEvaluation.trend1H.bias}) vs 15M structure (${strategyEvaluation.structure15M.direction}) — strict multi-timeframe alignment required before entry.`;

  const reasons: string[] = [
    `Strict Strategy Action: ${strategyEvaluation.action} — Setup Score ${strategyEvaluation.totalScore}/100 (${strategyEvaluation.scoreCategory}).`,
    `1H Trend: ${strategyEvaluation.trend1H.summary}`,
    `15M Structure: ${strategyEvaluation.structure15M.summary}`,
    `5M Entry Setup: ${strategyEvaluation.setup5M.summary}`,
    `1M Closed Confirmation: ${strategyEvaluation.confirmation1M.summary}`,
  ];

  if (strategyEvaluation.blockers.length > 0) {
    reasons.push(`Blocked By: ${strategyEvaluation.blockers.slice(0, 3).join(' | ')}`);
  } else if (tradeLevels) {
    reasons.push(
      `Execution Levels (Spot): Entry $${tradeLevels.referencePrice.toFixed(2)} · SL $${tradeLevels.stopLoss.toFixed(
        2
      )} · Single TP $${tradeLevels.takeProfit1.toFixed(2)} (${tradeLevels.rewardRiskRatio1}).`
    );
  }

  const agreements = strategyEvaluation.confirmations;
  const conflicts = strategyEvaluation.blockers;

  const primaryTf =
    timeframeAnalyses.find((t) => t.timeframe === '5m') ??
    timeframeAnalyses.find((t) => t.timeframe === '15m') ??
    timeframeAnalyses[0];

  const validSpotPrice = quote.freshness !== 'UNAVAILABLE' && quote.mid > 0 ? quote.mid : primaryTf.latestClose;
  const spotSource =
    quote.freshness !== 'UNAVAILABLE' && quote.mid > 0
      ? quote.source
      : 'Spot Feed Unavailable';

  const allSupports = Array.from(new Set(timeframeAnalyses.flatMap((t) => t.supportLevels)))
    .filter((s) => s < validSpotPrice * 0.9998)
    .sort((a, b) => b - a)
    .slice(0, 4);
  const allResistances = Array.from(new Set(timeframeAnalyses.flatMap((t) => t.resistanceLevels)))
    .filter((r) => r > validSpotPrice * 1.0002)
    .sort((a, b) => a - b)
    .slice(0, 4);

  const overallFreshness: 'LIVE' | 'DELAYED' =
    quote.freshness === 'LIVE' && strategyEvaluation.feedIntegrity.valid ? 'LIVE' : 'DELAYED';

  const latestMarketTs = Math.max(
    quote.freshness !== 'UNAVAILABLE' ? quote.timestamp : 0,
    ...timeframeAnalyses.map((t) => t.latestTimestamp)
  );

  const combinedMethodology = `Strict 4-timeframe analysis (1H trend -> 15M BOS/CHoCH structure -> 5M liquidity sweep & retest -> 1M closed-candle confirmation) across all 11 core indicators with EMA/SMA/Supertrend deduplicated into one Trend Cluster and a 100-point gate-enforced scoring model.`;

  const uncertaintyExplanation =
    `Setup score reflects technical alignment quality across strictly closed candles, not guaranteed win probability. ${
      strategyEvaluation.feedIntegrity.priceBasis
    }. Gold (XAU/USD) reacts rapidly to macro releases, USD yields, and liquidity shifts.`;

  const report: AnalysisReport = {
    id: crypto.randomUUID(),
    createdAt: strategyEvaluation.generatedAt,
    marketDataTimestamp: latestMarketTs,
    freshness: overallFreshness,
    spotPrice: validSpotPrice,
    spotBid: quote.bid > 0 ? quote.bid : validSpotPrice,
    spotAsk: quote.ask > 0 ? quote.ask : validSpotPrice,
    spotSource,
    candleSource: strategyEvaluation.feedIntegrity.candleSource,
    classification,
    combinedScore: Number(combinedScore.toFixed(3)),
    signalConfidence,
    selectedTimeframes: uniqueTimeframes,
    selectedIndicators: enabledIndicators.map((cfg) => {
      const def = INDICATOR_CATALOG.find((d) => d.id === cfg.id)!;
      return {
        id: cfg.id,
        name: def.name,
        category: def.category,
        params: cfg.params,
      };
    }),
    timeframeAnalyses,
    combinedMethodology,
    reasons,
    agreements,
    conflicts,
    supportLevels: allSupports,
    resistanceLevels: allResistances,
    shortVsLongComparison,
    uncertaintyExplanation,
    tradeLevels,
    signalQualityChecks,
    strategyEvaluation: {
      ...strategyEvaluation,
      newsProtection,
    },
    newsProtection,
  };

  if (options.persistReport === false) {
    return report;
  }
  return await saveReport(report);
}
