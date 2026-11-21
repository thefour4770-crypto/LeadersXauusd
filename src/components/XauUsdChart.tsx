import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';
import { Maximize2, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react';
import {
  getLiveQuoteSnapshot,
  subscribeLiveQuoteTicks,
} from '../contexts/LiveQuoteContext.tsx';
import type { Candle, ChartOverlaySeries, MarketQuote, Timeframe } from '../types/market.ts';

const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1_800,
  '1H': 3_600,
  '4H': 14_400,
  '1D': 86_400,
  '1W': 604_800,
};

interface XauUsdChartProps {
  candles: Candle[];
  overlays: ChartOverlaySeries[];
  timeframe: Timeframe;
  supportLevels: number[];
  resistanceLevels: number[];
  showVolume: boolean;
  hasExchangeVolume: boolean;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onCandleRollover?: () => void;
  fullHeight?: boolean;
}

interface CrosshairReadout {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: string;
}

function applyLiveQuoteToCandles(
  baseCandles: Candle[],
  timeframe: Timeframe,
  liveQuote?: MarketQuote | null
): Candle[] {
  if (
    baseCandles.length === 0 ||
    !liveQuote ||
    liveQuote.freshness === 'UNAVAILABLE' ||
    !Number.isFinite(liveQuote.mid) ||
    liveQuote.mid <= 0
  ) {
    return baseCandles;
  }

  const tfSec = TIMEFRAME_SECONDS[timeframe];
  const quoteSec = Math.floor(liveQuote.timestamp / 1000);
  const price = Number(liveQuote.mid.toFixed(2));
  const next = baseCandles.map((c) => ({ ...c }));
  const last = next[next.length - 1];

  if (quoteSec >= last.time && quoteSec - last.time < tfSec) {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
  } else if (quoteSec - last.time >= tfSec) {
    const bucket = Math.floor(quoteSec / tfSec) * tfSec;
    const safeTime = bucket > last.time ? bucket : last.time + tfSec;
    next.push({
      time: safeTime,
      open: last.close,
      high: Math.max(last.close, price),
      low: Math.min(last.close, price),
      close: price,
      volume: 0,
    });
  }

  return next;
}

