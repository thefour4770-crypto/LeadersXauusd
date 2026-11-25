import { memo } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { useLiveQuoteState } from '../contexts/LiveQuoteContext.tsx';
import {
  ALL_TIMEFRAMES,
  type Candle,
  type ChartOverlaySeries,
  type Timeframe,
} from '../types/market.ts';
import { safeFixed } from '../utils/format.ts';
import { isMarketClosedStatus } from '../utils/marketHours.ts';
import { SmoothedPriceText } from './SmoothedPriceText.tsx';
import { XauUsdChart } from './XauUsdChart.tsx';

const EMPTY_OVERLAYS: ChartOverlaySeries[] = [];
const EMPTY_LEVELS: number[] = [];

interface LeaderChartFullViewProps {
  lastCandleClose: number | null;
  candles: Candle[];
  timeframe: Timeframe;
  loading: boolean;
  error: string | null;
  onChangeTimeframe: (tf: Timeframe) => void;
  onRefresh: () => void;
  onCandleRollover?: () => void;
  onClose: () => void;
}

const LeaderHeaderPrice = memo(function LeaderHeaderPrice({
  lastCandleClose,
  hasCandles,
  latestCandleTimestamp,
}: {
  lastCandleClose: number | null;
  hasCandles: boolean;
  latestCandleTimestamp: number | null;
}) {
  const { quote, error: quoteError } = useLiveQuoteState();

  const rawDisplayPrice =
    quote && quote.freshness !== 'UNAVAILABLE' && quote.mid > 0
      ? quote.mid
      : lastCandleClose;

  const freshness =
    quote && quote.freshness !== 'UNAVAILABLE'
      ? quote.freshness
      : hasCandles
      ? 'DELAYED'
      : 'UNAVAILABLE';

  const latestDataTs =
    quote && quote.freshness !== 'UNAVAILABLE' && quote.timestamp
      ? quote.timestamp
      : latestCandleTimestamp;

  const marketClosed = isMarketClosedStatus(freshness, latestDataTs);

  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex items-center gap-2 text-xs font-mono">
        <span className="font-display font-bold tracking-wide text-[#F5D061]">LEADER</span>
        <span className="text-zinc-500">·</span>
        <span className="font-semibold text-zinc-200">XAU/USD</span>
        <span className="text-zinc-600">·</span>
        <span
          className={`inline-flex items-center gap-1.5 font-semibold ${
            freshness === 'LIVE'
              ? 'text-emerald-400'
              : marketClosed || freshness === 'UNAVAILABLE'
              ? 'text-red-400'
              : 'text-amber-400'
          }`}
        >
          {freshness === 'LIVE' && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          )}
          {marketClosed && <span className="w-1.5 h-1.5 rounded-full bg-red-400" />}
          {freshness === 'UNAVAILABLE'
            ? 'DATA UNAVAILABLE'
            : marketClosed
            ? 'MARKET CLOSED'
            : freshness}
        </span>
      </div>

      {rawDisplayPrice != null ? (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono tabular-nums">
          <SmoothedPriceText
            value={rawDisplayPrice}
            flashOnMove
            className="text-2xl sm:text-3xl font-bold transition-colors duration-200"
          />
          {quote?.changeAbs != null && quote?.changePct != null && (
            <span
              className={`text-xs font-semibold ${
                quote.changeAbs >= 0 ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              {quote.changeAbs >= 0 ? '+' : ''}
              {safeFixed(quote.changeAbs)} ({quote.changePct >= 0 ? '+' : ''}
              {safeFixed(quote.changePct)}%)
            </span>
          )}
          {quote && quote.freshness !== 'UNAVAILABLE' && (
            <span className="text-[11px] text-zinc-400">
              Bid ${safeFixed(quote.bid)} · Ask ${safeFixed(quote.ask)}
            </span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-red-400 font-semibold">
          <AlertCircle className="w-3.5 h-3.5" />
          <span>{quoteError || 'DATA UNAVAILABLE'}</span>
        </div>
      )}
    </div>
  );
});

export const LeaderChartFullView = memo(function LeaderChartFullView({
  lastCandleClose,
  candles,
  timeframe,
  loading,
  error,
  onChangeTimeframe,
  onRefresh,
  onCandleRollover,
  onClose,
}: LeaderChartFullViewProps) {
  return (
    <div
      className="fixed inset-0 z-50 h-[100dvh] w-screen bg-[#09090B] flex flex-col overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Leader Chart View Only"
    >
      {/* Compact Live Price Bar */}
      <header className="shrink-0 bg-[#0D0E12] border-b border-[#D4AF37]/30 px-3 sm:px-5 py-2.5 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <LeaderHeaderPrice
            lastCandleClose={lastCandleClose}
            hasCandles={candles.length > 0}
            latestCandleTimestamp={
              candles.length > 0 ? candles[candles.length - 1].time * 1000 : null
            }
          />

          <button
            type="button"
            onClick={onClose}
            aria-label="Exit Leader Chart View Only"
            className="min-h-[44px] px-3 rounded-xl bg-[#181A20] border border-[#D4AF37]/35 text-zinc-200 hover:border-[#D4AF37]/65 hover:text-[#F5D061] text-xs font-semibold inline-flex items-center gap-1.5 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
            <span className="hidden sm:inline">Close</span>
          </button>
        </div>

        {/* Compact Single-Row Timeframe Selector for Plain Chart */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          {ALL_TIMEFRAMES.map((tf) => {
            const active = timeframe === tf;
            return (
              <button
                key={`leader-tf-${tf}`}
                type="button"
                onClick={() => onChangeTimeframe(tf)}
                className={`min-h-[36px] px-3 rounded-lg text-xs font-mono font-semibold transition-colors whitespace-nowrap shrink-0 border ${
                  active
                    ? 'bg-[#D4AF37] border-[#D4AF37] text-[#09090B]'
                    : 'bg-[#181A20] border-[#D4AF37]/20 text-zinc-400 hover:border-[#D4AF37]/45 hover:text-zinc-100'
                }`}
              >
                {tf}
              </button>
            );
          })}
        </div>
      </header>

      {/* Full-Screen Plain Live Candlestick Chart (No Indicators / Overlays) */}
      <div className="flex-1 min-h-0 flex flex-col">
        <XauUsdChart
          candles={candles}
          overlays={EMPTY_OVERLAYS}
          timeframe={timeframe}
          supportLevels={EMPTY_LEVELS}
          resistanceLevels={EMPTY_LEVELS}
          showVolume={false}
          hasExchangeVolume={false}
          loading={loading}
          error={error}
          onRefresh={onRefresh}
          onCandleRollover={onCandleRollover}
          fullHeight
        />
      </div>
    </div>
  );
});
