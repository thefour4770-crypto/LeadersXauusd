import type { SureSignalEntry, SureSignalScanStatus, SureSignalStatus } from '../types/market.ts';
import { fetchWithTimeout, safeFixed, safeNumber } from './format.ts';

const NOTIFIED_IDS_KEY = 'leaders_notified_sure_signal_ids_v1';
const BANNER_SEEN_IDS_KEY = 'leaders_banner_seen_sure_ids_v1';
const PHONE_ALERTS_ENABLED_KEY = 'leaders_phone_alerts_enabled_v1';

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export interface DetectedSureNotificationEvent {
  kind: 'NEW' | 'TP_HIT' | 'SL_HIT' | 'AMBIGUOUS';
  entry: SureSignalEntry;
}

export interface EnableAlertsResult {
  alertsEnabled: boolean;
  permissionState: NotificationPermissionState;
  inIframe: boolean;
  osNotificationDelivered: boolean;
  backgroundPushActive: boolean;
  soundPlayed: boolean;
  message: string;
}

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new AudioCtx();
  }
  return sharedAudioCtx;
}

export async function unlockAlertAudio(): Promise<boolean> {
  try {
    const ctx = getAudioContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    return ctx.state === 'running';
  } catch {
    return false;
  }
}

export function isRunningInIframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function getNotificationPermissionState(): NotificationPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  try {
    return Notification.permission;
  } catch {
    return 'unsupported';
  }
}

export function isPhoneAlertsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(PHONE_ALERTS_ENABLED_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return getNotificationPermissionState() === 'granted';
  } catch {
    return getNotificationPermissionState() === 'granted';
  }
}

const PHONE_ALERTS_CHANGED_EVENT = 'leaders-phone-alerts-changed';

export function setPhoneAlertsEnabledPref(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PHONE_ALERTS_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore storage quota errors
  }
  window.dispatchEvent(new CustomEvent(PHONE_ALERTS_CHANGED_EVENT, { detail: { enabled } }));
}

export function subscribePhoneAlertsPrefChange(listener: (enabled: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
    listener(typeof detail?.enabled === 'boolean' ? detail.enabled : isPhoneAlertsEnabled());
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key === PHONE_ALERTS_ENABLED_KEY) {
      listener(isPhoneAlertsEnabled());
    }
  };

  window.addEventListener(PHONE_ALERTS_CHANGED_EVENT, handleCustom);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(PHONE_ALERTS_CHANGED_EVENT, handleCustom);
    window.removeEventListener('storage', handleStorage);
  };
}

export function subscribeNotificationPermissionSync(
  listener: (perm: NotificationPermissionState) => void
): () => void {
  if (typeof window === 'undefined') return () => {};

  const syncNow = () => {
    listener(getNotificationPermissionState());
  };

  window.addEventListener('focus', syncNow);
  document.addEventListener('visibilitychange', syncNow);

  let permStatus: PermissionStatus | null = null;
  let cancelled = false;
  if (navigator.permissions && typeof navigator.permissions.query === 'function') {
    void navigator.permissions
      .query({ name: 'notifications' as PermissionName })
      .then((status) => {
        if (cancelled) return;
        permStatus = status;
        permStatus.onchange = syncNow;
      })
      .catch(() => {
        // Ignore Permissions API restrictions (e.g. iOS Safari)
      });
  }

  return () => {
    cancelled = true;
    window.removeEventListener('focus', syncNow);
    document.removeEventListener('visibilitychange', syncNow);
    if (permStatus) {
      permStatus.onchange = null;
    }
  };
}

export function requestPhoneNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return Promise.resolve('unsupported');
  }
  try {
    // Invoke Notification.requestPermission synchronously within the tap/click gesture
    return new Promise<NotificationPermission>((resolve, reject) => {
      try {
        const result = Notification.requestPermission((cbPerm) => resolve(cbPerm));
        if (result && typeof result.then === 'function') {
          result.then(resolve, reject);
        }
      } catch (err) {
        reject(err);
      }
    }).catch(() => getNotificationPermissionState());
  } catch {
    return Promise.resolve(getNotificationPermissionState());
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function areUint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function getActiveServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  try {
    const existingReg = await navigator.serviceWorker.getRegistration();
    if (existingReg) return existingReg;
    const readyReg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 2500)),
    ]);
    return readyReg;
  } catch {
    return null;
  }
}

