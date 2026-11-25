import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Bell, BellOff, CandlestickChart, Check, ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, FileText, Maximize2, Minus, RefreshCw, ShieldAlert, Sparkles, Trash2, TrendingDown, TrendingUp, Wand2 } from 'lucide-react';
import {
  AUTO_PERFECT_TIMEFRAMES,
  createAutoPerfectIndicators,
  createDefaultIndicators,
  INDICATOR_CATALOG,
  isAutoPerfectPresetSelected,
} from '../constants/indicators.ts';
import { useLiveQuoteState } from '../contexts/LiveQuoteContext.tsx';
import type {
  AnalysisReport,
  Candle,
  CandleDataset,
  ChartOverlaySeries,
  IndicatorCategory,
  IndicatorId,
  MarketSentiment24h,
  NewsProtectionState,
  SelectedIndicatorConfig,
  Timeframe,
} from '../types/market.ts';
import {
  enableAndTestPhoneAlerts,
  getNotificationPermissionState,
  isPhoneAlertsEnabled,
  sendTestPhoneNotification,
  setPhoneAlertsEnabledPref,
  subscribeNotificationPermissionSync,
  subscribePhoneAlertsPrefChange,
  unsubscribeWebPush,
  type NotificationPermissionState,
} from '../utils/phoneNotifications.ts';
import { fetchWithTimeout, safeFixed, safeLocaleDateTime, safeLocaleTime } from '../utils/format.ts';
import { isMarketClosedStatus } from '../utils/marketHours.ts';
import { getReportSignalConfidence } from '../utils/signalConfidence.ts';
import { AnalysisProcessingModal } from './AnalysisProcessingModal.tsx';
import { AnalysisResultView } from './AnalysisResultView.tsx';
import { IndicatorSelector } from './IndicatorSelector.tsx';
import { LeaderChartFullView } from './LeaderChartFullView.tsx';
import { MarketSentimentWidget } from './MarketSentimentWidget.tsx';
import { SmoothedPriceText } from './SmoothedPriceText.tsx';
import { TimeframeSelector } from './TimeframeSelector.tsx';
import { XauUsdChart } from './XauUsdChart.tsx';

const EMPTY_CANDLES: Candle[] = [];

interface TradeViewProps {
  isActive?: boolean;
  reports: AnalysisReport[];
  reportsLoading: boolean;
  newsProtection: NewsProtectionState | null;
  onRefreshQuote: () => void;
  onReportSaved: (report: AnalysisReport) => void;
  onDeleteReport: (id: string) => Promise<void>;
  onNewsProtectionSync?: (protection: NewsProtectionState) => void;
}

