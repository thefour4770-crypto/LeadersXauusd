import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  Clock,
  ImageDown,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import type {
  NewsProtectionState,
  SureSignalEntry,
  SureSignalScanStatus,
  SureSignalStatus,
} from '../types/market.ts';
import {
  renderSureSignalJpg,
  triggerJpgDownload,
  type RenderedJpgReport,
} from '../utils/exportReportJpg.ts';
import { isGoldMarketWeekendClosed } from '../utils/marketHours.ts';
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
import { safeFixed, safeLocaleDateTime, safeLocaleTime, safeNumber } from '../utils/format.ts';
import { JpgPreviewModal } from './JpgPreviewModal.tsx';
import { SureIconBadge } from './SureIconBadge.tsx';
import { TradeLevelsScale } from './TradeLevelsScale.tsx';

const EMPTY_CHECKS: SureSignalScanStatus['checks'] = [];

interface SureSignalsViewProps {
  sureStatus: SureSignalScanStatus | null;
  newsProtection: NewsProtectionState | null;
  loading: boolean;
  onDeleteHistoryItem: (id: string) => Promise<void>;
}

function getStatusBadge(status: SureSignalStatus | undefined) {
  if (status === 'TP_HIT') {
    return {
      label: 'TP HIT',
      className: 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300',
    };
  }
  if (status === 'SL_HIT') {
    return {
      label: 'SL HIT',
      className: 'bg-red-500/20 border-red-500/60 text-red-300',
    };
  }
  if (status === 'AMBIGUOUS') {
    return {
      label: 'AMBIGUOUS',
      className: 'bg-amber-500/20 border-amber-500/60 text-amber-300',
    };
  }
  return {
    label: 'ACTIVE TRADE',
    className: 'bg-[#D4AF37]/20 border-[#D4AF37]/60 text-[#F5D061]',
  };
}

function formatDurationMs(durationMs: number | undefined | null): string {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return '—';
  const totalSec = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

const SureScanCountdownText = memo(function SureScanCountdownText({
  formattedLastScanTime,
  isNewsPaused,
  tradeLocked,
  nextScanAt,
}: {
  formattedLastScanTime: string | null;
  isNewsPaused: boolean;
  tradeLocked: boolean;
  nextScanAt: string | null | undefined;
}) {
  const [countdownSec, setCountdownSec] = useState<number | null>(null);

  useEffect(() => {
    if (isNewsPaused || tradeLocked || !nextScanAt) {
      setCountdownSec(null);
      return;
    }

    const updateCountdown = () => {
      const targetMs = new Date(nextScanAt).getTime();
      if (!Number.isFinite(targetMs)) {
        setCountdownSec(null);
        return;
      }
      const diffSec = Math.max(0, Math.ceil((targetMs - Date.now()) / 1000));
      setCountdownSec(diffSec);
    };

    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1_000);
    return () => window.clearInterval(timer);
  }, [isNewsPaused, tradeLocked, nextScanAt]);

  return (
    <span>
      {formattedLastScanTime ? `Last check ${formattedLastScanTime}` : 'Starting scan...'}
      {isNewsPaused
        ? ' · Auto Scan will resume after news stabilizes'
        : tradeLocked
        ? ' · New scan paused until SL or TP hits'
        : countdownSec !== null
        ? ` · Next scan ${countdownSec}s`
        : ''}
    </span>
  );
});