export function isWebPushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function hasActiveWebPushSubscription(): Promise<boolean> {
  if (!isWebPushSupported() || getNotificationPermissionState() !== 'granted') {
    return false;
  }
  try {
    const reg = await getActiveServiceWorkerRegistration();
    if (!reg?.pushManager) return false;
    const sub = await reg.pushManager.getSubscription();
    return Boolean(sub);
  } catch {
    return false;
  }
}

let pendingWebPushSubscribe: Promise<{ subscribed: boolean; endpoint?: string }> | null = null;

export async function ensureWebPushSubscribed(): Promise<{
  subscribed: boolean;
  endpoint?: string;
}> {
  if (!isWebPushSupported() || getNotificationPermissionState() !== 'granted') {
    return { subscribed: false };
  }
  if (pendingWebPushSubscribe) {
    return pendingWebPushSubscribe;
  }

  pendingWebPushSubscribe = (async () => {
    try {
      const reg = await getActiveServiceWorkerRegistration();
      if (!reg?.pushManager) {
        return { subscribed: false };
      }

      const keyRes = await fetchWithTimeout('/api/push/vapid-public-key', {}, 10_000);
      if (!keyRes.ok) {
        return { subscribed: false };
      }
      const keyJson = (await keyRes.json().catch(() => ({}))) as { publicKey?: string };
      if (!keyJson.publicKey) {
        return { subscribed: false };
      }

      const expectedKeyBytes = urlBase64ToUint8Array(keyJson.publicKey);
      let sub = await reg.pushManager.getSubscription();

      if (sub?.options?.applicationServerKey) {
        const existingBytes = new Uint8Array(sub.options.applicationServerKey);
        if (!areUint8ArraysEqual(existingBytes, expectedKeyBytes)) {
          try {
            await sub.unsubscribe();
          } catch {
            // Ignore unsubscribe error before re-subscribing
          }
          sub = null;
        }
      }

      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: expectedKeyBytes,
        });
      }

      const saveRes = await fetchWithTimeout(
        '/api/push/subscribe',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        },
        10_000
      );

      if (!saveRes.ok) {
        return { subscribed: false };
      }
      return { subscribed: true, endpoint: sub.endpoint };
    } catch {
      return { subscribed: false };
    }
  })();

  try {
    return await pendingWebPushSubscribe;
  } finally {
    pendingWebPushSubscribe = null;
  }
}

export async function unsubscribeWebPush(): Promise<void> {
  if (!isWebPushSupported()) return;
  try {
    const reg = await getActiveServiceWorkerRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (!sub) return;
    await fetchWithTimeout(
      '/api/push/unsubscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      },
      10_000
    ).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  } catch {
    // Non-fatal cleanup error
  }
}

export async function syncWebPushSubscriptionIfEnabled(): Promise<boolean> {
  if (!isPhoneAlertsEnabled() || getNotificationPermissionState() !== 'granted') {
    return false;
  }
  const result = await ensureWebPushSubscribed();
  return result.subscribed;
}

async function sendServerTestWebPush(endpoint?: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      '/api/push/test',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(endpoint ? { endpoint } : {}),
      },
      10_000
    );
    if (!res.ok) return false;
    const json = (await res.json().catch(() => ({}))) as { delivered?: boolean };
    return json.delivered === true;
  } catch {
    return false;
  }
}

function getNotifiedIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(NOTIFIED_IDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function markIdNotified(id: string): void {
  try {
    const list = Array.from(getNotifiedIds());
    list.unshift(id);
    window.localStorage.setItem(NOTIFIED_IDS_KEY, JSON.stringify(list.slice(0, 60)));
  } catch {
    // Ignore storage errors
  }
}

export async function playSureSignalAlertFeedback(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    if ('vibrate' in navigator) {
      navigator.vibrate([180, 90, 220]);
    }
  } catch {
    // Ignore vibrate restriction
  }

  try {
    const ctx = getAudioContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    if (ctx.state !== 'running') return false;

    const now = ctx.currentTime;
    const playTone = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.14, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur);
    };

    playTone(880, now, 0.16);
    playTone(1174.66, now + 0.15, 0.26);
    return true;
  } catch {
    return false;
  }
}

type ExtendedNotificationOptions = NotificationOptions & {
  vibrate?: number[];
  renotify?: boolean;
};

