import { memo, useMemo } from 'react';
import { AlertTriangle, Calendar, Clock, RefreshCw, ShieldAlert } from 'lucide-react';
import type { EconomicCalendarPayload, EconomicNewsEvent } from '../types/market.ts';
import { safeLocaleTime } from '../utils/format.ts';

interface NewsCalendarViewProps {
  calendar: EconomicCalendarPayload | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
}

function ForexFactoryRedImpactIcon() {
  return (
    <span
      className="inline-flex items-end gap-[2px] h-3.5 px-1.5 py-0.5 rounded bg-red-600/15 border border-red-500/45"
      title="High Impact (RED)"
    >
      <span className="w-[3px] h-2 bg-red-500 rounded-[1px]" />
      <span className="w-[3px] h-2.5 bg-red-500 rounded-[1px]" />
      <span className="w-[3px] h-3 bg-red-500 rounded-[1px]" />
      <span className="ml-1 text-[9px] font-mono font-bold tracking-wider text-red-400 leading-none">
        HIGH
      </span>
    </span>
  );
}

function MetricCell({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string | null;
  highlight?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 sm:hidden">
        {label}
      </div>
      <div
        className={`text-xs font-mono tabular-nums truncate ${
          value
            ? highlight
              ? 'text-zinc-100 font-bold'
              : 'text-zinc-200 font-medium'
            : 'text-zinc-500'
        }`}
      >
        {value ?? '—'}
      </div>
    </div>
  );
}

const EventRow = memo(function EventRow({
  event,
  isBlocking,
  isUpcomingWarning,
}: {
  event: EconomicNewsEvent;
  isBlocking: boolean;
  isUpcomingWarning: boolean;
}) {
  return (
    <div
      className={`px-3.5 py-3 transition-colors ${
        isBlocking
          ? 'bg-red-950/35'
          : isUpcomingWarning
          ? 'bg-red-950/20'
          : 'hover:bg-white/[0.02]'
      }`}
    >
      {/* Desktop: Forex Factory 7-column layout | Mobile: stacked compact card row */}
      <div className="flex flex-col sm:grid sm:grid-cols-12 sm:items-center gap-2 sm:gap-3">
        {/* Time IST + Currency + Impact */}
        <div className="sm:col-span-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-mono font-semibold tabular-nums text-zinc-200 min-w-[76px]">
            {event.istTimeLabel} <span className="text-[10px] text-zinc-400">IST</span>
          </span>

          {/* Required USD Currency Badge in RED Box */}
          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded bg-red-600 text-white text-[11px] font-mono font-bold tracking-wider shrink-0">
            {event.currency}
          </span>

          {/* RED High Impact Indicator */}
          <ForexFactoryRedImpactIcon />
        </div>

        {/* Full News Event Name */}
        <div className="sm:col-span-4 min-w-0 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100 leading-snug break-words">
            {event.title}
          </span>
          {isBlocking && (
            <span className="text-[10px] font-mono font-bold text-red-400 whitespace-nowrap shrink-0">
              · PAUSED
            </span>
          )}
          {!isBlocking && isUpcomingWarning && (
            <span className="text-[10px] font-mono font-bold text-red-400 whitespace-nowrap shrink-0">
              · COMING
            </span>
          )}
        </div>

        {/* Actual | Forecast | Previous */}
        <div className="sm:col-span-4 grid grid-cols-3 gap-2 pt-1.5 sm:pt-0 border-t border-[#D4AF37]/15 sm:border-t-0 sm:text-right">
          <MetricCell label="Actual" value={event.actual} highlight />
          <MetricCell label="Forecast" value={event.forecast} />
          <MetricCell label="Previous" value={event.previous} />
        </div>
      </div>
    </div>
  );
});

