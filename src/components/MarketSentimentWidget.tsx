import { memo } from 'react';
import { Activity, AlertCircle, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { MarketSentiment24h } from '../types/market.ts';
import { isMarketClosedStatus } from '../utils/marketHours.ts';

interface MarketSentimentWidgetProps {
  sentiment: MarketSentiment24h | null;
  loading: boolean;
  error: string | null;
}

export const MarketSentimentWidget = memo(function MarketSentimentWidget({
  sentiment,
  loading,
  error,
}: MarketSentimentWidgetProps) {
  if (loading && !sentiment) {
    return (
      <section className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] p-4 space-y-3 animate-pulse">
        <div className="h-4 w-40 bg-white/10 rounded" />
        <div className="h-3 w-full bg-white/8 rounded-full" />
        <div className="h-10 w-full bg-white/5 rounded-xl" />
      </section>
    );
  }

  if (!sentiment || error) {
    return (
      <section className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] p-4 flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h2 className="text-xs font-display font-semibold text-zinc-200">
            Market Sentiment (24H Hourly Volatility)
          </h2>
          <p className="text-xs text-red-400 inline-flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>{error || 'DATA UNAVAILABLE'}</span>
          </p>
        </div>
      </section>
    );
  }

  const isBull = sentiment.direction === 'BULLISH';
  const isBear = sentiment.direction === 'BEARISH';
  const accentColor = isBull
    ? 'text-emerald-400'
    : isBear
    ? 'text-red-400'
    : 'text-[#F5D061]';
  const DirIcon = isBull ? TrendingUp : isBear ? TrendingDown : Minus;

  const dominantPct =
    sentiment.bullishSharePct >= sentiment.bearishSharePct
      ? `${sentiment.bullishSharePct}% Bullish`
      : `${sentiment.bearishSharePct}% Bearish`;

  const marketClosed = isMarketClosedStatus(sentiment.freshness, sentiment.latestTimestamp);

  return (
    <section className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] p-4 space-y-3">
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#D4AF37]" />
          <h2 className="text-sm font-display font-semibold text-zinc-100">
            Market Sentiment
          </h2>
          <span className="text-[11px] font-mono text-zinc-400">
            · 24H Hourly Volatility ·{' '}
            {marketClosed ? (
              <span className="text-red-400 font-semibold">MARKET CLOSED</span>
            ) : (
              sentiment.freshness
            )}
          </span>
        </div>

        <div className={`inline-flex items-center gap-1.5 text-sm font-mono font-bold tabular-nums ${accentColor}`}>
          <DirIcon className="w-4 h-4" />
          <span>
            {sentiment.directionalTrendPct >= 0 ? '+' : ''}
            {sentiment.directionalTrendPct.toFixed(1)}%
          </span>
          <span className="text-xs font-medium text-zinc-400">({dominantPct})</span>
        </div>
      </div>

      {/* Directional Pressure Bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px] font-mono tabular-nums">
          <span className="text-emerald-400 font-semibold">
            Bullish Pressure {sentiment.bullishSharePct}%
          </span>
          <span className="text-red-400 font-semibold">
            Bearish Pressure {sentiment.bearishSharePct}%
          </span>
        </div>
        <div className="h-2.5 w-full rounded-full overflow-hidden flex bg-[#09090B] border border-[#D4AF37]/25">
          <div
            className="h-full bg-emerald-500/75 transition-all duration-300"
            style={{ width: `${sentiment.bullishSharePct}%` }}
          />
          <div
            className="h-full bg-red-500/75 transition-all duration-300"
            style={{ width: `${sentiment.bearishSharePct}%` }}
          />
        </div>
      </div>

      {/* Hourly Volatility Metrics Strip */}
      <div className="grid grid-cols-3 gap-2 pt-0.5 text-xs font-mono tabular-nums">
        <div className="rounded-xl bg-[#0D0E12] border border-[#D4AF37]/22 px-2.5 py-2">
          <div className="text-[10px] text-zinc-500">24H Net Move</div>
          <div
            className={`font-semibold ${
              sentiment.priceChange24hPct >= 0 ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {sentiment.priceChange24hPct >= 0 ? '+' : ''}
            {sentiment.priceChange24hPct.toFixed(2)}%
          </div>
        </div>

        <div className="rounded-xl bg-[#0D0E12] border border-[#D4AF37]/22 px-2.5 py-2">
          <div className="text-[10px] text-zinc-500">1H ATR / Avg</div>
          <div className="text-zinc-200 font-semibold">
            ${sentiment.latestHourlyAtrUsd.toFixed(2)}{' '}
            <span className="text-[10px] text-zinc-400">({sentiment.volatilityRegime})</span>
          </div>
        </div>

        <div className="rounded-xl bg-[#0D0E12] border border-[#D4AF37]/22 px-2.5 py-2">
          <div className="text-[10px] text-zinc-500">Up / Down Hrs</div>
          <div className="text-zinc-200 font-semibold">
            {sentiment.upHours} / {sentiment.downHours}{' '}
            <span className="text-[10px] text-zinc-500">({sentiment.hoursAnalyzed}h)</span>
          </div>
        </div>
      </div>
    </section>
  );
});
