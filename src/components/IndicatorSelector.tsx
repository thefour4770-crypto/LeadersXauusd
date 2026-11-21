import { memo, useMemo, useState } from 'react';
import { CheckCheck, ChevronDown, ChevronUp, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import { INDICATOR_CATALOG } from '../constants/indicators.ts';
import type { IndicatorCategory, IndicatorId, SelectedIndicatorConfig } from '../types/market.ts';

interface IndicatorSelectorProps {
  indicators: SelectedIndicatorConfig[];
  onToggleIndicator: (id: IndicatorId) => void;
  onUpdateParam: (id: IndicatorId, key: string, value: number) => void;
  onResetDefaults: () => void;
  onBulkCategoryToggle: (category: IndicatorCategory, enable: boolean) => void;
  onEnableAllIndicators: () => void;
}

const CATEGORIES: { key: IndicatorCategory; label: string }[] = [
  { key: 'TREND', label: 'Trend' },
  { key: 'MOMENTUM', label: 'Momentum' },
  { key: 'VOLATILITY', label: 'Volatility' },
  { key: 'VOLUME', label: 'Volume' },
];

export const IndicatorSelector = memo(function IndicatorSelector({
  indicators,
  onToggleIndicator,
  onUpdateParam,
  onResetDefaults,
  onBulkCategoryToggle,
  onEnableAllIndicators,
}: IndicatorSelectorProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState<IndicatorCategory>('TREND');
  const [expandedParamId, setExpandedParamId] = useState<IndicatorId | null>(null);

  const indicatorById = useMemo(() => {
    const map = new Map<IndicatorId, SelectedIndicatorConfig>();
    for (const item of indicators) {
      map.set(item.id, item);
    }
    return map;
  }, [indicators]);

  const enabledConfigs = useMemo(() => indicators.filter((i) => i.enabled), [indicators]);
  const allEnabled = enabledConfigs.length === INDICATOR_CATALOG.length;

  const enabledNames = useMemo(
    () =>
      enabledConfigs
        .map((cfg) => INDICATOR_CATALOG.find((d) => d.id === cfg.id)?.name)
        .filter((name): name is string => Boolean(name)),
    [enabledConfigs]
  );

  const categoryDefs = useMemo(
    () => INDICATOR_CATALOG.filter((d) => d.category === activeCategory),
    [activeCategory]
  );

  const categoryEnabledCount = useMemo(
    () => categoryDefs.filter((d) => indicatorById.get(d.id)?.enabled).length,
    [categoryDefs, indicatorById]
  );

  const categorySummaries = useMemo(
    () =>
      CATEGORIES.map((cat) => {
        const totalInCat = INDICATOR_CATALOG.filter((d) => d.category === cat.key);
        const activeInCat = totalInCat.filter((d) => indicatorById.get(d.id)?.enabled).length;
        return {
          key: cat.key,
          label: cat.label,
          total: totalInCat.length,
          active: activeInCat,
        };
      }),
    [indicatorById]
  );

  return (
    <>
      {/* Separated Indicator Configuration Card */}
      <section
        aria-label="Indicator Configuration"
        className="rounded-2xl border border-[#D4AF37]/35 bg-[#121318] shadow-[0_8px_24px_-16px_rgba(212,175,55,0.22)] p-4 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2.5 pb-2.5 border-b border-[#D4AF37]/20">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-zinc-400">
              Indicator Configuration
            </div>
            <h2 className="text-sm font-display font-semibold text-zinc-100 mt-0.5">
              Technical Indicators
            </h2>
            <p className="text-[11px] font-mono tabular-nums text-zinc-400 mt-0.5">
              {enabledConfigs.length} of {INDICATOR_CATALOG.length} active across 4 categories
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onEnableAllIndicators}
              disabled={allEnabled}
              className={`min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                allEnabled
                  ? 'bg-emerald-500/15 border border-emerald-500/35 text-emerald-400'
                  : 'bg-[#D4AF37] text-[#09090B] hover:bg-[#F5D061]'
              }`}
            >
              <CheckCheck className="w-3.5 h-3.5" />
              <span>{allEnabled ? 'All Enabled' : 'Enable All'}</span>
            </button>
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className="min-h-[44px] px-3 py-2 rounded-xl bg-[#181A20] border border-[#D4AF37]/40 text-[#F5D061] text-xs font-semibold inline-flex items-center gap-1.5 hover:bg-[#D4AF37]/10 transition-colors whitespace-nowrap"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Configure</span>
            </button>
          </div>
        </div>

        {/* Category Coverage Breakdown */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 font-mono tabular-nums">
          {categorySummaries.map((cat) => (
            <div
              key={cat.key}
              className="rounded-xl border border-[#D4AF37]/22 bg-[#0C0D11]/80 px-2.5 py-2 flex items-center justify-between gap-1.5"
            >
              <span className="text-[11px] text-zinc-400 truncate">{cat.label}</span>
              <span
                className={`text-[11px] font-semibold ${
                  cat.active > 0 ? 'text-[#F5D061]' : 'text-zinc-600'
                }`}
              >
                {cat.active}/{cat.total}
              </span>
            </div>
          ))}
        </div>

        {/* Subtle Inner-Bordered Summary of Active Indicators */}
        <div className="rounded-xl border border-[#D4AF37]/22 bg-[#0C0D11]/60 px-3 py-2.5">
          {enabledNames.length > 0 ? (
            <p className="text-xs text-zinc-400 leading-relaxed line-clamp-3">
              {enabledNames.join(' · ')}
            </p>
          ) : (
            <p className="text-xs text-amber-400">
              No indicators selected. Enable at least one indicator to run analysis.
            </p>
          )}
        </div>
      </section>

      {/* Bottom Sheet / Responsive Modal */}
      {sheetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Configure Technical Indicators"
        >
          <div className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-[#121318] border border-[#D4AF37]/40 shadow-[0_16px_48px_-16px_rgba(212,175,55,0.28)] overflow-hidden">
            {/* Drag Handle on mobile */}
            <div className="sm:hidden pt-2.5 pb-1 flex justify-center">
              <div className="w-10 h-1 rounded-full bg-[#D4AF37]/45" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#D4AF37]/20">
              <div>
                <h3 className="text-base font-display font-semibold text-zinc-100">
                  Technical Indicators
                </h3>
                <p className="text-xs text-zinc-400 font-mono">
                  {enabledConfigs.length} enabled · Configure parameters
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onEnableAllIndicators}
                  disabled={allEnabled}
                  className={`min-h-[40px] px-3 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                    allEnabled
                      ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                      : 'bg-[#D4AF37] text-[#09090B] hover:bg-[#F5D061]'
                  }`}
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  <span>{allEnabled ? 'All Enabled' : 'Enable All'}</span>
                </button>
                <button
                  type="button"
                  onClick={onResetDefaults}
                  className="min-h-[40px] px-2.5 rounded-xl text-xs font-medium text-zinc-300 hover:text-[#F5D061] hover:bg-white/5 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Defaults</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSheetOpen(false)}
                  aria-label="Close indicator selector"
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* 4 Category Tabs */}
            <div className="grid grid-cols-4 gap-1 p-2 bg-[#0C0D11] border-b border-[#D4AF37]/20">
              {categorySummaries.map((cat) => {
                const active = activeCategory === cat.key;
                return (
                  <button
                    key={cat.key}
                    type="button"
                    onClick={() => setActiveCategory(cat.key)}
                    className={`min-h-[42px] px-2 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-[#D4AF37] text-[#09090B]'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
                    }`}
                  >
                    {cat.label} ({cat.active})
                  </button>
                );
              })}
            </div>

            {/* Category Quick Actions */}
            <div className="flex items-center justify-between px-4 py-2 bg-[#0F1015] border-b border-[#D4AF37]/15 text-xs">
              <span className="text-zinc-400">
                {categoryEnabledCount} / {categoryDefs.length} active in {activeCategory}
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onBulkCategoryToggle(activeCategory, true)}
                  className="text-[#D4AF37] hover:text-[#F5D061] font-medium py-1"
                >
                  Enable All
                </button>
                <button
                  type="button"
                  onClick={() => onBulkCategoryToggle(activeCategory, false)}
                  className="text-zinc-400 hover:text-zinc-200 font-medium py-1"
                >
                  Disable All
                </button>
              </div>
            </div>

            {/* Indicator List */}
            <div className="flex-1 overflow-y-auto divide-y divide-[#D4AF37]/15">
              {categoryDefs.map((def) => {
                const cfg = indicatorById.get(def.id)!;
                const isExpanded = expandedParamId === def.id;
                return (
                  <div key={def.id} className="px-4 py-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => onToggleIndicator(def.id)}
                        className="flex-1 text-left min-h-[44px] flex items-center gap-3"
                      >
                        <div
                          className={`w-10 h-6 rounded-full p-0.5 transition-colors shrink-0 flex items-center ${
                            cfg.enabled ? 'bg-[#D4AF37] justify-end' : 'bg-zinc-700 justify-start'
                          }`}
                        >
                          <div className="w-5 h-5 rounded-full bg-[#09090B]" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-zinc-100">{def.name}</span>
                            {def.overlayOnChart && (
                              <span className="text-[11px] font-mono text-[#D4AF37]">
                                · Chart Overlay
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-zinc-400 line-clamp-1">{def.description}</p>
                        </div>
                      </button>

                      {def.paramSpecs.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setExpandedParamId(isExpanded ? null : def.id)}
                          aria-label={`Configure ${def.name} parameters`}
                          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-zinc-400 hover:text-[#F5D061] hover:bg-white/5 transition-colors"
                        >
                          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      )}
                    </div>

                    {/* Parameter Editor */}
                    {isExpanded && (
                      <div className="pl-13 pr-1 pt-1 pb-1 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {def.paramSpecs.map((spec) => {
                          const val = cfg.params[spec.key] ?? spec.defaultValue;
                          return (
                            <div
                              key={spec.key}
                              className="flex items-center justify-between gap-2 rounded-xl bg-[#181A20] border border-[#D4AF37]/25 px-3 py-2"
                            >
                              <span className="text-xs text-zinc-300">{spec.label}</span>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    onUpdateParam(
                                      def.id,
                                      spec.key,
                                      Math.max(spec.min, Number((val - spec.step).toFixed(2)))
                                    )
                                  }
                                  className="w-8 h-8 rounded-lg bg-[#0C0D11] text-zinc-300 hover:text-[#F5D061] font-mono text-sm flex items-center justify-center"
                                >
                                  -
                                </button>
                                <input
                                  type="number"
                                  value={val}
                                  min={spec.min}
                                  max={spec.max}
                                  step={spec.step}
                                  onChange={(e) => {
                                    const parsed = Number(e.target.value);
                                    if (Number.isFinite(parsed)) {
                                      onUpdateParam(
                                        def.id,
                                        spec.key,
                                        Math.min(spec.max, Math.max(spec.min, parsed))
                                      );
                                    }
                                  }}
                                  className="w-16 text-center bg-transparent text-xs font-mono font-semibold text-[#F5D061] focus:outline-none"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    onUpdateParam(
                                      def.id,
                                      spec.key,
                                      Math.min(spec.max, Number((val + spec.step).toFixed(2)))
                                    )
                                  }
                                  className="w-8 h-8 rounded-lg bg-[#0C0D11] text-zinc-300 hover:text-[#F5D061] font-mono text-sm flex items-center justify-center"
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Bottom Done Bar */}
            <div className="p-3.5 border-t border-[#D4AF37]/20 bg-[#0C0D11]">
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="w-full min-h-[48px] rounded-xl bg-[#D4AF37] text-[#09090B] text-sm font-semibold hover:bg-[#F5D061] transition-colors"
              >
                Apply Indicator Selection ({enabledConfigs.length})
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});