const TradeLivePriceStrip = memo(function TradeLivePriceStrip({
  dataset,
  lastCandleClose,
  enabled,
  onRefreshAll,
}: {
  dataset: CandleDataset | null;
  lastCandleClose: number | null;
  enabled: boolean;
  onRefreshAll: () => void;
}) {
  const { quote, error: quoteError } = useLiveQuoteState();

  const rawDisplayPrice =
    quote && quote.freshness !== 'UNAVAILABLE' && quote.mid > 0
      ? quote.mid
      : lastCandleClose;

  const freshnessLabel =
    quote && quote.freshness !== 'UNAVAILABLE'
      ? quote.freshness
      : dataset?.freshness ?? 'UNAVAILABLE';

  const latestDataTs =
    quote?.freshness !== 'UNAVAILABLE' && quote?.timestamp
      ? quote.timestamp
      : dataset?.latestTimestamp ?? null;

  const marketClosed = isMarketClosedStatus(freshnessLabel, latestDataTs);

  const formattedUpdatedTime = useMemo(() => {
    if (!latestDataTs) return null;
    const formatted = safeLocaleTime(
      latestDataTs,
      {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      },
      ''
    );
    return formatted || null;
  }, [latestDataTs]);

  return (
    <section className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
            <span className="font-semibold text-[#F5D061]">XAU/USD</span>
            <span>·</span>
            <span>Spot Gold / US Dollar</span>
            <span>·</span>
            <span
              className={`inline-flex items-center gap-1.5 font-semibold ${
                freshnessLabel === 'LIVE'
                  ? 'text-emerald-400'
                  : marketClosed || freshnessLabel === 'UNAVAILABLE'
                  ? 'text-red-400'
                  : 'text-amber-400'
              }`}
            >
              {freshnessLabel === 'LIVE' && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              )}
              {marketClosed && (
                <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
              )}
              {freshnessLabel === 'UNAVAILABLE'
                ? 'DATA UNAVAILABLE'
                : marketClosed
                ? 'MARKET CLOSED'
                : freshnessLabel}
            </span>
          </div>

          {rawDisplayPrice != null ? (
            <div className="flex items-baseline gap-3">
              <SmoothedPriceText
                value={rawDisplayPrice}
                enabled={enabled}
                flashOnMove
                className="text-3xl sm:text-4xl font-mono font-bold tabular-nums tracking-tight transition-colors duration-200"
              />
              {quote?.changeAbs != null && quote?.changePct != null && (
                <span
                  className={`text-xs font-mono font-semibold tabular-nums ${
                    quote.changeAbs >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {quote.changeAbs >= 0 ? '+' : ''}
                  {safeFixed(quote.changeAbs)} ({quote.changePct >= 0 ? '+' : ''}
                  {safeFixed(quote.changePct)}%)
                </span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-red-400 text-sm font-semibold py-1">
              <AlertCircle className="w-4 h-4" />
              <span>DATA UNAVAILABLE — Cannot display spot price</span>
            </div>
          )}
        </div>

        <div className="flex flex-col sm:items-end gap-1 text-xs font-mono tabular-nums text-zinc-400">
          {quote && quote.freshness !== 'UNAVAILABLE' && (
            <div>
              Bid <span className="text-zinc-200">${safeFixed(quote.bid)}</span> · Ask{' '}
              <span className="text-zinc-200">${safeFixed(quote.ask)}</span> · Spread{' '}
              <span className="text-zinc-200">${safeFixed(quote.spread)}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span>
              {formattedUpdatedTime
                ? `Updated ${formattedUpdatedTime}`
                : quoteError || 'Awaiting feed'}
            </span>
            <button
              type="button"
              onClick={onRefreshAll}
              aria-label="Refresh quote"
              className="p-1.5 rounded-lg text-zinc-400 hover:text-[#F5D061] hover:bg-white/5 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {dataset && (
        <div className="mt-2.5 pt-2.5 border-t border-[#D4AF37]/20 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-zinc-500">
          <span>Candles: {dataset.candleSource}</span>
          <span>{dataset.volumeNote}</span>
        </div>
      )}
    </section>
  );
});

export const TradeView = memo(function TradeView({
  isActive = true,
  reports,
  reportsLoading,
  newsProtection,
  onRefreshQuote,
  onReportSaved,
  onDeleteReport,
  onNewsProtectionSync,
}: TradeViewProps) {
  const [activeChartTimeframe, setActiveChartTimeframe] = useState<Timeframe>('15m');
  const [selectedTimeframes, setSelectedTimeframes] = useState<Timeframe[]>(['1m', '5m', '15m', '1H']);
  const [indicators, setIndicators] = useState<SelectedIndicatorConfig[]>(() => createDefaultIndicators());

  const [dataset, setDataset] = useState<CandleDataset | null>(null);
  const [supportLevels, setSupportLevels] = useState<number[]>([]);
  const [resistanceLevels, setResistanceLevels] = useState<number[]>([]);
  const [overlays, setOverlays] = useState<ChartOverlaySeries[]>([]);
  const [overlayRefreshSeq, setOverlayRefreshSeq] = useState(0);
  const [chartLoading, setChartLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const [showChart, setShowChart] = useState(false);
  const [leaderViewOpen, setLeaderViewOpen] = useState(false);

  const [sentiment, setSentiment] = useState<MarketSentiment24h | null>(null);
  const [sentimentLoading, setSentimentLoading] = useState(true);
  const [sentimentError, setSentimentError] = useState<string | null>(null);

  const [analyzing, setAnalyzing] = useState(false);
  const [stageIndex, setStageIndex] = useState(0);
  const [analysisErrStatus, setAnalysisErrStatus] = useState<string | null>(null);
  const [analysisErrMsg, setAnalysisErrMsg] = useState<string | null>(null);
  const [activeReport, setActiveReport] = useState<AnalysisReport | null>(null);
  const [showAnalysisHistory, setShowAnalysisHistory] = useState(false);
  const [deletingReportId, setDeletingReportId] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const stageTimersRef = useRef<number[]>([]);
  const datasetRef = useRef<CandleDataset | null>(null);
  datasetRef.current = dataset;
  const sentimentRef = useRef<MarketSentiment24h | null>(null);
  sentimentRef.current = sentiment;
  const [phoneAlertsEnabled, setPhoneAlertsEnabled] = useState<boolean>(() => isPhoneAlertsEnabled());
  const [notificationPerm, setNotificationPerm] = useState<NotificationPermissionState>(() =>
    getNotificationPermissionState()
  );
  const [alertFeedback, setAlertFeedback] = useState<string | null>(null);
  const [testingAlert, setTestingAlert] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stageTimersRef.current.forEach((id) => clearTimeout(id));
      stageTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    const unsubPref = subscribePhoneAlertsPrefChange(setPhoneAlertsEnabled);
    const unsubPerm = subscribeNotificationPermissionSync(setNotificationPerm);
    return () => {
      unsubPref();
      unsubPerm();
    };
  }, []);

  const isNewsBlocked = newsProtection?.blocked === true;

  // Never let a previously generated BUY/SELL report stay displayed as current when news-block engages
  useEffect(() => {
    if (isNewsBlocked) {
      setActiveReport(null);
      setAnalyzing(false);
    }
  }, [isNewsBlocked]);

  const handleTogglePhoneAlerts = useCallback(async () => {
    if (phoneAlertsEnabled) {
      setPhoneAlertsEnabledPref(false);
      setPhoneAlertsEnabled(false);
      setAlertFeedback(null);
      void unsubscribeWebPush();
      return;
    }
    const result = await enableAndTestPhoneAlerts();
    setPhoneAlertsEnabled(result.alertsEnabled);
    setNotificationPerm(result.permissionState);
    setAlertFeedback(result.message);
  }, [phoneAlertsEnabled]);

  const handleTestPhoneAlert = useCallback(async () => {
    setTestingAlert(true);
    try {
      const result = await sendTestPhoneNotification();
      setNotificationPerm(result.permissionState);
      setAlertFeedback(result.message);
    } finally {
      setTestingAlert(false);
    }
  }, []);

  const loadChartData = useCallback(async (tf: Timeframe, showSpinner = false) => {
    if (showSpinner) setChartLoading(true);
    try {
      const candlesRes = await fetchWithTimeout(
        `/api/market/candles?timeframe=${encodeURIComponent(tf)}`,
        { cache: 'no-store' },
        15_000
      );
      if (!candlesRes.ok) {
        const errJson = await candlesRes.json().catch(() => ({}));
        throw new Error(errJson.error || 'Market candle feed unavailable');
      }

      const cJson = await candlesRes.json();
      if (!mountedRef.current) return;
      setDataset(cJson.dataset);
      setSupportLevels(Array.isArray(cJson.supportLevels) ? cJson.supportLevels : []);
      setResistanceLevels(Array.isArray(cJson.resistanceLevels) ? cJson.resistanceLevels : []);
      setChartError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      if (!datasetRef.current || datasetRef.current.timeframe !== tf) {
        setChartError(err instanceof Error ? err.message : 'Unable to load XAUUSD chart data');
      }
    } finally {
      if (mountedRef.current) setChartLoading(false);
    }
  }, []);

  const loadSentiment = useCallback(async () => {
    try {
      const res = await fetchWithTimeout('/api/market/sentiment', { cache: 'no-store' }, 12_000);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.sentiment) {
        throw new Error(json.error || 'DATA UNAVAILABLE');
      }
      if (!mountedRef.current) return;
      setSentiment(json.sentiment);
      setSentimentError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      if (!sentimentRef.current) {
        setSentimentError(err instanceof Error ? err.message : 'DATA UNAVAILABLE');
      }
    } finally {
      if (mountedRef.current) setSentimentLoading(false);
    }
  }, []);

  const showingReport = activeReport !== null;

  // Load candles on timeframe change or tab re-activation; pause polling when tab inactive or report open
  useEffect(() => {
    if (!isActive || showingReport) return;
    const needsSpinner = !datasetRef.current || datasetRef.current.timeframe !== activeChartTimeframe;
    void loadChartData(activeChartTimeframe, needsSpinner);
    const pollMs = showChart || leaderViewOpen ? 20_000 : 60_000;
    const interval = setInterval(() => {
      if (!document.hidden) {
        void loadChartData(activeChartTimeframe, false);
      }
    }, pollMs);
    return () => clearInterval(interval);
  }, [activeChartTimeframe, loadChartData, showChart, leaderViewOpen, isActive, showingReport]);

  // Trigger an immediate quote sync when opening either chart
  useEffect(() => {
    if (!isActive || (!showChart && !leaderViewOpen)) return;
    onRefreshQuote();
  }, [isActive, showChart, leaderViewOpen, onRefreshQuote]);

  // Load 24h Market Sentiment & poll every 60s only while TRADE tab is active
  useEffect(() => {
    if (!isActive || showingReport) return;
    void loadSentiment();
    const interval = setInterval(() => {
      if (!document.hidden) {
        void loadSentiment();
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, [loadSentiment, isActive, showingReport]);

  // Single unified effect for chart overlays (only fires once per indicator/timeframe/refresh change)
  useEffect(() => {
    if (!isActive || showingReport) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout(
          '/api/market/overlays',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timeframe: activeChartTimeframe, indicators }),
          },
          12_000
        );
        if (!res.ok || cancelled) return;
        const json = await res.json();
        if (!cancelled && Array.isArray(json.overlays)) {
          setOverlays(json.overlays);
        }
      } catch {
        // Non-fatal overlay refresh error
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [indicators, activeChartTimeframe, overlayRefreshSeq, isActive, showingReport]);

  const handleToggleAnalysisTimeframe = useCallback((tf: Timeframe) => {
    setSelectedTimeframes((prev) => {
      if (prev.includes(tf)) {
        if (prev.length === 1) return prev; // Keep at least 1 timeframe selected
        return prev.filter((item) => item !== tf);
      }
      return [...prev, tf];
    });
  }, []);

  const handleToggleIndicator = useCallback((id: IndicatorId) => {
    setIndicators((prev) =>
      prev.map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item))
    );
  }, []);

  const handleUpdateParam = useCallback((id: IndicatorId, key: string, value: number) => {
    setIndicators((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, params: { ...item.params, [key]: value } } : item
      )
    );
  }, []);

  const handleResetIndicatorDefaults = useCallback(() => {
    setIndicators(createDefaultIndicators());
  }, []);

  const handleBulkCategoryToggle = useCallback((category: IndicatorCategory, enable: boolean) => {
    const ids = new Set(INDICATOR_CATALOG.filter((d) => d.category === category).map((d) => d.id));
    setIndicators((prev) =>
      prev.map((item) => (ids.has(item.id) ? { ...item, enabled: enable } : item))
    );
  }, []);

  const handleEnableAllIndicators = useCallback(() => {
    setIndicators((prev) => prev.map((item) => ({ ...item, enabled: true })));
  }, []);

  const handleApplyAutoPreset = useCallback(() => {
    setSelectedTimeframes([...AUTO_PERFECT_TIMEFRAMES]);
    setIndicators(createAutoPerfectIndicators());
    setActiveChartTimeframe('15m');
  }, []);

  const handleSelectChartTimeframe = useCallback((tf: Timeframe) => {
    setActiveChartTimeframe(tf);
    setSelectedTimeframes((prev) => (prev.includes(tf) ? prev : [...prev, tf]));
  }, []);

  const handleRefreshAll = useCallback(() => {
    onRefreshQuote();
    void loadChartData(activeChartTimeframe, false);
    setOverlayRefreshSeq((s) => s + 1);
    void loadSentiment();
  }, [onRefreshQuote, loadChartData, activeChartTimeframe, loadSentiment]);

  const handleRefreshChartSpinner = useCallback(() => {
    void loadChartData(activeChartTimeframe, true);
    setOverlayRefreshSeq((s) => s + 1);
  }, [loadChartData, activeChartTimeframe]);

  const handleCandleRollover = useCallback(() => {
    void loadChartData(activeChartTimeframe, false);
  }, [loadChartData, activeChartTimeframe]);

  const handleRefreshLeader = useCallback(() => {
    onRefreshQuote();
    void loadChartData(activeChartTimeframe, true);
  }, [onRefreshQuote, loadChartData, activeChartTimeframe]);

  const handleRunAnalysis = async () => {
    if (isNewsBlocked) return;
    const enabledCount = indicators.filter((i) => i.enabled).length;
    if (enabledCount === 0 || selectedTimeframes.length === 0) return;

    stageTimersRef.current.forEach((id) => clearTimeout(id));
    stageTimersRef.current = [];

    setAnalyzing(true);
    setStageIndex(0);
    setAnalysisErrStatus(null);
    setAnalysisErrMsg(null);

    // Honest early-stage timer while request executes; never advances past stage 3 until API resolves
    stageTimersRef.current.push(window.setTimeout(() => setStageIndex((s) => Math.max(s, 1)), 240));
    stageTimersRef.current.push(window.setTimeout(() => setStageIndex((s) => Math.max(s, 2)), 520));
    stageTimersRef.current.push(window.setTimeout(() => setStageIndex((s) => Math.max(s, 3)), 850));

    try {
      const res = await fetchWithTimeout(
        '/api/analyze',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            timeframes: selectedTimeframes,
            indicators,
          }),
        },
        30_000
      );

      const json = await res.json().catch(() => ({}));
      stageTimersRef.current.forEach((id) => clearTimeout(id));
      stageTimersRef.current = [];
      if (!mountedRef.current) return;

      if (res.status === 423 && json.newsProtection) {
        onNewsProtectionSync?.(json.newsProtection as NewsProtectionState);
        setAnalyzing(false);
        return;
      }

      if (!res.ok || !json.report) {
        setAnalysisErrStatus(json.status || 'DATA UNAVAILABLE');
        setAnalysisErrMsg(
          json.error || 'Real XAUUSD market data could not be verified. No classification was generated.'
        );
        return;
      }

      setStageIndex(6);
      onReportSaved(json.report);
      setActiveReport(json.report);
      setAnalyzing(false);
    } catch (err) {
      stageTimersRef.current.forEach((id) => clearTimeout(id));
      stageTimersRef.current = [];
      if (!mountedRef.current) return;
      setAnalysisErrStatus('DATA UNAVAILABLE');
      setAnalysisErrMsg(
        err instanceof Error ? err.message : 'Network connection failed while analysing XAUUSD data.'
      );
    }
  };

  const enabledIndicatorCount = useMemo(
    () => indicators.filter((i) => i.enabled).length,
    [indicators]
  );
  const isAutoPresetActive = useMemo(
    () => isAutoPerfectPresetSelected(selectedTimeframes, indicators),
    [selectedTimeframes, indicators]
  );
  const showVolumeOnChart = useMemo(
    () => indicators.some((i) => i.id === 'volume' && i.enabled),
    [indicators]
  );
  const chartCandles = useMemo(
    () => dataset?.candles ?? EMPTY_CANDLES,
    [dataset?.candles]
  );
  const lastCandleClose = chartCandles.length > 0 ? chartCandles[chartCandles.length - 1].close : null;

  const savedHistoryItems = useMemo(
    () =>
      reports.map((report) => ({
        report,
        dt: safeLocaleDateTime(report.createdAt, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        confidence: getReportSignalConfidence(report),
      })),
    [reports]
  );

  const handleDeleteSavedReport = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      setDeletingReportId(id);
      try {
        await onDeleteReport(id);
      } finally {
        setDeletingReportId(null);
      }
    },
    [onDeleteReport]
  );

  if (activeReport) {
    return (
      <AnalysisResultView
        report={activeReport}
        onBack={() => setActiveReport(null)}
        backLabel="Back to XAUUSD Chart"
      />
    );
  }

  return (
    <div className="space-y-4 pb-6">
      {/* Live XAUUSD Price Strip (Isolated subscriber so ticks never re-render TradeView body) */}
      <TradeLivePriceStrip
        dataset={dataset}
        lastCandleClose={lastCandleClose}
        enabled={isActive && !activeReport}
        onRefreshAll={handleRefreshAll}
      />

      {/* High-Impact USD News Warning Box (positioned between Live Price & LEADER Section) */}
      {newsProtection && newsProtection.warningActive && (
        <section
          role="alert"
          aria-label="High Impact News Warning"
          className="rounded-2xl border border-red-500/80 bg-gradient-to-r from-[#280B0F] via-[#1C0A0E] to-[#280B0F] px-4 py-3.5 shadow-[0_0_26px_-4px_rgba(239,68,68,0.68)] space-y-1.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
              <span className="text-sm sm:text-base font-display font-bold tracking-wider text-red-400 drop-shadow-[0_0_10px_rgba(248,113,113,0.7)]">
                {newsProtection.safeFallbackActive
                  ? 'NEWS DATA UNVERIFIED — TRADING PAUSED'
                  : newsProtection.blocked
                  ? 'HIGH IMPACT NEWS — TRADING PAUSED'
                  : 'HIGH IMPACT NEWS COMING'}
              </span>
            </div>
            {(newsProtection.activeEvent || newsProtection.upcomingEvent) && (
              <span className="text-[11px] font-mono font-bold text-red-300 tabular-nums">
                {(newsProtection.activeEvent ?? newsProtection.upcomingEvent)!.istTimeLabel} IST
                {newsProtection.minutesToEvent != null && !newsProtection.blocked
                  ? ` · in ${newsProtection.minutesToEvent}m`
                  : ''}
              </span>
            )}
          </div>
          <p className="text-xs text-red-100/90 leading-relaxed">
            {newsProtection.subtext}
          </p>
        </section>
      )}

      {/* Responsive 2-Column Workstation on Desktop, Vertical Thumb Flow on Mobile */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        <div className="lg:col-span-8 space-y-4">
          {/* Leader Chart View Only */}
          <div className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] px-4 py-4 flex flex-col sm:grid sm:grid-cols-3 items-center gap-3">
            <div className="hidden sm:block" aria-hidden="true" />
            <div className="text-center font-display text-lg sm:text-xl font-bold tracking-[0.24em] text-zinc-100 uppercase select-none">
              LIVE
            </div>

            <button
              type="button"
              onClick={() => setLeaderViewOpen(true)}
              className="w-full sm:w-auto sm:justify-self-end min-h-[44px] px-4 py-2 rounded-xl bg-[#181A20] border border-[#D4AF37]/50 text-xs font-semibold inline-flex items-center justify-center gap-2 hover:bg-[#D4AF37]/10 transition-colors whitespace-nowrap shrink-0"
            >
              <Maximize2 className="w-3.5 h-3.5 text-[#F5D061]" />
              <span>
                <span className="text-[#F5D061] font-bold">LEADER</span>{' '}
                <span className="text-zinc-100">Chart View Only</span>
              </span>
            </button>
          </div>

          <MarketSentimentWidget
            sentiment={sentiment}
            loading={sentimentLoading}
            error={sentimentError}
          />
        </div>

        <div className="lg:col-span-4 space-y-4">
          {/* Indicator Configuration Section */}
          <IndicatorSelector
            indicators={indicators}
            onToggleIndicator={handleToggleIndicator}
            onUpdateParam={handleUpdateParam}
            onResetDefaults={handleResetIndicatorDefaults}
            onBulkCategoryToggle={handleBulkCategoryToggle}
            onEnableAllIndicators={handleEnableAllIndicators}
          />

          {/* Main Analysis Control Panel (Replaced by HIGH IMPACT NEWS block during news lock) */}
          {isNewsBlocked ? (
            <section
              role="status"
              aria-label="Analysis Paused For High Impact News"
              className="rounded-2xl border border-red-500/80 bg-[#1B0B0F] p-5 shadow-[0_0_24px_-6px_rgba(239,68,68,0.65)] text-center space-y-3"
            >
              <div className="mx-auto w-11 h-11 rounded-2xl bg-red-500/15 border border-red-500/50 flex items-center justify-center text-red-400">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div className="text-2xl font-display font-bold tracking-wider text-red-500 drop-shadow-[0_0_12px_rgba(239,68,68,0.65)]">
                HIGH IMPACT NEWS
              </div>
              {newsProtection?.safeFallbackActive && (
                <div className="text-[11px] font-mono font-bold text-amber-300 uppercase tracking-wider">
                  News Data Unavailable / Unverified — Safe Fallback Active
                </div>
              )}
              <p className="text-xs text-red-100/90 leading-relaxed">
                {newsProtection?.subtext ||
                  'High-impact USD news protection active. Normal XAUUSD analysis and BUY/SELL entry signals are paused until market volatility and data stabilize.'}
              </p>
              {newsProtection?.activeEvent && (
                <div className="rounded-xl bg-[#12080B] border border-red-500/30 px-3 py-2 text-[11px] font-mono text-red-200 space-y-0.5">
                  <div className="font-bold text-red-300">{newsProtection.activeEvent.title}</div>
                  <div>
                    USD · RED HIGH IMPACT · {newsProtection.activeEvent.istTimeLabel} IST
                  </div>
                </div>
              )}
              <div className="text-[11px] font-mono text-zinc-400 pt-1">
                {newsProtection?.marketStability.volatilityDetail}
              </div>
            </section>
          ) : (
            <section
              aria-label="Analysis Control Panel"
              className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] p-4 space-y-3.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-[#D4AF37]/20">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[#F5D061]">
                    Analysis Control Panel
                  </div>
                  <h2 className="text-sm font-display font-semibold text-zinc-100 mt-0.5">
                    Scope & Execution
                  </h2>
                </div>
                <div className="flex items-center gap-2.5 ml-auto">
                  <div className="text-[11px] font-mono tabular-nums text-zinc-400">
                    {selectedTimeframes.length} TF × {enabledIndicatorCount} Ind
                  </div>
                  <button
                    type="button"
                    onClick={handleApplyAutoPreset}
                    aria-pressed={isAutoPresetActive}
                    title="Auto-select 1m, 5m, 15m, 1H + all 11 core technical indicators"
                    className={`min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap border ${
                      isAutoPresetActive
                        ? 'bg-emerald-500/15 border-emerald-500/45 text-emerald-400'
                        : 'bg-[#181A20] border-[#D4AF37]/45 text-[#F5D061] hover:bg-[#D4AF37]/15'
                    }`}
                  >
                    {isAutoPresetActive ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Wand2 className="w-3.5 h-3.5" />
                    )}
                    <span>Auto</span>
                  </button>
                </div>
              </div>

              <TimeframeSelector
                embedded
                mode="analysis-only"
                activeChartTimeframe={activeChartTimeframe}
                selectedTimeframes={selectedTimeframes}
                onSelectChartTimeframe={handleSelectChartTimeframe}
                onToggleAnalysisTimeframe={handleToggleAnalysisTimeframe}
                onSetPresetTimeframes={setSelectedTimeframes}
              />

              {/* Prominent Gold Execute Button */}
              <div className="pt-2.5 border-t border-[#D4AF37]/20 space-y-2">
                <button
                  type="button"
                  onClick={handleRunAnalysis}
                  disabled={analyzing || enabledIndicatorCount === 0 || selectedTimeframes.length === 0}
                  className="w-full min-h-[54px] px-6 py-3.5 rounded-2xl bg-gradient-to-r from-[#F5D061] via-[#D4AF37] to-[#C29724] text-[#09090B] font-display font-bold text-sm tracking-wide inline-flex items-center justify-center gap-2.5 shadow-lg shadow-[#D4AF37]/15 hover:brightness-105 active:scale-[0.99] transition-all disabled:opacity-45 disabled:pointer-events-none"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>ANALYSE XAUUSD</span>
                </button>
                <p className="text-[11px] text-center font-mono tabular-nums text-zinc-500">
                  Processes {selectedTimeframes.length} timeframe(s) × {enabledIndicatorCount} indicator(s)
                </p>
              </div>
            </section>
          )}

          {/* Alert Settings */}
          <section
            aria-label="Phone Alert Settings"
            className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] px-4 py-3 space-y-2.5"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <div
                  className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${
                    phoneAlertsEnabled && notificationPerm === 'granted'
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400'
                      : phoneAlertsEnabled
                      ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                      : 'bg-[#181A20] border-[#D4AF37]/25 text-zinc-400'
                  }`}
                >
                  {phoneAlertsEnabled ? (
                    <Bell className="w-4 h-4" />
                  ) : (
                    <BellOff className="w-4 h-4" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-zinc-100">Enable Phone Alerts</div>
                  <div className="text-[11px] font-mono text-zinc-400 truncate">
                    {!phoneAlertsEnabled
                      ? 'OFF · Tap to enable signal alerts'
                      : notificationPerm === 'granted'
                      ? 'ON · Background Push, Sound & Vibration active'
                      : notificationPerm === 'denied'
                      ? 'Sound ON · OS Push blocked in site settings'
                      : notificationPerm === 'unsupported'
                      ? 'Sound ON · Install app for OS push alerts'
                      : 'Sound ON · Tap Test to allow OS push popups'}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {phoneAlertsEnabled && (
                  <button
                    type="button"
                    onClick={() => void handleTestPhoneAlert()}
                    disabled={testingAlert}
                    className="min-h-[30px] px-2.5 rounded-lg bg-[#181A20] border border-[#D4AF37]/40 text-[11px] font-mono font-semibold text-[#F5D061] hover:bg-[#D4AF37]/15 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {testingAlert ? 'Testing...' : notificationPerm === 'default' ? 'Allow' : 'Test'}
                  </button>
                )}

                <button
                  type="button"
                  role="switch"
                  aria-checked={phoneAlertsEnabled}
                  aria-label="Enable Phone Alerts"
                  onClick={handleTogglePhoneAlerts}
                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border transition-colors ${
                    phoneAlertsEnabled
                      ? notificationPerm === 'granted'
                        ? 'bg-emerald-500 border-emerald-400'
                        : 'bg-amber-500 border-amber-400'
                      : 'bg-[#181A20] border-[#D4AF37]/30'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                      phoneAlertsEnabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>

            {(alertFeedback || (phoneAlertsEnabled && notificationPerm === 'denied')) && (
              <div
                className={`rounded-xl border px-3 py-2 text-[11px] leading-relaxed ${
                  notificationPerm === 'granted'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                    : 'border-amber-500/35 bg-amber-500/10 text-amber-200'
                }`}
              >
                {alertFeedback ||
                  'Browser notifications are blocked for this site. Tap the lock/settings icon in your browser address bar and allow Notifications.'}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Saved ANALYSE XAUUSD Result History Option (Tap to expand history inside) */}
      <section aria-label="Saved Analysis History" className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] overflow-hidden">
        <button
          type="button"
          onClick={() => setShowAnalysisHistory((prev) => !prev)}
          aria-expanded={showAnalysisHistory}
          className="w-full px-4 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-[#D4AF37]/[0.04] transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[#D4AF37]/12 border border-[#D4AF37]/35 flex items-center justify-center text-[#F5D061] shrink-0">
              <FileText className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs sm:text-sm font-display font-semibold text-zinc-100 truncate">
                  Saved XAUUSD Analysis History
                </span>
                <span className="px-2 py-0.5 rounded-md bg-[#181A20] border border-[#D4AF37]/30 text-[11px] font-mono font-bold text-[#F5D061] tabular-nums shrink-0">
                  {reports.length}
                </span>
              </div>
              <div className="text-[11px] font-mono text-zinc-400 truncate">
                {showAnalysisHistory
                  ? 'Tap any saved result below · Tap header to close'
                  : reports.length > 0
                  ? `Latest: ${reports[0].strategyEvaluation?.action ?? reports[0].classification} · $${safeFixed(reports[0].spotPrice)} · Tap to open history`
                  : 'Tap to open saved XAUUSD analysis history'}
              </div>
            </div>
          </div>

          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#181A20] border border-[#D4AF37]/30 text-xs font-semibold text-[#F5D061] shrink-0">
            <span>{showAnalysisHistory ? 'Hide' : 'Open'}</span>
            {showAnalysisHistory ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </div>
        </button>

        {showAnalysisHistory && (
          <div className="px-4 pb-4 pt-2 border-t border-[#D4AF37]/20 space-y-2.5">
            {reportsLoading && savedHistoryItems.length === 0 ? (
              <div className="h-16 rounded-xl border border-[#D4AF37]/25 bg-[#0D0E12] animate-pulse" />
            ) : savedHistoryItems.length === 0 ? (
              <div className="rounded-xl border border-[#D4AF37]/25 bg-[#0D0E12] p-4 text-center text-xs text-zinc-400">
                No saved analysis results yet. Tap <span className="text-[#F5D061] font-semibold">ANALYSE XAUUSD</span> above — every generated result stays saved here automatically.
              </div>
            ) : (
              <div className="space-y-2 max-h-[360px] overflow-y-auto pr-0.5">
                {savedHistoryItems.map(({ report, dt, confidence }, idx) => {
                  const classColor =
                    report.classification === 'BUY'
                      ? 'text-emerald-400'
                      : report.classification === 'SELL'
                      ? 'text-red-400'
                      : 'text-[#F5D061]';
                  const Icon =
                    report.classification === 'BUY'
                      ? TrendingUp
                      : report.classification === 'SELL'
                      ? TrendingDown
                      : Minus;

                  return (
                    <div
                      key={report.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setActiveReport(report)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setActiveReport(report);
                        }
                      }}
                      className="rounded-xl border border-[#D4AF37]/25 bg-[#0D0E12] hover:border-[#D4AF37]/55 px-3.5 py-2.5 flex items-center justify-between gap-3 cursor-pointer transition-colors"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className={`inline-flex items-center gap-1 text-xs sm:text-sm font-display font-bold ${classColor}`}>
                            <Icon className="w-3.5 h-3.5" />
                            <span>{report.strategyEvaluation?.action ?? report.classification}</span>
                          </span>
                          {idx === 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-[#D4AF37]/15 border border-[#D4AF37]/40 text-[10px] font-mono font-bold text-[#F5D061]">
                              LATEST
                            </span>
                          )}
                          {report.strategyEvaluation && (
                            <span className="text-[11px] font-mono tabular-nums text-[#F5D061]">
                              · {report.strategyEvaluation.totalScore}/100
                            </span>
                          )}
                          <span className="text-[11px] font-mono tabular-nums text-zinc-200">
                            · {confidence.scorePct}% conf
                          </span>
                          <span className="text-[11px] font-mono tabular-nums text-zinc-200">
                            · ${safeFixed(report.spotPrice)}
                          </span>
                          <span className="text-[11px] font-mono text-zinc-400">· {dt}</span>
                        </div>
                        <div className="text-[11px] font-mono text-zinc-400 truncate">
                          {(report.selectedTimeframes ?? []).join(', ')} · {report.freshness}
                          {report.tradeLevels && (
                            <span className="text-zinc-300">
                              {' '}· SL ${safeFixed(report.tradeLevels.stopLoss)} · TP ${safeFixed(report.tradeLevels.takeProfit1)} ({report.tradeLevels.rewardRiskRatio1})
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => void handleDeleteSavedReport(e, report.id)}
                          disabled={deletingReportId === report.id}
                          aria-label="Delete saved analysis"
                          className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                        <ChevronRight className="w-4 h-4 text-zinc-500" />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Show / Hide Chart Option positioned below ANALYSE XAUUSD at the bottom */}
      <section className="space-y-4">
        <div className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <CandlestickChart className="w-4 h-4 text-[#D4AF37] shrink-0" />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-zinc-200 truncate">
                XAU/USD Candlestick Chart ({activeChartTimeframe})
              </div>
              <div className="text-[11px] font-mono text-zinc-400">
                {showChart ? 'Chart visible · Tap to collapse' : 'Chart hidden by default · Tap Show Chart to expand'}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowChart((prev) => !prev)}
            aria-expanded={showChart}
            className={`min-h-[44px] px-3.5 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
              showChart
                ? 'bg-[#181A20] border border-[#D4AF37]/35 text-zinc-200 hover:border-[#D4AF37]/60 hover:text-[#F5D061]'
                : 'bg-[#D4AF37] text-[#09090B] hover:bg-[#F5D061]'
            }`}
          >
            {showChart ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            <span>{showChart ? 'Hide Chart' : 'Show Chart'}</span>
          </button>
        </div>

        {showChart && (
          <XauUsdChart
            candles={chartCandles}
            overlays={overlays}
            timeframe={activeChartTimeframe}
            supportLevels={supportLevels}
            resistanceLevels={resistanceLevels}
            showVolume={showVolumeOnChart}
            hasExchangeVolume={dataset?.hasExchangeVolume ?? true}
            loading={chartLoading}
            error={chartError}
            onRefresh={handleRefreshChartSpinner}
            onCandleRollover={handleCandleRollover}
          />
        )}

        {/* Chart Timeframe Selector positioned at the very bottom below Show Chart */}
        <TimeframeSelector
          mode="chart-only"
          activeChartTimeframe={activeChartTimeframe}
          selectedTimeframes={selectedTimeframes}
          onSelectChartTimeframe={handleSelectChartTimeframe}
          onToggleAnalysisTimeframe={handleToggleAnalysisTimeframe}
          onSetPresetTimeframes={setSelectedTimeframes}
        />
      </section>

      {analyzing && (
        <AnalysisProcessingModal
          currentStageIndex={stageIndex}
          selectedTimeframeCount={selectedTimeframes.length}
          selectedIndicatorCount={enabledIndicatorCount}
          errorStatus={analysisErrStatus}
          errorMessage={analysisErrMsg}
          onCloseError={() => setAnalyzing(false)}
          onRetry={handleRunAnalysis}
        />
      )}

      {leaderViewOpen && (
        <LeaderChartFullView
          lastCandleClose={lastCandleClose}
          candles={chartCandles}
          timeframe={activeChartTimeframe}
          loading={chartLoading}
          error={chartError}
          onChangeTimeframe={setActiveChartTimeframe}
          onRefresh={handleRefreshLeader}
          onCandleRollover={handleCandleRollover}
          onClose={() => setLeaderViewOpen(false)}
        />
      )}
    </div>
  );
});