async function showBrowserOrSwNotification(
  title: string,
  options: ExtendedNotificationOptions
): Promise<boolean> {
  if (getNotificationPermissionState() !== 'granted') {
    return false;
  }

  const normalizedOptions: ExtendedNotificationOptions = {
    ...options,
    renotify: options.renotify ?? Boolean(options.tag),
    data: options.data ?? { url: '/?tab=SURE' },
  };

  try {
    const reg = await getActiveServiceWorkerRegistration();
    if (reg && typeof reg.showNotification === 'function') {
      await reg.showNotification(title, normalizedOptions);
      return true;
    }
  } catch {
    // Fallback to direct Notification constructor below when supported
  }

  try {
    new Notification(title, normalizedOptions);
    return true;
  } catch {
    return false;
  }
}

function buildAlertFeedbackMessage(params: {
  osNotificationDelivered: boolean;
  backgroundPushActive: boolean;
  permissionState: NotificationPermissionState;
  inIframe: boolean;
}): string {
  const { osNotificationDelivered, backgroundPushActive, permissionState, inIframe } = params;
  if (backgroundPushActive && osNotificationDelivered) {
    return 'Phone Alerts ON (Background Web Push + Sound + Vibration). You will receive SURE signals and TP/SL hits even when the app is closed or screen is locked.';
  }
  if (osNotificationDelivered) {
    return 'Phone Alerts ON (System Push + Sound + Vibration). You will be notified on SURE signals and TP/SL hits.';
  }
  if (permissionState === 'granted') {
    return 'System permission granted & Sound/Vibration alerts ON! Live SURE signals and TP/SL outcomes will ring and notify.';
  }
  if (inIframe) {
    return 'Sound, Vibration & In-App Alerts ON! Browser preview iframe blocks OS push popups — install or open the direct App URL for closed-app lock-screen push alerts.';
  }
  if (permissionState === 'unsupported') {
    return 'Sound, Vibration & In-App Alerts ON! On mobile Safari/iOS, tap Share → Add to Home Screen and open from Home Screen for background push notifications.';
  }
  if (permissionState === 'denied') {
    return 'Sound & In-App Alerts ON, but browser Notifications are blocked in site settings. Tap the lock icon in your address bar → Allow Notifications.';
  }
  return 'Sound, Vibration & In-App Alerts ON! Tap Test Alert and choose Allow when prompted to enable lock-screen background push popups.';
}

export async function enableAndTestPhoneAlerts(): Promise<EnableAlertsResult> {
  const inIframe = isRunningInIframe();
  const permBefore = getNotificationPermissionState();
  // IMPORTANT: Trigger requestPermission synchronously BEFORE awaiting AudioContext.resume()
  // so iOS Safari and Android Chrome preserve the user activation gesture.
  const permPromise =
    permBefore === 'granted'
      ? Promise.resolve<NotificationPermissionState>('granted')
      : requestPhoneNotificationPermission();

  setPhoneAlertsEnabledPref(true);
  await unlockAlertAudio();
  const permissionState = await permPromise;

  const soundPlayed = await playSureSignalAlertFeedback();
  let backgroundPushActive = false;
  let osNotificationDelivered = false;

  if (permissionState === 'granted') {
    const pushSub = await ensureWebPushSubscribed();
    backgroundPushActive = pushSub.subscribed;
    if (pushSub.subscribed) {
      osNotificationDelivered = await sendServerTestWebPush(pushSub.endpoint);
    }
    if (!osNotificationDelivered) {
      osNotificationDelivered = await showBrowserOrSwNotification('LEADERS XAUUSD · Alerts Ready', {
        body: 'Phone alerts are active. You will be notified on new SURE signals and TP HIT / SL HIT outcomes.',
        icon: '/pwa-192x192.png',
        badge: '/pwa-192x192.png',
        tag: 'leaders-sure-test',
        renotify: true,
        vibrate: [160, 80, 160],
      });
    }
  }

  return {
    alertsEnabled: true,
    permissionState,
    inIframe,
    osNotificationDelivered,
    backgroundPushActive,
    soundPlayed,
    message: buildAlertFeedbackMessage({
      osNotificationDelivered,
      backgroundPushActive,
      permissionState,
      inIframe,
    }),
  };
}

