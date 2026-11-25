import { memo, useMemo } from 'react';
import type { SignalClassification, TradeLevelsAnalysis } from '../types/market.ts';
import { safeFixed, safeNumber } from '../utils/format.ts';

interface TradeLevelsScaleProps {
  classification: SignalClassification;
  levels: TradeLevelsAnalysis;
  singleTp?: boolean;
}

export const TradeLevelsScale = memo(function TradeLevelsScale({
  classification,
  levels,
  singleTp = true,
}: TradeLevelsScaleProps) {
  const referencePrice = safeNumber(levels?.referencePrice);
  const stopLoss = safeNumber(levels?.stopLoss, referencePrice);
  const takeProfit1 = safeNumber(levels?.takeProfit1, referencePrice);
  const takeProfit2 = safeNumber(levels?.takeProfit2, takeProfit1);
  const riskPoints = Math.max(0, safeNumber(levels?.riskPoints));

  const scaleMetrics = useMemo(() => {
    const minPrice = singleTp
      ? Math.min(stopLoss, referencePrice, takeProfit1)
      : Math.min(stopLoss, referencePrice, takeProfit1, takeProfit2);
    const maxPrice = singleTp
      ? Math.max(stopLoss, referencePrice, takeProfit1)
      : Math.max(stopLoss, referencePrice, takeProfit1, takeProfit2);
    const span = Math.max(0.01, maxPrice - minPrice);

    const toPct = (price: number) => ((price - minPrice) / span) * 100;

    const slPct = toPct(stopLoss);
    const spotPct = toPct(referencePrice);
    const tp1Pct = toPct(takeProfit1);
    const tp2Pct = toPct(takeProfit2);

    const riskLeft = Math.min(slPct, spotPct);
    const riskWidth = Math.abs(spotPct - slPct);

    const tp1Left = Math.min(spotPct, tp1Pct);
    const tp1Width = Math.abs(tp1Pct - spotPct);

    const tp2Left = Math.min(tp1Pct, tp2Pct);
    const tp2Width = Math.abs(tp2Pct - tp1Pct);

    const markers = [
      {
        key: 'SL',
        label: 'SL',
        price: stopLoss,
        pct: slPct,
        delta: stopLoss - referencePrice,
        colorClass: 'text-red-400',
        dotClass: 'bg-red-400',
      },
      {
        key: 'SPOT',
        label: singleTp ? 'Entry' : 'Spot',
        price: referencePrice,
        pct: spotPct,
        delta: 0,
        colorClass: 'text-[#F5D061]',
        dotClass: 'bg-[#F5D061]',
      },
      {
        key: 'TP1',
        label: singleTp ? 'TP' : 'TP1',
        price: takeProfit1,
        pct: tp1Pct,
        delta: takeProfit1 - referencePrice,
        colorClass: 'text-emerald-400',
        dotClass: 'bg-emerald-400',
      },
      ...(!singleTp
        ? [
            {
              key: 'TP2',
              label: 'TP2',
              price: takeProfit2,
              pct: tp2Pct,
              delta: takeProfit2 - referencePrice,
              colorClass: 'text-emerald-300',
              dotClass: 'bg-emerald-300',
            },
          ]
        : []),
    ].sort((a, b) => a.price - b.price);

    const targetPrice = singleTp ? takeProfit1 : takeProfit2;
    const totalReward = Math.abs(targetPrice - referencePrice);
    const totalDist = riskPoints + totalReward;
    const riskShare = totalDist > 0 ? (riskPoints / totalDist) * 100 : 30;
    const rewardShare = 100 - riskShare;

    return {
      minPrice,
      maxPrice,
      slPct,
      spotPct,
      tp1Pct,
      riskLeft,
      riskWidth,
      tp1Left,
      tp1Width,
      tp2Left,
      tp2Width,
      markers,
      totalReward,
      riskShare,
      rewardShare,
    };
  }, [referencePrice, stopLoss, takeProfit1, takeProfit2, riskPoints, singleTp]);

  const {
    minPrice,
    maxPrice,
    slPct,
    spotPct,
    tp1Pct,
    riskLeft,
    riskWidth,
    tp1Left,
    tp1Width,
    tp2Left,
    tp2Width,
    markers,
    totalReward,
    riskShare,
    rewardShare,
  } = scaleMetrics;

  return (
    <div className="rounded-xl bg-[#0D0E12] border border-[#D4AF37]/25 p-3.5 space-y-3">
      {/* Scale Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
        <span className="text-zinc-300 font-semibold">
          Price Target Scale (
          {classification === 'BUY'
            ? singleTp
              ? 'Long Range: SL → Entry → TP'
              : 'Long Range: SL → Spot → TP2'
            : singleTp
            ? 'Short Range: TP ← Entry ← SL'
            : 'Short Range: TP2 ← Spot ← SL'}
          )
        </span>
        <span className="text-zinc-400 tabular-nums">
          Range ${safeFixed(minPrice)} – ${safeFixed(maxPrice)}
        </span>
      </div>

      {/* Graphical Horizontal Scale Bar */}
      <div className="relative pt-5 pb-2">
        {/* Top directional end labels */}
        <div className="absolute top-0 left-0 right-0 flex items-center justify-between text-[10px] font-mono tabular-nums">
          <span className={markers[0].colorClass}>
            {markers[0].label} ${safeFixed(markers[0].price)}
          </span>
          <span className={markers[markers.length - 1].colorClass}>
            {markers[markers.length - 1].label} ${safeFixed(markers[markers.length - 1].price)}
          </span>
        </div>

        {/* Track */}
        <div className="relative h-4 w-full rounded-full bg-[#181A20] border border-[#D4AF37]/25 overflow-hidden">
          {/* Risk Segment (SL <-> Spot) */}
          <div
            className="absolute top-0 bottom-0 bg-red-500/45"
            style={{ left: `${riskLeft}%`, width: `${riskWidth}%` }}
          />
          {/* TP1 Reward Segment (Spot <-> TP1) */}
          <div
            className="absolute top-0 bottom-0 bg-emerald-500/45"
            style={{ left: `${tp1Left}%`, width: `${tp1Width}%` }}
          />
          {/* TP2 Extended Reward Segment (TP1 <-> TP2) */}
          {!singleTp && (
            <div
              className="absolute top-0 bottom-0 bg-emerald-500/22"
              style={{ left: `${tp2Left}%`, width: `${tp2Width}%` }}
            />
          )}

          {/* TP Milestone Divider */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-emerald-300"
            style={{ left: `calc(${Math.min(99.5, Math.max(0.5, tp1Pct))}% - 1px)` }}
          />
          {/* SL Boundary Divider */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-red-400"
            style={{ left: `calc(${Math.min(99.5, Math.max(0.5, slPct))}% - 1px)` }}
          />
        </div>

        {/* Current Spot Price Marker Pin */}
        <div
          className="absolute top-4 flex flex-col items-center -translate-x-1/2 pointer-events-none"
          style={{ left: `${spotPct}%` }}
        >
          <div className="w-3.5 h-6 rounded-full bg-[#F5D061] border-2 border-[#09090B] shadow-md" />
        </div>
      </div>

      {/* Ordered Price Milestones Strip */}
      <div
        className={`grid grid-cols-1 ${singleTp ? 'sm:grid-cols-3' : 'sm:grid-cols-4'} gap-2 pt-1 font-mono tabular-nums`}
      >
        {markers.map((m) => {
          const pctMove = referencePrice > 0 ? (m.delta / referencePrice) * 100 : 0;
          return (
            <div
              key={m.key}
              className="flex items-center justify-between gap-2 rounded-lg bg-[#121318] border border-[#D4AF37]/22 px-2.5 py-1.5 text-[11px]"
            >
              <span className="inline-flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${m.dotClass}`} />
                <span className={`font-semibold ${m.colorClass}`}>{m.label}</span>
              </span>
              <span className="text-right">
                <span className="text-zinc-100 font-semibold">${safeFixed(m.price)}</span>
                {m.key !== 'SPOT' && (
                  <span className="block text-[10px] text-zinc-500">
                    {pctMove >= 0 ? '+' : ''}
                    {safeFixed(pctMove, 2, '0.00')}%
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {/* Proportional Risk vs Reward Balance Bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 tabular-nums">
          <span className="text-red-400">Risk Exposure (${safeFixed(riskPoints)})</span>
          <span className="text-emerald-400">
            {singleTp ? 'Target Reward up to TP' : 'Target Reward up to TP2'} ($
            {safeFixed(totalReward)} · {singleTp ? levels?.rewardRiskRatio1 ?? '—' : levels?.rewardRiskRatio2 ?? '—'})
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full overflow-hidden flex bg-[#181A20]">
          <div className="bg-red-500/70 h-full" style={{ width: `${riskShare}%` }} />
          <div className="bg-emerald-500/70 h-full" style={{ width: `${rewardShare}%` }} />
        </div>
      </div>
    </div>
  );
});
