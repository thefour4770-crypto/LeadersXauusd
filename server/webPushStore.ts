import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as WebPushLib from 'web-push';
import type { SureSignalEntry } from '../src/types/market.ts';

const require = createRequire(import.meta.url);
const webpush = require('web-push') as typeof WebPushLib;

const DATA_DIR = path.resolve(process.cwd(), 'data');
const VAPID_FILE = path.join(DATA_DIR, 'vapid-keys.json');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
const MAX_SUBSCRIPTIONS = 500;
const IS_TEST_ENV = Boolean(
  process.env.NODE_TEST_CONTEXT || process.argv.some((a) => a.includes('--test'))
);

export interface StoredPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
  updatedAt: string;
}

export interface WebPushNotificationPayload {
  title: string;
  body: string;
  tag: string;
  url?: string;
  icon?: string;
  badge?: string;
  vibrate?: number[];
  requireInteraction?: boolean;
  renotify?: boolean;
  kind?: 'NEW' | 'TP_HIT' | 'SL_HIT' | 'AMBIGUOUS' | 'TEST';
  signalId?: string;
}

interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

let cachedVapid: VapidKeyPair | null = null;
let vapidInitPromise: Promise<VapidKeyPair> | null = null;
let subscriptionsLoaded = false;
const subscriptionsMap = new Map<string, StoredPushSubscription>();
let saveQueue: Promise<void> = Promise.resolve();

function getVapidSubject(): string {
  const raw = process.env.VAPID_SUBJECT?.trim();
  if (raw && (raw.startsWith('mailto:') || raw.startsWith('https://'))) {
    return raw;
  }
  const appUrl = process.env.APP_URL?.trim();
  if (appUrl && appUrl.startsWith('https://')) {
    return appUrl;
  }
  return 'mailto:alerts@leadersxauusd.app';
}

