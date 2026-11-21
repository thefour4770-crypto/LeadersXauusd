import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CandlestickChart,
  FileText,
  Newspaper,
  User,
  X,
} from 'lucide-react';
import type {
  AnalysisReport,
  EconomicCalendarPayload,
  MarketQuote,
  NewsProtectionState,
  SureSignalEntry,
  SureSignalScanStatus,
  SureSignalStatus,
} from './types/market.ts';
import {
  createAdaptivePollState,
  evaluateAdaptivePollInterval,
  STANDARD_POLL_INTERVAL_MS,
  type AdaptivePollState,
} from './utils/adaptivePolling.ts';
import {
  getPersistedBannerSeenIds,
  isPhoneAlertsEnabled,
  markBannerSeenIds,
  notifyNewSureSignalOnPhone,
  notifySureSignalOutcomeOnPhone,
  reconcileSureStatusTransitions,
  subscribeNotificationPermissionSync,
  syncWebPushSubscriptionIfEnabled,
  unlockAlertAudio,
} from './utils/phoneNotifications.ts';
import { publishLiveQuote, useLiveQuoteState } from './contexts/LiveQuoteContext.tsx';
import { NewsCalendarView } from './components/NewsCalendarView.tsx';
import { ProfileView } from './components/ProfileView.tsx';
import { SignalsView } from './components/SignalsView.tsx';
import { SmoothedPriceText } from './components/SmoothedPriceText.tsx';
import { SureIconBadge } from './components/SureIconBadge.tsx';
import { SureSignalsView } from './components/SureSignalsView.tsx';
import { TradeView } from './components/TradeView.tsx';
import { useOnlineStatus } from './hooks/usePWAInstall.ts';

type BottomTab = 'TRADE' | 'NEWS' | 'SURE' | 'SIGNALS' | 'PROFILE';

interface BannerNotification {
  kind: 'NEW' | 'TP_HIT' | 'SL_HIT' | 'AMBIGUOUS';
  entry: SureSignalEntry;
}

const HeaderPriceStatus = memo(function HeaderPriceStatus() {
  const { quote } = useLiveQuoteState();
  const validPrice =
    quote && quote.freshness !== 'UNAVAILABLE' && quote.mid > 0 ? quote.mid : null;

  return (
    <div className="flex items-center gap-2.5 text-xs font-mono tabular-nums whitespace-nowrap shrink-0">
      {quote && quote.freshness !== 'UNAVAILABLE' && validPrice != null ? (
        <>
          <SmoothedPriceText
            value={validPrice}
            flashOnMove
            className="font-semibold transition-colors duration-200"
          />
          <span className="text-zinc-600">·</span>
          <span
            className={`inline-flex items-center gap-1.5 font-semibold ${
              quote.freshness === 'LIVE' ? 'text-emerald-400' : 'text-amber-400'
            }`}
          >
            {quote.freshness === 'LIVE' && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            )}
            {quote.freshness}
          </span>
        </>
      ) : (
        <span className="text-red-400 font-semibold">DATA UNAVAILABLE</span>
      )}
    </div>
  );
});