export function getPersistedBannerSeenIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(BANNER_SEEN_IDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export function markBannerSeenIds(keys: string[]): void {
  if (typeof window === 'undefined' || keys.length === 0) return;
  try {
    const merged = [...keys, ...Array.from(getPersistedBannerSeenIds())];
    const unique = Array.from(new Set(merged)).slice(0, 80);
    window.localStorage.setItem(BANNER_SEEN_IDS_KEY, JSON.stringify(unique));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Pure transition reconciler that detects newly generated SURE signals and terminal TP/SL/AMBIGUOUS outcomes
 * from any SureSignalScanStatus snapshot (SSE sure_signal, sure_outcome, sure_status, or HTTP fallback poll).
 */
export function reconcileSureStatusTransitions(params: {
  nextStatus: SureSignalScanStatus | null;
  prevStatuses: Map<string, SureSignalStatus>;
  hasHydratedBaseline: boolean;
  persistedSeenKeys: Set<string>;
  explicitNewSignal?: SureSignalEntry;
  explicitClosedSignal?: SureSignalEntry;
  nowMs?: number;
  recentCatchupWindowMs?: number;
}): {
  events: DetectedSureNotificationEvent[];
  nextStatuses: Map<string, SureSignalStatus>;
  newlySeenKeys: string[];
} {
  const {
    nextStatus,
    prevStatuses,
    hasHydratedBaseline,
    persistedSeenKeys,
    explicitNewSignal,
    explicitClosedSignal,
    nowMs = Date.now(),
    recentCatchupWindowMs = 30 * 60_000,
  } = params;

  const entryMap = new Map<string, SureSignalEntry>();
  const addCandidate = (candidate?: SureSignalEntry | null) => {
    if (!candidate || !candidate.id) return;
    if (!entryMap.has(candidate.id)) {
      entryMap.set(candidate.id, candidate);
    }
  };

  addCandidate(explicitClosedSignal);
  addCandidate(explicitNewSignal);
  addCandidate(nextStatus?.activeSignal);
  if (nextStatus?.history) {
    for (const item of nextStatus.history) {
      addCandidate(item);
    }
  }

  const nextStatuses = new Map<string, SureSignalStatus>();
  const events: DetectedSureNotificationEvent[] = [];
  const newlySeenKeys: string[] = [];

  for (const entry of entryMap.values()) {
    nextStatuses.set(entry.id, entry.status);
    const prevStatus = prevStatuses.get(entry.id);

    if (entry.status === 'TP_HIT' || entry.status === 'SL_HIT' || entry.status === 'AMBIGUOUS') {
      const outcomeKey = `outcome-${entry.id}-${entry.status}`;
      const closedMs = entry.closedAt ? Date.parse(entry.closedAt) : NaN;
      const closedRecently = Number.isFinite(closedMs) && nowMs - closedMs <= recentCatchupWindowMs;
      const transitionedFromActive = prevStatus === 'ACTIVE';
      const isExplicitClosed = explicitClosedSignal?.id === entry.id;

      if (
        !persistedSeenKeys.has(outcomeKey) &&
        (isExplicitClosed || transitionedFromActive || (prevStatus === undefined && closedRecently))
      ) {
        events.push({ kind: entry.status, entry });
        newlySeenKeys.push(outcomeKey);
      }
      continue;
    }

    if (entry.status === 'ACTIVE') {
      const newKey = `new-${entry.id}`;
      const createdMs = Date.parse(entry.createdAt);
      const createdRecently = Number.isFinite(createdMs) && nowMs - createdMs <= recentCatchupWindowMs;
      const isExplicitNew = explicitNewSignal?.id === entry.id;
      const newlyDiscoveredLive = hasHydratedBaseline && prevStatus === undefined;

      if (
        !persistedSeenKeys.has(newKey) &&
        (isExplicitNew || newlyDiscoveredLive || (prevStatus === undefined && createdRecently))
      ) {
        events.push({ kind: 'NEW', entry });
        newlySeenKeys.push(newKey);
      }
    }
  }

  return { events, nextStatuses, newlySeenKeys };
}

export async function notifyNewSureSignalOnPhone(entry: SureSignalEntry): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!isPhoneAlertsEnabled()) {
    return false;
  }

  const dedupKey = `new-${entry.id}`;
  const notified = getNotifiedIds();
  if (notified.has(dedupKey) || notified.has(entry.id)) {
    return false;
  }
  markIdNotified(dedupKey);

  await playSureSignalAlertFeedback();

  // When Web Push subscription is active, server sureScanner already dispatches
  // the SW OS notification with the exact same tag — skip local duplicate popup.
  if (await hasActiveWebPushSubscription()) {
    return true;
  }

  const arrow = entry.direction === 'BUY' ? '▲ SURE BUY' : '▼ SURE SELL';
  const title = `${arrow} · XAU/USD $${safeFixed(entry.spotPrice)}`;
  const body = `Score ${entry.setupScore ?? entry.confidencePct}/100 · Entry $${safeFixed(
    entry.tradeLevels?.referencePrice ?? entry.spotPrice
  )} · SL $${safeFixed(entry.tradeLevels?.stopLoss)} · TP $${safeFixed(entry.tradeLevels?.takeProfit1)}`;

  return showBrowserOrSwNotification(title, {
    body,
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: `leaders-sure-${entry.id}`,
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200],
  });
}

