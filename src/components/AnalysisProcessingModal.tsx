import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { motion } from 'motion/react';

export const ANALYSIS_STAGES = [
  'Connecting to XAUUSD market data',
  'Fetching historical candles',
  'Reading selected timeframes',
  'Calculating technical indicators',
  'Comparing market conditions',
  'Preparing final analysis',
] as const;

interface AnalysisProcessingModalProps {
  currentStageIndex: number;
  selectedTimeframeCount: number;
  selectedIndicatorCount: number;
  errorStatus: string | null;
  errorMessage: string | null;
  onCloseError: () => void;
  onRetry: () => void;
}

export function AnalysisProcessingModal({
  currentStageIndex,
  selectedTimeframeCount,
  selectedIndicatorCount,
  errorStatus,
  errorMessage,
  onCloseError,
  onRetry,
}: AnalysisProcessingModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4"
      role="dialog"
      aria-modal="true"
      aria-label="XAUUSD Analysis Processing"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2 }}
        className="w-full max-w-md rounded-2xl border border-[#D4AF37]/40 bg-[#121318] shadow-[0_16px_48px_-16px_rgba(212,175,55,0.28)] p-6 space-y-5"
      >
        {errorMessage ? (
          <div className="space-y-4 text-center">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-red-500/15 border border-red-500/30 flex items-center justify-center text-red-400">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-lg font-display font-bold text-red-400">
                {errorStatus || 'DATA UNAVAILABLE'}
              </h3>
              <p className="text-sm text-zinc-300 leading-relaxed">{errorMessage}</p>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={onCloseError}
                className="flex-1 min-h-[44px] rounded-xl border border-[#D4AF37]/30 text-zinc-300 text-xs font-semibold hover:bg-[#D4AF37]/10 transition-colors"
              >
                Close
              </button>
              <button
                type="button"
                onClick={onRetry}
                className="flex-1 min-h-[44px] rounded-xl bg-[#D4AF37] text-[#09090B] text-xs font-semibold hover:bg-[#F5D061] transition-colors"
              >
                Retry Analysis
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <h3 className="text-lg font-display font-bold text-[#F5D061]">
                Analysing XAUUSD Market Data
              </h3>
              <p className="text-xs font-mono text-zinc-400">
                {selectedTimeframeCount} timeframe(s) · {selectedIndicatorCount} indicator(s)
              </p>
            </div>

            <div className="space-y-2.5">
              {ANALYSIS_STAGES.map((stage, idx) => {
                const isDone = idx < currentStageIndex;
                const isActive = idx === currentStageIndex;
                return (
                  <div
                    key={stage}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 border transition-colors ${
                      isDone
                        ? 'border-[#D4AF37]/25 bg-[#D4AF37]/10 text-zinc-100'
                        : isActive
                        ? 'border-[#D4AF37]/50 bg-[#181A20] text-[#F5D061]'
                        : 'border-[#D4AF37]/18 bg-[#0E0F14] text-zinc-500'
                    }`}
                  >
                    <div className="shrink-0">
                      {isDone ? (
                        <CheckCircle2 className="w-4 h-4 text-[#D4AF37]" />
                      ) : isActive ? (
                        <Loader2 className="w-4 h-4 animate-spin text-[#F5D061]" />
                      ) : (
                        <div className="w-4 h-4 rounded-full border border-zinc-700" />
                      )}
                    </div>
                    <span className="text-xs font-medium">{stage}</span>
                  </div>
                );
              })}
            </div>

            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Calculations execute against live/historical exchange candles on the backend. Report will appear only once all indicators complete.
            </p>
          </>
        )}
      </motion.div>
    </div>
  );
}
