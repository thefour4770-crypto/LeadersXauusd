import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAutoPerfectIndicators } from '../src/constants/indicators.ts';
import type {
  AnalysisReport,
  Candle,
  CandleDataset,
  MarketQuote,
  SureSignalEntry,
  SureSignalScanStatus,
  SureSignalStatus,
  Timeframe,
} from '../src/types/market.ts';
import { reconcileSureStatusTransitions } from '../src/utils/phoneNotifications.ts';
import { computeSignalConfidence } from '../src/utils/signalConfidence.ts';
import {
  atrArray,
  bollingerArrays,
  dmiAdxSeries,
  emaArray,
  macdSeries,
  obvSeries,
  rsiArray,
  smaArray,
  supertrendSeries,
} from '../server/indicators.ts';
import { isFreshSpotDataset } from '../server/analyzer.ts';
import { stitchFuturesContractRollovers, validateCandleSeriesIntegrity } from '../server/marketData.ts';
import {
  listReports,
  saveReport,
  setReportsStoreFile,
} from '../server/reportsStore.ts';
import {
  evaluateCandleOutcome,
  evaluateStrictMultiTimeframeStrategy,
  evaluateTickOutcome,
  sliceClosedCandles,
} from '../server/strategyEngine.ts';
import {
  computeSureHistoryStats,
  listSureSignals,
  saveSureSignal,
  setSureSignalsStoreFile,
  updateSureSignal,
} from '../server/sureSignalsStore.ts';
import {
  getNextUtcMinuteScanMs,
  isSureStatusStaleForMinute,
} from '../server/sureScanner.ts';

const NOW_SEC = 1_760_000_000;
const NOW_MS = NOW_SEC * 1000;

function makeTrendCandles(params: {
  count: number;
  tfSeconds: number;
  startPrice: number;
  step: number;
  endSec?: number;
  mode?: 'TREND' | 'STRUCTURE_15M' | 'SETUP_5M' | 'CONFIRM_1M';
  bullish?: boolean;
}): Candle[] {
  const {
    count,
    tfSeconds,
    startPrice,
    step,
    endSec = NOW_SEC - tfSeconds,
    mode = 'TREND',
    bullish = true,
  } = params;
  const startTime = endSec - (count - 1) * tfSeconds;
  const candles: Candle[] = [];
  let price = startPrice;
  const sign = bullish ? 1 : -1;

  for (let i = 0; i < count; i++) {
    const t = startTime + i * tfSeconds;
    const wave = Math.sin(i * 0.45) * 1.4;
    let delta = step + wave * 0.35;
    let vol = 1_500 + (i % 7) * 200;

    if (mode === 'STRUCTURE_15M') {
      // Deterministic 14-bar HH/HL (or LL/LH) structure cycle + pullback + BOS breakout
      if (i >= count - 12 && i <= count - 9) {
        delta = sign * -0.52;
      } else if (i > count - 9) {
        delta = sign * 0.62;
        vol = 3_100;
      } else {
        delta = sign * (i % 14 < 9 ? 0.55 : -0.48);
      }
    } else if (mode === 'SETUP_5M') {
      if (i === count - 20) {
        // Quiet base candle preceding demand/supply impulse
        delta = sign * 0.08;
      } else if (i === count - 19) {
        // Impulse candle creating Demand/Supply zone (body >= 1.15 * ATR)
        delta = sign * 5.2;
        vol = 3_900;
      } else if (i >= count - 12 && i <= count - 7) {
        // Controlled pullback into the zone
        delta = sign * -0.7;
      } else if (i > count - 7 && i < count - 1) {
        // Reclaim and continuation
        delta = sign * 1.05;
        vol = 2_800;
      }
    } else if (mode === 'CONFIRM_1M') {
      if (i >= count - 16 && i <= count - 8) {
        // Shallow reset so RSI stays ~55-65 and MACD accelerates upward cleanly on entry
        delta = sign * -0.14;
      } else if (i > count - 8 && i < count - 1) {
        delta = sign * 0.24;
        vol = 3_100;
      }
    }

    const open = Number(price.toFixed(2));
    const close = Number((price + delta).toFixed(2));
    let high = Number((Math.max(open, close) + 0.95).toFixed(2));
    let low = Number((Math.min(open, close) - 0.95).toFixed(2));

    if (mode === 'SETUP_5M' && i === count - 6) {
      // Liquidity sweep of the local pullback low/high & strong close reclaim
      if (bullish) {
        const localMin = Math.min(...candles.slice(-20).map((c) => c.low));
        low = Number((localMin - 1.8).toFixed(2));
      } else {
        const localMax = Math.max(...candles.slice(-20).map((c) => c.high));
        high = Number((localMax + 1.8).toFixed(2));
      }
      vol = 4_200;
    }

    if ((mode === 'SETUP_5M' || mode === 'CONFIRM_1M') && i === count - 1) {
      // Clean closed confirmation candle in momentum range without blowing RSI overbought
      const bodyMove = sign * (mode === 'CONFIRM_1M' ? 0.65 : 1.45);
      const confirmedClose = Number((open + bodyMove).toFixed(2));
      const confirmedLow = Number((Math.min(open, confirmedClose) - 0.35).toFixed(2));
      const confirmedHigh = Number((Math.max(open, confirmedClose) + 0.35).toFixed(2));
      candles.push({
        time: t,
        open,
        high: confirmedHigh,
        low: confirmedLow,
        close: confirmedClose,
        volume: 5_200,
      });
      price = confirmedClose;
      continue;
    }

    candles.push({
      time: t,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume: vol,
    });
    price = close;
  }

  return candles;
}

function makeDataset(timeframe: Timeframe, candles: Candle[], source = 'Swissquote Spot XAU/USD BBO Stream'): CandleDataset {
  const latest = candles[candles.length - 1]?.time ?? NOW_SEC;
  return {
    symbol: 'XAU/USD',
    candleSource: source,
    timeframe,
    candles,
    latestTimestamp: latest * 1000,
    freshness: 'LIVE',
    hasExchangeVolume: true,
    nonZeroVolumeRatio: 1,
    volumeNote: 'Verified test stream',
  };
}

function makeQuote(mid: number, spread = 0.6, freshness: MarketQuote['freshness'] = 'LIVE'): MarketQuote {
  return {
    symbol: 'XAU/USD',
    bid: Number((mid - spread / 2).toFixed(3)),
    ask: Number((mid + spread / 2).toFixed(3)),
    mid: Number(mid.toFixed(3)),
    spread,
    timestamp: NOW_MS - 1_500,
    freshness,
    source: 'Swissquote Spot XAU/USD BBO',
  };
}

function buildBullishDatasets(spotPrice = 3780) {
  const c1H = makeTrendCandles({ count: 220, tfSeconds: 3600, startPrice: spotPrice - 92, step: 0.42, mode: 'TREND', bullish: true });
  const c15m = makeTrendCandles({ count: 220, tfSeconds: 900, startPrice: spotPrice - 46, step: 0.24, mode: 'STRUCTURE_15M', bullish: true });
  const c5m = makeTrendCandles({ count: 220, tfSeconds: 300, startPrice: spotPrice - 28, step: 0.12, mode: 'SETUP_5M', bullish: true });
  const c1m = makeTrendCandles({ count: 220, tfSeconds: 60, startPrice: spotPrice - 12, step: 0.05, mode: 'CONFIRM_1M', bullish: true });
  const lastClose = c1m[c1m.length - 1].close;
  return {
    datasets: {
      tf1H: makeDataset('1H', c1H),
      tf15m: makeDataset('15m', c15m),
      tf5m: makeDataset('5m', c5m),
      tf1m: makeDataset('1m', c1m),
    },
    quote: makeQuote(lastClose + 0.15),
  };
}

function buildBearishDatasets(spotPrice = 3780) {
  const c1H = makeTrendCandles({ count: 220, tfSeconds: 3600, startPrice: spotPrice + 92, step: -0.42, mode: 'TREND', bullish: false });
  const c15m = makeTrendCandles({ count: 220, tfSeconds: 900, startPrice: spotPrice + 46, step: -0.24, mode: 'STRUCTURE_15M', bullish: false });
  const c5m = makeTrendCandles({ count: 220, tfSeconds: 300, startPrice: spotPrice + 28, step: -0.12, mode: 'SETUP_5M', bullish: false });
  const c1m = makeTrendCandles({ count: 220, tfSeconds: 60, startPrice: spotPrice + 12, step: -0.05, mode: 'CONFIRM_1M', bullish: false });
  const lastClose = c1m[c1m.length - 1].close;
  return {
    datasets: {
      tf1H: makeDataset('1H', c1H),
      tf15m: makeDataset('15m', c15m),
      tf5m: makeDataset('5m', c5m),
      tf1m: makeDataset('1m', c1m),
    },
    quote: makeQuote(lastClose - 0.15),
  };
}

test('1. All 11 technical indicators calculate accurately on 220 bars', () => {
  const candles = makeTrendCandles({ count: 220, tfSeconds: 300, startPrice: 3720, step: 0.25, bullish: true });
  const closes = candles.map((c) => c.close);

  assert.ok(emaArray(closes, 200)[219] !== null, 'EMA(200) must be populated');
  assert.ok(smaArray(closes, 200)[219] !== null, 'SMA(200) must be populated');
  assert.ok(atrArray(candles, 14)[219]! > 0, 'ATR(14) must be positive');
  const st = supertrendSeries(candles, 10, 3);
  assert.equal(st.dir[219], 1, 'Supertrend direction should reflect uptrend');
  const dmi = dmiAdxSeries(candles, 14);
  assert.ok(dmi.adx[219]! > 15 && dmi.plusDI[219]! > dmi.minusDI[219]!, 'ADX & DMI must align');
  const rsi = rsiArray(closes, 14);
  assert.ok(rsi[219]! > 50, 'RSI(14) should be bullish');
  const macd = macdSeries(closes, 12, 26, 9);
  assert.ok(macd.macd !== null && macd.signal !== null, 'MACD should be computed');
  const bb = bollingerArrays(closes, 20, 2);
  assert.ok(bb.upper[219]! > bb.mid[219]! && bb.mid[219]! > bb.lower[219]!, 'Bollinger upper > mid > lower');
  const obv = obvSeries(candles, 20);
  assert.ok(obv.obv !== null && obv.signal !== null, 'OBV cumulative series should be computed');
});

test('2. Anti-duplicate confirmation: EMA, SMA, and Supertrend collapse into 1 Trend Cluster vote', () => {
  const conf = computeSignalConfidence({
    classification: 'BUY',
    timeframeAnalyses: [
      {
        timeframe: '1H',
        classification: 'BUY',
        candleCount: 220,
        latestClose: 3780,
        latestTimestamp: NOW_MS,
        freshness: 'LIVE',
        candleSource: 'Spot',
        volumeNote: 'ok',
        combinedScore: 0.8,
        trendScore: 0.9,
        momentumScore: 0.7,
        volatilityState: '$2.50',
        volumeState: '1.2x',
        supportLevels: [3760],
        resistanceLevels: [3800],
        indicatorResults: [
          { id: 'ema', name: 'EMA', category: 'TREND', bias: 'BUY', primaryValue: '3775', explanation: '', score: 1 },
          { id: 'sma', name: 'SMA', category: 'TREND', bias: 'BUY', primaryValue: '3772', explanation: '', score: 1 },
          { id: 'supertrend', name: 'ST', category: 'TREND', bias: 'BUY', primaryValue: '3770', explanation: '', score: 1 },
          { id: 'rsi', name: 'RSI', category: 'MOMENTUM', bias: 'BUY', primaryValue: '61', explanation: '', score: 0.7 },
        ],
        agreements: [],
        conflicts: [],
        summary: '',
      },
    ],
  });

  // EMA+SMA+ST collapse into 1 trend vote + RSI = 2 total votes (NOT 4!)
  assert.equal(conf.totalVotes, 2);
  assert.equal(conf.buyVotes, 2);
});

test('3. Valid strict BUY & SELL signals generate single TP with >= 1:1.5 R:R and all 11 indicators', () => {
  const indicators = createAutoPerfectIndicators();

  const bull = buildBullishDatasets(3780);
  const resBull = evaluateStrictMultiTimeframeStrategy({
    datasets: bull.datasets,
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'ANALYSIS',
    nowMs: NOW_MS,
  });

  assert.equal(resBull.evaluation.all11Indicators.length, 11);
  assert.equal(resBull.evaluation.trend1H.bias, 'BULLISH');
  assert.equal(resBull.evaluation.structure15M.agreesWith1H, true);
  assert.ok(resBull.evaluation.totalScore >= 75, `Expected score >= 75, got ${resBull.evaluation.totalScore}`);
  assert.equal(resBull.evaluation.action, 'BUY');
  assert.ok(resBull.tradeLevels, 'Trade levels must be generated for BUY');
  assert.equal(resBull.tradeLevels!.takeProfit1, resBull.tradeLevels!.takeProfit2, 'Single TP only');
  assert.ok(resBull.tradeLevels!.takeProfit1 > resBull.tradeLevels!.referencePrice);
  assert.ok(resBull.tradeLevels!.stopLoss < resBull.tradeLevels!.referencePrice);

  const bear = buildBearishDatasets(3780);
  const resBear = evaluateStrictMultiTimeframeStrategy({
    datasets: bear.datasets,
    quote: bear.quote,
    indicatorConfigs: indicators,
    mode: 'ANALYSIS',
    nowMs: NOW_MS,
  });

  assert.equal(resBear.evaluation.trend1H.bias, 'BEARISH');
  assert.equal(resBear.evaluation.action, 'SELL');
  assert.ok(resBear.tradeLevels);
  assert.equal(resBear.tradeLevels!.takeProfit1, resBear.tradeLevels!.takeProfit2, 'Single TP only');
  assert.ok(resBear.tradeLevels!.takeProfit1 < resBear.tradeLevels!.referencePrice);
  assert.ok(resBear.tradeLevels!.stopLoss > resBear.tradeLevels!.referencePrice);
});