export const NewsCalendarView = memo(function NewsCalendarView({
  calendar,
  loading,
  refreshing,
  error,
  onRefresh,
}: NewsCalendarViewProps) {
  const protection = calendar?.protection ?? null;
  const activeId = protection?.activeEvent?.id ?? null;
  const upcomingId = protection?.upcomingEvent?.id ?? null;
  const showYearPerDay = useMemo(
    () => (calendar?.days ? new Set(calendar.days.map((d) => d.year)).size > 1 : false),
    [calendar?.days]
  );

  const formattedUpdated = useMemo(() => {
    if (!calendar?.lastUpdatedAt) return null;
    const formatted = safeLocaleTime(
      calendar.lastUpdatedAt,
      {
        timeZone: 'Asia/Kolkata',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      },
      ''
    );
    return formatted || null;
  }, [calendar?.lastUpdatedAt]);

  return (
    <div className="space-y-4 pb-6">
      {/* Header Bar — Automatic Locked Scope (NO manual filter controls) */}
      <section className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-[#D4AF37]" />
              <h1 className="text-lg sm:text-xl font-display font-bold text-zinc-100">
                Economic News Calendar
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-zinc-400">
              <span className="text-red-400 font-semibold">USD</span>
              <span>·</span>
              <span className="text-red-400 font-semibold">RED High Impact Only</span>
              <span>·</span>
              <span>IST (Asia/Kolkata)</span>
            </div>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            {calendar && (
              <span
                className={`text-[11px] font-mono font-semibold ${
                  calendar.feedStatus === 'LIVE'
                    ? 'text-emerald-400'
                    : calendar.feedStatus === 'CACHED'
                    ? 'text-amber-300'
                    : 'text-red-400'
                }`}
              >
                {calendar.feedStatus}
                {formattedUpdated ? ` · ${formattedUpdated} IST` : ''}
              </span>
            )}
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh economic calendar"
              className="min-h-[44px] px-3 rounded-xl border border-[#D4AF37]/30 bg-[#181A20] text-xs font-semibold text-zinc-200 hover:border-[#D4AF37]/60 hover:text-[#F5D061] inline-flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* Centralized Blocking / Safe Fallback Status Notice */}
        {(error || calendar?.dataStatusWarning) && (
          <div className="rounded-xl border border-red-500/55 bg-red-950/45 px-3.5 py-2.5 flex items-start gap-2.5 text-xs text-red-200">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-mono font-bold text-red-400">
                NEWS DATA UNVERIFIED — SAFE FALLBACK ACTIVE
              </div>
              <p className="leading-relaxed">
                {calendar?.dataStatusWarning || error}
              </p>
            </div>
          </div>
        )}

        {protection && !protection.safeFallbackActive && protection.blocked && (
          <div className="rounded-xl border border-red-500/75 bg-red-950/55 px-3.5 py-2.5 shadow-[0_0_22px_-6px_rgba(239,68,68,0.65)] flex items-start gap-2.5 text-xs">
            <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-mono font-bold text-red-400 tracking-wide">
                HIGH IMPACT NEWS — TRADING PAUSED
              </div>
              <p className="text-red-100 leading-relaxed">{protection.subtext}</p>
            </div>
          </div>
        )}

        {protection && !protection.blocked && protection.warningActive && (
          <div className="rounded-xl border border-red-500/65 bg-red-950/40 px-3.5 py-2.5 shadow-[0_0_18px_-6px_rgba(239,68,68,0.5)] flex items-start gap-2.5 text-xs">
            <Clock className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-mono font-bold text-red-400 tracking-wide">
                HIGH IMPACT NEWS COMING
              </div>
              <p className="text-red-100 leading-relaxed">{protection.subtext}</p>
            </div>
          </div>
        )}
      </section>

      {/* Rolling 7-Day Calendar Container */}
      {loading && !calendar ? (
        <div className="space-y-3">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className="h-28 rounded-2xl border border-[#D4AF37]/30 bg-[#121318] animate-pulse"
            />
          ))}
        </div>
      ) : !calendar ? (
        <section className="rounded-2xl border border-red-500/40 bg-[#121318] p-6 text-center space-y-2">
          <div className="text-sm font-display font-bold text-red-400">
            Economic Calendar Unavailable
          </div>
          <p className="text-xs text-zinc-400 max-w-md mx-auto">
            {error || 'Unable to load USD High-Impact events. Safe fallback keeps trading signals paused until verified.'}
          </p>
        </section>
      ) : (
        <div className="space-y-3">
          {/* Top-Center Year Header Required by Spec */}
          <div className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] px-4 py-3 text-center space-y-1">
            <div className="text-2xl sm:text-3xl font-display font-bold tracking-[0.16em] text-[#F5D061] tabular-nums">
              {calendar.yearHeader}
            </div>
            <div className="text-[11px] font-mono text-zinc-400">
              Rolling 7-Day Calendar · {calendar.startDateKey} to {calendar.endDateKey} ·{' '}
              {calendar.eventsCount} USD Red Event{calendar.eventsCount === 1 ? '' : 's'}
            </div>
          </div>

          {/* Desktop Column Legend */}
          <div className="hidden sm:grid sm:grid-cols-12 gap-3 px-4 py-1.5 text-[11px] font-mono uppercase tracking-wider text-zinc-500">
            <div className="col-span-4">Time (IST) · Currency · Impact</div>
            <div className="col-span-4">Event</div>
            <div className="col-span-4 grid grid-cols-3 text-right">
              <div>Actual</div>
              <div>Forecast</div>
              <div>Previous</div>
            </div>
          </div>

          {/* Day-by-Day Date Sections (Today through Today + 7 Calendar Days) */}
          {calendar.days.map((day) => (
            <section
              key={day.dateKey}
              className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] overflow-hidden"
            >
              <header className="px-4 py-2.5 bg-[#181A20] border-b border-[#D4AF37]/20 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-display font-bold text-zinc-100">
                    {day.dayLabel}
                    {showYearPerDay ? `, ${day.year}` : ''}
                  </h2>
                  {day.isToday && (
                    <span className="text-[11px] font-mono font-bold text-[#F5D061]">
                      · Today
                    </span>
                  )}
                </div>
                <span className="text-[11px] font-mono text-zinc-400 tabular-nums">
                  {day.events.length} {day.events.length === 1 ? 'event' : 'events'}
                </span>
              </header>

              {day.events.length === 0 ? (
                <div className="px-4 py-3 text-xs text-zinc-500 font-mono">
                  No scheduled USD red high-impact events on this date.
                </div>
              ) : (
                <div className="divide-y divide-[#D4AF37]/15">
                  {day.events.map((ev) => (
                    <EventRow
                      key={ev.id}
                      event={ev}
                      isBlocking={activeId === ev.id}
                      isUpcomingWarning={upcomingId === ev.id && protection?.warningActive === true}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}

          {calendar.sources.length > 0 && (
            <p className="text-[11px] font-mono text-zinc-500 text-center pt-1">
              Data Sources: {calendar.sources.join(' + ')} · News protection reduces exposure during scheduled macro volatility; does not guarantee against trading losses.
            </p>
          )}
        </div>
      )}
    </div>
  );
});