async function ensureVapidConfigured(): Promise<VapidKeyPair> {
  if (cachedVapid) return cachedVapid;
  if (vapidInitPromise) return vapidInitPromise;

  vapidInitPromise = (async () => {
    const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
    const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
    if (envPub && envPriv) {
      cachedVapid = { publicKey: envPub, privateKey: envPriv };
      webpush.setVapidDetails(getVapidSubject(), cachedVapid.publicKey, cachedVapid.privateKey);
      return cachedVapid;
    }

    try {
      const raw = await fs.readFile(VAPID_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<VapidKeyPair>;
      if (
        typeof parsed.publicKey === 'string' &&
        parsed.publicKey.length > 20 &&
        typeof parsed.privateKey === 'string' &&
        parsed.privateKey.length > 20
      ) {
        cachedVapid = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        webpush.setVapidDetails(getVapidSubject(), cachedVapid.publicKey, cachedVapid.privateKey);
        return cachedVapid;
      }
    } catch {
      // File not yet created; generate fresh persistent keys below
    }

    const generated = webpush.generateVAPIDKeys();
    cachedVapid = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    webpush.setVapidDetails(getVapidSubject(), cachedVapid.publicKey, cachedVapid.privateKey);

    if (!IS_TEST_ENV) {
      const tmp = `${VAPID_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
      try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(cachedVapid, null, 2), 'utf8');
        await fs.rename(tmp, VAPID_FILE);
      } catch {
        await fs.unlink(tmp).catch(() => {});
      }
    }

    return cachedVapid;
  })();

  try {
    return await vapidInitPromise;
  } finally {
    vapidInitPromise = null;
  }
}

async function ensureSubscriptionsLoaded(): Promise<void> {
  if (subscriptionsLoaded) return;
  subscriptionsLoaded = true;
  if (IS_TEST_ENV) return;

  try {
    const raw = await fs.readFile(SUBSCRIPTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (isValidPushSubscription(item)) {
        subscriptionsMap.set(item.endpoint, item);
      }
    }
  } catch {
    // No saved subscriptions yet
  }
}

function persistSubscriptions(): Promise<void> {
  if (IS_TEST_ENV) return Promise.resolve();
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(async () => {
      const tmp = `${SUBSCRIPTIONS_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
      try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        const items = Array.from(subscriptionsMap.values()).slice(-MAX_SUBSCRIPTIONS);
        await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf8');
        await fs.rename(tmp, SUBSCRIPTIONS_FILE);
      } catch {
        await fs.unlink(tmp).catch(() => {});
      }
    });
  return saveQueue;
}

export function isValidPushSubscription(raw: unknown): raw is StoredPushSubscription {
  if (!raw || typeof raw !== 'object') return false;
  const sub = raw as Record<string, unknown>;
  if (typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || sub.endpoint.length > 2048) {
    return false;
  }
  const keys = sub.keys as Record<string, unknown> | undefined;
  if (
    !keys ||
    typeof keys !== 'object' ||
    typeof keys.p256dh !== 'string' ||
    keys.p256dh.length < 10 ||
    typeof keys.auth !== 'string' ||
    keys.auth.length < 6
  ) {
    return false;
  }
  return true;
}

export async function getVapidPublicKey(): Promise<string> {
  const keys = await ensureVapidConfigured();
  return keys.publicKey;
}

export async function upsertPushSubscription(
  rawSub: unknown,
  userAgent?: string
): Promise<{ saved: boolean; count: number }> {
  await ensureVapidConfigured();
  await ensureSubscriptionsLoaded();

  if (!isValidPushSubscription(rawSub)) {
    throw new Error('Invalid Web Push subscription payload');
  }

  const normalized: StoredPushSubscription = {
    endpoint: rawSub.endpoint,
    expirationTime: typeof rawSub.expirationTime === 'number' ? rawSub.expirationTime : null,
    keys: {
      p256dh: rawSub.keys.p256dh,
      auth: rawSub.keys.auth,
    },
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 180) : undefined,
    updatedAt: new Date().toISOString(),
  };

  subscriptionsMap.set(normalized.endpoint, normalized);
  if (subscriptionsMap.size > MAX_SUBSCRIPTIONS) {
    const oldest = subscriptionsMap.keys().next().value;
    if (oldest) subscriptionsMap.delete(oldest);
  }

  await persistSubscriptions();
  return { saved: true, count: subscriptionsMap.size };
}

export async function removePushSubscription(endpoint: string): Promise<boolean> {
  await ensureSubscriptionsLoaded();
  const existed = subscriptionsMap.delete(endpoint);
  if (existed) {
    await persistSubscriptions();
  }
  return existed;
}

export async function getPushSubscriptionCount(): Promise<number> {
  await ensureSubscriptionsLoaded();
  return subscriptionsMap.size;
}

async function dispatchPushToSubscription(
  sub: StoredPushSubscription,
  serializedPayload: string
): Promise<{ ok: boolean; expired: boolean }> {
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        expirationTime: sub.expirationTime ?? null,
        keys: sub.keys,
      },
      serializedPayload,
      {
        TTL: 300,
        urgency: 'high',
      }
    );
    return { ok: true, expired: false };
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const expired = statusCode === 404 || statusCode === 410;
    return { ok: false, expired };
  }
}

export async function sendPushNotificationToAll(
  payload: WebPushNotificationPayload
): Promise<{ attempted: number; delivered: number; removedExpired: number }> {
  if (IS_TEST_ENV) {
    return { attempted: 0, delivered: 0, removedExpired: 0 };
  }
  await ensureVapidConfigured();
  await ensureSubscriptionsLoaded();

  const targets = Array.from(subscriptionsMap.values());
  if (targets.length === 0) {
    return { attempted: 0, delivered: 0, removedExpired: 0 };
  }

  const serialized = JSON.stringify({
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    url: '/?tab=SURE',
    requireInteraction: true,
    renotify: true,
    ...payload,
  });

  const results = await Promise.all(
    targets.map(async (sub) => ({
      endpoint: sub.endpoint,
      ...(await dispatchPushToSubscription(sub, serialized)),
    }))
  );

  let delivered = 0;
  let removedExpired = 0;
  for (const res of results) {
    if (res.ok) {
      delivered += 1;
    } else if (res.expired) {
      if (subscriptionsMap.delete(res.endpoint)) {
        removedExpired += 1;
      }
    }
  }

  if (removedExpired > 0) {
    await persistSubscriptions();
  }

  return { attempted: targets.length, delivered, removedExpired };
}