export async function notifySureSignalOutcomeOnPhone(entry: SureSignalEntry): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (entry.status !== 'TP_HIT' && entry.status !== 'SL_HIT' && entry.status !== 'AMBIGUOUS') return false;
  if (!isPhoneAlertsEnabled()) {
    return false;
  }

  const dedupKey = `outcome-${entry.id}-${entry.status}`;
  const notified = getNotifiedIds();
  if (notified.has(dedupKey)) {
    return false;
  }
  markIdNotified(dedupKey);

  await playSureSignalAlertFeedback();

  if (await hasActiveWebPushSubscription()) {
    return true;
  }

  const isTp = entry.status === 'TP_HIT';
  const isAmbiguous = entry.status === 'AMBIGUOUS';
  const title = isTp
    ? `TP HIT · SURE ${entry.direction} Closed`
    : isAmbiguous
    ? `AMBIGUOUS · SURE ${entry.direction} Closed`
    : `SL HIT · SURE ${entry.direction} Closed`;
  const pnl = safeNumber(entry.pnlPoints);
  const pnlText = `${pnl >= 0 ? '+' : ''}${safeFixed(pnl, 2, '0.00')} pts`;
  const closeStr = `$${safeFixed(entry.closePrice ?? entry.spotPrice)}`;
  const body = `Entry $${safeFixed(entry.tradeLevels?.referencePrice ?? entry.spotPrice)} → Close ${closeStr} (${pnlText}). Auto-scanner resumed for next SURE signal.`;

  return showBrowserOrSwNotification(title, {
    body,
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: `leaders-sure-outcome-${entry.id}`,
    renotify: true,
    requireInteraction: true,
    vibrate: isTp ? [180, 80, 260] : [260, 100, 260],
  });
}

export async function sendTestPhoneNotification(): Promise<{
  osSent: boolean;
  backgroundPushActive: boolean;
  soundPlayed: boolean;
  inIframe: boolean;
  permissionState: NotificationPermissionState;
  message: string;
}> {
  const inIframe = isRunningInIframe();
  const permBefore = getNotificationPermissionState();
  const permPromise =
    permBefore === 'default'
      ? requestPhoneNotificationPermission()
      : Promise.resolve<NotificationPermissionState>(permBefore);

  await unlockAlertAudio();
  const permissionState = await permPromise;
  const soundPlayed = await playSureSignalAlertFeedback();

  let backgroundPushActive = false;
  let osSent = false;

  if (permissionState === 'granted') {
    const pushSub = await ensureWebPushSubscribed();
    backgroundPushActive = pushSub.subscribed;
    if (pushSub.subscribed) {
      osSent = await sendServerTestWebPush(pushSub.endpoint);
    }
    if (!osSent) {
      osSent = await showBrowserOrSwNotification('LEADERS XAUUSD · Alerts Ready', {
        body: 'Phone alerts are active. You will be notified on new SURE signals and instant TP HIT / SL HIT outcomes.',
        icon: '/pwa-192x192.png',
        badge: '/pwa-192x192.png',
        tag: 'leaders-sure-test',
        renotify: true,
        vibrate: [160, 80, 160],
      });
    }
  }

  return {
    osSent,
    backgroundPushActive,
    soundPlayed,
    inIframe,
    permissionState,
    message: buildAlertFeedbackMessage({
      osNotificationDelivered: osSent,
      backgroundPushActive,
      permissionState,
      inIframe,
    }),
  };
}


