import { memo } from 'react';

interface SureIconBadgeProps {
  size?: 'nav' | 'compact' | 'header';
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<SureIconBadgeProps['size']>, string> = {
  nav: 'w-[32px] h-[42px]',
  compact: 'w-[20px] h-[27px]',
  header: 'w-[36px] h-[48px]',
};

export const SureIconBadge = memo(function SureIconBadge({
  size = 'nav',
  className = '',
}: SureIconBadgeProps) {
  return (
    <span
      className={`relative inline-block overflow-hidden shrink-0 select-none ${SIZE_CLASSES[size]} ${className}`}
      aria-hidden="true"
    >
      <img
        src="/assets/aistudio/file_00000000154c820bba58b2af6f81c365_ff6fbc14.png"
        alt=""
        decoding="async"
        className="pointer-events-none select-none absolute left-1/2 top-[50.5%] h-full w-auto max-w-none aspect-square -translate-x-1/2 -translate-y-1/2 scale-[2.18] mix-blend-screen"
      />
    </span>
  );
});