export async function sendTestPushToSubscription(
  endpoint?: string
): Promise<{ delivered: boolean; attempted: number }> {
  await ensureVapidConfigured();
  await ensureSubscriptionsLoaded();

  const payload: WebPushNotificationPayload = {
    title: 'LEADERS XAUUSD · Background Push Active',
    body: 'Phone alerts ready! You will receive SURE BUY/SELL and TP/SL notifications even when the app is closed.',
    tag: 'leaders-sure-test',
    url: '/?tab=SURE',
    vibrate: [160, 80, 160],
    requireInteraction: false,
    renotify: true,
    kind: 'TEST',
  };

  if (endpoint) {
    const sub = subscriptionsMap.get(endpoint);
    if (!sub) {
      return { delivered: false, attempted: 0 };
    }
    const serialized = JSON.stringify({
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      ...payload,
    });
    const res = await dispatchPushToSubscription(sub, serialized);
    if (res.expired) {
      subscriptionsMap.delete(endpoint);
      await persistSubscriptions();
    }
    return { delivered: res.ok, attempted: 1 };
  }

  const summary = await sendPushNotificationToAll(payload);
  return { delivered: summary.delivered > 0, attempted: summary.attempted };
}

const fmtUsd = (val: number | undefined): string =>
  typeof val === 'number' && Number.isFinite(val) ? `$${val.toFixed(2)}` : '$—';

export async function sendSureSignalWebPush(entry: SureSignalEntry): Promise<void> {
  const arrow = entry.direction === 'BUY' ? '▲ SURE BUY' : '▼ SURE SELL';
  const title = `${arrow} · XAU/USD ${fmtUsd(entry.spotPrice)}`;
  const body = `Score ${entry.setupScore ?? entry.confidencePct ?? 0}/100 · Entry ${fmtUsd(
    entry.tradeLevels?.referencePrice
  )} · SL ${fmtUsd(entry.tradeLevels?.stopLoss)} · TP ${fmtUsd(entry.tradeLevels?.takeProfit1)}`;

  await sendPushNotificationToAll({
    title,
    body,
    tag: `leaders-sure-${entry.id}`,
    url: '/?tab=SURE',
    vibrate: [220, 100, 220],
    requireInteraction: true,
    renotify: true,
    kind: 'NEW',
    signalId: entry.id,
  });
}

export async function sendSureOutcomeWebPush(entry: SureSignalEntry): Promise<void> {
  if (entry.status !== 'TP_HIT' && entry.status !== 'SL_HIT' && entry.status !== 'AMBIGUOUS') {
    return;
  }

  const isTp = entry.status === 'TP_HIT';
  const isAmbiguous = entry.status === 'AMBIGUOUS';
  const title = isTp
    ? `TP HIT · SURE ${entry.direction} Closed`
    : isAmbiguous
    ? `AMBIGUOUS · SURE ${entry.direction} Closed`
    : `SL HIT · SURE ${entry.direction} Closed`;
  const pnl = typeof entry.pnlPoints === 'number' && Number.isFinite(entry.pnlPoints) ? entry.pnlPoints : 0;
  const pnlText = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} pts`;
  const closeStr = fmtUsd(entry.closePrice ?? entry.spotPrice);
  const body = `Entry ${fmtUsd(
    entry.tradeLevels?.referencePrice
  )} → Close ${closeStr} (${pnlText}). Auto-scanner resumed for next SURE signal.`;

  await sendPushNotificationToAll({
    title,
    body,
    tag: `leaders-sure-outcome-${entry.id}`,
    url: '/?tab=SURE',
    vibrate: isTp ? [180, 80, 260] : [260, 100, 260],
    requireInteraction: true,
    renotify: true,
    kind: entry.status,
    signalId: entry.id,
  });
}