export const SureSignalsView = memo(function SureSignalsView({
  sureStatus,
  newsProtection,
  loading,
  onDeleteHistoryItem,
}: SureSignalsViewProps) {
  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(() => isPhoneAlertsEnabled());
  const [notificationPerm, setNotificationPerm] = useState<NotificationPermissionState>(() =>
    getNotificationPermissionState()
  );
  const [alertFeedback, setAlertFeedback] = useState<string | null>(null);
  const [testingAlert, setTestingAlert] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [previewJpg, setPreviewJpg] = useState<RenderedJpgReport | null>(null);
  const [downloadedId, setDownloadedId] = useState<string | null>(null);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    const unsubPref = subscribePhoneAlertsPrefChange(setAlertsEnabled);
    const unsubPerm = subscribeNotificationPermissionSync(setNotificationPerm);
    return () => {
      unsubPref();
      unsubPerm();
    };
  }, []);

  const handleClosePreview = useCallback(() => setPreviewJpg(null), []);

  const handleDownloadSignal = useCallback((signal: SureSignalEntry) => {
    setDownloadError(null);
    try {
      const rendered = renderSureSignalJpg(signal);
      triggerJpgDownload(rendered.blobUrl, rendered.filename);
      setPreviewJpg(rendered);
      setDownloadedId(signal.id);
      setDownloadNotice(rendered.filename);
      window.setTimeout(() => {
        setDownloadedId((curr) => (curr === signal.id ? null : curr));
        setDownloadNotice((curr) => (curr === rendered.filename ? null : curr));
      }, 4000);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Unable to export SURE signal JPG');
    }
  }, []);

  const handleTogglePhoneAlerts = useCallback(async () => {
    if (alertsEnabled) {
      setPhoneAlertsEnabledPref(false);
      setAlertsEnabled(false);
      setAlertFeedback(null);
      void unsubscribeWebPush();
      return;
    }

    const result = await enableAndTestPhoneAlerts();
    setAlertsEnabled(result.alertsEnabled);
    setNotificationPerm(result.permissionState);
    setAlertFeedback(result.message);
  }, [alertsEnabled]);

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

  const handleDeleteActiveReset = useCallback(
    async (id: string) => {
      setDeletingId(id);
      try {
        await onDeleteHistoryItem(id);
      } finally {
        setDeletingId(null);
      }
    },
    [onDeleteHistoryItem]
  );

  const effectiveNews = newsProtection ?? sureStatus?.newsProtection ?? null;
  const isNewsPaused =
    effectiveNews?.blocked === true || sureStatus?.marketState === 'NEWS_PAUSED';
  const isNewsWarningOnly = !isNewsPaused && effectiveNews?.warningActive === true;

  const spotlight = isNewsPaused ? null : (sureStatus?.activeSignal ?? null);
  const spotlightStatus: SureSignalStatus = spotlight?.status ?? 'ACTIVE';
  const spotlightBadge = useMemo(() => getStatusBadge(spotlightStatus), [spotlightStatus]);
  const checks = useMemo(() => sureStatus?.checks ?? EMPTY_CHECKS, [sureStatus?.checks]);
  const passedCount = useMemo(() => checks.filter((c) => c.passed).length, [checks]);
  const stats = sureStatus?.stats;
  const evalData = isNewsPaused ? undefined : sureStatus?.strategyEvaluation;
  const isFeedUnavailable = sureStatus?.marketState === 'UNAVAILABLE';
  const isMarketClosed =
    sureStatus?.monitoringMode !== 'REALTIME_SPOT_BBO' &&
    (isGoldMarketWeekendClosed() ||
      Boolean(sureStatus?.reason?.toLowerCase().includes('market closed')) ||
      (isFeedUnavailable && sureStatus?.monitoringMode === 'DELAYED_POLL'));

  const formattedLastScanTime = useMemo(() => {
    if (!sureStatus?.lastScannedAt) return null;
    return safeLocaleTime(
      sureStatus.lastScannedAt,
      {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      },
      ''
    ) || null;
  }, [sureStatus?.lastScannedAt]);

  const formattedSpotlightCreatedAt = useMemo(() => {
    if (!spotlight?.createdAt) return null;
    return safeLocaleDateTime(spotlight.createdAt, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }, [spotlight?.createdAt]);

  const formattedSpotlightClosedAt = useMemo(() => {
    if (!spotlight?.closedAt) return null;
    return safeLocaleTime(
      spotlight.closedAt,
      {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      },
      ''
    ) || null;
  }, [spotlight?.closedAt]);

  const formattedSpotlightDuration = useMemo(
    () => formatDurationMs(spotlight?.durationMs),
    [spotlight?.durationMs]
  );

  const formattedAvgDuration = useMemo(
    () => formatDurationMs(stats?.avgDurationMs),
    [stats?.avgDurationMs]
  );

  const formattedHistoryItems = useMemo(() => {
    const history = sureStatus?.history;
    if (!Array.isArray(history) || history.length === 0) return [];
    return history.map((item) => ({
      item,
      badge: getStatusBadge(item.status),
      isActive: item.status === 'ACTIVE',
      formattedCreatedAt: safeLocaleDateTime(item.createdAt, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      formattedClosedAt: item.closedAt
        ? safeLocaleTime(
            item.closedAt,
            {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            },
            ''
          ) || null
        : null,
      formattedDuration: formatDurationMs(item.durationMs),
    }));
  }, [sureStatus?.history]);

  return (
    <div className="space-y-4 pb-6">
      {/* Automatic Scanner Status Header — Zero Manual Scan Buttons */}
      <section className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] p-4 space-y-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <SureIconBadge variant="header" />
              <h1 className="text-lg sm:text-xl font-display font-bold text-zinc-100">
                SURE Auto-Scanner
              </h1>
            </div>
            <p className="text-xs text-zinc-400 max-w-xl leading-relaxed">
              Strictly automatic 60-second multi-timeframe scanner (<span className="font-mono text-zinc-300">1H → 15m → 5m → 1m closed candles</span>, 11 indicators, ≥ 90/100 score + mandatory gates). Automatically pauses around USD high-impact news and resumes when market conditions stabilize.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              className={`min-h-[42px] px-3 py-2 rounded-xl border text-xs font-mono font-semibold inline-flex items-center gap-2 whitespace-nowrap ${
                isNewsPaused
                  ? 'border-red-500/60 bg-red-600/15 text-red-300 shadow-[0_0_20px_-6px_rgba(239,68,68,0.55)]'
                  : isFeedUnavailable
                  ? 'border-red-500/45 bg-red-500/10 text-red-300'
                  : sureStatus?.tradeLocked
                  ? 'border-[#D4AF37]/45 bg-[#D4AF37]/10 text-[#F5D061]'
                  : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              }`}
            >
              <Activity
                className={`w-3.5 h-3.5 ${
                  sureStatus?.tradeLocked || isFeedUnavailable || isNewsPaused
                    ? ''
                    : 'animate-pulse text-emerald-400'
                }`}
              />
              <span>
                {isNewsPaused
                  ? effectiveNews?.safeFallbackActive
                    ? 'NEWS UNVERIFIED · PAUSED'
                    : 'HIGH IMPACT NEWS · PAUSED'
                  : isMarketClosed
                  ? 'MARKET CLOSED'
                  : isFeedUnavailable
                  ? 'DATA UNAVAILABLE'
                  : sureStatus?.tradeLocked
                  ? 'TRADE ACTIVE · SCAN PAUSED'
                  : 'AUTO SCANNER ACTIVE'}
              </span>
            </div>

            <button
              type="button"
              onClick={handleTogglePhoneAlerts}
              className={`min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-2 border transition-colors whitespace-nowrap cursor-pointer ${
                alertsEnabled
                  ? notificationPerm === 'granted'
                    ? 'bg-emerald-500/15 border-emerald-500/45 text-emerald-400'
                    : 'bg-amber-500/15 border-amber-500/45 text-amber-300'
                  : 'bg-[#D4AF37] border-[#D4AF37] text-[#09090B] hover:bg-[#F5D061]'
              }`}
            >
              {alertsEnabled ? (
                <Bell className="w-3.5 h-3.5" />
              ) : (
                <BellOff className="w-3.5 h-3.5" />
              )}
              <span>
                {!alertsEnabled
                  ? 'Enable Phone Alerts'
                  : notificationPerm === 'granted'
                  ? 'Phone Alerts ON'
                  : notificationPerm === 'denied'
                  ? 'Sound ON · Push Blocked'
                  : 'Sound ON · Allow Push'}
              </span>
            </button>

            {alertsEnabled && (
              <button
                type="button"
                onClick={() => void handleTestPhoneAlert()}
                disabled={testingAlert}
                className="min-h-[42px] px-3 py-2 rounded-xl bg-[#181A20] border border-[#D4AF37]/40 text-xs font-mono font-semibold text-[#F5D061] hover:bg-[#D4AF37]/15 transition-colors whitespace-nowrap disabled:opacity-50 cursor-pointer"
              >
                {testingAlert ? 'Testing...' : 'Test Alert'}
              </button>
            )}
          </div>
        </div>

        {(alertFeedback || (alertsEnabled && notificationPerm === 'denied')) && (
          <div
            className={`rounded-xl border px-3.5 py-2 text-xs leading-relaxed ${
              notificationPerm === 'granted'
                ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
            }`}
          >
            {alertFeedback ||
              'Browser notifications are blocked for this site. Tap the lock/settings icon in your browser address bar and allow Notifications.'}
          </div>
        )}

        {/* Live Telemetry & Countdown Row */}
        <div className="pt-2.5 border-t border-[#D4AF37]/20 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-zinc-400">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              Spot:{' '}
              <span className="text-zinc-200 font-semibold">
                {sureStatus?.latestPrice != null ? `$${safeFixed(sureStatus.latestPrice)}` : '—'}
              </span>
            </span>
            {!isNewsPaused && (
              <>
                <span>·</span>
                <span>
                  Setup Score:{' '}
                  <span className="text-[#F5D061] font-semibold">
                    {sureStatus && !isFeedUnavailable
                      ? `${sureStatus.latestSetupScore ?? sureStatus.latestConfidencePct}/100`
                      : '—'}
                  </span>
                </span>
                <span>·</span>
                <span>
                  ADX(14):{' '}
                  <span className="text-zinc-200 font-semibold">
                    {!isFeedUnavailable && sureStatus?.latestAdx != null
                      ? safeFixed(sureStatus.latestAdx, 1)
                      : '—'}
                  </span>
                </span>
              </>
            )}
            <span>·</span>
            <span>
              Monitoring:{' '}
              {sureStatus?.monitoringMode === 'REALTIME_SPOT_BBO' ? (
                <span className="text-emerald-400 font-semibold">Live Spot BBO</span>
              ) : isMarketClosed ? (
                <span className="text-red-400 font-semibold">MARKET CLOSED</span>
              ) : sureStatus?.monitoringMode === 'DELAYED_POLL' ? (
                <span className="text-amber-400 font-semibold">Delayed Poll</span>
              ) : (
                <span className="text-zinc-200 font-semibold">
                  {sureStatus?.monitoringMode ?? '—'}
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-zinc-400">
            <Clock className="w-3.5 h-3.5" />
            <SureScanCountdownText
              formattedLastScanTime={formattedLastScanTime}
              isNewsPaused={isNewsPaused}
              tradeLocked={Boolean(sureStatus?.tradeLocked)}
              nextScanAt={sureStatus?.nextScanAt}
            />
          </div>
        </div>
      </section>

      {downloadNotice && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs font-mono text-emerald-300 truncate">
          SURE signal JPG downloaded: {downloadNotice}
        </div>
      )}

      {downloadError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2 text-xs text-red-300">
          SURE signal download failed: {downloadError}
        </div>
      )}

      {/* Non-blocking Upcoming High-Impact News Pre-Warning */}
      {isNewsWarningOnly && effectiveNews && (
        <section
          role="alert"
          className="rounded-2xl border border-red-500/70 bg-gradient-to-r from-[#2A0B0F] via-[#1C0A0D] to-[#2A0B0F] px-4 py-3 shadow-[0_0_28px_-4px_rgba(239,68,68,0.55)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 animate-pulse" />
              <div>
                <div className="text-xs sm:text-sm font-display font-extrabold tracking-wider text-red-400 uppercase drop-shadow-[0_0_10px_rgba(239,68,68,0.75)]">
                  HIGH IMPACT NEWS COMING
                </div>
                <p className="text-[11px] font-mono text-red-200/85 mt-0.5">
                  {effectiveNews.subtext}
                </p>
              </div>
            </div>
            {effectiveNews.upcomingEvent && (
              <span className="px-2 py-1 rounded-lg bg-red-600/25 border border-red-500/50 text-[11px] font-mono font-bold text-red-200 whitespace-nowrap">
                {effectiveNews.upcomingEvent.istTimeLabel} IST
              </span>
            )}
          </div>
        </section>
      )}

      {/* News Paused OR Active Trade OR Latest Outcome OR Scanning For High-Quality Setup */}
      {isNewsPaused ? (
        <section
          role="status"
          aria-live="polite"
          className="rounded-2xl border border-red-500/75 bg-gradient-to-b from-[#2B0B0F] via-[#180A0C] to-[#120A0C] p-6 text-center space-y-3 shadow-[0_0_34px_-6px_rgba(239,68,68,0.6)]"
        >
          <div className="mx-auto w-12 h-12 rounded-2xl bg-red-600/20 border border-red-500/60 flex items-center justify-center text-red-400">
            <ShieldAlert className="w-6 h-6" />
          </div>

          <div className="space-y-1">
            <div className="text-3xl sm:text-4xl font-display font-extrabold tracking-tight text-red-400 drop-shadow-[0_0_14px_rgba(239,68,68,0.65)]">
              NO TRADE
            </div>
            <div className="text-base sm:text-lg font-display font-semibold text-red-200">
              Because High Impact News Coming
            </div>
            <div className="pt-1 text-xs sm:text-sm font-mono font-bold tracking-[0.14em] uppercase text-red-400">
              HIGH IMPACT NEWS — TRADING PAUSED
            </div>
          </div>

          {effectiveNews?.dataStatusWarning ? (
            <div className="max-w-xl mx-auto rounded-xl border border-amber-500/45 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200 leading-relaxed">
              {effectiveNews.dataStatusWarning}
            </div>
          ) : (
            <p className="text-xs text-red-100/85 max-w-xl mx-auto leading-relaxed">
              {effectiveNews?.subtext ??
                'SURE Auto Scan is temporarily paused around a qualifying USD high-impact economic release. New BUY/SELL recommendations are suppressed until post-news spread and volatility stabilize.'}
            </p>
          )}

          {effectiveNews?.activeEvent && (
            <div className="inline-flex flex-wrap items-center justify-center gap-2 rounded-xl border border-red-500/40 bg-[#0D0B0D]/80 px-3.5 py-2 text-xs font-mono text-zinc-200">
              <span className="px-1.5 py-0.5 rounded bg-red-600 text-white text-[10px] font-bold">
                USD
              </span>
              <span className="font-semibold">{effectiveNews.activeEvent.title}</span>
              <span className="text-zinc-400">·</span>
              <span className="text-red-300">{effectiveNews.activeEvent.istTimeLabel} IST</span>
            </div>
          )}

          {effectiveNews?.marketStability && (
            <div className="text-[11px] font-mono text-zinc-400">
              Market Check: {effectiveNews.marketStability.volatilityDetail} · Spread:{' '}
              {effectiveNews.marketStability.spreadUsd != null
                ? `$${safeFixed(effectiveNews.marketStability.spreadUsd)}`
                : '—'}
            </div>
          )}
        </section>
      ) : loading && !sureStatus ? (
        <div className="h-44 rounded-2xl border border-[#D4AF37]/30 bg-[#121318] animate-pulse" />
      ) : spotlight ? (
        <section
          className={`rounded-2xl border p-5 space-y-4 ${
            spotlightStatus === 'TP_HIT'
              ? 'border-emerald-500/60 bg-emerald-500/12'
              : spotlightStatus === 'SL_HIT'
              ? 'border-red-500/60 bg-red-500/12'
              : spotlightStatus === 'AMBIGUOUS'
              ? 'border-amber-500/60 bg-amber-500/12'
              : spotlight.direction === 'BUY'
              ? 'border-emerald-500/45 bg-emerald-500/10'
              : 'border-red-500/45 bg-red-500/10'
          }`}
        >
          <div
            className={`rounded-xl border px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 ${spotlightBadge.className}`}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono font-bold tracking-wider">
              <span>{spotlightBadge.label}</span>
              {spotlightStatus !== 'ACTIVE' && spotlight.closePrice != null && (
                <span className="font-normal text-zinc-100">
                  · Exit ${safeFixed(spotlight.closePrice)} (
                  {safeNumber(spotlight.pnlPoints) >= 0 ? '+' : ''}
                  {safeFixed(spotlight.pnlPoints, 2, '0.00')} pts) · Duration {formattedSpotlightDuration}
                </span>
              )}
              {spotlightStatus === 'ACTIVE' && (
                <span className="font-normal text-zinc-200">
                  · Tracking live XAU/USD ticks continuously until TP or SL hits
                </span>
              )}
            </div>
            <span className="text-[11px] font-mono text-zinc-300">
              {spotlightStatus === 'ACTIVE'
                ? 'Scan Locked Until SL or TP Hits'
                : 'SCANNING FOR HIGH-QUALITY SETUP'}
            </span>
          </div>

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-zinc-300">
                ID {spotlight.id.slice(0, 8)} · {spotlight.timeframes.join(' · ')}
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                {spotlight.direction === 'BUY' ? (
                  <ArrowUp className="w-8 h-8 text-emerald-400" />
                ) : (
                  <ArrowDown className="w-8 h-8 text-red-400" />
                )}
                <h2
                  className={`text-3xl font-display font-bold tracking-tight ${
                    spotlight.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  SURE {spotlight.direction}
                </h2>
                <span
                  className={`px-2.5 py-0.5 rounded-lg border text-xs font-mono font-bold ${spotlightBadge.className}`}
                >
                  {spotlightBadge.label}
                </span>
              </div>
              <p className="text-xs text-zinc-200 max-w-xl leading-relaxed">{spotlight.summary}</p>
            </div>

            <div className="flex flex-col sm:items-end gap-2">
              <button
                type="button"
                onClick={() => handleDownloadSignal(spotlight)}
                aria-label="Download active SURE signal as JPG"
                className={`min-h-[40px] px-3.5 rounded-xl border text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                  downloadedId === spotlight.id
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                    : 'border-[#D4AF37]/45 bg-[#181A20] text-[#F5D061] hover:bg-[#D4AF37]/15'
                }`}
              >
                {downloadedId === spotlight.id ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <ImageDown className="w-4 h-4" />
                )}
                <span>{downloadedId === spotlight.id ? 'Downloaded' : 'Download Signal'}</span>
              </button>

              <div className="text-left sm:text-right font-mono tabular-nums space-y-1">
                <div className="text-[11px] text-zinc-300">Setup Quality Score</div>
                <div
                  className={`text-2xl font-bold ${
                    spotlight.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {spotlight.setupScore}/100
                </div>
                <div className="text-[11px] text-zinc-300">
                  R:R {spotlight.riskRewardRatio} · ADX {safeFixed(spotlight.adxValue, 1)}
                </div>
                <div className="text-[11px] text-zinc-400">
                  Created {formattedSpotlightCreatedAt}
                </div>
                {formattedSpotlightClosedAt && (
                  <div className="text-[11px] text-zinc-300">
                    Completed {formattedSpotlightClosedAt}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 3-Card Layout: Entry Spot · Stop Loss (SL) · ONE Take Profit (TP) */}
          {spotlight.tradeLevels && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 font-mono tabular-nums">
                <div className="rounded-xl bg-[#0D0E12] border border-[#D4AF37]/25 p-3 space-y-1">
                  <div className="text-[11px] text-zinc-400">Entry Price</div>
                  <div className="text-base font-bold text-zinc-100">
                    ${safeFixed(spotlight.tradeLevels.referencePrice)}
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    ATR ${safeFixed(spotlight.tradeLevels.atrValue)}
                  </div>
                </div>
                <div
                  className={`rounded-xl bg-[#0D0E12] border p-3 space-y-1 ${
                    spotlightStatus === 'SL_HIT'
                      ? 'border-red-400 bg-red-500/15'
                      : 'border-red-500/35'
                  }`}
                >
                  <div className="flex items-center justify-between text-[11px] text-red-400 font-semibold">
                    <span>Stop Loss (SL)</span>
                    {spotlightStatus === 'SL_HIT' && <span className="font-bold">SL HIT</span>}
                  </div>
                  <div className="text-base font-bold text-red-400">
                    ${safeFixed(spotlight.tradeLevels.stopLoss)}
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    -${safeFixed(spotlight.tradeLevels.riskPoints)} risk
                  </div>
                </div>
                <div
                  className={`rounded-xl bg-[#0D0E12] border p-3 space-y-1 ${
                    spotlightStatus === 'TP_HIT'
                      ? 'border-emerald-400 bg-emerald-500/15'
                      : 'border-emerald-500/35'
                  }`}
                >
                  <div className="flex items-center justify-between text-[11px] text-emerald-400 font-semibold">
                    <span>Take Profit (TP)</span>
                    {spotlightStatus === 'TP_HIT' && <span className="font-bold">TP HIT</span>}
                  </div>
                  <div className="text-base font-bold text-emerald-400">
                    ${safeFixed(spotlight.tradeLevels.takeProfit1)}
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    R:R {spotlight.tradeLevels.rewardRiskRatio1}
                  </div>
                </div>
              </div>

              <TradeLevelsScale
                classification={spotlight.direction}
                levels={spotlight.tradeLevels}
                singleTp
              />
            </>
          )}
        </section>
      ) : (
        <section className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] p-5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span
              className={`text-xs font-mono font-bold uppercase tracking-wider inline-flex items-center gap-2 ${
                isMarketClosed || isFeedUnavailable ? 'text-red-400' : 'text-[#F5D061]'
              }`}
            >
              {(isFeedUnavailable || isMarketClosed) && (
                <AlertTriangle className="w-4 h-4 text-red-400" />
              )}
              {isMarketClosed
                ? 'MARKET CLOSED'
                : isFeedUnavailable
                ? 'DATA UNAVAILABLE'
                : 'SCANNING FOR HIGH-QUALITY SETUP'}
            </span>
            {!isMarketClosed && !isFeedUnavailable && (
              <span className="text-xs font-mono text-zinc-400">
                {passedCount} / {checks.length || 8} strict SURE gates passed
              </span>
            )}
          </div>
          <p className="text-sm text-zinc-200 leading-relaxed">
            {sureStatus?.reason || 'SCANNING FOR HIGH-QUALITY SETUP'}
          </p>
        </section>
      )}

      {/* Real SURE Performance Statistics Card (Excluding ACTIVE & AMBIGUOUS from Win Rate) */}
      {stats && (
        <section className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-display font-semibold text-[#F5D061]">
              SURE Signal Performance Statistics
            </h2>
            <span className="text-[11px] font-mono text-zinc-500">
              Win rate excludes ACTIVE & AMBIGUOUS outcomes
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 font-mono tabular-nums text-xs">
            <div className="rounded-xl bg-[#0D0E12] border border-[#D4AF37]/22 p-2.5">
              <div className="text-[10px] text-zinc-500">Completed</div>
              <div className="text-sm font-bold text-zinc-100">{stats.totalSignals}</div>
            </div>
            <div className="rounded-xl bg-[#0D0E12] border border-emerald-500/20 p-2.5">
              <div className="text-[10px] text-emerald-400">TP Hits</div>
              <div className="text-sm font-bold text-emerald-400">{stats.tpHits}</div>
            </div>
            <div className="rounded-xl bg-[#0D0E12] border border-red-500/20 p-2.5">
              <div className="text-[10px] text-red-400">SL Hits</div>
              <div className="text-sm font-bold text-red-400">{stats.slHits}</div>
            </div>
            <div className="rounded-xl bg-[#0D0E12] border border-amber-500/20 p-2.5">
              <div className="text-[10px] text-amber-300">Ambiguous</div>
              <div className="text-sm font-bold text-amber-300">{stats.ambiguousOutcomes}</div>
            </div>
            <div className="rounded-xl bg-[#0D0E12] border border-[#D4AF37]/22 p-2.5">
              <div className="text-[10px] text-zinc-400">Win Rate</div>
              <div className="text-sm font-bold text-[#F5D061]">
                {stats.winRatePct != null ? `${stats.winRatePct}%` : '—'}
              </div>
            </div>
            <div className="rounded-xl bg-[#0D0E12] border border-[#D4AF37]/22 p-2.5">
              <div className="text-[10px] text-zinc-400">Avg R:R</div>
              <div className="text-sm font-bold text-zinc-100">
                {stats.avgRiskReward != null ? `1 : ${safeFixed(stats.avgRiskReward)}` : '—'}
              </div>
            </div>
            <div className="rounded-xl bg-[#0D0E12] border border-[#D4AF37]/22 p-2.5">
              <div className="text-[10px] text-zinc-400">Avg Duration</div>
              <div className="text-sm font-bold text-zinc-100">
                {formattedAvgDuration}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Mandatory Strict SURE Gates */}
      {!isNewsPaused && checks.length > 0 && (
        <section className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <ShieldCheck className="w-4 h-4 text-[#D4AF37] shrink-0" />
              <h2 className="text-sm font-display font-semibold text-[#F5D061]">
                8 Mandatory SURE Filter Gates ({sureStatus?.tradeLocked ? 'Locked on Active Trade · Waiting for SL/TP' : isFeedUnavailable ? 'Feed Integrity Check' : '60s Auto-Evaluation'})
              </h2>
            </div>
            <span className="text-[11px] font-mono text-zinc-400 whitespace-nowrap shrink-0">
              {passedCount} / {checks.length} passed
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {checks.map((chk) => (
              <div
                key={chk.label}
                className={`rounded-xl border p-3 flex items-start gap-2.5 ${
                  chk.passed
                    ? 'border-emerald-500/25 bg-emerald-500/5'
                    : 'border-amber-500/25 bg-amber-500/5'
                }`}
              >
                {chk.passed ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-start justify-between gap-2 text-xs font-semibold text-zinc-100">
                    <span className="leading-snug">{chk.label}</span>
                    <span
                      className={`text-[10px] font-mono whitespace-nowrap shrink-0 pt-0.5 ${
                        chk.passed ? 'text-emerald-400' : 'text-amber-400'
                      }`}
                    >
                      · {chk.passed ? 'PASS' : 'WAIT'}
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed break-words">{chk.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Latest Live 11 Indicators Snapshot inside SURE */}
      {!isNewsPaused && !isFeedUnavailable && evalData && evalData.all11Indicators.length > 0 && (
        <section className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] p-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-display font-semibold text-[#F5D061]">
              Live 11-Indicator Scanner Telemetry (5M Closed Snapshot)
            </h2>
            <span className="text-[11px] font-mono text-zinc-400">
              1H: {evalData.trend1H.bias} · 15M: {evalData.structure15M.direction} · 5M: {evalData.setup5M.direction} · 1M: {evalData.confirmation1M.direction}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 text-[11px] font-mono">
            {evalData.all11Indicators.map((ind) => {
              const metaEntries = Object.entries(ind.secondaryValues ?? {}).filter(
                ([k]) => k !== 'ClusterWeight'
              );
              return (
                <div key={ind.id} className="rounded-xl bg-[#0D0E12] border border-[#D4AF37]/22 p-2.5 space-y-1 min-w-0">
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="text-zinc-300 font-semibold truncate">{ind.name}</span>
                    <span
                      className={`shrink-0 ${
                        ind.bias === 'BUY'
                          ? 'text-emerald-400 font-bold'
                          : ind.bias === 'SELL'
                          ? 'text-red-400 font-bold'
                          : 'text-[#F5D061] font-bold'
                      }`}
                    >
                      {ind.bias}
                    </span>
                  </div>
                  <div className="text-zinc-100 tabular-nums truncate">{ind.primaryValue}</div>
                  {metaEntries.length > 0 && (
                    <div className="text-[10px] text-zinc-400 tabular-nums truncate">
                      {metaEntries.map(([k, v]) => `${k}: ${v}`).join(' · ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Persistent SURE Signal History (Completed records preserved & immutable) */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-display font-semibold text-zinc-200">
            SURE Signal History ({sureStatus?.history.length ?? 0})
          </h2>
          <span className="text-[11px] font-mono text-zinc-500">
            Completed signals preserved permanently · 1 active signal max
          </span>
        </div>

        {formattedHistoryItems.length === 0 ? (
          <div className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] p-6 text-center text-xs text-zinc-400">
            No SURE signals recorded yet. Confirmed high-quality setups (≥ 90/100) and TP HIT / SL HIT / AMBIGUOUS outcomes appear here automatically.
          </div>
        ) : (
          <div className="space-y-2">
            {formattedHistoryItems.map(
              ({
                item,
                badge,
                isActive,
                formattedCreatedAt,
                formattedClosedAt,
                formattedDuration,
              }) => (
                <div
                  key={item.id}
                  className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] p-3.5 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span
                        className={`inline-flex items-center gap-1 text-sm font-display font-bold ${
                          item.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {item.direction === 'BUY' ? (
                          <ArrowUp className="w-4 h-4" />
                        ) : (
                          <ArrowDown className="w-4 h-4" />
                        )}
                        <span>SURE {item.direction}</span>
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-md border text-[10px] font-mono font-bold ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                      <span className="text-xs font-mono text-[#F5D061]">
                        · Score {item.setupScore}/100
                      </span>
                      <span className="text-xs font-mono text-zinc-200">
                        · Entry ${safeFixed(item.tradeLevels?.referencePrice ?? item.spotPrice)}
                      </span>
                      {item.closePrice != null && (
                        <span
                          className={`text-xs font-mono font-semibold ${
                            item.status === 'TP_HIT'
                              ? 'text-emerald-400'
                              : item.status === 'SL_HIT'
                              ? 'text-red-400'
                              : 'text-amber-300'
                          }`}
                        >
                          · Exit ${safeFixed(item.closePrice)} ({safeNumber(item.pnlPoints) >= 0 ? '+' : ''}
                          {safeFixed(item.pnlPoints, 2, '0.00')} pts)
                        </span>
                      )}
                    </div>
                    <div className="text-xs font-mono text-zinc-300 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                      <span>SL ${safeFixed(item.tradeLevels?.stopLoss)}</span>
                      <span>·</span>
                      <span>TP ${safeFixed(item.tradeLevels?.takeProfit1)}</span>
                      <span>·</span>
                      <span>R:R {item.riskRewardRatio}</span>
                      <span>·</span>
                      <span>Created {formattedCreatedAt}</span>
                      {formattedClosedAt && (
                        <>
                          <span>·</span>
                          <span>Completed {formattedClosedAt}</span>
                          <span>·</span>
                          <span>Duration {formattedDuration}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleDownloadSignal(item)}
                      aria-label="Download SURE signal as JPG"
                      title="Download Signal JPG"
                      className={`min-h-[40px] px-3 flex items-center justify-center gap-1.5 rounded-xl border text-xs font-semibold transition-colors cursor-pointer ${
                        downloadedId === item.id
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                          : 'border-[#D4AF37]/35 bg-[#181A20] text-[#F5D061] hover:bg-[#D4AF37]/15'
                      }`}
                    >
                      {downloadedId === item.id ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <ImageDown className="w-4 h-4" />
                      )}
                      <span className="hidden sm:inline">
                        {downloadedId === item.id ? 'Ready' : 'Download'}
                      </span>
                    </button>

                    {isActive && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteActiveReset(item.id)}
                        disabled={deletingId === item.id}
                        aria-label="Reset active sure signal"
                        title="Clear active signal lock"
                        className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </section>

      {previewJpg && (
        <JpgPreviewModal rendered={previewJpg} onClose={handleClosePreview} />
      )}
    </div>
  );
});
