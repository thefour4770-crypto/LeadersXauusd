import { memo } from 'react';
import { Check } from 'lucide-react';
import { ALL_TIMEFRAMES, type Timeframe } from '../types/market.ts';

interface TimeframeSelectorProps {
  activeChartTimeframe: Timeframe;
  selectedTimeframes: Timeframe[];
  onSelectChartTimeframe: (tf: Timeframe) => void;
  onToggleAnalysisTimeframe: (tf: Timeframe) => void;
  onSetPresetTimeframes: (tfs: Timeframe[]) => void;
  embedded?: boolean;
  mode?: 'both' | 'analysis-only' | 'chart-only';
}

export const TimeframeSelector = memo(function TimeframeSelector({
  activeChartTimeframe,
  selectedTimeframes,
  onSelectChartTimeframe,
  onToggleAnalysisTimeframe,
  onSetPresetTimeframes,
  embedded = false,
  mode = 'both',
}: TimeframeSelectorProps) {
  const showChartTf = mode === 'both' || mode === 'chart-only';
  const showAnalysisTf = mode === 'both' || mode === 'analysis-only';

  return (
    <div
      className={
        embedded
          ? 'rounded-xl border border-[#D4AF37]/25 bg-[#0C0D11]/80 p-3 space-y-3'
          : 'rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] p-3.5 space-y-3'
      }
    >
      {/* Row 1: Chart Timeframe */}
      {showChartTf && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-zinc-300">Chart Timeframe</span>
            <span className="text-[11px] font-mono text-zinc-500">Tap to view candles</span>
          </div>
          <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
            {ALL_TIMEFRAMES.map((tf) => {
              const isActive = activeChartTimeframe === tf;
              return (
                <button
                  key={`chart-${tf}`}
                  type="button"
                  onClick={() => onSelectChartTimeframe(tf)}
                  className={`min-h-[40px] px-2 rounded-xl text-xs font-mono font-semibold transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-[#D4AF37] text-[#09090B]'
                      : 'bg-[#181A20] text-zinc-300 hover:bg-[#D4AF37]/10 hover:border-[#D4AF37]/45 border border-[#D4AF37]/20'
                  }`}
                >
                  {tf}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Divider */}
      {showChartTf && showAnalysisTf && <div className="h-px bg-[#D4AF37]/20" />}

      {/* Row 2: Multi-Timeframe Analysis Scope */}
      {showAnalysisTf && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium text-zinc-300">Multi-Timeframe Analysis Scope</span>
              <span className="text-zinc-500 font-mono">· {selectedTimeframes.length} selected</span>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={() => onSetPresetTimeframes(['1m', '5m', '15m', '1H'])}
                className="text-[#D4AF37] hover:text-[#F5D061] font-medium transition-colors py-1 px-1.5"
              >
                Strict Core (4)
              </button>
              <span className="text-zinc-600">/</span>
              <button
                type="button"
                onClick={() => onSetPresetTimeframes([...ALL_TIMEFRAMES])}
                className="text-zinc-400 hover:text-zinc-200 font-medium transition-colors py-1 px-1.5"
              >
                All (8)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
            {ALL_TIMEFRAMES.map((tf) => {
              const isSelected = selectedTimeframes.includes(tf);
              return (
                <button
                  key={`analyze-${tf}`}
                  type="button"
                  onClick={() => onToggleAnalysisTimeframe(tf)}
                  aria-pressed={isSelected}
                  className={`min-h-[40px] px-2 rounded-xl text-xs font-mono font-medium inline-flex items-center justify-center gap-1 transition-colors whitespace-nowrap border ${
                    isSelected
                      ? 'bg-[#D4AF37]/15 border-[#D4AF37]/65 text-[#F5D061]'
                      : 'bg-[#181A20] border-[#D4AF37]/20 text-zinc-400 hover:text-zinc-200 hover:border-[#D4AF37]/45'
                  }`}
                >
                  {isSelected && <Check className="w-3 h-3 shrink-0" />}
                  <span>{tf}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});
