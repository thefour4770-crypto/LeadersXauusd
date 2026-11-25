import fs from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisReport } from '../src/types/market.ts';

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');
let activeReportsFile = path.join(DEFAULT_DATA_DIR, 'reports.json');
let storeMutex: Promise<void> = Promise.resolve();

export function setReportsStoreFile(customPath: string | null): void {
  activeReportsFile = customPath
    ? path.resolve(customPath)
    : path.join(DEFAULT_DATA_DIR, 'reports.json');
}

async function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = storeMutex;
  let release!: () => void;
  storeMutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function isValidReportRecord(item: unknown): item is AnalysisReport {
  if (!item || typeof item !== 'object') return false;
  const r = item as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.createdAt === 'string' &&
    typeof r.classification === 'string' &&
    Array.isArray(r.timeframeAnalyses) &&
    r.timeframeAnalyses.length > 0 &&
    typeof r.spotPrice === 'number' &&
    Number.isFinite(r.spotPrice)
  );
}

function safeTimeMs(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function ensureStoreFile(): Promise<void> {
  await fs.mkdir(path.dirname(activeReportsFile), { recursive: true });
  try {
    await fs.access(activeReportsFile);
  } catch {
    await fs.writeFile(activeReportsFile, '[]', 'utf8');
  }
}

async function readAllReportsUnlocked(): Promise<AnalysisReport[]> {
  await ensureStoreFile();
  try {
    const raw = await fs.readFile(activeReportsFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidReportRecord);
  } catch {
    return [];
  }
}

async function writeAllReportsUnlocked(reports: AnalysisReport[]): Promise<void> {
  await ensureStoreFile();
  const tmpFile = `${activeReportsFile}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  try {
    await fs.writeFile(tmpFile, JSON.stringify(reports, null, 2), 'utf8');
    await fs.rename(tmpFile, activeReportsFile);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }
}

export async function listReports(): Promise<AnalysisReport[]> {
  return withStoreLock(async () => {
    const reports = await readAllReportsUnlocked();
    return reports.sort((a, b) => safeTimeMs(b.createdAt) - safeTimeMs(a.createdAt));
  });
}

export async function getReportById(id: string): Promise<AnalysisReport | null> {
  return withStoreLock(async () => {
    const reports = await readAllReportsUnlocked();
    return reports.find((r) => r.id === id) ?? null;
  });
}

export async function saveReport(report: AnalysisReport): Promise<AnalysisReport> {
  if (!isValidReportRecord(report)) {
    throw new Error('Refusing to save incomplete analysis report');
  }

  return withStoreLock(async () => {
    const reports = await readAllReportsUnlocked();

    // Deduplication guard: prevent duplicate report with same timeframes, indicators & marketDataTimestamp within 4 seconds
    const nowMs = safeTimeMs(report.createdAt) || Date.now();
    const tfKey = Array.isArray(report.selectedTimeframes) ? report.selectedTimeframes.join(',') : '';
    const indKey = Array.isArray(report.selectedIndicators)
      ? report.selectedIndicators.map((i) => `${i.id}:${JSON.stringify(i.params ?? {})}`).join('|')
      : '';

    const duplicate = reports.find((existing) => {
      const diff = Math.abs(nowMs - safeTimeMs(existing.createdAt));
      const exTf = Array.isArray(existing.selectedTimeframes) ? existing.selectedTimeframes.join(',') : '';
      const exInd = Array.isArray(existing.selectedIndicators)
        ? existing.selectedIndicators.map((i) => `${i.id}:${JSON.stringify(i.params ?? {})}`).join('|')
        : '';
      return diff < 4000 && exTf === tfKey && exInd === indKey && existing.classification === report.classification;
    });

    if (duplicate) {
      return duplicate;
    }

    const updated = [report, ...reports].slice(0, 200);
    await writeAllReportsUnlocked(updated);
    return report;
  });
}

export async function deleteReportById(id: string): Promise<boolean> {
  return withStoreLock(async () => {
    const reports = await readAllReportsUnlocked();
    const filtered = reports.filter((r) => r.id !== id);
    if (filtered.length === reports.length) {
      return false;
    }
    await writeAllReportsUnlocked(filtered);
    return true;
  });
}
