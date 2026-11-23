import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAutoPerfectIndicators } from '../src/constants/indicators.ts';
import type {
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


