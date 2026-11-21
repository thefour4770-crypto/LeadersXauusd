import { memo } from 'react';

interface SureIconBadgeProps {
  variant?: 'nav' | 'header';
  active?: boolean;
  tone?: 'gold' | 'buy' | 'sell' | 'paused';
  className?: string;
}

/**
 * Crisp classic obsidian-and-gold directional crest (Bullish Up / Gold Horizon / Bearish Down).
 * Designed with clean vector geometry so it scales cleanly at all DPIs without raster cropping.
 */
export const SureIconBadge = memo(function SureIconBadge({
  variant = 'header',
  active = false,
  tone = 'gold',
  className = '',
}: SureIconBadgeProps) {
  if (variant === 'header') {
    return (
      <span
        className={`relative inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-b from-[#1E1A11] via-[#12100B] to-[#08090C] border border-[#D4AF37]/65 shadow-[inset_0_1px_0_rgba(245,208,97,0.32),0_6px_16px_-6px_rgba(212,175,55,0.4)] shrink-0 select-none ${className}`}
        aria-hidden="true"
      >
        <span className="absolute inset-[2px] rounded-[9px] border border-[#D4AF37]/20 pointer-events-none" />
        <svg
          viewBox="0 0 28 28"
          className="w-6 h-6"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Bullish Up Chevron */}
          <path
            d="M9.5 19V7.5M9.5 7.5L5.75 11.25M9.5 7.5L13.25 11.25"
            stroke="#34D399"
            strokeWidth="2.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Bearish Down Chevron */}
          <path
            d="M18.5 9V20.5M18.5 20.5L14.75 16.75M18.5 20.5L22.25 16.75"
            stroke="#F87171"
            strokeWidth="2.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  const insetBgClass =
    tone === 'paused' || tone === 'sell'
      ? 'bg-[#120709]/90 border-red-400/35'
      : tone === 'buy'
      ? 'bg-[#06130E]/90 border-emerald-400/35'
      : active
      ? 'bg-[#090A0E]/95 border-[#09090B]/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
      : 'bg-[#07080B]/95 border-[#D4AF37]/35';

  return (
    <span
      className={`inline-flex items-center justify-center rounded-md border px-2 py-[2px] transition-colors select-none ${insetBgClass} ${className}`}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 26 14"
        className="w-[24px] h-[13px]"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M8.5 11.5V2.5M8.5 2.5L5.25 5.75M8.5 2.5L11.75 5.75"
          stroke="#34D399"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M17.5 2.5V11.5M17.5 11.5L14.25 8.25M17.5 11.5L20.75 8.25"
          stroke="#F87171"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
});
