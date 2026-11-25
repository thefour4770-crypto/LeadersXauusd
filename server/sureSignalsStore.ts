import fs from 'node:fs/promises';
import path from 'node:path';
import type { SureHistoryStats, SureSignalEntry } from '../src/types/market.ts';

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');
let activeStoreFile = path.join(DEFAULT_DATA_DIR, 'sure-signals.json');
let storeMutex: Promise<void> = Promise.resolve();

export function setSureSignalsStoreFile(customPath: string | null): void {
  activeStoreFile = customPath
    ? path.resolve(customPath)
    : path.join(DEFAULT_DATA_DIR, 'sure-signals.json');
}

export function getSureSignalsStoreFile(): string {
  return activeStoreFile;
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

async function ensureStoreFile(): Promise<void> {
  await fs.mkdir(path.dirname(activeStoreFile), { recursive: true });
  try {
    await fs.access(activeStoreFile);
  } catch {
    await fs.writeFile(activeStoreFile, '[]', 'utf8');
  }
}

function parseRiskRewardRatio(rr: string | undefined): number | null {
  if (!rr) return null;
  const parts = rr.split(':');
  const val = Number((parts[parts.length - 1] ?? '').trim());
  return Number.isFinite(val) && val > 0 ? val : null;
}

function normalizeEntry(raw: SureSignalEntry): SureSignalEntry {
  const createdMs = new Date(raw.createdAt).getTime();
  const closedMs = raw.closedAt ? new Date(raw.closedAt).getTime() : NaN;
  const computedDuration =
    typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) && raw.durationMs >= 0
      ? raw.durationMs
      : Number.isFinite(createdMs) && Number.isFinite(closedMs) && closedMs >= createdMs
      ? closedMs - createdMs
      : undefined;

  return {
    ...raw,
    status: raw.status ?? 'ACTIVE',
    setupScore: typeof raw.setupScore === 'number' ? raw.setupScore : Math.round(raw.confidencePct ?? 0),
    scoreCategory:
      raw.scoreCategory ??
      ((raw.setupScore ?? raw.confidencePct ?? 0) >= 85 ? 'STRONG SIGNAL' : 'VALID SIGNAL'),
    riskRewardRatio: raw.riskRewardRatio ?? raw.tradeLevels?.rewardRiskRatio1 ?? '1 : 1.50',
    durationMs: computedDuration,
  };
}

function isValidSureSignalRecord(raw: unknown): raw is SureSignalEntry {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  const tl = r.tradeLevels as Record<string, unknown> | undefined;
  return (
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.createdAt === 'string' &&
    (r.direction === 'BUY' || r.direction === 'SELL') &&
    typeof r.spotPrice === 'number' &&
    Number.isFinite(r.spotPrice) &&
    tl != null &&
    typeof tl === 'object' &&
    typeof tl.referencePrice === 'number' &&
    Number.isFinite(tl.referencePrice) &&
    typeof tl.stopLoss === 'number' &&
    Number.isFinite(tl.stopLoss) &&
    typeof tl.takeProfit1 === 'number' &&
    Number.isFinite(tl.takeProfit1)
  );
}

function safeTimestampMs(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function readAllUnlocked(): Promise<SureSignalEntry[]> {
  await ensureStoreFile();
  try {
    const raw = await fs.readFile(activeStoreFile, 'utf8');
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed)
      ? parsed.filter(isValidSureSignalRecord).map(normalizeEntry)
      : [];
    return items.sort(
      (a, b) => safeTimestampMs(b.createdAt) - safeTimestampMs(a.createdAt)
    );
  } catch {
    return [];
  }
}