test('4. Timeframe disagreement (1H Bullish vs 15m Bearish) strictly blocks BUY/SELL', () => {
  const bull = buildBullishDatasets(3780);
  const bear15m = makeTrendCandles({
    count: 220,
    tfSeconds: 900,
    startPrice: 3820,
    step: -0.25,
    mode: 'STRUCTURE_15M',
    bullish: false,
  });
  bull.datasets.tf15m = makeDataset('15m', bear15m);

  const res = evaluateStrictMultiTimeframeStrategy({
    datasets: bull.datasets,
    quote: bull.quote,
    mode: 'ANALYSIS',
    nowMs: NOW_MS,
  });

  assert.equal(res.evaluation.trend1H.bias, 'BULLISH');
  assert.equal(res.evaluation.structure15M.agreesWith1H, false);
  assert.notEqual(res.evaluation.action, 'BUY');
  assert.notEqual(res.evaluation.action, 'SELL');
  assert.equal(res.tradeLevels, undefined);
});

test('5. Unfinished trailing 1m candle is excluded and never confirms entry', () => {
  const bull = buildBullishDatasets(3780);
  // Make the last CLOSED 1m candle bearish (fails 1m confirmation),
  // then append an UNFINISHED bullish forming candle at NOW_SEC - 10
  const closedSet = bull.datasets.tf1m.candles;
  const lastClosed = closedSet[closedSet.length - 1];
  lastClosed.close = Number((lastClosed.open - 2.2).toFixed(2));
  lastClosed.low = Math.min(lastClosed.low, lastClosed.close - 0.3);

  const formingUnfinished: Candle = {
    time: NOW_SEC - 10, // time + 60 > NOW_SEC -> unfinished!
    open: lastClosed.close,
    high: lastClosed.close + 5,
    low: lastClosed.close - 0.2,
    close: lastClosed.close + 4.5,
    volume: 99_000,
  };
  bull.datasets.tf1m.candles = [...closedSet, formingUnfinished];

  const sliced = sliceClosedCandles(bull.datasets.tf1m.candles, '1m', NOW_SEC);
  assert.equal(sliced.droppedUnfinished, true);
  assert.equal(sliced.closed[sliced.closed.length - 1].time, lastClosed.time);

  const res = evaluateStrictMultiTimeframeStrategy({
    datasets: bull.datasets,
    quote: bull.quote,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.equal(res.evaluation.confirmation1M.confirmed, false);
  assert.notEqual(res.evaluation.action, 'BUY');
});

test('6. Feed integrity rejects stale candles, OHLC corruption, abnormal spread & futures/spot basis divergence', () => {
  const bull = buildBullishDatasets(3780);

  // Stale quote
  const staleRes = evaluateStrictMultiTimeframeStrategy({
    datasets: bull.datasets,
    quote: makeQuote(3780, 0.6, 'DELAYED'),
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.equal(staleRes.evaluation.feedIntegrity.valid, false);
  assert.equal(staleRes.evaluation.action, 'NO TRADE');
  assert.ok(staleRes.evaluation.blockers[0].startsWith('DATA UNAVAILABLE'));

  // Corrupted OHLC candle (high < low)
  const badOhlc = buildBullishDatasets(3780);
  badOhlc.datasets.tf5m.candles[100].high = badOhlc.datasets.tf5m.candles[100].low - 1;
  const ohlcRes = evaluateStrictMultiTimeframeStrategy({
    datasets: badOhlc.datasets,
    quote: badOhlc.quote,
    mode: 'ANALYSIS',
    nowMs: NOW_MS,
  });
  assert.equal(ohlcRes.evaluation.feedIntegrity.valid, false);
  assert.equal(ohlcRes.evaluation.action, 'NO TRADE');

  // Abnormal spread ($5.00 > $2.50 threshold)
  const wideSpreadRes = evaluateStrictMultiTimeframeStrategy({
    datasets: bull.datasets,
    quote: makeQuote(bull.quote.mid, 5.0, 'LIVE'),
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.equal(wideSpreadRes.evaluation.feedIntegrity.spreadAcceptable, false);
  assert.equal(wideSpreadRes.evaluation.action, 'NO TRADE');

  // Futures/Spot basis divergence > 1.5%
  const basisDiv = buildBullishDatasets(3780);
  basisDiv.datasets.tf1m.candleSource = 'Yahoo Finance COMEX Gold (GC=F)';
  basisDiv.quote = makeQuote(3600, 0.6, 'LIVE'); // ~5% basis gap!
  const basisRes = evaluateStrictMultiTimeframeStrategy({
    datasets: basisDiv.datasets,
    quote: basisDiv.quote,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.equal(basisRes.evaluation.feedIntegrity.valid, false);
  assert.equal(basisRes.evaluation.action, 'NO TRADE');
});

test('7. Tick and Candle TP/SL outcome detection including AMBIGUOUS same-candle hits', () => {
  // BUY tick hits
  assert.equal(evaluateTickOutcome('BUY', 3780, 3770, 3798, 3798)?.status, 'TP_HIT');
  assert.equal(evaluateTickOutcome('BUY', 3780, 3770, 3798, 3770)?.status, 'SL_HIT');
  assert.equal(evaluateTickOutcome('BUY', 3780, 3770, 3798, 3785), null);

  // SELL tick hits
  assert.equal(evaluateTickOutcome('SELL', 3780, 3790, 3762, 3762)?.status, 'TP_HIT');
  assert.equal(evaluateTickOutcome('SELL', 3780, 3790, 3762, 3790)?.status, 'SL_HIT');

  // OHLC single-candle AMBIGUOUS when both TP & SL crossed in same candle
  const ambiguousBar: Candle = {
    time: NOW_SEC,
    open: 3780,
    high: 3802,
    low: 3760,
    close: 3782,
    volume: 1000,
  };
  assert.equal(
    evaluateCandleOutcome('BUY', 3780, 3770, 3798, [ambiguousBar])?.status,
    'AMBIGUOUS'
  );
  assert.equal(
    evaluateCandleOutcome('SELL', 3780, 3790, 3762, [ambiguousBar])?.status,
    'AMBIGUOUS'
  );
});

test('8. SURE persistent one-active-signal lock, immutability & history stats (excluding ACTIVE & AMBIGUOUS)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leaders-sure-test-'));
  const storePath = path.join(tmpDir, 'sure-signals.json');
  setSureSignalsStoreFile(storePath);

  try {
    const baseLevels = {
      referencePrice: 3780,
      atrValue: 2.5,
      referenceTimeframe: '5m' as const,
      stopLoss: 3770,
      takeProfit1: 3798,
      takeProfit2: 3798,
      riskPoints: 10,
      rewardRiskRatio1: '1 : 1.80',
      rewardRiskRatio2: '1 : 1.80',
      methodology: 'test',
    };

    const sig1: SureSignalEntry = {
      id: 'sig-1',
      createdAt: new Date(NOW_MS - 600_000).toISOString(),
      direction: 'BUY',
      spotPrice: 3780,
      confidencePct: 92,
      combinedScore: 0.92,
      setupScore: 92,
      scoreCategory: 'STRONG SIGNAL',
      adxValue: 29,
      timeframes: ['1m', '5m', '15m', '1H'],
      tradeLevels: baseLevels,
      riskRewardRatio: '1 : 1.80',
      summary: 'test 1',
      checks: [],
      status: 'ACTIVE',
    };

    const sig2Duplicate: SureSignalEntry = {
      ...sig1,
      id: 'sig-2-dup',
      createdAt: new Date(NOW_MS - 500_000).toISOString(),
    };

    // Race two concurrent saves: only ONE ACTIVE trade must be permitted!
    const [r1, r2] = await Promise.all([saveSureSignal(sig1), saveSureSignal(sig2Duplicate)]);
    assert.ok(r1.saved !== r2.saved, 'Exactly one concurrent ACTIVE save should succeed');
    const activeId = r1.saved ? sig1.id : sig2Duplicate.id;

    // Close active signal to TP_HIT
    const closed = await updateSureSignal(activeId, {
      status: 'TP_HIT',
      closedAt: new Date(NOW_MS - 400_000).toISOString(),
      closePrice: 3798,
      pnlPoints: 18,
      durationMs: 200_000,
    });
    assert.equal(closed?.status, 'TP_HIT');

    // Attempt silent modification of completed signal -> must remain immutable TP_HIT!
    const overwriteAttempt = await updateSureSignal(activeId, { status: 'SL_HIT', pnlPoints: -10 });
    assert.equal(overwriteAttempt?.status, 'TP_HIT');
    assert.equal(overwriteAttempt?.pnlPoints, 18);

    // Save SL_HIT, AMBIGUOUS, and ACTIVE records to test statistics accuracy
    await saveSureSignal({
      ...sig1,
      id: 'sig-sl',
      createdAt: new Date(NOW_MS - 300_000).toISOString(),
      status: 'SL_HIT',
      closedAt: new Date(NOW_MS - 200_000).toISOString(),
      closePrice: 3770,
      pnlPoints: -10,
      durationMs: 100_000,
    });
    await saveSureSignal({
      ...sig1,
      id: 'sig-amb',
      createdAt: new Date(NOW_MS - 150_000).toISOString(),
      status: 'AMBIGUOUS',
      closedAt: new Date(NOW_MS - 100_000).toISOString(),
      closePrice: 3781,
      pnlPoints: 0,
      durationMs: 50_000,
    });
    await saveSureSignal({
      ...sig1,
      id: 'sig-active',
      createdAt: new Date(NOW_MS - 30_000).toISOString(),
      status: 'ACTIVE',
    });

    const loaded = await listSureSignals();
    assert.equal(loaded.length, 4);

    const stats = computeSureHistoryStats(loaded);
    assert.equal(stats.totalSignals, 3, 'Completed count excludes ACTIVE');
    assert.equal(stats.tpHits, 1);
    assert.equal(stats.slHits, 1);
    assert.equal(stats.ambiguousOutcomes, 1);
    assert.equal(stats.activeSignals, 1);
    assert.equal(stats.winRatePct, 50, 'Win rate 1/(1+1) = 50% excluding ACTIVE and AMBIGUOUS');
    assert.equal(stats.avgRiskReward, 1.8);
    assert.equal(stats.avgDurationMs, Math.round((200_000 + 100_000 + 50_000) / 3));
  } finally {
    setSureSignalsStoreFile(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('9. SURE Auto Scanner enforces stricter >= 90/100 threshold & rejects sub-90 ANALYSIS setups', () => {
  const indicators = createAutoPerfectIndicators();
  const bull = buildBullishDatasets(3780);

  const surePass = evaluateStrictMultiTimeframeStrategy({
    datasets: bull.datasets,
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.ok(surePass.evaluation.totalScore >= 90, `Expected SURE score >= 90, got ${surePass.evaluation.totalScore}`);
  assert.equal(surePass.evaluation.action, 'BUY');
  assert.equal(surePass.evaluation.scoreCategory, 'STRONG SIGNAL');
  assert.ok(surePass.tradeLevels);
  assert.equal(surePass.tradeLevels!.takeProfit1, surePass.tradeLevels!.takeProfit2);

  // Degrade 5m setup by removing the liquidity sweep wick -> ANALYSIS can still pass if retest/score >= 75,
  // but SURE must strictly block it!
  const noSweep5m = makeTrendCandles({
    count: 220,
    tfSeconds: 300,
    startPrice: 3752,
    step: 0.12,
    mode: 'TREND',
    bullish: true,
  });
  const weakBull = buildBullishDatasets(3780);
  weakBull.datasets.tf5m = makeDataset('5m', noSweep5m);

  const sureBlocked = evaluateStrictMultiTimeframeStrategy({
    datasets: weakBull.datasets,
    quote: weakBull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.notEqual(sureBlocked.evaluation.action, 'BUY');
  assert.equal(sureBlocked.tradeLevels, undefined);
});

test('10. Notification reconciler detects NEW signals, TP/SL/AMBIGUOUS transitions & reconnect catch-up without old-history spam', () => {
  const baseLevels = {
    referencePrice: 3780,
    atrValue: 2.5,
    referenceTimeframe: '5m' as const,
    stopLoss: 3770,
    takeProfit1: 3798,
    takeProfit2: 3798,
    riskPoints: 10,
    rewardRiskRatio1: '1 : 1.80',
    rewardRiskRatio2: '1 : 1.80',
    methodology: 'test',
  };

  const makeEntry = (
    id: string,
    status: SureSignalStatus,
    createdOffsetMs: number,
    closedOffsetMs?: number
  ): SureSignalEntry => ({
    id,
    createdAt: new Date(NOW_MS - createdOffsetMs).toISOString(),
    direction: 'BUY',
    spotPrice: 3780,
    confidencePct: 93,
    combinedScore: 0.93,
    setupScore: 93,
    scoreCategory: 'STRONG SIGNAL',
    adxValue: 28,
    timeframes: ['1m', '5m', '15m', '1H'],
    tradeLevels: baseLevels,
    riskRewardRatio: '1 : 1.80',
    summary: 'test',
    checks: [],
    status,
    closedAt: closedOffsetMs != null ? new Date(NOW_MS - closedOffsetMs).toISOString() : undefined,
    closePrice: status === 'TP_HIT' ? 3798 : status === 'SL_HIT' ? 3770 : status === 'AMBIGUOUS' ? 3782 : undefined,
    pnlPoints: status === 'TP_HIT' ? 18 : status === 'SL_HIT' ? -10 : 0,
  });

  const makeStatus = (activeSignal: SureSignalEntry | null, history: SureSignalEntry[]): SureSignalScanStatus => ({
    scanning: false,
    tradeLocked: Boolean(activeSignal && activeSignal.status === 'ACTIVE'),
    lastScannedAt: new Date(NOW_MS).toISOString(),
    nextScanAt: new Date(NOW_MS + 60_000).toISOString(),
    scanIntervalMs: 60_000,
    monitoringMode: 'REALTIME_SPOT_BBO',
    marketState: activeSignal?.status === 'ACTIVE' ? 'SURE_BUY' : 'NO_SURE_SIGNAL',
    latestPrice: 3780,
    latestConfidencePct: 93,
    latestScore: 0.93,
    latestSetupScore: 93,
    latestAdx: 28,
    reason: 'test',
    checks: [],
    activeSignal,
    history,
    stats: computeSureHistoryStats(history),
  });

  // 1. Cold boot with old 2-hour-closed trade -> must NOT spam old completed history
  const oldClosed = makeEntry('old-1', 'TP_HIT', 7_200_000, 6_000_000);
  const seen = new Set<string>();
  const r1 = reconcileSureStatusTransitions({
    nextStatus: makeStatus(oldClosed, [oldClosed]),
    prevStatuses: new Map(),
    hasHydratedBaseline: false,
    persistedSeenKeys: seen,
    nowMs: NOW_MS,
  });
  assert.equal(r1.events.length, 0);

  // 2. Live scan emits new ACTIVE signal (discovered even without explicitNewSignal via sure_status / poll)
  const activeSig = makeEntry('sig-live-1', 'ACTIVE', 5_000);
  const r2 = reconcileSureStatusTransitions({
    nextStatus: makeStatus(activeSig, [activeSig, oldClosed]),
    prevStatuses: r1.nextStatuses,
    hasHydratedBaseline: true,
    persistedSeenKeys: seen,
    nowMs: NOW_MS,
  });
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].kind, 'NEW');
  assert.equal(r2.events[0].entry.id, 'sig-live-1');
  r2.newlySeenKeys.forEach((k) => seen.add(k));

  // 3. Same ACTIVE signal polled again -> deduplicated, zero repeat events
  const r3 = reconcileSureStatusTransitions({
    nextStatus: makeStatus(activeSig, [activeSig, oldClosed]),
    prevStatuses: r2.nextStatuses,
    hasHydratedBaseline: true,
    persistedSeenKeys: seen,
    nowMs: NOW_MS + 10_000,
  });
  assert.equal(r3.events.length, 0);

  // 4. First signal hits SL AND a new ACTIVE signal replaces activeSignal spotlight before next poll!
  const closedSl = makeEntry('sig-live-1', 'SL_HIT', 120_000, 15_000);
  const activeSig2 = makeEntry('sig-live-2', 'ACTIVE', 2_000);
  const r4 = reconcileSureStatusTransitions({
    nextStatus: makeStatus(activeSig2, [activeSig2, closedSl, oldClosed]),
    prevStatuses: r3.nextStatuses,
    hasHydratedBaseline: true,
    persistedSeenKeys: seen,
    nowMs: NOW_MS + 120_000,
  });
  assert.equal(r4.events.length, 2);
  assert.ok(r4.events.some((e) => e.kind === 'SL_HIT' && e.entry.id === 'sig-live-1'));
  assert.ok(r4.events.some((e) => e.kind === 'NEW' && e.entry.id === 'sig-live-2'));
});

test('11. SURE blocks overextended/exhausted chasing entries & anchors SL past 5m sweep structure', () => {
  const indicators = createAutoPerfectIndicators();

  // Baseline valid SURE BUY signal must anchor SL below swept 5m low with >= 1.15x ATR cushion
  const bull = buildBullishDatasets(3780);
  const validSure = evaluateStrictMultiTimeframeStrategy({
    datasets: bull.datasets,
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.equal(validSure.evaluation.action, 'BUY');
  assert.ok(validSure.tradeLevels);
  assert.ok(
    validSure.tradeLevels!.riskPoints >= validSure.tradeLevels!.atrValue * 1.15,
    `Expected SURE SL distance >= 1.15x ATR, got risk=${validSure.tradeLevels!.riskPoints} vs atr=${validSure.tradeLevels!.atrValue}`
  );

  // Extended chasing scenario: live Spot price spikes far away (>2.5x ATR above 5m EMA21) after the sweep
  const chasedBull = buildBullishDatasets(3780);
  const atr5mApprox = validSure.tradeLevels!.atrValue;
  const chasedSpot = Number((chasedBull.quote.mid + atr5mApprox * 3.2).toFixed(2));
  const blockedChase = evaluateStrictMultiTimeframeStrategy({
    datasets: chasedBull.datasets,
    quote: makeQuote(chasedSpot, 0.6, 'LIVE'),
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.notEqual(blockedChase.evaluation.action, 'BUY', 'SURE must reject chasing extended price > 1.65x ATR from 5m EMA21');
  assert.equal(blockedChase.tradeLevels, undefined);

  // Oversold chasing scenario on BEARISH setup: 15m/5m pushed too deep (RSI exhaustion bounce risk)
  const bear = buildBearishDatasets(3780);
  const exhaustedSpot = Number((bear.quote.mid - atr5mApprox * 3.0).toFixed(2));
  const blockedBearChase = evaluateStrictMultiTimeframeStrategy({
    datasets: bear.datasets,
    quote: makeQuote(exhaustedSpot, 0.6, 'LIVE'),
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.notEqual(blockedBearChase.evaluation.action, 'SELL', 'SURE must reject oversold SELL chasing into bounce zone');
  assert.equal(blockedBearChase.tradeLevels, undefined);
});

test('12. Mixed Spot (1m/5m) + GC=F Futures (15m/1H) translates 15m/1H levels accurately to Spot scale', () => {
  const indicators = createAutoPerfectIndicators();
  const bull = buildBullishDatasets(3780);
  const BASIS_OFFSET = 25;

  const shiftCandles = (candles: Candle[], offset: number): Candle[] =>
    candles.map((c) => ({
      ...c,
      open: Number((c.open + offset).toFixed(2)),
      high: Number((c.high + offset).toFixed(2)),
      low: Number((c.low + offset).toFixed(2)),
      close: Number((c.close + offset).toFixed(2)),
    }));

  bull.datasets.tf1H = makeDataset(
    '1H',
    shiftCandles(bull.datasets.tf1H.candles, BASIS_OFFSET),
    'Yahoo Finance COMEX Gold (GC=F)'
  );
  bull.datasets.tf15m = makeDataset(
    '15m',
    shiftCandles(bull.datasets.tf15m.candles, BASIS_OFFSET),
    'Yahoo Finance COMEX Gold (GC=F)'
  );

  const unshiftedRes = evaluateStrictMultiTimeframeStrategy({
    datasets: buildBullishDatasets(3780).datasets,
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  const mixedRes = evaluateStrictMultiTimeframeStrategy({
    datasets: bull.datasets,
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.equal(mixedRes.evaluation.feedIntegrity.valid, true);
  assert.ok(
    mixedRes.evaluation.feedIntegrity.basisDiffUsd != null &&
      mixedRes.evaluation.feedIntegrity.basisDiffUsd >= 15 &&
      mixedRes.evaluation.feedIntegrity.basisDiffUsd <= 30,
    `Expected positive futures basis near +$${BASIS_OFFSET} (never ~0), got ${mixedRes.evaluation.feedIntegrity.basisDiffUsd}`
  );
  assert.equal(mixedRes.evaluation.action, 'BUY');
  assert.ok(mixedRes.evaluation.structure15M.lastSwingLow != null);
  assert.ok(unshiftedRes.evaluation.structure15M.lastSwingLow != null);
  assert.ok(
    Math.abs(mixedRes.evaluation.structure15M.lastSwingLow! - unshiftedRes.evaluation.structure15M.lastSwingLow!) < 8,
    `Expected translated 15m swing low (${mixedRes.evaluation.structure15M.lastSwingLow}) to match Spot swing low (${unshiftedRes.evaluation.structure15M.lastSwingLow}) instead of staying +$${BASIS_OFFSET} higher`
  );
});

test('13. 1H fast EMA (9>21) + Supertrend reversal unlocks Gate 2 while slow EMA50/SMA50 still lag after a drop', () => {
  const indicators = createAutoPerfectIndicators();
  const bull = buildBullishDatasets(3617);

  // Simulate prior multi-day drop (bars 0..175 falling from ~3750 -> ~3540) followed by
  // strong bullish recovery (bars 176..219 climbing to ~3617) so EMA9 > EMA21 & ST=+1
  // while EMA21 and SMA20 still sit below slow EMA50/SMA50.
  const reversal1H: Candle[] = [];
  const startTime = NOW_SEC - 220 * 3600;
  let price = 3745;
  for (let i = 0; i < 220; i++) {
    const t = startTime + i * 3600;
    const delta = i < 170 ? -0.45 : i < 205 ? -4.2 : 3.1;
    const open = Number(price.toFixed(2));
    const close = Number((price + delta).toFixed(2));
    const high = Number((Math.max(open, close) + 1.1).toFixed(2));
    const low = Number((Math.min(open, close) - 1.1).toFixed(2));
    reversal1H.push({ time: t, open, high, low, close, volume: 2_500 });
    price = close;
  }

  const resReversal = evaluateStrictMultiTimeframeStrategy({
    datasets: {
      ...bull.datasets,
      tf1H: makeDataset('1H', reversal1H),
    },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.equal(resReversal.evaluation.trend1H.bias, 'BULLISH');
  assert.equal(resReversal.evaluation.trend1H.supertrendDir, 'BULLISH');
  assert.equal(resReversal.evaluation.mandatoryGates[1].passed, true);
  assert.equal(resReversal.evaluation.trend1H.emaAlignment, 'Price > EMA9 > EMA21 (Bullish)');

  // Counter-check: if 1H pulls back below EMA9 while slow EMA50 still sits above EMA21, Gate 2 must stay NEUTRAL
  const broken1H = reversal1H.map((c) => ({ ...c }));
  for (let i = 217; i < broken1H.length; i++) {
    const prevClose = broken1H[i - 1].close;
    const close = Number((prevClose - 6.0).toFixed(2));
    broken1H[i] = {
      time: broken1H[i].time,
      open: prevClose,
      high: Number((prevClose + 0.5).toFixed(2)),
      low: Number((close - 0.8).toFixed(2)),
      close,
      volume: 3_000,
    };
  }
  const resNeutral = evaluateStrictMultiTimeframeStrategy({
    datasets: {
      ...bull.datasets,
      tf1H: makeDataset('1H', broken1H),
    },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.equal(resNeutral.evaluation.trend1H.bias, 'NEUTRAL');
  assert.equal(resNeutral.evaluation.mandatoryGates[1].passed, false);
});

test('14. SURE blocks Friday pre-weekend (>= 18:30 UTC) and rollover illiquidity while ANALYSIS stays available', () => {
  const indicators = createAutoPerfectIndicators();

  // Friday 2025-10-10T19:00:00Z -> pre-weekend gap risk window
  const fridayLateSec = Math.floor(Date.UTC(2025, 9, 10, 19, 0, 0) / 1000);
  const fridayLateMs = fridayLateSec * 1000;

  const makeAtNow = (tfSec: number, start: number, step: number, mode: 'TREND' | 'STRUCTURE_15M' | 'SETUP_5M' | 'CONFIRM_1M') =>
    makeTrendCandles({ count: 220, tfSeconds: tfSec, startPrice: start, step, endSec: fridayLateSec - tfSec, mode, bullish: true });

  const c1H = makeAtNow(3600, 3688, 0.42, 'TREND');
  const c15m = makeAtNow(900, 3734, 0.24, 'STRUCTURE_15M');
  const c5m = makeAtNow(300, 3752, 0.12, 'SETUP_5M');
  const c1m = makeAtNow(60, 3768, 0.05, 'CONFIRM_1M');
  const quoteFriday: MarketQuote = {
    symbol: 'XAU/USD',
    bid: Number((c1m[c1m.length - 1].close - 0.15).toFixed(3)),
    ask: Number((c1m[c1m.length - 1].close + 0.45).toFixed(3)),
    mid: Number((c1m[c1m.length - 1].close + 0.15).toFixed(3)),
    spread: 0.6,
    timestamp: fridayLateMs - 1_500,
    freshness: 'LIVE',
    source: 'Swissquote Spot XAU/USD BBO',
  };
  const datasets = {
    tf1H: makeDataset('1H', c1H),
    tf15m: makeDataset('15m', c15m),
    tf5m: makeDataset('5m', c5m),
    tf1m: makeDataset('1m', c1m),
  };

  const sureBlocked = evaluateStrictMultiTimeframeStrategy({
    datasets,
    quote: quoteFriday,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: fridayLateMs,
  });
  assert.notEqual(sureBlocked.evaluation.action, 'BUY');
  assert.equal(sureBlocked.tradeLevels, undefined);
  assert.equal(sureBlocked.evaluation.mandatoryGates[6].passed, false);
  assert.ok(sureBlocked.evaluation.mandatoryGates[6].detail.includes('Pre-weekend risk window'));

  // ANALYSIS mode remains unblocked for chart review
  const analysisAllowed = evaluateStrictMultiTimeframeStrategy({
    datasets,
    quote: quoteFriday,
    indicatorConfigs: indicators,
    mode: 'ANALYSIS',
    nowMs: fridayLateMs,
  });
  assert.equal(analysisAllowed.evaluation.action, 'BUY');
});

test('15. SURE rejects 1H climax exhaustion (>3.8x ATR from EMA21) and opposing 1m rejection wicks', () => {
  const indicators = createAutoPerfectIndicators();

  // Case A: 1H climax exhaustion (price rockets far >3.8x ATR above 1H EMA21)
  const bull = buildBullishDatasets(3780);
  const climax1H = bull.datasets.tf1H.candles.map((c, idx) => {
    if (idx < 214) return c;
    const prev = idx === 214 ? bull.datasets.tf1H.candles[213].close : bull.datasets.tf1H.candles[213].close + (idx - 213) * 18;
    const close = Number((prev + 18).toFixed(2));
    return { ...c, open: prev, high: Number((close + 0.5).toFixed(2)), low: Number((prev - 0.5).toFixed(2)), close };
  });
  // Ensure monotonically contiguous close sequence
  for (let i = 214; i < climax1H.length; i++) {
    const p = climax1H[i - 1].close;
    const c = Number((p + 18).toFixed(2));
    climax1H[i] = { ...climax1H[i], open: p, high: c + 0.5, low: p - 0.3, close: c };
  }
  const resClimax = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bull.datasets, tf1H: makeDataset('1H', climax1H) },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.notEqual(resClimax.evaluation.action, 'BUY');
  assert.equal(resClimax.evaluation.mandatoryGates[5].passed, false);
  assert.ok(resClimax.evaluation.mandatoryGates[5].detail.includes('climax exhaustion'));

  // Case B: Last closed 1m candle has a massive upper rejection wick (>50% of bar) -> Gate 5 blocks BUY
  const wickedBull = buildBullishDatasets(3780);
  const last1m = wickedBull.datasets.tf1m.candles[wickedBull.datasets.tf1m.candles.length - 1];
  last1m.high = Number((last1m.close + (last1m.close - last1m.open) * 2.5).toFixed(2));
  const resWick = evaluateStrictMultiTimeframeStrategy({
    datasets: wickedBull.datasets,
    quote: wickedBull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.equal(resWick.evaluation.confirmation1M.confirmed, false);
  assert.notEqual(resWick.evaluation.action, 'BUY');
});

test('16. 15M structure never emits contradictory BOS:BULLISH + CHoCH:BEARISH or false BEARISH BOS after strong rebound above swing low', () => {
  const indicators = createAutoPerfectIndicators();
  const bull = buildBullishDatasets(3780);
  const c15m = bull.datasets.tf15m.candles.map((c) => ({ ...c }));
  const n = c15m.length;

  // Create two swing lows where the second dipped $0.50 below the first ~20 bars ago,
  // then a swing high and a lower high followed by strong bullish rebound near upper range
  // (mimicking today's 3599.9 < 3600.29 dip followed by +22pt recovery above EMA20>EMA50)
  const baseClose = c15m[n - 35].close;
  // Earlier swing high
  for (let i = n - 34; i <= n - 28; i++) {
    const step = i <= n - 31 ? (i - (n - 34)) * 3.0 : (n - 28 - i) * 3.0;
    const p = Number((baseClose + step).toFixed(2));
    c15m[i] = { ...c15m[i], open: p - 0.5, high: p + 1.2, low: p - 1.0, close: p };
  }
  // Prev swing low around baseClose - 12
  for (let i = n - 27; i <= n - 21; i++) {
    const dip = i === n - 24 ? 12.0 : Math.max(2, 12.0 - Math.abs(i - (n - 24)) * 2.5);
    const p = Number((baseClose - dip).toFixed(2));
    c15m[i] = { ...c15m[i], open: p + 0.5, high: p + 1.0, low: i === n - 24 ? p - 0.5 : p - 0.2, close: p };
  }
  // Minor high then second swing low slightly deeper (-12.8)
  for (let i = n - 20; i <= n - 12; i++) {
    const dip = i === n - 15 ? 12.8 : i < n - 15 ? (i - (n - 20)) * 2.0 : 12.8 - (i - (n - 15)) * 4.0;
    const p = Number((baseClose - dip).toFixed(2));
    c15m[i] = { ...c15m[i], open: p + 0.3, high: p + 1.0, low: i === n - 15 ? p - 0.8 : p - 0.2, close: p };
  }
  // Strong rebound back into upper range (EMA20 > EMA50, well above lastSwingLow)
  for (let i = n - 11; i < n; i++) {
    const prev = c15m[i - 1].close;
    const close = Number((prev + 1.6).toFixed(2));
    c15m[i] = { ...c15m[i], open: prev, high: Number((close + 0.6).toFixed(2)), low: Number((prev - 0.4).toFixed(2)), close };
  }

  const res = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bull.datasets, tf15m: makeDataset('15m', c15m) },
    quote: {
      ...bull.quote,
      bid: Number((c15m[n - 1].close - 0.2).toFixed(3)),
      ask: Number((c15m[n - 1].close + 0.4).toFixed(3)),
      mid: Number((c15m[n - 1].close + 0.1).toFixed(3)),
    },
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.equal(res.evaluation.structure15M.direction, 'BULLISH');
  assert.notEqual(res.evaluation.structure15M.chochDetected, 'BEARISH');
  assert.equal(res.evaluation.structure15M.agreesWith1H, true);
  assert.equal(res.evaluation.mandatoryGates[2].passed, true);
});

test('17. Live 11-indicator price levels translate GC=F futures basis to Spot scale and Gate 6 reports exact failure details', () => {
  const indicators = createAutoPerfectIndicators();
  const bull = buildBullishDatasets(3780);
  const basisShift = 20; // COMEX GC=F trades +$20 over Spot XAU/USD

  const shiftCandles = (arr: Candle[]): Candle[] =>
    arr.map((c) => ({
      ...c,
      open: Number((c.open + basisShift).toFixed(2)),
      high: Number((c.high + basisShift).toFixed(2)),
      low: Number((c.low + basisShift).toFixed(2)),
      close: Number((c.close + basisShift).toFixed(2)),
    }));

  // Force low volume on 5M/1M futures bars so Gate 6 fails specifically on volume
  const c5mFutures = shiftCandles(bull.datasets.tf5m.candles);
  c5mFutures[c5mFutures.length - 1].volume = 50;
  const c1mFutures = shiftCandles(bull.datasets.tf1m.candles);
  c1mFutures[c1mFutures.length - 1].volume = 50;

  const res = evaluateStrictMultiTimeframeStrategy({
    datasets: {
      tf1H: makeDataset('1H', shiftCandles(bull.datasets.tf1H.candles), 'Yahoo Finance COMEX Gold (GC=F)'),
      tf15m: makeDataset('15m', shiftCandles(bull.datasets.tf15m.candles), 'Yahoo Finance COMEX Gold (GC=F)'),
      tf5m: makeDataset('5m', c5mFutures, 'Yahoo Finance COMEX Gold (GC=F)'),
      tf1m: makeDataset('1m', c1mFutures, 'Yahoo Finance COMEX Gold (GC=F)'),
    },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  const emaInd = res.evaluation.all11Indicators.find((i) => i.id === 'ema');
  assert.ok(emaInd, 'EMA indicator must be present');
  const ema21Spot = Number(emaInd.primaryValue.replace(/[^0-9.-]/g, ''));
  assert.ok(
    Math.abs(ema21Spot - bull.quote.mid) < 12,
    `EMA21 ($${ema21Spot}) should be translated to Spot scale near $${bull.quote.mid}, not futures scale (+$${basisShift})`
  );

  const gate6 = res.evaluation.mandatoryGates[5];
  assert.equal(gate6.passed, false);
  assert.ok(gate6.detail.includes('low volume'), `Gate 6 detail should name specific volume block, got: ${gate6.detail}`);
});

test('18. Gate 7 ignores minor 15M / swept 1H wicks while still blocking genuine untouched 1H macro walls', () => {
  const indicators = createAutoPerfectIndicators();
  const bull = buildBullishDatasets(3780);
  const price = bull.quote.mid;

  // Inject an old minor 15M fractal high ~$4 above entry (would falsely trip old 15M blockingWall),
  // plus a swept 1H pivot (~$5 above) that was later exceeded -> Gate 7 must still allow BUY!
  const c15m = bull.datasets.tf15m.candles.map((c) => ({ ...c }));
  const m = c15m.length;
  c15m[m - 12] = { ...c15m[m - 12], high: Number((price + 4.2).toFixed(2)) };

  const resAllowed = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bull.datasets, tf15m: makeDataset('15m', c15m) },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.equal(resAllowed.evaluation.action, 'BUY', `Minor 15M wick must not block A+ BUY; blockers: ${resAllowed.evaluation.blockers.join(' | ')}`);
  assert.equal(resAllowed.evaluation.mandatoryGates[6].passed, true);
  assert.ok(
    resAllowed.tradeLevels!.riskPoints >= resAllowed.tradeLevels!.atrValue * 1.64,
    'SURE stop distance must respect 1.65x ATR noise buffer'
  );

  // Now place an untouched major 1H macro swing ceiling (leftRight=3) just ~$4 above current entry
  const c1H = bull.datasets.tf1H.candles.map((c) => ({ ...c }));
  const hLen = c1H.length;
  const macroWall = Number((price + 4.5).toFixed(2));
  for (let i = hLen - 8; i <= hLen - 2; i++) {
    const dist = Math.abs(i - (hLen - 5));
    const barHigh = dist === 0 ? macroWall : Number((price + 2.0 - dist * 0.4).toFixed(2));
    c1H[i] = {
      ...c1H[i],
      high: Math.max(barHigh, c1H[i].open, c1H[i].close),
    };
  }
  c1H[hLen - 1] = {
    ...c1H[hLen - 1],
    high: Math.max(Number((price + 2.2).toFixed(2)), c1H[hLen - 1].open, c1H[hLen - 1].close),
  };

  const resBlocked = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bull.datasets, tf1H: makeDataset('1H', c1H), tf15m: makeDataset('15m', c15m) },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.equal(resBlocked.evaluation.mandatoryGates[0].passed, true, 'Feed integrity must remain valid');
  assert.equal(resBlocked.evaluation.mandatoryGates[6].passed, false);
  assert.ok(resBlocked.evaluation.mandatoryGates[6].detail.includes('Major 1H resistance'));
  assert.notEqual(resBlocked.evaluation.action, 'BUY');
});

test('19. Recent 1H shooting-star blow-off high blocks late BUY chase within 1.40R even before leftRight=3 pivot forms', () => {
  const indicators = createAutoPerfectIndicators();
  const bull = buildBullishDatasets(3780);
  const price = bull.quote.mid;

  // Turn the latest closed 1H bar (idx = length - 1) into a high-range shooting-star blow-off rejection
  // whose upper wick is > 0.75x ATR(1H) and sits < 1.40R above current BUY entry (~$6 above Spot while 1.4R is ~$12+)
  const c1H = bull.datasets.tf1H.candles.map((c) => ({ ...c }));
  const lastIdx = c1H.length - 1;
  const lastBar = c1H[lastIdx];
  c1H[lastIdx] = {
    ...lastBar,
    low: Number(Math.min(lastBar.low, lastBar.open - 1.5).toFixed(2)),
    high: Number((price + 5.8).toFixed(2)),
  };

  // Scale 5m bar volatility slightly so stop distance exceeds $8 and 1.40R clearance is > $5.8
  const c5m = bull.datasets.tf5m.candles.map((c, idx) => {
    if (idx < bull.datasets.tf5m.candles.length - 20) return c;
    return {
      ...c,
      high: Number((c.high + 2.4).toFixed(2)),
      low: Number((c.low - 2.4).toFixed(2)),
    };
  });

  const resBlocked = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bull.datasets, tf1H: makeDataset('1H', c1H), tf5m: makeDataset('5m', c5m) },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.equal(resBlocked.evaluation.mandatoryGates[0].passed, true, 'Feed integrity must remain valid');
  assert.equal(resBlocked.evaluation.mandatoryGates[6].passed, false);
  assert.ok(
    resBlocked.evaluation.mandatoryGates[6].detail.includes('Major 1H resistance'),
    `Expected fresh 1H shooting-star high to trigger Major 1H resistance block, got: ${resBlocked.evaluation.mandatoryGates[6].detail}`
  );
  assert.notEqual(resBlocked.evaluation.action, 'BUY');
  assert.equal(resBlocked.tradeLevels, undefined);

  // When the blow-off peak is far enough overhead (> 1.40R away) and stopDistance > $8, TP scales to 1.60R instead of 1.80R
  const c1HClean = bull.datasets.tf1H.candles.map((c) => ({ ...c }));
  const resWideAllowed = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bull.datasets, tf1H: makeDataset('1H', c1HClean), tf5m: makeDataset('5m', c5m) },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.equal(resWideAllowed.evaluation.action, 'BUY', `Clean trend with wide stop should BUY; blockers: ${resWideAllowed.evaluation.blockers.join(' | ')}`);
  assert.ok(resWideAllowed.tradeLevels!.riskPoints > 8, 'Expected wide stop > $8');
  const rrActual =
    (resWideAllowed.tradeLevels!.takeProfit1 - resWideAllowed.tradeLevels!.referencePrice) /
    resWideAllowed.tradeLevels!.riskPoints;
  assert.ok(rrActual >= 1.55 && rrActual <= 1.65, `Expected compact ~1.60R TP on wide stop, got ${rrActual.toFixed(2)}R`);
});

test('20. 1H Multi-MA breakdown flips Gate 2 BEARISH despite lagging Supertrend ATR band while SURE rejects oversized chased stops', () => {
  const indicators = createAutoPerfectIndicators();
  const bear = buildBearishDatasets(3630);

  // Build a 1H series that rallies sharply (widening Supertrend band far below) and then reverses down
  // below EMA9 (falling), EMA21, EMA50, and SMA20 with -DI > +DI while Supertrend(10,3) still lags BULLISH
  const rev1H: Candle[] = [];
  const startTime = NOW_SEC - 220 * 3600;
  let price = 3580;
  for (let i = 0; i < 220; i++) {
    const t = startTime + i * 3600;
    let delta = 0.2;
    let wick = 1.1;
    if (i >= 195 && i < 204) {
      delta = 10.5; // Sharp rally spikes ATR(10) and leaves a deep Supertrend floor
      wick = 14.0;
    } else if (i >= 204) {
      delta = -4.2; // Steady sell-off breaking below EMA9/21/50 & SMA20 with -DI > +DI while ST floor sits lower
      wick = 1.2;
    }
    const open = Number(price.toFixed(2));
    const close = Number((price + delta).toFixed(2));
    const high = Number((Math.max(open, close) + wick).toFixed(2));
    const low = Number((Math.min(open, close) - wick).toFixed(2));
    rev1H.push({ time: t, open, high, low, close, volume: 3_500 });
    price = close;
  }

  const resBearRev = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bear.datasets, tf1H: makeDataset('1H', rev1H) },
    quote: bear.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.equal(resBearRev.evaluation.trend1H.bias, 'BEARISH', `Expected 1H Multi-MA breakdown to flip BEARISH, got ${resBearRev.evaluation.trend1H.summary}`);
  assert.equal(resBearRev.evaluation.mandatoryGates[1].passed, true);

  // Counter-check: oversized chased stop (> max($12.50, 2.6x ATR5m)) must be rejected in SURE mode
  const wideStopBull = buildBullishDatasets(3626);
  const c5mWide = wideStopBull.datasets.tf5m.candles.map((c, idx, arr) => {
    // Deep sweep low far below current entry (~$16 away while ATR5m is ~$4.5 -> >3.5x ATR and >$12.50)
    if (idx === arr.length - 4) {
      return { ...c, low: Number((wideStopBull.quote.mid - 16.5).toFixed(2)) };
    }
    if (idx >= arr.length - 12) {
      return { ...c, high: Number((c.high + 2.0).toFixed(2)), low: Number((c.low - 2.0).toFixed(2)) };
    }
    return c;
  });
  const resTooWide = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...wideStopBull.datasets, tf5m: makeDataset('5m', c5mWide) },
    quote: wideStopBull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.notEqual(resTooWide.evaluation.action, 'BUY', 'SURE must reject chased entry whose stop exceeds volatility corridor');
});

test('21. Gate 7 keeps 2-bar-old 1H climax wall active at 1.40R while allowing >=18h aged pivots with >=1.20R room', () => {
  const indicators = createAutoPerfectIndicators();
  const bull = buildBullishDatasets(3780);
  const price = bull.quote.mid;

  // Widen 5m volatility slightly so riskPoints > $8 (1.40R ~ $12, 1.20R ~ $10)
  const c5m = bull.datasets.tf5m.candles.map((c, idx) =>
    idx >= bull.datasets.tf5m.candles.length - 20
      ? { ...c, high: Number((c.high + 2.4).toFixed(2)), low: Number((c.low - 2.4).toFixed(2)) }
      : c
  );

  // Case A: Shooting-star climax high 2 bars before latest closed 1H bar (maxIdx = len - 3) with lower-high inside bars
  const c1HClimaxOld = bull.datasets.tf1H.candles.map((c) => ({ ...c }));
  const hLen = c1HClimaxOld.length;
  const bar3 = c1HClimaxOld[hLen - 3];
  c1HClimaxOld[hLen - 3] = {
    ...bar3,
    low: Number((bar3.open - 1.5).toFixed(2)),
    high: Number((price + 8.5).toFixed(2)), // range > 1.35x ATR, upper wick > 0.75x ATR
  };
  const resClimaxBlocked = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bull.datasets, tf1H: makeDataset('1H', c1HClimaxOld), tf5m: makeDataset('5m', c5m) },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.equal(resClimaxBlocked.evaluation.mandatoryGates[6].passed, false);
  assert.ok(resClimaxBlocked.evaluation.mandatoryGates[6].detail.includes('Major 1H resistance'));

  // Case B: Aged >= 18h leftRight=3 pivot sitting ~1.28R overhead (> 1.20R, < 1.40R) must NOT falsely suffocate BUY
  const baseline = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bull.datasets, tf5m: makeDataset('5m', c5m) },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.ok(baseline.tradeLevels, 'Expected baseline BUY tradeLevels');
  const risk = baseline.tradeLevels!.riskPoints;
  const agedWallPrice = Number((price + risk * 1.28).toFixed(2));
  const c1HAged = bull.datasets.tf1H.candles.map((c, idx) => {
    const pivotIdx = hLen - 25;
    if (idx === pivotIdx) {
      return { ...c, high: agedWallPrice };
    }
    if (idx >= pivotIdx - 3 && idx <= pivotIdx + 3) {
      return { ...c, high: Math.min(c.high, Number((agedWallPrice - 2.0).toFixed(2))) };
    }
    if (idx > pivotIdx + 3) {
      return { ...c, high: Math.min(c.high, Number((agedWallPrice - 1.0).toFixed(2))) };
    }
    return c;
  });
  const resAgedAllowed = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bull.datasets, tf1H: makeDataset('1H', c1HAged), tf5m: makeDataset('5m', c5m) },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.equal(resAgedAllowed.evaluation.mandatoryGates[6].passed, true, `Aged >=18h pivot at 1.28R should not block: ${resAgedAllowed.evaluation.mandatoryGates[6].detail}`);
  assert.equal(resAgedAllowed.evaluation.action, 'BUY');
});

test('22. Transitional 1H NEUTRAL reflects real sub-timeframe setup readiness (35-74) instead of collapsing to 11/100 while blocking SURE entry', () => {
  const indicators = createAutoPerfectIndicators();
  const bull = buildBullishDatasets(3630);

  // Craft a flat/choppy 1H series with ADX < 18 (NEUTRAL) so Gate 2 fails while 15M/5M/1M align BULLISH
  const chop1H: Candle[] = [];
  const startTime = NOW_SEC - 220 * 3600;
  let price = 3630;
  for (let i = 0; i < 220; i++) {
    const t = startTime + i * 3600;
    const step = i % 2 === 0 ? 1.8 : -1.7;
    const open = Number(price.toFixed(2));
    const close = Number((price + step).toFixed(2));
    chop1H.push({
      time: t,
      open,
      high: Number((Math.max(open, close) + 1.5).toFixed(2)),
      low: Number((Math.min(open, close) - 1.5).toFixed(2)),
      close,
      volume: 3_000,
    });
    price = close;
  }

  const res = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bull.datasets, tf1H: makeDataset('1H', chop1H) },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.equal(res.evaluation.trend1H.bias, 'NEUTRAL');
  assert.equal(res.evaluation.mandatoryGates[1].passed, false);
  assert.ok(res.evaluation.action === 'NO TRADE' || res.evaluation.action === 'WAIT');
  assert.ok(
    res.evaluation.totalScore >= 35 && res.evaluation.totalScore <= 74,
    `Expected transitional readiness score between 35 and 74, got ${res.evaluation.totalScore}`
  );
});

test('23. 15M structure direction switches immediately to BEARISH on BEARISH CHoCH/BOS even if prior swings had HH/HL', () => {
  const indicators = createAutoPerfectIndicators();
  const bull = buildBullishDatasets(3650);
  const c15m = bull.datasets.tf15m.candles.map((c) => ({ ...c }));
  const n = c15m.length;
  const base = c15m[n - 35].close;

  // Build explicit HH + HL swings then dump below lastSwingLow at the tail
  for (let i = n - 34; i <= n - 26; i++) {
    const step = i <= n - 30 ? -(i - (n - 34)) * 2.5 : -10 + (i - (n - 30)) * 2.5;
    const p = Number((base + step).toFixed(2));
    c15m[i] = { ...c15m[i], open: p, high: p + 0.8, low: p - 0.8, close: p };
  }
  for (let i = n - 25; i <= n - 17; i++) {
    const step = i <= n - 21 ? (i - (n - 25)) * 3.0 : 12 - (i - (n - 21)) * 2.5;
    const p = Number((base + step).toFixed(2));
    c15m[i] = { ...c15m[i], open: p, high: p + 0.8, low: p - 0.8, close: p };
  }
  for (let i = n - 16; i <= n - 10; i++) {
    const step = i <= n - 13 ? -(i - (n - 16)) * 2.0 : -6 + (i - (n - 13)) * 5.0; // HL > -10
    const p = Number((base + step).toFixed(2));
    c15m[i] = { ...c15m[i], open: p, high: p + 0.8, low: p - 0.8, close: p };
  }
  for (let i = n - 9; i <= n - 5; i++) {
    const p = Number((base + 16 - Math.abs(i - (n - 7)) * 2.5).toFixed(2)); // HH > +12
    c15m[i] = { ...c15m[i], open: p, high: p + 0.8, low: p - 0.8, close: p };
  }
  // Now break sharply below HL (-6)
  for (let i = n - 4; i < n; i++) {
    const p = Number((base - 4 - (i - (n - 4)) * 4.5).toFixed(2));
    c15m[i] = { ...c15m[i], open: p + 2, high: p + 2.5, low: p - 0.5, close: p };
  }

  const res = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bull.datasets, tf15m: makeDataset('15m', c15m) },
    quote: {
      ...bull.quote,
      bid: Number((c15m[n - 1].close - 0.2).toFixed(3)),
      ask: Number((c15m[n - 1].close + 0.4).toFixed(3)),
      mid: Number((c15m[n - 1].close + 0.1).toFixed(3)),
    },
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.equal(res.evaluation.structure15M.direction, 'BEARISH');
});

test('24. Bearish 5M setup allows healthy downtrend RSI (e.g. 32-37) symmetric with bullish window instead of rejecting below 38', () => {
  const indicators = createAutoPerfectIndicators();
  const bear = buildBearishDatasets(3780);
  const c5m = bear.datasets.tf5m.candles.map((c) => ({ ...c }));
  // Nudge last 12 5m bars cleanly downward so 5m RSI sits ~33-36 without extreme oversold (<26)
  for (let i = c5m.length - 12; i < c5m.length - 2; i++) {
    const drop = (i - (c5m.length - 13)) * 0.45;
    c5m[i] = {
      ...c5m[i],
      open: Number((c5m[i].open - drop * 0.6).toFixed(2)),
      high: Number((c5m[i].high - drop * 0.5).toFixed(2)),
      low: Number((c5m[i].low - drop).toFixed(2)),
      close: Number((c5m[i].close - drop).toFixed(2)),
    };
  }
  const rsiSeries = rsiArray(
    c5m.map((c) => c.close),
    14
  );
  const latestRsi = rsiSeries[rsiSeries.length - 1]!;
  assert.ok(latestRsi >= 26 && latestRsi < 38, `Expected 5M RSI in [26, 38), got ${latestRsi.toFixed(1)}`);

  const res = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bear.datasets, tf5m: makeDataset('5m', c5m) },
    quote: makeQuote(c5m[c5m.length - 1].close - 0.1),
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  const gate4 = res.evaluation.mandatoryGates[3];
  assert.equal(gate4.passed, true, `Gate 4 should pass at bearish 5M RSI ${latestRsi.toFixed(1)}, got: ${gate4.detail}`);
});

test('25. Full-cluster 1H breakdown with strong DMI spread (>=8) and ADX>=15.5 unlocks Gate 2 despite Wilder ADX lag', () => {
  const indicators = createAutoPerfectIndicators();
  const base = buildBearishDatasets(3650);
  // Build a 1H series with chop followed by a 2-bar impulsive breakdown so Wilder ADX lags in [15.5, 17.5)
  // while ST=-1, EMA9<21<=50, Price<SMA20, and (-DI - +DI) >= 8.
  const c1H = base.datasets.tf1H.candles.map((c, idx, arr) => {
    if (idx < arr.length - 2) {
      const wave = Math.sin(idx * 0.75) * 8;
      const p = Number((3630 + wave).toFixed(2));
      return { ...c, open: p, high: p + 7, low: p - 7, close: p };
    }
    const stepDown = (idx - (arr.length - 3)) * 28;
    const p = Number((3620 - stepDown).toFixed(2));
    return { ...c, open: p + 12, high: p + 13, low: p - 2, close: p };
  });

  const res = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...base.datasets, tf1H: makeDataset('1H', c1H) },
    quote: base.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.ok(
    (res.evaluation.trend1H.adxValue ?? 0) >= 15.5 && (res.evaluation.trend1H.adxValue ?? 99) < 17.5,
    `Expected lagged ADX in [15.5, 17.5), got ${res.evaluation.trend1H.adxValue}`
  );
  assert.equal(res.evaluation.trend1H.bias, 'BEARISH');
  assert.equal(res.evaluation.mandatoryGates[1].passed, true);
});

test('26. Gates 4, 5, and 6 report true 5M/1M/Momentum readiness independently when 1H is NEUTRAL while still blocking entry', () => {
  const indicators = createAutoPerfectIndicators();
  const bull = buildBullishDatasets(3780);
  // Flatten 1H into sideways chop so bias1H = NEUTRAL while 15M/5M/1M remain cleanly BULLISH
  const chop1H = bull.datasets.tf1H.candles.map((c, idx) => {
    const wave = (idx % 2 === 0 ? 1 : -1) * 2.5;
    const p = Number((3780 + wave).toFixed(2));
    return { ...c, open: p, high: p + 3, low: p - 3, close: p };
  });

  const res = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bull.datasets, tf1H: makeDataset('1H', chop1H) },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.equal(res.evaluation.trend1H.bias, 'NEUTRAL');
  assert.equal(res.evaluation.mandatoryGates[1].passed, false, 'Gate 2 (1H) must fail');
  assert.equal(res.evaluation.mandatoryGates[2].passed, false, 'Gate 3 (15M agrees 1H) must fail');
  assert.equal(res.evaluation.mandatoryGates[3].passed, true, 'Gate 4 (5M) should reflect ready 5M setup');
  assert.equal(res.evaluation.mandatoryGates[4].passed, true, 'Gate 5 (1M) should reflect ready 1M closed bar');
  assert.equal(res.evaluation.mandatoryGates[5].passed, true, 'Gate 6 (Vol/Mom) should reflect aligned momentum');
  assert.equal(res.evaluation.action, 'NO TRADE');
});

test('27. SURE Gate 5 requires aligned 1M Supertrend and rejects weak 1M+5M volume even when EMA9 > EMA21', () => {
  const indicators = createAutoPerfectIndicators();

  // Subcase A: Weak combined volume (1M volRatio < 0.55 and 5M volRatio ~0.75 < 0.9) must fail SURE Gate 5
  const bullWeakVol = buildBullishDatasets(3780);
  const c1mWeak = bullWeakVol.datasets.tf1m.candles.map((c, idx, arr) =>
    idx === arr.length - 1 ? { ...c, volume: 650 } : { ...c, volume: 2200 }
  );
  const c5mWeak = bullWeakVol.datasets.tf5m.candles.map((c, idx, arr) =>
    idx === arr.length - 1 ? { ...c, volume: 1500 } : { ...c, volume: 2000 }
  );
  const resWeakVol = evaluateStrictMultiTimeframeStrategy({
    datasets: {
      ...bullWeakVol.datasets,
      tf1m: makeDataset('1m', c1mWeak),
      tf5m: makeDataset('5m', c5mWeak),
    },
    quote: bullWeakVol.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.equal(resWeakVol.evaluation.confirmation1M.emaAligned, true);
  assert.equal(resWeakVol.evaluation.confirmation1M.supertrendAligned, true);
  assert.equal(resWeakVol.evaluation.confirmation1M.volumeOk, false);
  assert.equal(resWeakVol.evaluation.confirmation1M.confirmed, false);
  assert.notEqual(resWeakVol.evaluation.action, 'BUY');

  // Subcase B: Opposing 1M Supertrend (ST=-1 while EMA9>EMA21) must fail SURE Gate 5
  const bullOpposingSt = buildBullishDatasets(3780);
  const c1mStOppose = bullOpposingSt.datasets.tf1m.candles.map((c) => ({ ...c }));
  const n1m = c1mStOppose.length;
  // Create a sharp temporary spike 6 bars ago then dip slightly below ST upper band, while slow EMA21 lags below EMA9
  for (let i = n1m - 12; i < n1m - 5; i++) {
    c1mStOppose[i] = {
      ...c1mStOppose[i],
      open: c1mStOppose[i].open + 1.8,
      high: c1mStOppose[i].high + 2.4,
      low: c1mStOppose[i].low + 1.5,
      close: c1mStOppose[i].close + 2.1,
    };
  }
  const peakHigh = c1mStOppose[n1m - 6].high;
  for (let i = n1m - 5; i < n1m - 2; i++) {
    const dropClose = Number((peakHigh - 4.8).toFixed(2));
    c1mStOppose[i] = {
      ...c1mStOppose[i],
      open: dropClose + 0.4,
      high: dropClose + 0.6,
      low: dropClose - 0.5,
      close: dropClose,
    };
  }
  // Tiny bounce on last 2 bars stays under upper ST band so stDir1m = -1 while ema9 >= ema21 or fast cross occurs
  const stSeries = supertrendSeries(c1mStOppose, 10, 3);
  if (stSeries.dir[n1m - 1] > 0) {
    // Force final bar close just below lower/mid threshold only if needed; check dir is -1
    const upperBand = stSeries.line[n1m - 1] ?? c1mStOppose[n1m - 1].close;
    c1mStOppose[n1m - 1] = {
      ...c1mStOppose[n1m - 1],
      open: Number((upperBand - 1.2).toFixed(2)),
      close: Number((upperBand - 0.4).toFixed(2)),
      high: Number((upperBand - 0.1).toFixed(2)),
      low: Number((upperBand - 1.5).toFixed(2)),
    };
  }
  const resOpposeSt = evaluateStrictMultiTimeframeStrategy({
    datasets: {
      ...bullOpposingSt.datasets,
      tf1m: makeDataset('1m', c1mStOppose),
    },
    quote: makeQuote(c1mStOppose[n1m - 1].close + 0.1),
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.equal(resOpposeSt.evaluation.confirmation1M.supertrendAligned, false);
  assert.equal(resOpposeSt.evaluation.confirmation1M.confirmed, false);
  assert.notEqual(resOpposeSt.evaluation.action, 'BUY');
});

test('28. SURE Gate 6 protects SL beyond recent 10-bar 5M swing floor and blocks chased entries exceeding maxStopDist', () => {
  const indicators = createAutoPerfectIndicators();

  // Case A: Unbroken 5M low 7 bars back at -7.5 below spotEntry must pull BUY SL below that floor
  const bullProtected = buildBullishDatasets(3780);
  const c5mA = bullProtected.datasets.tf5m.candles.map((c) => ({ ...c }));
  const spikeFloor = Number((bullProtected.quote.mid - 7.5).toFixed(2));
  c5mA[c5mA.length - 7] = {
    ...c5mA[c5mA.length - 7],
    low: spikeFloor,
  };
  const resProtected = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bullProtected.datasets, tf5m: makeDataset('5m', c5mA) },
    quote: bullProtected.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.equal(resProtected.evaluation.action, 'BUY', `Expected BUY, got blockers: ${resProtected.evaluation.blockers.join(' | ')}`);
  assert.ok(resProtected.tradeLevels != null);
  assert.ok(
    resProtected.tradeLevels!.stopLoss < spikeFloor,
    `Expected BUY SL (${resProtected.tradeLevels!.stopLoss}) to protect below 10-bar 5M low (${spikeFloor})`
  );

  // Case B: Chased BUY far above unbroken recent 10-bar 5M low (-14.5 away) exceeds maxStopDist and must be blocked
  const bullChased = buildBullishDatasets(3780);
  const c5mB = bullChased.datasets.tf5m.candles.map((c) => ({ ...c }));
  c5mB[c5mB.length - 7] = {
    ...c5mB[c5mB.length - 7],
    low: Number((bullChased.quote.mid - 14.5).toFixed(2)),
  };
  const resChased = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bullChased.datasets, tf5m: makeDataset('5m', c5mB) },
    quote: bullChased.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });

  assert.notEqual(resChased.evaluation.action, 'BUY', 'SURE must reject chased entry whose protected SL exceeds maxStopDist');
  assert.equal(resChased.tradeLevels, undefined);
});

test('29. isFreshSpotDataset and validateCandleSeriesIntegrity reject fragmented intraday Spot gaps while passing contiguous streams', () => {
  const bull = buildBullishDatasets(3780);
  const contiguous1m = bull.datasets.tf1m;
  assert.equal(isFreshSpotDataset(contiguous1m, '1m', 240, NOW_SEC, 60), true);

  // Inject server-sleep holes into recent Spot 1m tail (missing 30m+ blocks)
  const gappedCandles = contiguous1m.candles.map((c, idx, arr) => {
    if (idx < arr.length - 10) return { ...c, time: c.time - 3600 };
    if (idx < arr.length - 5) return { ...c, time: c.time - 1800 };
    return c;
  });
  const gappedDs = makeDataset('1m', gappedCandles);
  assert.equal(
    isFreshSpotDataset(gappedDs, '1m', 240, NOW_SEC, 60),
    false,
    'Fragmented live-spot-1m history must fall back to continuous GC=F'
  );

  // validateCandleSeriesIntegrity must flag >= 4h non-weekend intraday gaps across recent 24 bars
  const multiHourGapped: Candle[] = [];
  let t = NOW_SEC - 200 * 60;
  for (let i = 0; i < 40; i++) {
    if (i === 25 || i === 30 || i === 35) {
      t += 5 * 3600; // 3 distinct 5-hour intraday outages
    } else {
      t += 60;
    }
    multiHourGapped.push({ time: t, open: 3780, high: 3781, low: 3779, close: 3780.5, volume: 100 });
  }
  const integrity = validateCandleSeriesIntegrity(multiHourGapped, '1m', t + 30, 600);
  assert.ok(integrity.gapWarnings.length > 0, 'Expected non-weekend multi-hour intraday gaps to produce a gapWarning');
});

test('30. validateFeedIntegrity matches timestamp-aligned prior 15m/1m bars for futures basis even if latest Spot bar is delayed', () => {
  const indicators = createAutoPerfectIndicators();
  const bull = buildBullishDatasets(3780);
  const OFFSET = 24.5;

  const shifted1H = bull.datasets.tf1H.candles.map((c) => ({
    ...c,
    open: Number((c.open + OFFSET).toFixed(2)),
    high: Number((c.high + OFFSET).toFixed(2)),
    low: Number((c.low + OFFSET).toFixed(2)),
    close: Number((c.close + OFFSET).toFixed(2)),
  }));
  const shifted15m = bull.datasets.tf15m.candles.map((c) => ({
    ...c,
    open: Number((c.open + OFFSET).toFixed(2)),
    high: Number((c.high + OFFSET).toFixed(2)),
    low: Number((c.low + OFFSET).toFixed(2)),
    close: Number((c.close + OFFSET).toFixed(2)),
  }));

  // Drop the last 12 minutes of Spot 1m bars so finestFuturesEntry's latest bar falls outside Spot 1m,
  // forcing backward lookup onto the previous 15m bar for basis alignment (still fresh within maxAge? test direct gap between latest 15m close and spot tail)
  const truncatedSpot1m = bull.datasets.tf1m.candles.slice(0, -12);
  const res = evaluateStrictMultiTimeframeStrategy({
    datasets: {
      ...bull.datasets,
      tf1H: makeDataset('1H', shifted1H, 'Yahoo Finance COMEX Gold (GC=F)'),
      tf15m: makeDataset('15m', shifted15m, 'Yahoo Finance COMEX Gold (GC=F)'),
      tf1m: makeDataset('1m', truncatedSpot1m),
    },
    quote: makeQuote(bull.quote.mid + 6.0), // Even if live quote moved differently from truncated 1m tail
    indicatorConfigs: indicators,
    mode: 'ANALYSIS',
    nowMs: NOW_MS,
  });

  assert.ok(
    res.evaluation.feedIntegrity.basisDiffUsd != null &&
      res.evaluation.feedIntegrity.basisDiffUsd >= 15 &&
      res.evaluation.feedIntegrity.basisDiffUsd <= 30,
    `Expected backward bar-aligned basis near +$${OFFSET}, got ${res.evaluation.feedIntegrity.basisDiffUsd}`
  );
});

test('31. ANALYSIS mode never scores lower than SURE mode on identical datasets across 1M RSI edge cases', () => {
  const indicators = createAutoPerfectIndicators();

  for (const scenario of ['BULL', 'BEAR'] as const) {
    const built = scenario === 'BULL' ? buildBullishDatasets(3780) : buildBearishDatasets(3780);
    // Construct 1m pullback tail where 1M RSI sits inside SURE boundary edge (bull ~42.5-43.8, bear ~56.2-57.8)
    const tweaked1m = built.datasets.tf1m.candles.map((c, idx, arr) => {
      if (idx < arr.length - 18) return c;
      const offset = scenario === 'BULL' ? -0.35 : +0.35;
      const step = (idx - (arr.length - 18)) * offset;
      const open = Number((c.open + step).toFixed(2));
      const close = Number((c.close + step).toFixed(2));
      return {
        ...c,
        open,
        close,
        high: Number((Math.max(open, close) + 0.6).toFixed(2)),
        low: Number((Math.min(open, close) - 0.6).toFixed(2)),
      };
    });
    const lastPrice = tweaked1m[tweaked1m.length - 1].close;
    const ds = {
      ...built.datasets,
      tf1m: makeDataset('1m', tweaked1m),
    };
    const quote = makeQuote(lastPrice);

    const sureRes = evaluateStrictMultiTimeframeStrategy({
      datasets: ds,
      quote,
      indicatorConfigs: indicators,
      mode: 'SURE',
      nowMs: NOW_MS,
    });
    const analysisRes = evaluateStrictMultiTimeframeStrategy({
      datasets: ds,
      quote,
      indicatorConfigs: indicators,
      mode: 'ANALYSIS',
      nowMs: NOW_MS,
    });

    assert.ok(
      analysisRes.evaluation.totalScore >= sureRes.evaluation.totalScore,
      `${scenario}: ANALYSIS score (${analysisRes.evaluation.totalScore}) must never drop below SURE score (${sureRes.evaluation.totalScore})`
    );
  }
});

test('32. SURE scanner UTC minute alignment and staleness detection sync Chrome and App scans', () => {
  const baseMinMs = Math.floor(NOW_MS / 60_000) * 60_000;

  // Before :02s in current minute -> schedules current minute :03s
  assert.equal(getNextUtcMinuteScanMs(baseMinMs + 500), baseMinMs + 3_000);
  // Past :03s -> schedules next minute :03s
  assert.equal(getNextUtcMinuteScanMs(baseMinMs + 12_000), baseMinMs + 63_000);

  // Scan from previous minute becomes stale once current minute reaches :03s
  const prevMinScanIso = new Date(baseMinMs - 57_000).toISOString();
  assert.equal(
    isSureStatusStaleForMinute({ tradeLocked: false, lastScannedAt: prevMinScanIso }, baseMinMs + 1_500),
    false
  );
  assert.equal(
    isSureStatusStaleForMinute({ tradeLocked: false, lastScannedAt: prevMinScanIso }, baseMinMs + 3_500),
    true
  );

  // Active trade lock never forces redundant re-scan
  assert.equal(
    isSureStatusStaleForMinute({ tradeLocked: true, lastScannedAt: prevMinScanIso }, baseMinMs + 45_000),
    false
  );
});

test('33. stitchFuturesContractRollovers back-adjusts 1m step-gaps and 5m/1H hybrid contract transitions without inflating ATR or volume', () => {
  const shiftUsd = 32.4;

  // Build 30 1m bars where bar index 24 jumps +$32.40 with huge rollover volume
  const bars1m: Candle[] = Array.from({ length: 30 }, (_, idx) => {
    const t = NOW_SEC - (30 - idx) * 60;
    const base = idx < 24 ? 3529 + idx * 0.05 : 3529 + idx * 0.05 + shiftUsd;
    const isRoll = idx === 24;
    return {
      time: t,
      open: Number(base.toFixed(2)),
      high: Number((base + 0.6).toFixed(2)),
      low: Number((base - 0.5).toFixed(2)),
      close: Number((base + 0.1).toFixed(2)),
      volume: isRoll ? 18_400 : 40,
    };
  });

  const res1m = stitchFuturesContractRollovers(bars1m, '1m');
  assert.equal(res1m.rollovers.length, 1);
  assert.ok(Math.abs(res1m.rollovers[0].shiftUsd - shiftUsd) < 0.5);
  // Bar 23 (pre-rollover) should be shifted up cleanly to match bar 24
  assert.ok(
    Math.abs(res1m.candles[24].open - res1m.candles[23].close) < 1.0,
    `Expected stitched 1m step gap near 0, got ${res1m.candles[24].open - res1m.candles[23].close}`
  );
  assert.ok(res1m.candles[24].volume < 100, `Rollover bar volume must be normalized, got ${res1m.candles[24].volume}`);

  // Now simulate 5m hybrid transition bar containing a mid-bar 1m rollover anchor
  const bars5m: Candle[] = Array.from({ length: 28 }, (_, idx) => {
    const t = NOW_SEC - (28 - idx) * 300;
    if (idx < 22) {
      const p = 3529 + idx * 0.1;
      return { time: t, open: p, high: p + 0.8, low: p - 0.7, close: p + 0.1, volume: 130 };
    }
    if (idx === 22) {
      // Hybrid bar opens on old contract (3531.2) and closes on new contract (3563.7)
      return {
        time: t,
        open: 3531.2,
        high: 3564.5,
        low: 3530.5,
        close: 3563.7,
        volume: 18_800,
      };
    }
    const p = 3563.7 + (idx - 22) * 0.1;
    return { time: t, open: p, high: p + 0.8, low: p - 0.7, close: p + 0.1, volume: 140 };
  });

  const anchorTime5m = bars5m[22].time + 60; // mid-bar rollover matching 1m detection
  const res5m = stitchFuturesContractRollovers(bars5m, '5m', {
    externalAnchors: [{ timeSec: anchorTime5m, shiftUsd }],
  });
  assert.equal(res5m.rollovers.length, 1);
  // Pre-rollover candle shifted by +32.4 and hybrid bar low/open back-adjusted cleanly
  assert.ok(res5m.candles[21].close > 3560, `Expected prior 5m bar shifted onto new contract, got ${res5m.candles[21].close}`);
  assert.ok(
    res5m.candles[22].high - res5m.candles[22].low < 5,
    `Expected repaired 5m hybrid bar range < $5, got ${res5m.candles[22].high - res5m.candles[22].low}`
  );
  assert.ok(res5m.candles[22].volume < 500, `Expected capped 5m rollover volume, got ${res5m.candles[22].volume}`);
});

test('34. stitchFuturesContractRollovers preserves weekend gaps and genuine high-volatility news spikes', () => {
  // 1) Genuine news spike where Spot and Futures move together (+$20 with high volume, zero basis jump)
  const newsFutures: Candle[] = [];
  const spot1m: Candle[] = [];
  for (let idx = 0; idx < 26; idx++) {
    const t = NOW_SEC - (26 - idx) * 300;
    const spikeOffset = idx >= 20 ? 18 : 0;
    const fBase = 3560 + spikeOffset;
    const sBase = 3535 + spikeOffset;
    newsFutures.push({
      time: t,
      open: idx === 20 ? 3560 : fBase,
      high: fBase + 2.5,
      low: (idx === 20 ? 3560 : fBase) - 0.8,
      close: fBase + 1.5,
      volume: idx === 20 ? 1_600 : 180,
    });
    for (let m = 0; m < 5; m++) {
      spot1m.push({
        time: t + m * 60,
        open: sBase,
        high: sBase + 1.5,
        low: sBase - 1.0,
        close: sBase + 1.0,
        volume: 20,
      });
    }
  }

  const newsRes = stitchFuturesContractRollovers(newsFutures, '5m', { spot1mCandles: spot1m });
  assert.equal(newsRes.rollovers.length, 0, 'Genuine news spike where Spot moves with Futures must NOT be stitched');
  assert.equal(newsRes.candles[19].close, newsFutures[19].close);

  // 2) Weekend gap (>= 6 hours between bars) must NOT be treated as a rollover
  const weekendBars: Candle[] = Array.from({ length: 24 }, (_, idx) => {
    const t = idx < 18 ? NOW_SEC - 100_000 + idx * 300 : NOW_SEC - (24 - idx) * 300;
    const p = idx < 18 ? 3520 : 3555;
    return { time: t, open: p, high: p + 1, low: p - 1, close: p + 0.2, volume: idx === 18 ? 1_200 : 120 };
  });
  const weekendRes = stitchFuturesContractRollovers(weekendBars, '5m');
  assert.equal(weekendRes.rollovers.length, 0, 'Weekend opening gap must never be altered');
});

test('35. validateFeedIntegrity aligns GC=F 1m futures against contemporaneous spot1mHistory even if live quote drifted', () => {
  const indicators = createAutoPerfectIndicators();
  const bull = buildBullishDatasets(3780);
  const BASIS = 26.5;

  const shiftSet = (bars: Candle[]) =>
    bars.map((c) => ({
      ...c,
      open: Number((c.open + BASIS).toFixed(2)),
      high: Number((c.high + BASIS).toFixed(2)),
      low: Number((c.low + BASIS).toFixed(2)),
      close: Number((c.close + BASIS).toFixed(2)),
    }));

  const spotHistory = bull.datasets.tf1m.candles;
  const gcf1m = shiftSet(spotHistory).slice(0, -10); // Delayed GC=F 1m ending 10 mins earlier
  const gcf5m = shiftSet(bull.datasets.tf5m.candles);
  const gcf15m = shiftSet(bull.datasets.tf15m.candles);
  const gcf1H = shiftSet(bull.datasets.tf1H.candles);

  // Live quote jumped +12 above the delayed spot tail, which would widen basis artificially if unaligned
  const res = evaluateStrictMultiTimeframeStrategy({
    datasets: {
      tf1H: makeDataset('1H', gcf1H, 'Yahoo Finance COMEX Gold (GC=F)'),
      tf15m: makeDataset('15m', gcf15m, 'Yahoo Finance COMEX Gold (GC=F)'),
      tf5m: makeDataset('5m', gcf5m, 'Yahoo Finance COMEX Gold (GC=F)'),
      tf1m: makeDataset('1m', gcf1m, 'Yahoo Finance COMEX Gold (GC=F)'),
      spot1mHistory: spotHistory,
    },
    quote: makeQuote(bull.quote.mid + 12.0),
    indicatorConfigs: indicators,
    mode: 'ANALYSIS',
    nowMs: NOW_MS,
  });

  assert.equal(res.evaluation.feedIntegrity.valid, true);
  assert.ok(
    res.evaluation.feedIntegrity.basisDiffUsd != null &&
      Math.abs(res.evaluation.feedIntegrity.basisDiffUsd - BASIS) < 1.5,
    `Expected contemporaneous spot1mHistory basis ~+$${BASIS}, got ${res.evaluation.feedIntegrity.basisDiffUsd}`
  );
});

test('36. reportsStore serializes concurrent writes and filters corrupt records from disk', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leaders-reports-'));
  const storePath = path.join(tmpDir, 'reports.json');
  setReportsStoreFile(storePath);

  try {
    // Seed file with one corrupt record and one valid record
    await fs.writeFile(
      storePath,
      JSON.stringify([
        { id: 'broken-no-tf', createdAt: new Date(NOW_MS).toISOString() },
        {
          id: 'valid-seed',
          createdAt: new Date(NOW_MS - 10_000).toISOString(),
          classification: 'HOLD',
          spotPrice: 3780,
          timeframeAnalyses: [{ timeframe: '1H' }],
        },
      ]),
      'utf8'
    );

    const makeReport = (idx: number): AnalysisReport => ({
      id: `rep-${idx}`,
      createdAt: new Date(NOW_MS + idx * 1_000).toISOString(),
      marketDataTimestamp: NOW_MS,
      freshness: 'LIVE',
      spotPrice: 3780 + idx,
      spotBid: 3779.7 + idx,
      spotAsk: 3780.3 + idx,
      spotSource: 'Test',
      candleSource: 'Test',
      selectedTimeframes: [idx % 2 === 0 ? '1m' : '5m', '15m'],
      selectedIndicators: createAutoPerfectIndicators()
        .slice(0, idx + 1)
        .map((ind) => ({
          id: ind.id,
          name: ind.id.toUpperCase(),
          category: 'TREND' as const,
          params: ind.params,
        })),
      timeframeAnalyses: [
        {
          timeframe: '15m',
          classification: 'HOLD',
          candleCount: 100,
          latestClose: 3780,
          latestTimestamp: NOW_MS,
          freshness: 'LIVE',
          candleSource: 'Test',
          volumeNote: 'ok',
          combinedScore: 0,
          trendScore: 0,
          momentumScore: 0,
          volatilityState: '$1.50',
          volumeState: '1.0x',
          supportLevels: [],
          resistanceLevels: [],
          indicatorResults: [],
          agreements: [],
          conflicts: [],
          summary: 'ok',
        },
      ],
      classification: idx % 2 === 0 ? 'BUY' : 'SELL',
      combinedScore: 0,
      signalConfidence: {
        scorePct: 50,
        tier: 'MODERATE',
        agreeingVotes: 1,
        opposingVotes: 0,
        neutralVotes: 0,
        totalVotes: 1,
        buyVotes: 1,
        sellVotes: 0,
        holdVotes: 0,
        alignedTimeframes: 1,
        totalTimeframes: 1,
        summary: 'ok',
      },
      reasons: [],
      agreements: [],
      conflicts: [],
      supportLevels: [],
      resistanceLevels: [],
      combinedMethodology: 'ok',
      shortVsLongComparison: 'ok',
      uncertaintyExplanation: 'ok',
    });

    await Promise.all([saveReport(makeReport(1)), saveReport(makeReport(2)), saveReport(makeReport(3))]);

    const loaded = await listReports();
    assert.equal(loaded.length, 4, `Expected 3 concurrent saves + 1 valid seed, got ${loaded.length}`);
    assert.ok(!loaded.some((r) => r.id === 'broken-no-tf'), 'Corrupt entry must be filtered out');
  } finally {
    setReportsStoreFile(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('37. sureSignalsStore filters corrupt disk entries and ignores invalid records safely', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leaders-sure-corrupt-'));
  const storePath = path.join(tmpDir, 'sure-signals.json');
  setSureSignalsStoreFile(storePath);

  try {
    await fs.writeFile(
      storePath,
      JSON.stringify([
        { id: '', status: 'ACTIVE' },
        { id: 'missing-levels', direction: 'BUY', status: 'TP_HIT', spotPrice: 3780 },
        {
          id: 'valid-closed',
          createdAt: new Date(NOW_MS - 60_000).toISOString(),
          closedAt: new Date(NOW_MS - 10_000).toISOString(),
          status: 'TP_HIT',
          direction: 'BUY',
          spotPrice: 3780,
          closePrice: 3792,
          pnlPoints: 12,
          setupScore: 92,
          scoreCategory: 'HIGH CONFIDENCE TRADE',
          confidencePct: 92,
          riskRewardRatio: '1 : 2.00',
          adxValue: 26,
          timeframes: ['1H', '15m', '5m', '1m'],
          summary: 'ok',
          tradeLevels: {
            referenceTimeframe: '15m',
            referencePrice: 3780,
            atrValue: 3.5,
            stopLoss: 3774,
            takeProfit1: 3792,
            takeProfit2: 3792,
            riskPoints: 6,
            rewardRiskRatio1: '1 : 2.00',
            rewardRiskRatio2: '1 : 2.00',
            methodology: 'ok',
          },
          checks: [],
        },
      ]),
      'utf8'
    );

    const list = await listSureSignals();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'valid-closed');
    const stats = computeSureHistoryStats(list);
    assert.equal(stats.tpHits, 1);
    assert.equal(stats.winRatePct, 100);
  } finally {
    setSureSignalsStoreFile(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('38. SURE blocks false SELL after 15m higher-low V-reversal, delayed GC=F upward Spot bounce, live Spot 1m bullish candle, and bloated ATR chop SL', () => {
  const indicators = createAutoPerfectIndicators();

  // Case A: Bearish 1H/15m history ends with 4 consecutive 15m higher lows + strong rebound off bottom
  const bear = buildBearishDatasets(3500);
  const c15m = bear.datasets.tf15m.candles.map((c) => ({ ...c }));
  const n15 = c15m.length;
  // Flush trough at n15 - 6, then 5 higher-low green candles surging upward
  const troughBase = Number((c15m[n15 - 7].close - 18).toFixed(2));
  c15m[n15 - 6] = {
    ...c15m[n15 - 6],
    open: Number((troughBase + 12).toFixed(2)),
    high: Number((troughBase + 13).toFixed(2)),
    low: troughBase,
    close: Number((troughBase + 4).toFixed(2)),
  };
  for (let k = 5; k >= 1; k--) {
    const step = 6 - k;
    const prevC = c15m[n15 - k - 1].close;
    const low = Number((troughBase + step * 3.0).toFixed(2));
    const close = Number((prevC + 4.8).toFixed(2));
    c15m[n15 - k] = {
      ...c15m[n15 - k],
      open: prevC,
      high: Number((close + 2.2).toFixed(2)),
      low,
      close,
    };
  }

  const resReversal = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bear.datasets, tf15m: makeDataset('15m', c15m) },
    quote: bear.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.notEqual(resReversal.evaluation.structure15M.bosDetected, 'BEARISH', '15m higher-low reversal must never emit BOS:BEARISH');
  assert.notEqual(resReversal.evaluation.action, 'SELL', 'SURE must block SELL during 15m higher-low rebound');

  // Case B: Delayed GC=F 1m shows bearish close 8m ago, while live Spot already bounced +$6.50 against SELL
  const bearDelayed = buildBearishDatasets(3500);
  const BASIS = 26.5;
  const shiftSet = (bars: Candle[]) =>
    bars.map((c) => ({
      ...c,
      open: Number((c.open + BASIS).toFixed(2)),
      high: Number((c.high + BASIS).toFixed(2)),
      low: Number((c.low + BASIS).toFixed(2)),
      close: Number((c.close + BASIS).toFixed(2)),
    }));
  const spot1mTail = bearDelayed.datasets.tf1m.candles.map((c) => ({ ...c }));
  // Last 2 real-time Spot 1m closed bars turned bullish (+$5 bounce above delayed GC=F 1m close)
  const f1mDelayed = shiftSet(spot1mTail.slice(0, -8));
  const lastIdx = spot1mTail.length - 1;
  spot1mTail[lastIdx] = {
    ...spot1mTail[lastIdx],
    open: Number((spot1mTail[lastIdx - 8].close + 1.5).toFixed(2)),
    high: Number((spot1mTail[lastIdx - 8].close + 6.5).toFixed(2)),
    low: Number((spot1mTail[lastIdx - 8].close + 1.0).toFixed(2)),
    close: Number((spot1mTail[lastIdx - 8].close + 6.0).toFixed(2)),
  };
  const bouncedQuote = makeQuote(spot1mTail[lastIdx].close + 0.5);

  const resDelayedBounce = evaluateStrictMultiTimeframeStrategy({
    datasets: {
      tf1H: makeDataset('1H', shiftSet(bearDelayed.datasets.tf1H.candles), 'Yahoo Finance COMEX Gold (GC=F)'),
      tf15m: makeDataset('15m', shiftSet(bearDelayed.datasets.tf15m.candles), 'Yahoo Finance COMEX Gold (GC=F)'),
      tf5m: makeDataset('5m', shiftSet(bearDelayed.datasets.tf5m.candles), 'Yahoo Finance COMEX Gold (GC=F)'),
      tf1m: makeDataset('1m', f1mDelayed, 'Yahoo Finance COMEX Gold (GC=F)'),
      spot1mHistory: spot1mTail,
    },
    quote: bouncedQuote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.equal(resDelayedBounce.evaluation.confirmation1M.confirmed, false, 'SURE 1M must reject delayed GC=F SELL after live Spot reversal');
  assert.notEqual(resDelayedBounce.evaluation.action, 'SELL');

  // Case C: Extreme 5M chop (ATR5m ~$10.2 producing >$16 SL) must be rejected by SURE volatility-capped stop ceiling ($14.80)
  const bearChop = buildBearishDatasets(3500);
  const c5mChop = bearChop.datasets.tf5m.candles.map((c, idx, arr) => {
    if (idx < arr.length - 18) return c;
    const mid = (c.high + c.low) / 2;
    return {
      ...c,
      high: Number((mid + 5.8).toFixed(2)),
      low: Number((mid - 5.8).toFixed(2)),
    };
  });
  const resChop = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bearChop.datasets, tf5m: makeDataset('5m', c5mChop) },
    quote: bearChop.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.notEqual(resChop.evaluation.action, 'SELL', 'SURE must reject oversized SL > $14.80 in extreme ATR chop');
});

test('39. Symmetric BUY protection: blocks 15m lower-high selloff BOS:BULLISH and delayed GC=F BUY when live Spot dumps', () => {
  const indicators = createAutoPerfectIndicators();

  // Case A: Bullish history ends with 4 consecutive lower highs + falling closes
  const bull = buildBullishDatasets(3780);
  const c15m = bull.datasets.tf15m.candles.map((c) => ({ ...c }));
  const n15 = c15m.length;
  const peakBase = Number((c15m[n15 - 7].close + 18).toFixed(2));
  c15m[n15 - 6] = {
    ...c15m[n15 - 6],
    open: Number((peakBase - 12).toFixed(2)),
    high: peakBase,
    low: Number((peakBase - 13).toFixed(2)),
    close: Number((peakBase - 4).toFixed(2)),
  };
  for (let k = 5; k >= 1; k--) {
    const step = 6 - k;
    const prevC = c15m[n15 - k - 1].close;
    const high = Number((peakBase - step * 3.0).toFixed(2));
    const close = Number((prevC - 4.8).toFixed(2));
    c15m[n15 - k] = {
      ...c15m[n15 - k],
      open: prevC,
      high,
      low: Number((close - 2.2).toFixed(2)),
      close,
    };
  }

  const resDump = evaluateStrictMultiTimeframeStrategy({
    datasets: { ...bull.datasets, tf15m: makeDataset('15m', c15m) },
    quote: bull.quote,
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.notEqual(resDump.evaluation.structure15M.bosDetected, 'BULLISH');
  assert.notEqual(resDump.evaluation.action, 'BUY');

  // Case B: Delayed GC=F 1m BUY invalidated when live Spot dumps -$5.50 below delayed 1m close
  const bullDelayed = buildBullishDatasets(3780);
  const BASIS = 26.5;
  const shiftSet = (bars: Candle[]) =>
    bars.map((c) => ({
      ...c,
      open: Number((c.open + BASIS).toFixed(2)),
      high: Number((c.high + BASIS).toFixed(2)),
      low: Number((c.low + BASIS).toFixed(2)),
      close: Number((c.close + BASIS).toFixed(2)),
    }));
  const spot1mTail = bullDelayed.datasets.tf1m.candles.map((c) => ({ ...c }));
  const f1mDelayed = shiftSet(spot1mTail.slice(0, -8));
  const lastIdx = spot1mTail.length - 1;
  spot1mTail[lastIdx] = {
    ...spot1mTail[lastIdx],
    open: Number((spot1mTail[lastIdx - 8].close - 1.0).toFixed(2)),
    high: Number((spot1mTail[lastIdx - 8].close - 0.5).toFixed(2)),
    low: Number((spot1mTail[lastIdx - 8].close - 5.8).toFixed(2)),
    close: Number((spot1mTail[lastIdx - 8].close - 5.2).toFixed(2)),
  };

  const resDelayedDump = evaluateStrictMultiTimeframeStrategy({
    datasets: {
      tf1H: makeDataset('1H', shiftSet(bullDelayed.datasets.tf1H.candles), 'Yahoo Finance COMEX Gold (GC=F)'),
      tf15m: makeDataset('15m', shiftSet(bullDelayed.datasets.tf15m.candles), 'Yahoo Finance COMEX Gold (GC=F)'),
      tf5m: makeDataset('5m', shiftSet(bullDelayed.datasets.tf5m.candles), 'Yahoo Finance COMEX Gold (GC=F)'),
      tf1m: makeDataset('1m', f1mDelayed, 'Yahoo Finance COMEX Gold (GC=F)'),
      spot1mHistory: spot1mTail,
    },
    quote: makeQuote(spot1mTail[lastIdx].close - 0.4),
    indicatorConfigs: indicators,
    mode: 'SURE',
    nowMs: NOW_MS,
  });
  assert.equal(resDelayedDump.evaluation.confirmation1M.confirmed, false);
  assert.notEqual(resDelayedDump.evaluation.action, 'BUY');
});