export default function App() {
  const [activeTab, setActiveTab] = useState<BottomTab>(() => {
    if (typeof window !== 'undefined') {
      const tabParam = new URLSearchParams(window.location.search).get('tab');
      if (tabParam === 'SURE' || tabParam === 'NEWS' || tabParam === 'SIGNALS' || tabParam === 'PROFILE') {
        return tabParam;
      }
    }
    return 'TRADE';
  });
  const [reports, setReports] = useState<AnalysisReport[]>([]);
  const [reportsLoading, setReportsLoading] = useState(true);

  const [sureStatus, setSureStatus] = useState<SureSignalScanStatus | null>(null);
  const [sureLoading, setSureLoading] = useState(true);

  const [newsCalendar, setNewsCalendar] = useState<EconomicCalendarPayload | null>(null);
  const [newsProtection, setNewsProtection] = useState<NewsProtectionState | null>(null);
  const [newsLoading, setNewsLoading] = useState(true);
  const [newsRefreshing, setNewsRefreshing] = useState(false);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [unreadSureAlert, setUnreadSureAlert] = useState(false);
  const [bannerAlert, setBannerAlert] = useState<BannerNotification | null>(null);
  const isOnline = useOnlineStatus();

  const pollStateRef = useRef<AdaptivePollState>(createAdaptivePollState());
  const latestQuoteRef = useRef<MarketQuote | null>(null);
  const latestQuoteErrorRef = useRef<string | null>(null);
  const quoteInFlightRef = useRef(false);
  const lastStreamAtRef = useRef(0);
  const activeTabRef = useRef<BottomTab>(activeTab);
  activeTabRef.current = activeTab;
  const sureStatusesRef = useRef<Map<string, SureSignalStatus>>(new Map());
  const sureBaselineHydratedRef = useRef(false);

  const applyIncomingQuote = useCallback((nextQuote: MarketQuote | null, ok: boolean) => {
    if (nextQuote && nextQuote.freshness !== 'UNAVAILABLE' && nextQuote.mid > 0) {
      latestQuoteRef.current = nextQuote;
      latestQuoteErrorRef.current = null;
      publishLiveQuote(nextQuote, null);
      pollStateRef.current = evaluateAdaptivePollInterval(pollStateRef.current, nextQuote);
      return;
    }

    if (nextQuote) {
      latestQuoteRef.current = nextQuote;
    }
    if (!ok) {
      latestQuoteErrorRef.current = 'DATA UNAVAILABLE';
    }
    publishLiveQuote(latestQuoteRef.current, latestQuoteErrorRef.current);
    pollStateRef.current = evaluateAdaptivePollInterval(pollStateRef.current, null);
  }, []);

  const fetchQuote = useCallback(async (): Promise<number> => {
    if (quoteInFlightRef.current) {
      return pollStateRef.current.currentIntervalMs;
    }
    quoteInFlightRef.current = true;
    try {
      const res = await fetch('/api/market/quote');
      const json = await res.json().catch(() => ({}));
      const nextQuote: MarketQuote | null = json.quote ?? null;
      applyIncomingQuote(nextQuote, res.ok);
      return pollStateRef.current.currentIntervalMs;
    } catch {
      applyIncomingQuote(null, false);
      return pollStateRef.current.currentIntervalMs;
    } finally {
      quoteInFlightRef.current = false;
    }
  }, [applyIncomingQuote]);

  const fetchReports = useCallback(async () => {
    try {
      const res = await fetch('/api/reports');
      if (!res.ok) return;
      const json = await res.json();
      if (Array.isArray(json.reports)) {
        setReports(json.reports);
      }
    } finally {
      setReportsLoading(false);
    }
  }, []);

  const fetchNewsCalendar = useCallback(async (forceRefresh = false) => {
    if (forceRefresh) {
      setNewsRefreshing(true);
    }
    try {
      const url = forceRefresh ? '/api/news/calendar?refresh=1' : '/api/news/calendar';
      const res = await fetch(url);
      const json = (await res.json().catch(() => ({}))) as {
        calendar?: EconomicCalendarPayload;
        error?: string;
      };
      if (!res.ok || !json.calendar) {
        setNewsError(json.error || 'Economic news calendar data unavailable.');
        return;
      }
      setNewsCalendar(json.calendar);
      setNewsProtection(json.calendar.protection);
      setNewsError(null);
    } catch {
      setNewsError('Unable to reach economic news calendar service.');
    } finally {
      setNewsLoading(false);
      setNewsRefreshing(false);
    }
  }, []);

  const applyIncomingSureStatus = useCallback(
    (
      nextStatus: SureSignalScanStatus | null,
      options?: {
        explicitNewSignal?: SureSignalEntry;
        explicitClosedSignal?: SureSignalEntry;
      }
    ) => {
      if (nextStatus) {
        setSureStatus(nextStatus);
        setSureLoading(false);
        if (nextStatus.newsProtection) {
          setNewsProtection(nextStatus.newsProtection);
        }
      }

      const persistedSeen = getPersistedBannerSeenIds();
      const { events, nextStatuses, newlySeenKeys } = reconcileSureStatusTransitions({
        nextStatus,
        prevStatuses: sureStatusesRef.current,
        hasHydratedBaseline: sureBaselineHydratedRef.current,
        persistedSeenKeys: persistedSeen,
        explicitNewSignal: options?.explicitNewSignal,
        explicitClosedSignal: options?.explicitClosedSignal,
      });

      if (nextStatus) {
        sureStatusesRef.current = nextStatuses;
        sureBaselineHydratedRef.current = true;
      }

      if (newlySeenKeys.length > 0) {
        markBannerSeenIds(newlySeenKeys);
      }

      for (const evt of events) {
        setBannerAlert({ kind: evt.kind, entry: evt.entry });
        if (activeTabRef.current !== 'SURE') {
          setUnreadSureAlert(true);
        }
        if (evt.kind === 'NEW') {
          void notifyNewSureSignalOnPhone(evt.entry);
        } else {
          void notifySureSignalOutcomeOnPhone(evt.entry);
        }
      }
    },
    []
  );

  const fetchSureStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/sure-signals');
      if (!res.ok) return;
      const json = await res.json();
      if (json.sureStatus) {
        applyIncomingSureStatus(json.sureStatus as SureSignalScanStatus);
      }
    } finally {
      setSureLoading(false);
    }
  }, [applyIncomingSureStatus]);

  const handleDeleteSureSignal = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/sure-signals/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        if (json.sureStatus) {
          applyIncomingSureStatus(json.sureStatus as SureSignalScanStatus);
        } else {
          setSureStatus((prev) =>
            prev ? { ...prev, history: prev.history.filter((h) => h.id !== id) } : prev
          );
        }
      } else if (res.status === 404) {
        setSureStatus((prev) =>
          prev ? { ...prev, history: prev.history.filter((h) => h.id !== id) } : prev
        );
      }
    },
    [applyIncomingSureStatus]
  );

  // Automatically unlock Web Audio on first tap/keypress when alerts are enabled in localStorage
  useEffect(() => {
    const handleFirstGesture = () => {
      if (isPhoneAlertsEnabled()) {
        void unlockAlertAudio();
      }
    };
    window.addEventListener('pointerdown', handleFirstGesture, { passive: true, once: true });
    window.addEventListener('keydown', handleFirstGesture, { passive: true, once: true });
    return () => {
      window.removeEventListener('pointerdown', handleFirstGesture);
      window.removeEventListener('keydown', handleFirstGesture);
    };
  }, []);

  // Sync browser Web Push (VAPID) subscription on boot and whenever notification permission becomes granted
  useEffect(() => {
    void syncWebPushSubscriptionIfEnabled();
    return subscribeNotificationPermissionSync((perm) => {
      if (perm === 'granted') {
        void syncWebPushSubscriptionIfEnabled();
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timerId: number | null = null;
    let eventSource: EventSource | null = null;

    const clearScheduled = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    const closeStream = () => {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };

    const openStream = () => {
      closeStream();
      if (cancelled || document.hidden || typeof EventSource === 'undefined') return;
      try {
        const es = new EventSource('/api/market/stream');
        es.onopen = () => {
          if (!cancelled) {
            void fetchSureStatus();
          }
        };
        es.onmessage = (event) => {
          if (cancelled) return;
          try {
            const payload = JSON.parse(event.data) as { quote?: MarketQuote };
            if (payload?.quote) {
              lastStreamAtRef.current = Date.now();
              applyIncomingQuote(payload.quote, payload.quote.freshness !== 'UNAVAILABLE');
            }
          } catch {
            // Ignore malformed SSE tick frame
          }
        };
        es.addEventListener('sure_signal', (event) => {
          if (cancelled) return;
          try {
            const payload = JSON.parse((event as MessageEvent<string>).data) as {
              status?: SureSignalScanStatus;
              newSignal?: SureSignalEntry;
            };
            applyIncomingSureStatus(payload.status ?? null, {
              explicitNewSignal: payload.newSignal,
            });
          } catch {
            // Ignore malformed sure_signal frame
          }
        });
        es.addEventListener('sure_outcome', (event) => {
          if (cancelled) return;
          try {
            const payload = JSON.parse((event as MessageEvent<string>).data) as {
              status?: SureSignalScanStatus;
              closedSignal?: SureSignalEntry;
            };
            applyIncomingSureStatus(payload.status ?? null, {
              explicitClosedSignal: payload.closedSignal,
            });
          } catch {
            // Ignore malformed sure_outcome frame
          }
        });
        es.addEventListener('sure_status', (event) => {
          if (cancelled) return;
          try {
            const payload = JSON.parse((event as MessageEvent<string>).data) as {
              status?: SureSignalScanStatus;
            };
            if (payload.status) {
              applyIncomingSureStatus(payload.status);
            }
          } catch {
            // Ignore malformed sure_status frame
          }
        });
        es.addEventListener('news_status', (event) => {
          if (cancelled) return;
          try {
            const payload = JSON.parse((event as MessageEvent<string>).data) as {
              protection?: NewsProtectionState;
              calendar?: EconomicCalendarPayload;
            };
            if (payload.protection) {
              setNewsProtection(payload.protection);
            }
            if (payload.calendar) {
              setNewsCalendar(payload.calendar);
              setNewsError(null);
              setNewsLoading(false);
            }
          } catch {
            // Ignore malformed news_status frame
          }
        });
        es.onerror = () => {
          // Adaptive HTTP polling fallback remains active automatically
        };
        eventSource = es;
      } catch {
        // Fallback to HTTP polling if EventSource is unavailable
      }
    };

    const scheduleNext = (delayMs: number) => {
      clearScheduled();
      if (cancelled || document.hidden) return;
      timerId = window.setTimeout(async () => {
        if (cancelled) return;
        const streamHealthy = Date.now() - lastStreamAtRef.current < 4_500;
        const nextDelay =
          document.hidden || streamHealthy
            ? pollStateRef.current.currentIntervalMs || STANDARD_POLL_INTERVAL_MS
            : await fetchQuote();
        if (!cancelled) {
          scheduleNext(nextDelay);
        }
      }, delayMs);
    };

    const startLiveSync = async () => {
      openStream();
      const nextDelay = await fetchQuote();
      if (!cancelled) {
        scheduleNext(nextDelay);
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearScheduled();
        closeStream();
      } else {
        void startLiveSync();
        void fetchSureStatus();
        void fetchNewsCalendar(false);
      }
    };

    void fetchReports();
    void fetchSureStatus();
    void fetchNewsCalendar(false);
    void startLiveSync();
    const sureFallbackTimer = window.setInterval(() => {
      if (!document.hidden) {
        void fetchSureStatus();
        void fetchNewsCalendar(false);
      }
    }, 60_000);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      clearScheduled();
      closeStream();
      window.clearInterval(sureFallbackTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    applyIncomingQuote,
    applyIncomingSureStatus,
    fetchNewsCalendar,
    fetchQuote,
    fetchReports,
    fetchSureStatus,
  ]);

  const handleReportSaved = useCallback((report: AnalysisReport) => {
    setReports((prev) => {
      if (prev.some((r) => r.id === report.id)) return prev;
      return [report, ...prev];
    });
  }, []);

  const handleDeleteReport = useCallback(async (id: string) => {
    const res = await fetch(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setReports((prev) => prev.filter((r) => r.id !== id));
    }
  }, []);

  const handleGoToTrade = useCallback(() => {
    setActiveTab('TRADE');
  }, []);

  const handleManualNewsRefresh = useCallback(() => {
    void fetchNewsCalendar(true);
  }, [fetchNewsCalendar]);

  const effectiveNewsProtection =
    newsProtection ?? sureStatus?.newsProtection ?? newsCalendar?.protection ?? null;
  const isNewsPaused =
    effectiveNewsProtection?.blocked === true || sureStatus?.marketState === 'NEWS_PAUSED';
  const activeTradeLocked = (sureStatus?.tradeLocked ?? false) && !isNewsPaused;
  const navSureMarketState = sureStatus?.marketState;

  return (
    <div
      className={`min-h-screen flex flex-col ${
        activeTab === 'PROFILE' ? 'bg-[#F5EEDB] text-[#09090B]' : 'bg-[#09090B] text-[#F4F4F5]'
      }`}
    >
      {/* Compact Sticky Top Bar (52px) — opaque surface to eliminate mobile backdrop-blur scroll lag */}
      <header className="sticky top-0 z-30 h-[52px] bg-[#09090B]/[0.98] border-b border-[#D4AF37]/30">
        <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
            <img
              src="/assets/aistudio/images_0b890af9.png"
              alt="LEADERS XAUUSD"
              className="w-7 h-7 rounded-full object-cover shrink-0"
            />
            <div className="font-display font-bold tracking-tight text-base sm:text-lg">
              <span className="text-zinc-100">LEADERS</span>{' '}
              <span className="text-[#D4AF37]">XAUUSD</span>
            </div>
          </div>

          <HeaderPriceStatus />
        </div>
      </header>

      {!isOnline && (
        <div className="fixed bottom-[66px] left-3 z-40 flex items-center gap-2 rounded-full bg-amber-500 px-3 py-1 text-[11px] font-semibold text-[#09090B] shadow-lg">
          <span className="h-1.5 w-1.5 rounded-full bg-[#09090B] animate-pulse" />
          Offline — Cached View
        </div>
      )}

      {/* In-App Alert Banner when a SURE signal or TP/SL outcome triggers (directional NEW banners suppressed during news pause) */}
      {bannerAlert && !(isNewsPaused && bannerAlert.kind === 'NEW') && (
        <div className="sticky top-[52px] z-20 px-3 sm:px-6 pt-2">
          <div
            className={`max-w-7xl mx-auto rounded-2xl border px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 shadow-lg ${
              bannerAlert.kind === 'AMBIGUOUS'
                ? 'border-amber-500/50 bg-[#1A160B]/95 text-amber-300'
                : bannerAlert.kind === 'TP_HIT' ||
                  (bannerAlert.kind === 'NEW' && bannerAlert.entry.direction === 'BUY')
                ? 'border-emerald-500/50 bg-[#0D1A15]/95 text-emerald-300'
                : 'border-red-500/50 bg-[#1B0E10]/95 text-red-300'
            }`}
          >
            <div className="flex items-center gap-2 text-xs font-mono">
              {bannerAlert.entry.direction === 'BUY' ? (
                <ArrowUp className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <ArrowDown className="w-4 h-4 text-red-400 shrink-0" />
              )}
              {bannerAlert.kind === 'NEW' ? (
                <>
                  <span className="font-bold">SURE {bannerAlert.entry.direction}</span>
                  <span className="text-zinc-200">
                    ${bannerAlert.entry.spotPrice.toFixed(2)} · Score{' '}
                    {bannerAlert.entry.setupScore ?? bannerAlert.entry.confidencePct}/100 · TP $
                    {bannerAlert.entry.tradeLevels.takeProfit1.toFixed(2)}
                  </span>
                </>
              ) : (
                <>
                  <span className="font-bold">
                    {bannerAlert.kind === 'TP_HIT'
                      ? 'TP HIT'
                      : bannerAlert.kind === 'SL_HIT'
                      ? 'SL HIT'
                      : 'AMBIGUOUS'}{' '}
                    · SURE {bannerAlert.entry.direction}
                  </span>
                  <span className="text-zinc-200">
                    Close ${(bannerAlert.entry.closePrice ?? bannerAlert.entry.spotPrice).toFixed(2)} (
                    {(bannerAlert.entry.pnlPoints ?? 0) >= 0 ? '+' : ''}
                    {(bannerAlert.entry.pnlPoints ?? 0).toFixed(2)} pts)
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={() => {
                  setActiveTab('SURE');
                  setUnreadSureAlert(false);
                  setBannerAlert(null);
                }}
                className="px-2.5 py-1 rounded-lg bg-[#D4AF37] text-[#09090B] text-[11px] font-semibold"
              >
                Open SURE
              </button>
              <button
                type="button"
                onClick={() => setBannerAlert(null)}
                aria-label="Dismiss alert"
                className="p-1 text-zinc-400 hover:text-zinc-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main
        className={
          activeTab === 'PROFILE'
            ? 'flex-1 w-full flex flex-col pb-[58px]'
            : 'flex-1 w-full max-w-7xl mx-auto px-3 sm:px-6 pt-3 pb-20'
        }
      >
        <div className={activeTab === 'TRADE' ? 'block' : 'hidden'} aria-hidden={activeTab !== 'TRADE'}>
          <TradeView
            isActive={activeTab === 'TRADE'}
            reports={reports}
            reportsLoading={reportsLoading}
            newsProtection={effectiveNewsProtection}
            onRefreshQuote={fetchQuote}
            onReportSaved={handleReportSaved}
            onDeleteReport={handleDeleteReport}
            onNewsProtectionSync={setNewsProtection}
          />
        </div>
        {activeTab === 'NEWS' ? (
          <NewsCalendarView
            calendar={newsCalendar}
            loading={newsLoading}
            refreshing={newsRefreshing}
            error={newsError}
            onRefresh={handleManualNewsRefresh}
          />
        ) : activeTab === 'SURE' ? (
          <SureSignalsView
            sureStatus={sureStatus}
            newsProtection={effectiveNewsProtection}
            loading={sureLoading}
            onDeleteHistoryItem={handleDeleteSureSignal}
          />
        ) : activeTab === 'SIGNALS' ? (
          <SignalsView
            reports={reports}
            newsProtection={effectiveNewsProtection}
            loading={reportsLoading}
            onDeleteReport={handleDeleteReport}
            onGoToTrade={handleGoToTrade}
          />
        ) : activeTab === 'PROFILE' ? (
          <ProfileView />
        ) : null}
      </main>

      {/* Bottom Navigation — Trade | News | Sure | Signal | Profile */}
      <nav
        aria-label="Primary Bottom Navigation"
        className="fixed bottom-0 left-0 right-0 z-40 h-[58px] bg-[#0B0C10]/[0.98] border-t border-[#D4AF37]/30 pb-[env(safe-area-inset-bottom)]"
      >
        <div className="max-w-xl mx-auto h-full grid grid-cols-5 items-center px-1">
          <button
            type="button"
            onClick={() => setActiveTab('TRADE')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
              activeTab === 'TRADE'
                ? 'text-[#F5D061]'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <CandlestickChart className="w-[18px] h-[18px]" />
            <span className="text-[10px] sm:text-[11px] font-display font-semibold tracking-wide whitespace-nowrap">
              Trade
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('NEWS')}
            aria-label="Economic News Calendar"
            className={`relative min-h-[44px] flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
              activeTab === 'NEWS'
                ? 'text-[#F5D061]'
                : isNewsPaused || effectiveNewsProtection?.warningActive
                ? 'text-red-400 hover:text-red-300'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {(isNewsPaused || effectiveNewsProtection?.warningActive) && (
              <span className="absolute top-1.5 right-3 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            )}
            <Newspaper className="w-[18px] h-[18px]" />
            <span className="text-[10px] sm:text-[11px] font-display font-semibold tracking-wide whitespace-nowrap">
              News
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveTab('SURE');
              setUnreadSureAlert(false);
            }}
            aria-label="Sure Signal Auto Scanner"
            className={`relative min-h-[44px] mx-1 my-1 px-1.5 rounded-xl border flex flex-col items-center justify-center gap-0.5 transition-all cursor-pointer ${
              isNewsPaused
                ? 'border-red-500/65 bg-red-600/15 text-red-300 shadow-sm shadow-red-500/20'
                : activeTradeLocked && navSureMarketState === 'SURE_BUY'
                ? 'border-emerald-500/65 bg-emerald-500/15 text-emerald-300 shadow-sm shadow-emerald-500/20'
                : activeTradeLocked && navSureMarketState === 'SURE_SELL'
                ? 'border-red-500/65 bg-red-500/15 text-red-300 shadow-sm shadow-red-500/20'
                : activeTab === 'SURE'
                ? 'border-[#D4AF37]/75 bg-[#090A0E] text-[#F5D061] shadow-[0_0_18px_-5px_rgba(212,175,55,0.5)]'
                : 'border-[#D4AF37]/35 bg-[#090A0E] text-zinc-200 hover:border-[#D4AF37]/65'
            }`}
          >
            {unreadSureAlert && !isNewsPaused && (
              <span className="absolute top-1 right-1.5 z-10 w-2 h-2 rounded-full bg-[#F5D061] animate-pulse" />
            )}
            {isNewsPaused ||
            (activeTradeLocked &&
              (navSureMarketState === 'SURE_BUY' || navSureMarketState === 'SURE_SELL')) ? (
              <>
                <SureIconBadge size="compact" />
                <span className="text-[9px] leading-none font-display font-bold tracking-wide whitespace-nowrap">
                  {isNewsPaused
                    ? 'NO TRADE'
                    : navSureMarketState === 'SURE_BUY'
                    ? 'SURE BUY'
                    : 'SURE SELL'}
                </span>
              </>
            ) : (
              <SureIconBadge size="nav" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('SIGNALS')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
              activeTab === 'SIGNALS'
                ? 'text-[#F5D061]'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <FileText className="w-[18px] h-[18px]" />
            <span className="text-[10px] sm:text-[11px] font-display font-semibold tracking-wide whitespace-nowrap">
              Signal{reports.length > 0 ? ` (${reports.length})` : ''}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('PROFILE')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
              activeTab === 'PROFILE'
                ? 'text-[#F5D061]'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <User className="w-[18px] h-[18px]" />
            <span className="text-[10px] sm:text-[11px] font-display font-semibold tracking-wide whitespace-nowrap">
              Profile
            </span>
          </button>
        </div>
      </nav>
    </div>
  );
}
