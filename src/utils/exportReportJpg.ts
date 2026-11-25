import type { AnalysisReport, SignalClassification, SureSignalEntry } from '../types/market.ts';
import { fetchWithTimeout, safeFixed, safeNumber } from './format.ts';
import { getReportSignalConfidence } from './signalConfidence.ts';

const LOGICAL_WIDTH = 1080;
const PADDING_X = 36;
const CONTENT_WIDTH = LOGICAL_WIDTH - PADDING_X * 2;
const TOP_PADDING = 36;
const BOTTOM_PADDING = 36;
const MAX_CANVAS_PX = 14000;

const PALETTE = {
  bg: '#09090B',
  surface: '#121318',
  surfaceInner: '#0C0D11',
  gold: '#D4AF37',
  goldBright: '#F5D061',
  textPrimary: '#F4F4F5',
  textSecondary: '#D4D4D8',
  textMuted: '#A1A1AA',
  textDim: '#71717A',
  border: 'rgba(255, 255, 255, 0.10)',
  goldBorder: 'rgba(212, 175, 55, 0.38)',
  buy: '#34D399',
  buyBg: 'rgba(16, 185, 129, 0.10)',
  buyBorder: 'rgba(16, 185, 129, 0.35)',
  sell: '#F87171',
  sellBg: 'rgba(239, 68, 68, 0.10)',
  sellBorder: 'rgba(239, 68, 68, 0.35)',
  hold: '#F5D061',
  holdBg: 'rgba(212, 175, 55, 0.10)',
  holdBorder: 'rgba(212, 175, 55, 0.40)',
};

function getBiasColors(bias: SignalClassification) {
  if (bias === 'BUY') {
    return { text: PALETTE.buy, bg: PALETTE.buyBg, border: PALETTE.buyBorder };
  }
  if (bias === 'SELL') {
    return { text: PALETTE.sell, bg: PALETTE.sellBg, border: PALETTE.sellBorder };
  }
  return { text: PALETTE.hold, bg: PALETTE.holdBg, border: PALETTE.holdBorder };
}