async function writeAllUnlocked(entries: SureSignalEntry[]): Promise<void> {
  await ensureStoreFile();
  const tmpFile = `${activeStoreFile}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  try {
    await fs.writeFile(tmpFile, JSON.stringify(entries, null, 2), 'utf8');
    await fs.rename(tmpFile, activeStoreFile);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }
}

export async function listSureSignals(): Promise<SureSignalEntry[]> {
  return withStoreLock(() => readAllUnlocked());
}

/**
 * Saves a new SURE signal atomically while strictly preventing duplicate ACTIVE signals.
 * Returns `{ saved, entry }` — if an ACTIVE trade already exists on disk, refuses duplicate creation.
 */
export async function saveSureSignal(
  entry: SureSignalEntry
): Promise<{ saved: boolean; entry: SureSignalEntry }> {
  if (!isValidSureSignalRecord(entry)) {
    throw new Error('Refusing to save invalid SURE signal entry');
  }
  return withStoreLock(async () => {
    const existing = await readAllUnlocked();
    const normalized = normalizeEntry(entry);

    if (normalized.status === 'ACTIVE') {
      const currentActive = existing.find((e) => e.status === 'ACTIVE');
      if (currentActive) {
        return { saved: false, entry: currentActive };
      }
    }

    const updated = [normalized, ...existing.filter((e) => e.id !== normalized.id)].slice(0, 200);
    await writeAllUnlocked(updated);
    return { saved: true, entry: normalized };
  });
}

/**
 * Transitions an ACTIVE signal to its terminal state (TP_HIT, SL_HIT, or AMBIGUOUS).
 * Completed signals are immutable and will never be silently modified or overwritten.
 */
export async function updateSureSignal(
  id: string,
  patch: Partial<SureSignalEntry>
): Promise<SureSignalEntry | null> {
  return withStoreLock(async () => {
    const existing = await readAllUnlocked();
    const idx = existing.findIndex((e) => e.id === id);
    if (idx === -1) return null;

    // Never silently modify completed signals
    if (existing[idx].status !== 'ACTIVE') {
      return existing[idx];
    }

    const updatedEntry: SureSignalEntry = normalizeEntry({
      ...existing[idx],
      ...patch,
    });
    const nextList = existing.map((e, i) => (i === idx ? updatedEntry : e));
    await writeAllUnlocked(nextList);
    return updatedEntry;
  });
}

export async function deleteSureSignalById(id: string): Promise<boolean> {
  return withStoreLock(async () => {
    const existing = await readAllUnlocked();
    const filtered = existing.filter((e) => e.id !== id);
    if (filtered.length === existing.length) return false;
    await writeAllUnlocked(filtered);
    return true;
  });
}

/**
 * Computes real historical statistics strictly from completed signals.
 * Never counts ACTIVE or AMBIGUOUS outcomes as wins or losses.
 */
export function computeSureHistoryStats(history: SureSignalEntry[]): SureHistoryStats {
  const tpHits = history.filter((h) => h.status === 'TP_HIT').length;
  const slHits = history.filter((h) => h.status === 'SL_HIT').length;
  const ambiguousOutcomes = history.filter((h) => h.status === 'AMBIGUOUS').length;
  const activeSignals = history.filter((h) => h.status === 'ACTIVE').length;
  const completed = history.filter((h) => h.status !== 'ACTIVE');

  const resolvedWinsLosses = tpHits + slHits;
  const winRatePct =
    resolvedWinsLosses > 0 ? Number(((tpHits / resolvedWinsLosses) * 100).toFixed(1)) : null;

  const rrValues = completed
    .map((c) => parseRiskRewardRatio(c.riskRewardRatio ?? c.tradeLevels?.rewardRiskRatio1))
    .filter((v): v is number => v !== null);
  const avgRiskReward =
    rrValues.length > 0
      ? Number((rrValues.reduce((s, v) => s + v, 0) / rrValues.length).toFixed(2))
      : null;

  const durations = completed
    .map((c) => {
      if (typeof c.durationMs === 'number' && Number.isFinite(c.durationMs) && c.durationMs >= 0) {
        return c.durationMs;
      }
      if (c.closedAt) {
        const diff = new Date(c.closedAt).getTime() - new Date(c.createdAt).getTime();
        return Number.isFinite(diff) && diff >= 0 ? diff : null;
      }
      return null;
    })
    .filter((v): v is number => v !== null);

  const avgDurationMs =
    durations.length > 0
      ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length)
      : null;

  return {
    totalSignals: completed.length,
    tpHits,
    slHits,
    ambiguousOutcomes,
    activeSignals,
    winRatePct,
    avgRiskReward,
    avgDurationMs,
  };
}