export const XauUsdChart = memo(function XauUsdChart({
  candles,
  overlays,
  timeframe,
  supportLevels,
  resistanceLevels,
  showVolume,
  hasExchangeVolume,
  loading,
  error,
  onRefresh,
  onCandleRollover,
  fullHeight = false,
}: XauUsdChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlaySeriesMapRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const lastFittedTfRef = useRef<Timeframe | null>(null);
  const lastSeriesSigRef = useRef<string>('');
  const candleMapRef = useRef<Map<number, Candle>>(new Map());

  // Persistent refs for continuous 60/120fps requestAnimationFrame loop
  const renderedBarRef = useRef<Candle | null>(null);
  const targetBarRef = useRef<Candle | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const lastFrameTsRef = useRef<number>(0);
  const lastRolloverBucketRef = useRef<number>(0);
  const lastPriceLineUpRef = useRef<boolean | null>(null);
  const lastCrosshairKeyRef = useRef<string | null>(null);
  const showVolumeRef = useRef<boolean>(showVolume);
  const hasExchangeVolumeRef = useRef<boolean>(hasExchangeVolume);
  const timeframeRef = useRef<Timeframe>(timeframe);
  const onCandleRolloverRef = useRef(onCandleRollover);
  showVolumeRef.current = showVolume;
  hasExchangeVolumeRef.current = hasExchangeVolume;
  timeframeRef.current = timeframe;
  onCandleRolloverRef.current = onCandleRollover;

  // Direct DOM refs keep OHLC price readout bar synchronized with candlestick at 60fps
  const ohlcOpenRef = useRef<HTMLElement | null>(null);
  const ohlcHighRef = useRef<HTMLElement | null>(null);
  const ohlcLowRef = useRef<HTMLElement | null>(null);
  const ohlcCloseRef = useRef<HTMLElement | null>(null);
  const readoutRef = useRef<CrosshairReadout | null>(null);

  const [readout, setReadout] = useState<CrosshairReadout | null>(null);

  const syncOhlcDom = useCallback((bar: Candle) => {
    if (readoutRef.current !== null) return;
    if (ohlcOpenRef.current) ohlcOpenRef.current.textContent = bar.open.toFixed(2);
    if (ohlcHighRef.current) ohlcHighRef.current.textContent = bar.high.toFixed(2);
    if (ohlcLowRef.current) ohlcLowRef.current.textContent = bar.low.toFixed(2);
    if (ohlcCloseRef.current) ohlcCloseRef.current.textContent = bar.close.toFixed(2);
  }, []);

  const pushCandleAndVolumeToChart = useCallback(
    (bar: Candle) => {
      const candleSeries = candleSeriesRef.current;
      const volumeSeries = volumeSeriesRef.current;
      if (!candleSeries) return;

      candleSeries.update({
        time: bar.time as Time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      });

      const isUp = bar.close >= bar.open;
      if (lastPriceLineUpRef.current !== isUp) {
        lastPriceLineUpRef.current = isUp;
        candleSeries.applyOptions({
          priceLineColor: isUp ? '#10B981' : '#EF4444',
        });
      }

      if (volumeSeries && showVolumeRef.current) {
        const volVal = hasExchangeVolumeRef.current
          ? bar.volume
          : Math.round((bar.high - bar.low) * 100 + Math.abs(bar.close - bar.open) * 50);
        volumeSeries.update({
          time: bar.time as Time,
          value: volVal,
          color: isUp ? 'rgba(16, 185, 129, 0.28)' : 'rgba(239, 68, 68, 0.28)',
        });
      }

      renderedBarRef.current = bar;
      candleMapRef.current.set(bar.time, bar);
      syncOhlcDom(bar);
    },
    [syncOhlcDom]
  );

  const ensureRafLoopRunning = useCallback(() => {
    if (animFrameRef.current !== null) return;
    lastFrameTsRef.current = performance.now();

    const step = (now: number) => {
      const target = targetBarRef.current;
      const prev = renderedBarRef.current;
      const candleSeries = candleSeriesRef.current;

      if (!target || !candleSeries) {
        animFrameRef.current = null;
        return;
      }

      const dtSec = Math.min(0.05, Math.max(0.001, (now - lastFrameTsRef.current) / 1000));
      lastFrameTsRef.current = now;

      // If switching to a new candle bar, anchor interpolation from open price cleanly
      const startBar =
        prev && prev.time === target.time
          ? prev
          : {
              time: target.time,
              open: target.open,
              high: target.open,
              low: target.open,
              close: target.open,
              volume: target.volume,
            };

      const diff = target.close - startBar.close;
      const converged = Math.abs(diff) < 0.005;

      if (converged) {
        pushCandleAndVolumeToChart(target);
        animFrameRef.current = null;
        return;
      }

      // Frame-rate-independent exponential smoothing (never resets/stutters between rapid ticks)
      const alpha = 1 - Math.exp(-dtSec * 15);
      const nextClose = Number((startBar.close + diff * alpha).toFixed(2));
      const nextHigh = Math.max(startBar.high, target.open, nextClose);
      const nextLow = Math.min(startBar.low, target.open, nextClose);

      const frameBar: Candle = {
        time: target.time,
        open: target.open,
        high: Number(nextHigh.toFixed(2)),
        low: Number(nextLow.toFixed(2)),
        close: nextClose,
        volume: target.volume,
      };

      pushCandleAndVolumeToChart(frameBar);
      animFrameRef.current = requestAnimationFrame(step);
    };

    animFrameRef.current = requestAnimationFrame(step);
  }, [pushCandleAndVolumeToChart]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#0B0C10' },
        textColor: '#A1A1AA',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(212, 175, 55, 0.45)', labelBackgroundColor: '#181A20' },
        horzLine: { color: 'rgba(212, 175, 55, 0.45)', labelBackgroundColor: '#181A20' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        scaleMargins: { top: 0.08, bottom: showVolume ? 0.2 : 0.08 },
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        rightBarStaysOnScroll: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10B981',
      downColor: '#EF4444',
      borderUpColor: '#10B981',
      borderDownColor: '#EF4444',
      wickUpColor: '#10B981',
      wickDownColor: '#EF4444',
      priceLineVisible: true,
      lastValueVisible: true,
      priceLineWidth: 1,
      priceLineStyle: LineStyle.Dashed,
      priceLineColor: '#F5D061',
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    });

    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        if (readoutRef.current !== null) {
          readoutRef.current = null;
          lastCrosshairKeyRef.current = null;
          setReadout(null);
        }
        return;
      }
      const ts = typeof param.time === 'number' ? param.time : null;
      if (ts == null) return;
      const bar = candleMapRef.current.get(ts);
      if (bar) {
        const key = `${bar.time}:${bar.close}:${bar.high}:${bar.low}`;
        if (lastCrosshairKeyRef.current === key) return;
        lastCrosshairKeyRef.current = key;
        const nextReadout = {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          time: new Date(bar.time * 1000).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
        };
        readoutRef.current = nextReadout;
        setReadout(nextReadout);
      }
    });

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          chart.applyOptions({ width, height });
        }
      }
    });
    ro.observe(el);

    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      overlaySeriesMapRef.current.clear();
      priceLinesRef.current = [];
      renderedBarRef.current = null;
      targetBarRef.current = null;
      lastSeriesSigRef.current = '';
      lastPriceLineUpRef.current = null;
      lastCrosshairKeyRef.current = null;
    };
  }, []);

  // Re-sync live OHLC DOM text immediately when crosshair pointer leaves chart
  useEffect(() => {
    if (readout === null && renderedBarRef.current) {
      syncOhlcDom(renderedBarRef.current);
    }
  }, [readout, syncOhlcDom]);

  // Update full candle & volume series when historical candles or timeframe change
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!chart || !candleSeries || !volumeSeries) return;

    const liveQuote = getLiveQuoteSnapshot().quote;
    const synced = applyLiveQuoteToCandles(candles, timeframe, liveQuote);
    const timeframeChanged = lastFittedTfRef.current !== timeframe;
    const prevRendered = timeframeChanged ? null : renderedBarRef.current;

    if (prevRendered && synced.length > 0) {
      const latestSynced = synced[synced.length - 1];
      if (latestSynced.time === prevRendered.time) {
        latestSynced.high = Math.max(latestSynced.high, prevRendered.high);
        latestSynced.low = Math.min(latestSynced.low, prevRendered.low);
      }
    }

    const prevHistorySig =
      candles.length > 1
        ? `${timeframe}:${candles.length}:${candles[0].time}:${candles[candles.length - 2].time}:${candles[candles.length - 2].close}:${showVolume}:${hasExchangeVolume}`
        : `${timeframe}:${candles.length}:${showVolume}:${hasExchangeVolume}`;

    if (
      !timeframeChanged &&
      synced.length > 1 &&
      prevRendered &&
      synced[synced.length - 1].time === prevRendered.time &&
      lastSeriesSigRef.current === prevHistorySig
    ) {
      // Fast incremental path: history didn't shift, only update target bar smoothly
      const targetLatest = { ...synced[synced.length - 1] };
      candleMapRef.current.set(targetLatest.time, targetLatest);
      targetBarRef.current = targetLatest;
      if (Math.abs(targetLatest.close - prevRendered.close) >= 0.005) {
        ensureRafLoopRunning();
      } else if (
        targetLatest.high !== prevRendered.high ||
        targetLatest.low !== prevRendered.low ||
        targetLatest.volume !== prevRendered.volume
      ) {
        pushCandleAndVolumeToChart(targetLatest);
      }
      return;
    }

    lastSeriesSigRef.current = prevHistorySig;

    const map = new Map<number, Candle>();
    for (const c of synced) map.set(c.time, c);
    candleMapRef.current = map;

    if (synced.length === 0) {
      candleSeries.setData([]);
      volumeSeries.setData([]);
      renderedBarRef.current = null;
      targetBarRef.current = null;
      lastPriceLineUpRef.current = null;
      return;
    }

    const targetLatest = { ...synced[synced.length - 1] };
    // Preserve smooth in-flight close when 5s background candles refresh on the same bar
    const displaySynced = synced.map((c, idx) => {
      if (
        idx === synced.length - 1 &&
        prevRendered &&
        prevRendered.time === c.time &&
        Math.abs(prevRendered.close - c.close) >= 0.005
      ) {
        return {
          ...c,
          close: prevRendered.close,
          high: Math.max(c.high, prevRendered.high),
          low: Math.min(c.low, prevRendered.low),
        };
      }
      return c;
    });

    candleSeries.setData(
      displaySynced.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );

    const drawnLast = displaySynced[displaySynced.length - 1];
    const drawnUp = drawnLast.close >= drawnLast.open;
    if (lastPriceLineUpRef.current !== drawnUp) {
      lastPriceLineUpRef.current = drawnUp;
      candleSeries.applyOptions({
        priceLineColor: drawnUp ? '#10B981' : '#EF4444',
      });
    }
    renderedBarRef.current = { ...drawnLast };
    targetBarRef.current = targetLatest;
    syncOhlcDom(drawnLast);

    if (showVolume) {
      volumeSeries.setData(
        displaySynced.map((c) => {
          const val = hasExchangeVolume
            ? c.volume
            : Math.round((c.high - c.low) * 100 + Math.abs(c.close - c.open) * 50);
          return {
            time: c.time as Time,
            value: val,
            color: c.close >= c.open ? 'rgba(16, 185, 129, 0.28)' : 'rgba(239, 68, 68, 0.28)',
          };
        })
      );
    } else {
      volumeSeries.setData([]);
    }

    chart.priceScale('right').applyOptions({
      scaleMargins: { top: 0.08, bottom: showVolume ? 0.2 : 0.08 },
    });

    if (timeframeChanged) {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      const visibleCount = Math.min(displaySynced.length, 75);
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, displaySynced.length - visibleCount),
        to: displaySynced.length + 2,
      });
      lastFittedTfRef.current = timeframe;
    } else if (Math.abs(targetLatest.close - drawnLast.close) >= 0.005) {
      ensureRafLoopRunning();
    }
  }, [candles, timeframe, showVolume, hasExchangeVolume, ensureRafLoopRunning, syncOhlcDom]);

  // Subscribe directly to live quote ticks without triggering React re-renders
  useEffect(() => {
    const feedLiveQuote = (liveQuote: MarketQuote | null) => {
      const prevBase = targetBarRef.current ?? renderedBarRef.current;
      if (
        !candleSeriesRef.current ||
        !prevBase ||
        !liveQuote ||
        liveQuote.freshness === 'UNAVAILABLE' ||
        !Number.isFinite(liveQuote.mid) ||
        liveQuote.mid <= 0
      ) {
        return;
      }

      const tfSec = TIMEFRAME_SECONDS[timeframeRef.current];
      const quoteSec = Math.floor(liveQuote.timestamp / 1000);
      const targetPrice = Number(liveQuote.mid.toFixed(2));

      if (quoteSec >= prevBase.time && quoteSec - prevBase.time < tfSec) {
        targetBarRef.current = {
          time: prevBase.time,
          open: prevBase.open,
          high: Math.max(prevBase.high, targetPrice),
          low: Math.min(prevBase.low, targetPrice),
          close: targetPrice,
          volume: prevBase.volume,
        };
      } else if (quoteSec - prevBase.time >= tfSec) {
        const bucket = Math.floor(quoteSec / tfSec) * tfSec;
        const safeTime = bucket > prevBase.time ? bucket : prevBase.time + tfSec;
        if (lastRolloverBucketRef.current !== safeTime) {
          lastRolloverBucketRef.current = safeTime;
          onCandleRolloverRef.current?.();
        }
        targetBarRef.current = {
          time: safeTime,
          open: prevBase.close,
          high: Math.max(prevBase.close, targetPrice),
          low: Math.min(prevBase.close, targetPrice),
          close: targetPrice,
          volume: 0,
        };
      } else {
        return;
      }

      ensureRafLoopRunning();
    };

    feedLiveQuote(getLiveQuoteSnapshot().quote);
    return subscribeLiveQuoteTicks(feedLiveQuote);
  }, [ensureRafLoopRunning]);

  // Update indicator overlays
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const existing = overlaySeriesMapRef.current;
    const incomingIds = new Set(overlays.map((o) => o.id));

    for (const [id, series] of existing.entries()) {
      if (!incomingIds.has(id)) {
        chart.removeSeries(series);
        existing.delete(id);
      }
    }

    for (const ov of overlays) {
      let series = existing.get(ov.id);
      const lineStyle =
        ov.lineStyle === 'dashed'
          ? LineStyle.Dashed
          : ov.lineStyle === 'dotted'
          ? LineStyle.Dotted
          : LineStyle.Solid;

      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: ov.color,
          lineWidth: (ov.lineWidth ?? 2) as 1 | 2 | 3 | 4,
          lineStyle,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        existing.set(ov.id, series);
      } else {
        series.applyOptions({
          color: ov.color,
          lineWidth: (ov.lineWidth ?? 2) as 1 | 2 | 3 | 4,
          lineStyle,
        });
      }

      series.setData(ov.data.map((pt) => ({ time: pt.time as Time, value: pt.value })));
    }
  }, [overlays]);

  // Update Support & Resistance price lines
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) return;

    for (const pl of priceLinesRef.current) {
      candleSeries.removePriceLine(pl);
    }
    priceLinesRef.current = [];

    for (const s of supportLevels.slice(0, 2)) {
      priceLinesRef.current.push(
        candleSeries.createPriceLine({
          price: s,
          color: 'rgba(16, 185, 129, 0.45)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'S',
        })
      );
    }
    for (const r of resistanceLevels.slice(0, 2)) {
      priceLinesRef.current.push(
        candleSeries.createPriceLine({
          price: r,
          color: 'rgba(239, 68, 68, 0.45)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'R',
        })
      );
    }
  }, [supportLevels, resistanceLevels]);

  const handleZoom = useCallback((direction: 'in' | 'out') => {
    const chart = chartRef.current;
    if (!chart) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const span = range.to - range.from;
    const delta = span * 0.2;
    const nextFrom = direction === 'in' ? range.from + delta : range.from - delta;
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, nextFrom),
      to: range.to,
    });
  }, []);

  const handleResetZoom = useCallback(() => {
    const chart = chartRef.current;
    if (!chart || candles.length === 0) return;
    const visibleCount = Math.min(candles.length, 75);
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, candles.length - visibleCount),
      to: candles.length + 2,
    });
  }, [candles.length]);

  const legendOverlays = useMemo(() => overlays.slice(0, 6), [overlays]);
  const latestBar = renderedBarRef.current ?? candles[candles.length - 1];
  const activeBar = readout ?? (latestBar ? { ...latestBar, time: '' } : null);

  return (
    <div
      className={`relative flex flex-col bg-[#0B0C10] overflow-hidden ${
        fullHeight ? 'flex-1 h-full border-0 rounded-none' : 'rounded-2xl border border-[#D4AF37]/35 shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)]'
      }`}
    >
      {/* Compact OHLC Readout & Chart Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-[#D4AF37]/20 bg-[#101217]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono tabular-nums text-zinc-400">
          <span className="font-semibold text-[#F5D061]">{timeframe}</span>
          {activeBar && (
            <>
              <span>
                O{' '}
                <strong ref={readout ? undefined : ohlcOpenRef} className="text-zinc-200">
                  {activeBar.open.toFixed(2)}
                </strong>
              </span>
              <span>
                H{' '}
                <strong ref={readout ? undefined : ohlcHighRef} className="text-zinc-200">
                  {activeBar.high.toFixed(2)}
                </strong>
              </span>
              <span>
                L{' '}
                <strong ref={readout ? undefined : ohlcLowRef} className="text-zinc-200">
                  {activeBar.low.toFixed(2)}
                </strong>
              </span>
              <span>
                C{' '}
                <strong ref={readout ? undefined : ohlcCloseRef} className="text-zinc-200">
                  {activeBar.close.toFixed(2)}
                </strong>
              </span>
              {activeBar.time && <span className="text-zinc-500">{activeBar.time}</span>}
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => handleZoom('in')}
            aria-label="Zoom in chart"
            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-zinc-400 hover:text-[#F5D061] hover:bg-white/5 transition-colors"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => handleZoom('out')}
            aria-label="Zoom out chart"
            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-zinc-400 hover:text-[#F5D061] hover:bg-white/5 transition-colors"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleResetZoom}
            aria-label="Reset chart scale"
            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-zinc-400 hover:text-[#F5D061] hover:bg-white/5 transition-colors"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh chart data"
            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-zinc-400 hover:text-[#F5D061] hover:bg-white/5 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-[#D4AF37]' : ''}`} />
          </button>
        </div>
      </div>

      {/* Overlay Legend (Unboxed Metadata Text) */}
      {overlays.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 bg-[#0B0C10] border-b border-[#D4AF37]/15 text-[11px] font-mono text-zinc-400">
          {legendOverlays.map((ov) => (
            <span key={ov.id} className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span className="w-2.5 h-0.5 inline-block" style={{ backgroundColor: ov.color }} />
              <span>{ov.label}</span>
            </span>
          ))}
          {overlays.length > 6 && <span className="text-zinc-500">+{overlays.length - 6} more</span>}
        </div>
      )}

      {/* Chart Canvas */}
      <div
        className={`relative w-full ${
          fullHeight ? 'flex-1 min-h-0' : 'h-[300px] sm:h-[340px] lg:h-[420px]'
        }`}
      >
        <div ref={containerRef} className="w-full h-full touch-pan-x" />

        {loading && candles.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0B0C10]/90 text-zinc-400 gap-2">
            <RefreshCw className="w-5 h-5 animate-spin text-[#D4AF37]" />
            <span className="text-xs font-medium">Loading XAUUSD candles...</span>
          </div>
        )}

        {error && candles.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0B0C10]/95 p-6 text-center gap-3">
            <span className="text-sm font-semibold text-red-400">DATA UNAVAILABLE</span>
            <p className="text-xs text-zinc-400 max-w-sm">{error}</p>
            <button
              type="button"
              onClick={onRefresh}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#D4AF37] text-[#09090B] text-xs font-semibold hover:bg-[#F5D061] transition-colors"
            >
              Retry Market Feed
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