function formatDateTime(value: string | number): string {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  return dt.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function buildFilename(report: AnalysisReport): string {
  const dt = new Date(report.createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = Number.isNaN(dt.getTime())
    ? 'report'
    : `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}-${pad(dt.getHours())}${pad(dt.getMinutes())}`;
  const shortId = report.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'signal';
  return `LEADERS-XAUUSD-${report.classification}-${stamp}-${shortId}.jpg`;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  font: string
): string[] {
  ctx.font = font;
  const paragraphs = String(text ?? '').split('\n');
  const lines: string[] = [];

  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${current} ${words[i]}`;
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = words[i];
      }
    }
    lines.push(current);
  }

  return lines;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fillStyle?: string,
  strokeStyle?: string,
  lineWidth = 1
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();

  if (fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }
  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

function renderReportToCanvas(
  ctx: CanvasRenderingContext2D,
  report: AnalysisReport,
  dryRun: boolean
): number {
  let y = TOP_PADDING;

  if (!dryRun) {
    ctx.textBaseline = 'top';
  }

  // -------------------------------------------------------------------------
  // 1. Header Banner
  // -------------------------------------------------------------------------
  const bannerH = 96;
  if (!dryRun) {
    drawRoundedRect(ctx, PADDING_X, y, CONTENT_WIDTH, bannerH, 16, PALETTE.surface, PALETTE.goldBorder, 1.5);

    ctx.font = '700 26px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = PALETTE.goldBright;
    ctx.fillText('LEADERS XAUUSD', PADDING_X + 24, y + 18);

    ctx.font = '500 14px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = PALETTE.textSecondary;
    ctx.fillText('Multi-Timeframe Technical Analysis Snapshot', PADDING_X + 24, y + 50);

    ctx.font = '400 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(
      `Report ID: ${report.id}  ·  Saved: ${formatDateTime(report.createdAt)}`,
      PADDING_X + 24,
      y + 71
    );

    ctx.textAlign = 'right';
    ctx.font = '700 14px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = report.freshness === 'LIVE' ? PALETTE.buy : PALETTE.goldBright;
    ctx.fillText(`DATA: ${report.freshness}`, PADDING_X + CONTENT_WIDTH - 24, y + 22);

    ctx.font = '400 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(
      `${report.selectedTimeframes.length} TF × ${report.selectedIndicators.length} Indicators`,
      PADDING_X + CONTENT_WIDTH - 24,
      y + 46
    );
    ctx.fillText(
      `Market TS: ${formatDateTime(report.marketDataTimestamp)}`,
      PADDING_X + CONTENT_WIDTH - 24,
      y + 68
    );
    ctx.textAlign = 'left';
  }
  y += bannerH + 18;

  // -------------------------------------------------------------------------
  // 2. Primary Classification Card
  // -------------------------------------------------------------------------
  const biasColors = getBiasColors(report.classification);
  const confidence = getReportSignalConfidence(report);
  const classCardH = 128;
  if (!dryRun) {
    drawRoundedRect(ctx, PADDING_X, y, CONTENT_WIDTH, classCardH, 16, biasColors.bg, biasColors.border, 1.5);

    ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(`XAU/USD MARKET CLASSIFICATION · ${report.freshness} DATA`, PADDING_X + 24, y + 18);

    ctx.font = '800 42px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = biasColors.text;
    ctx.fillText(report.classification, PADDING_X + 24, y + 40);

    ctx.font = '500 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textSecondary;
    ctx.fillText(
      `Confidence: ${confidence.scorePct}% (${confidence.tier})  ·  Score: ${safeNumber(report.combinedScore) >= 0 ? '+' : ''}${safeFixed(report.combinedScore, 3, '0.000')}  ·  TF: ${(report.selectedTimeframes ?? []).join(', ')}`,
      PADDING_X + 24,
      y + 96
    );

    ctx.textAlign = 'right';
    ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText('SPOT REFERENCE', PADDING_X + CONTENT_WIDTH - 24, y + 18);

    ctx.font = '700 32px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textPrimary;
    ctx.fillText(`$${safeFixed(report.spotPrice)}`, PADDING_X + CONTENT_WIDTH - 24, y + 42);

    ctx.font = '400 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textSecondary;
    ctx.fillText(
      `Bid $${safeFixed(report.spotBid)}  ·  Ask $${safeFixed(report.spotAsk)}`,
      PADDING_X + CONTENT_WIDTH - 24,
      y + 84
    );
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(`${report.spotSource ?? ''}`, PADDING_X + CONTENT_WIDTH - 24, y + 102);
    ctx.textAlign = 'left';
  }
  y += classCardH + 18;

  // -------------------------------------------------------------------------
  // 3. SL & TP Reference Levels
  // -------------------------------------------------------------------------
  if (report.tradeLevels) {
    const lv = report.tradeLevels;
    const methFont = '400 13px system-ui, -apple-system, Segoe UI, sans-serif';
    const methLines = wrapText(ctx, lv.methodology, CONTENT_WIDTH - 48, methFont);
    const levelsCardH = 160 + methLines.length * 19;

    if (!dryRun) {
      drawRoundedRect(ctx, PADDING_X, y, CONTENT_WIDTH, levelsCardH, 16, PALETTE.surface, PALETTE.goldBorder, 1.2);

      ctx.font = '700 16px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = PALETTE.goldBright;
      ctx.fillText(`Calculated SL & TP Reference Levels (${report.classification})`, PADDING_X + 24, y + 18);

      ctx.textAlign = 'right';
      ctx.font = '500 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = PALETTE.textMuted;
      ctx.fillText(
        `${lv.referenceTimeframe} ATR(14): $${safeFixed(lv.atrValue)} · Risk: $${safeFixed(lv.riskPoints)}`,
        PADDING_X + CONTENT_WIDTH - 24,
        y + 20
      );
      ctx.textAlign = 'left';

      const gap = 14;
      const boxW = (CONTENT_WIDTH - 48 - gap * 2) / 3;
      const boxY = y + 50;
      const boxH = 82;
      const items = [
        {
          label: 'Entry Spot',
          val: `$${safeFixed(lv.referencePrice)}`,
          sub: 'Spot at analysis',
          color: PALETTE.textPrimary,
          border: PALETTE.border,
        },
        {
          label: 'Stop Loss (SL)',
          val: `$${safeFixed(lv.stopLoss)}`,
          sub: `-$${safeFixed(lv.riskPoints)} risk`,
          color: PALETTE.sell,
          border: PALETTE.sellBorder,
        },
        {
          label: 'Take Profit (TP)',
          val: `$${safeFixed(lv.takeProfit1)}`,
          sub: `R:R ${lv.rewardRiskRatio1}`,
          color: PALETTE.buy,
          border: PALETTE.buyBorder,
        },
      ];

      items.forEach((item, idx) => {
        const bx = PADDING_X + 24 + idx * (boxW + gap);
        drawRoundedRect(ctx, bx, boxY, boxW, boxH, 12, PALETTE.surfaceInner, item.border, 1);

        ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = idx === 0 ? PALETTE.textMuted : item.color;
        ctx.fillText(item.label, bx + 14, boxY + 12);

        ctx.font = '700 20px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = item.color;
        ctx.fillText(item.val, bx + 14, boxY + 33);

        ctx.font = '400 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = PALETTE.textDim;
        ctx.fillText(item.sub, bx + 14, boxY + 60);
      });

      ctx.font = methFont;
      ctx.fillStyle = PALETTE.textMuted;
      let ty = boxY + boxH + 16;
      for (const line of methLines) {
        ctx.fillText(line, PADDING_X + 24, ty);
        ty += 19;
      }
    }

    y += levelsCardH + 18;
  } else {
    const holdCardH = 82;
    if (!dryRun) {
      drawRoundedRect(ctx, PADDING_X, y, CONTENT_WIDTH, holdCardH, 16, PALETTE.surface, PALETTE.border, 1);
      ctx.font = '700 15px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = PALETTE.goldBright;
      ctx.fillText('SL & TP Reference Levels Withheld (HOLD)', PADDING_X + 24, y + 18);

      ctx.font = '400 13px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = PALETTE.textMuted;
      ctx.fillText(
        'Directional Stop Loss and Take Profit targets are computed only when multi-timeframe consensus reaches BUY or SELL.',
        PADDING_X + 24,
        y + 46
      );
    }
    y += holdCardH + 18;
  }

  // -------------------------------------------------------------------------
  // 4. Signal Conviction & Anti-Fake-Signal Gates
  // -------------------------------------------------------------------------
  if (report.signalQualityChecks && report.signalQualityChecks.length > 0) {
    const checks = report.signalQualityChecks;
    const passed = checks.filter((c) => c.passed).length;
    const gateGap = 12;
    const gateW = (CONTENT_WIDTH - 48 - gateGap) / 2;
    const gateFont = '400 12px system-ui, -apple-system, Segoe UI, sans-serif';

    const gateLayouts = checks.map((gate) => {
      const detailLines = wrapText(ctx, gate.detail, gateW - 28, gateFont);
      return {
        gate,
        detailLines,
        height: 36 + detailLines.length * 17 + 12,
      };
    });

    const rowHeights: number[] = [];
    for (let i = 0; i < gateLayouts.length; i += 2) {
      const h1 = gateLayouts[i].height;
      const h2 = gateLayouts[i + 1]?.height ?? 0;
      rowHeights.push(Math.max(h1, h2));
    }

    const totalRowsH = rowHeights.reduce((a, b) => a + b, 0) + Math.max(0, rowHeights.length - 1) * gateGap;
    const gatesCardH = 56 + totalRowsH + 20;

    if (!dryRun) {
      drawRoundedRect(ctx, PADDING_X, y, CONTENT_WIDTH, gatesCardH, 16, PALETTE.surface, PALETTE.border, 1);

      ctx.font = '700 16px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = PALETTE.goldBright;
      ctx.fillText('Signal Conviction & Anti-Fake-Signal Gates', PADDING_X + 24, y + 18);

      ctx.textAlign = 'right';
      ctx.font = '500 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = PALETTE.textMuted;
      ctx.fillText(`${passed} / ${checks.length} gates passed`, PADDING_X + CONTENT_WIDTH - 24, y + 20);
      ctx.textAlign = 'left';

      let gy = y + 52;
      for (let r = 0; r < rowHeights.length; r++) {
        const rh = rowHeights[r];
        for (let c = 0; c < 2; c++) {
          const item = gateLayouts[r * 2 + c];
          if (!item) continue;
          const gx = PADDING_X + 24 + c * (gateW + gateGap);
          const gColor = item.gate.passed ? PALETTE.buy : PALETTE.hold;
          const gBg = item.gate.passed ? PALETTE.buyBg : PALETTE.holdBg;
          const gBorder = item.gate.passed ? PALETTE.buyBorder : PALETTE.holdBorder;

          drawRoundedRect(ctx, gx, gy, gateW, rh, 12, gBg, gBorder, 1);

          ctx.font = '700 13px system-ui, -apple-system, Segoe UI, sans-serif';
          ctx.fillStyle = PALETTE.textPrimary;
          const labelText = `${item.gate.label}`;
          ctx.fillText(labelText, gx + 14, gy + 12);

          const labelW = ctx.measureText(labelText).width;
          ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.fillStyle = gColor;
          ctx.fillText(` · ${item.gate.passed ? 'PASS' : 'BLOCKED'}`, gx + 14 + labelW + 2, gy + 14);

          ctx.font = gateFont;
          ctx.fillStyle = PALETTE.textMuted;
          let ly = gy + 34;
          for (const line of item.detailLines) {
            ctx.fillText(line, gx + 14, ly);
            ly += 17;
          }
        }
        gy += rh + gateGap;
      }
    }

    y += gatesCardH + 18;
  }

  // -------------------------------------------------------------------------
  // 5. Synthesis, S/R Levels & Risk Context
  // -------------------------------------------------------------------------
  const bodyFont = '400 13px system-ui, -apple-system, Segoe UI, sans-serif';
  const synthLines = wrapText(ctx, report.combinedMethodology, CONTENT_WIDTH - 48, bodyFont);
  const compLines = wrapText(ctx, `Short vs Long Horizon: ${report.shortVsLongComparison}`, CONTENT_WIDTH - 48, bodyFont);
  const uncLines = wrapText(ctx, `Uncertainty & Risk Context: ${report.uncertaintyExplanation}`, CONTENT_WIDTH - 48, bodyFont);

  const supText =
    report.supportLevels && report.supportLevels.length > 0
      ? report.supportLevels.map((v) => `$${safeFixed(v)}`).join('  ·  ')
      : 'None detected in lookback';
  const resText =
    report.resistanceLevels && report.resistanceLevels.length > 0
      ? report.resistanceLevels.map((v) => `$${safeFixed(v)}`).join('  ·  ')
      : 'None detected in lookback';

  const synthCardH =
    56 +
    synthLines.length * 19 +
    10 +
    compLines.length * 19 +
    16 +
    68 +
    16 +
    uncLines.length * 19 +
    32;

  if (!dryRun) {
    drawRoundedRect(ctx, PADDING_X, y, CONTENT_WIDTH, synthCardH, 16, PALETTE.surface, PALETTE.border, 1);

    ctx.font = '700 16px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = PALETTE.goldBright;
    ctx.fillText('Combined Synthesis, Support & Resistance', PADDING_X + 24, y + 18);

    let sy = y + 50;
    ctx.font = bodyFont;
    ctx.fillStyle = PALETTE.textSecondary;
    for (const line of synthLines) {
      ctx.fillText(line, PADDING_X + 24, sy);
      sy += 19;
    }

    sy += 10;
    for (const line of compLines) {
      ctx.fillText(line, PADDING_X + 24, sy);
      sy += 19;
    }

    sy += 14;
    const srGap = 14;
    const srW = (CONTENT_WIDTH - 48 - srGap) / 2;
    drawRoundedRect(ctx, PADDING_X + 24, sy, srW, 64, 12, PALETTE.surfaceInner, PALETTE.border, 1);
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.buy;
    ctx.fillText('CALCULATED SUPPORT', PADDING_X + 38, sy + 12);
    ctx.font = '700 15px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textPrimary;
    ctx.fillText(supText, PADDING_X + 38, sy + 34);

    drawRoundedRect(ctx, PADDING_X + 24 + srW + srGap, sy, srW, 64, 12, PALETTE.surfaceInner, PALETTE.border, 1);
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.sell;
    ctx.fillText('CALCULATED RESISTANCE', PADDING_X + 38 + srW + srGap, sy + 12);
    ctx.font = '700 15px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textPrimary;
    ctx.fillText(resText, PADDING_X + 38 + srW + srGap, sy + 34);

    sy += 80;
    ctx.font = bodyFont;
    ctx.fillStyle = PALETTE.textMuted;
    for (const line of uncLines) {
      ctx.fillText(line, PADDING_X + 24, sy);
      sy += 19;
    }

    ctx.font = '400 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textDim;
    ctx.fillText(`Spot Source: ${report.spotSource}  ·  Candles: ${report.candleSource}`, PADDING_X + 24, sy + 6);
  }
  y += synthCardH + 18;

  // -------------------------------------------------------------------------
  // Footer
  // -------------------------------------------------------------------------
  if (!dryRun) {
    ctx.font = '400 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textDim;
    ctx.fillText(
      'LEADERS XAUUSD · Educational Market Analysis Derived From Historical Price & Indicator Math (Not Financial Advice)',
      PADDING_X,
      y + 6
    );
  }
  y += 28 + BOTTOM_PADDING;

  return y;
}

export interface RenderedJpgReport {
  filename: string;
  dataUrl: string;
  blob: Blob;
  blobUrl: string;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: 'image/jpeg' });
}

export function triggerJpgDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function renderAnalysisReportJpg(report: AnalysisReport): RenderedJpgReport {
  if (typeof document === 'undefined') {
    throw new Error('Image export is only supported in the browser');
  }

  // Pass 1: Measure full content height accurately
  const measureCanvas = document.createElement('canvas');
  measureCanvas.width = LOGICAL_WIDTH;
  measureCanvas.height = 100;
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx) {
    throw new Error('Unable to initialize canvas rendering context');
  }

  const totalLogicalHeight = renderReportToCanvas(measureCtx, report, true);

  // Use up to 2x HiDPI scale while staying safely under browser canvas limits
  const scale = Math.min(2, Math.max(1, MAX_CANVAS_PX / totalLogicalHeight));

  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = Math.round(LOGICAL_WIDTH * scale);
  outputCanvas.height = Math.round(totalLogicalHeight * scale);
  const ctx = outputCanvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to allocate output canvas');
  }

  // Fill solid dark background before scaling (JPEG has no alpha channel)
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, outputCanvas.width, outputCanvas.height);

  ctx.save();
  ctx.scale(scale, scale);
  renderReportToCanvas(ctx, report, false);
  ctx.restore();

  const filename = buildFilename(report);
  const dataUrl = outputCanvas.toDataURL('image/jpeg', 0.94);
  const blob = dataUrlToBlob(dataUrl);
  const blobUrl = URL.createObjectURL(blob);

  return { filename, dataUrl, blob, blobUrl };
}

export async function uploadJpgForAttachmentUrl(
  filename: string,
  dataUrl: string
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      '/api/export/jpg',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, dataUrl }),
      },
      15_000
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => ({}));
    return typeof json.downloadUrl === 'string' ? json.downloadUrl : null;
  } catch {
    return null;
  }
}

function buildSureFilename(signal: SureSignalEntry): string {
  const dt = new Date(signal.createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = Number.isNaN(dt.getTime())
    ? 'signal'
    : `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}-${pad(dt.getHours())}${pad(dt.getMinutes())}`;
  const shortId = signal.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'sure';
  return `LEADERS-XAUUSD-SURE-${signal.direction}-${stamp}-${shortId}.jpg`;
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

function getSureStatusStyle(status: SureSignalEntry['status']) {
  if (status === 'TP_HIT') {
    return { label: 'TP HIT', color: PALETTE.buy, bg: PALETTE.buyBg, border: PALETTE.buyBorder };
  }
  if (status === 'SL_HIT') {
    return { label: 'SL HIT', color: PALETTE.sell, bg: PALETTE.sellBg, border: PALETTE.sellBorder };
  }
  if (status === 'AMBIGUOUS') {
    return { label: 'AMBIGUOUS', color: PALETTE.hold, bg: PALETTE.holdBg, border: PALETTE.holdBorder };
  }
  return { label: 'ACTIVE TRADE', color: PALETTE.goldBright, bg: PALETTE.holdBg, border: PALETTE.goldBorder };
}

function renderSureSignalToCanvas(
  ctx: CanvasRenderingContext2D,
  signal: SureSignalEntry,
  dryRun: boolean
): number {
  let y = TOP_PADDING;

  if (!dryRun) {
    ctx.textBaseline = 'top';
  }

  const statusStyle = getSureStatusStyle(signal.status);
  const biasColors = getBiasColors(signal.direction);

  // 1. Header Banner
  const bannerH = 96;
  if (!dryRun) {
    drawRoundedRect(ctx, PADDING_X, y, CONTENT_WIDTH, bannerH, 16, PALETTE.surface, PALETTE.goldBorder, 1.5);

    ctx.font = '700 26px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = PALETTE.goldBright;
    ctx.fillText('LEADERS XAUUSD · SURE SIGNAL', PADDING_X + 24, y + 18);

    ctx.font = '500 14px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = PALETTE.textSecondary;
    ctx.fillText('Strict Multi-Timeframe Auto-Scanner Verified Setup', PADDING_X + 24, y + 50);

    ctx.font = '400 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(
      `Signal ID: ${signal.id.slice(0, 12)}  ·  Created: ${formatDateTime(signal.createdAt)}`,
      PADDING_X + 24,
      y + 71
    );

    ctx.textAlign = 'right';
    ctx.font = '700 14px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = statusStyle.color;
    ctx.fillText(`STATUS: ${statusStyle.label}`, PADDING_X + CONTENT_WIDTH - 24, y + 22);

    ctx.font = '400 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(`${signal.timeframes.join(' · ')}`, PADDING_X + CONTENT_WIDTH - 24, y + 46);
    if (signal.closedAt) {
      ctx.fillText(`Closed: ${formatDateTime(signal.closedAt)}`, PADDING_X + CONTENT_WIDTH - 24, y + 68);
    } else {
      ctx.fillText(`Score Category: ${signal.scoreCategory}`, PADDING_X + CONTENT_WIDTH - 24, y + 68);
    }
    ctx.textAlign = 'left';
  }
  y += bannerH + 18;

  // 2. Primary SURE Signal Card
  const classCardH = signal.status !== 'ACTIVE' && signal.closePrice != null ? 148 : 128;
  if (!dryRun) {
    drawRoundedRect(ctx, PADDING_X, y, CONTENT_WIDTH, classCardH, 16, biasColors.bg, biasColors.border, 1.5);

    ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(`XAU/USD SURE AUTO-SCANNER · ${statusStyle.label}`, PADDING_X + 24, y + 18);

    ctx.font = '800 42px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = biasColors.text;
    ctx.fillText(`SURE ${signal.direction}`, PADDING_X + 24, y + 40);

    ctx.font = '500 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textSecondary;
    ctx.fillText(
      `Setup Score: ${signal.setupScore}/100 (${signal.scoreCategory})  ·  ADX: ${safeFixed(signal.adxValue, 1)}  ·  R:R: ${signal.riskRewardRatio}`,
      PADDING_X + 24,
      y + 96
    );

    if (signal.status !== 'ACTIVE' && signal.closePrice != null) {
      const pnl = safeNumber(signal.pnlPoints);
      ctx.font = '700 13px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = statusStyle.color;
      ctx.fillText(
        `Exit: $${safeFixed(signal.closePrice)} (${pnl >= 0 ? '+' : ''}${safeFixed(pnl, 2, '0.00')} pts)  ·  Duration: ${formatDurationMs(signal.durationMs)}`,
        PADDING_X + 24,
        y + 118
      );
    }

    ctx.textAlign = 'right';
    ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText('ENTRY SPOT PRICE', PADDING_X + CONTENT_WIDTH - 24, y + 18);

    ctx.font = '700 32px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textPrimary;
    ctx.fillText(`$${safeFixed(signal.tradeLevels?.referencePrice ?? signal.spotPrice)}`, PADDING_X + CONTENT_WIDTH - 24, y + 42);

    ctx.font = '400 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textSecondary;
    ctx.fillText(
      `${signal.tradeLevels?.referenceTimeframe ?? '15m'} ATR(14): $${safeFixed(signal.tradeLevels?.atrValue)}`,
      PADDING_X + CONTENT_WIDTH - 24,
      y + 84
    );
    ctx.textAlign = 'left';
  }
  y += classCardH + 18;

  // 3. Trade Levels (Entry, SL, TP + Summary)
  const lv = signal.tradeLevels;
  const bodyFont = '400 13px system-ui, -apple-system, Segoe UI, sans-serif';
  const summaryLines = wrapText(ctx, signal.summary, CONTENT_WIDTH - 48, bodyFont);
  const methLines = wrapText(ctx, lv?.methodology ?? '', CONTENT_WIDTH - 48, bodyFont);
  const levelsCardH = 166 + (summaryLines.length + methLines.length) * 19 + 12;

  if (!dryRun) {
    drawRoundedRect(ctx, PADDING_X, y, CONTENT_WIDTH, levelsCardH, 16, PALETTE.surface, PALETTE.goldBorder, 1.2);

    ctx.font = '700 16px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = PALETTE.goldBright;
    ctx.fillText(`SURE Trade Levels (SURE ${signal.direction})`, PADDING_X + 24, y + 18);

    const gap = 14;
    const boxW = (CONTENT_WIDTH - 48 - gap * 2) / 3;
    const boxY = y + 50;
    const boxH = 82;
    const items = [
      {
        label: 'Entry Price',
        val: `$${safeFixed(lv?.referencePrice ?? signal.spotPrice)}`,
        sub: `Spot at trigger`,
        color: PALETTE.textPrimary,
        border: PALETTE.border,
      },
      {
        label: 'Stop Loss (SL)',
        val: `$${safeFixed(lv?.stopLoss)}`,
        sub: `-$${safeFixed(lv?.riskPoints)} risk`,
        color: PALETTE.sell,
        border: PALETTE.sellBorder,
      },
      {
        label: 'Take Profit (TP)',
        val: `$${safeFixed(lv?.takeProfit1)}`,
        sub: `R:R ${lv?.rewardRiskRatio1 ?? signal.riskRewardRatio}`,
        color: PALETTE.buy,
        border: PALETTE.buyBorder,
      },
    ];

    items.forEach((item, idx) => {
      const bx = PADDING_X + 24 + idx * (boxW + gap);
      drawRoundedRect(ctx, bx, boxY, boxW, boxH, 12, PALETTE.surfaceInner, item.border, 1);

      ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = idx === 0 ? PALETTE.textMuted : item.color;
      ctx.fillText(item.label, bx + 14, boxY + 12);

      ctx.font = '700 20px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = item.color;
      ctx.fillText(item.val, bx + 14, boxY + 33);

      ctx.font = '400 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = PALETTE.textDim;
      ctx.fillText(item.sub, bx + 14, boxY + 60);
    });

    let ty = boxY + boxH + 16;
    ctx.font = bodyFont;
    ctx.fillStyle = PALETTE.textSecondary;
    for (const line of summaryLines) {
      ctx.fillText(line, PADDING_X + 24, ty);
      ty += 19;
    }
    ty += 8;
    ctx.fillStyle = PALETTE.textMuted;
    for (const line of methLines) {
      ctx.fillText(line, PADDING_X + 24, ty);
      ty += 19;
    }
  }
  y += levelsCardH + 18;

  // 4. Mandatory SURE Filter Gates
  if (signal.checks && signal.checks.length > 0) {
    const checks = signal.checks;
    const passed = checks.filter((c) => c.passed).length;
    const gateGap = 12;
    const gateW = (CONTENT_WIDTH - 48 - gateGap) / 2;
    const gateFont = '400 12px system-ui, -apple-system, Segoe UI, sans-serif';

    const gateLayouts = checks.map((gate) => {
      const detailLines = wrapText(ctx, gate.detail, gateW - 28, gateFont);
      return {
        gate,
        detailLines,
        height: 36 + detailLines.length * 17 + 12,
      };
    });

    const rowHeights: number[] = [];
    for (let i = 0; i < gateLayouts.length; i += 2) {
      rowHeights.push(Math.max(gateLayouts[i].height, gateLayouts[i + 1]?.height ?? 0));
    }
    const totalRowsH = rowHeights.reduce((a, b) => a + b, 0) + Math.max(0, rowHeights.length - 1) * gateGap;
    const gatesCardH = 56 + totalRowsH + 20;

    if (!dryRun) {
      drawRoundedRect(ctx, PADDING_X, y, CONTENT_WIDTH, gatesCardH, 16, PALETTE.surface, PALETTE.border, 1);

      ctx.font = '700 16px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = PALETTE.goldBright;
      ctx.fillText('Mandatory SURE Filter Gates', PADDING_X + 24, y + 18);

      ctx.textAlign = 'right';
      ctx.font = '500 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = PALETTE.textMuted;
      ctx.fillText(`${passed} / ${checks.length} gates passed`, PADDING_X + CONTENT_WIDTH - 24, y + 20);
      ctx.textAlign = 'left';

      let gy = y + 52;
      for (let r = 0; r < rowHeights.length; r++) {
        const rh = rowHeights[r];
        for (let c = 0; c < 2; c++) {
          const item = gateLayouts[r * 2 + c];
          if (!item) continue;
          const gx = PADDING_X + 24 + c * (gateW + gateGap);
          const gColor = item.gate.passed ? PALETTE.buy : PALETTE.hold;
          const gBg = item.gate.passed ? PALETTE.buyBg : PALETTE.holdBg;
          const gBorder = item.gate.passed ? PALETTE.buyBorder : PALETTE.holdBorder;

          drawRoundedRect(ctx, gx, gy, gateW, rh, 12, gBg, gBorder, 1);

          ctx.font = '700 13px system-ui, -apple-system, Segoe UI, sans-serif';
          ctx.fillStyle = PALETTE.textPrimary;
          ctx.fillText(item.gate.label, gx + 14, gy + 12);

          const labelW = ctx.measureText(item.gate.label).width;
          ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.fillStyle = gColor;
          ctx.fillText(` · ${item.gate.passed ? 'PASS' : 'WAIT'}`, gx + 14 + labelW + 2, gy + 14);

          ctx.font = gateFont;
          ctx.fillStyle = PALETTE.textMuted;
          let ly = gy + 34;
          for (const line of item.detailLines) {
            ctx.fillText(line, gx + 14, ly);
            ly += 17;
          }
        }
        gy += rh + gateGap;
      }
    }
    y += gatesCardH + 18;
  }

  // 5. Footer
  if (!dryRun) {
    ctx.font = '400 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = PALETTE.textDim;
    ctx.fillText(
      'LEADERS XAUUSD · SURE Auto-Scanner Snapshot (Educational Technical Signal — Not Financial Advice)',
      PADDING_X,
      y + 6
    );
  }
  y += 28 + BOTTOM_PADDING;

  return y;
}

export function renderSureSignalJpg(signal: SureSignalEntry): RenderedJpgReport {
  if (typeof document === 'undefined') {
    throw new Error('Image export is only supported in the browser');
  }

  const measureCanvas = document.createElement('canvas');
  measureCanvas.width = LOGICAL_WIDTH;
  measureCanvas.height = 100;
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx) {
    throw new Error('Unable to initialize canvas rendering context');
  }

  const totalLogicalHeight = renderSureSignalToCanvas(measureCtx, signal, true);
  const scale = Math.min(2, Math.max(1, MAX_CANVAS_PX / totalLogicalHeight));

  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = Math.round(LOGICAL_WIDTH * scale);
  outputCanvas.height = Math.round(totalLogicalHeight * scale);
  const ctx = outputCanvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to allocate output canvas');
  }

  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, outputCanvas.width, outputCanvas.height);

  ctx.save();
  ctx.scale(scale, scale);
  renderSureSignalToCanvas(ctx, signal, false);
  ctx.restore();

  const filename = buildSureFilename(signal);
  const dataUrl = outputCanvas.toDataURL('image/jpeg', 0.94);
  const blob = dataUrlToBlob(dataUrl);
  const blobUrl = URL.createObjectURL(blob);

  return { filename, dataUrl, blob, blobUrl };
}


