export function safeNumber(val: unknown, fallback = 0): number {
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

export function safeFixed(val: unknown, decimals = 2, fallback = '—'): string {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    return fallback;
  }
  return val.toFixed(decimals);
}

export function safeLocaleDateTime(
  isoOrMs: string | number | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  fallback = '—',
): string {
  if (isoOrMs === null || isoOrMs === undefined || isoOrMs === '') {
    return fallback;
  }
  const d = isoOrMs instanceof Date ? isoOrMs : new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) {
    return fallback;
  }
  try {
    return d.toLocaleString(undefined, options);
  } catch {
    return fallback;
  }
}

export function safeLocaleTime(
  isoOrMs: string | number | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  fallback = '—',
): string {
  if (isoOrMs === null || isoOrMs === undefined || isoOrMs === '') {
    return fallback;
  }
  const d = isoOrMs instanceof Date ? isoOrMs : new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) {
    return fallback;
  }
  try {
    return d.toLocaleTimeString(undefined, options);
  } catch {
    return fallback;
  }
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 12_000,
): Promise<Response> {
  const controller = new AbortController();
  const externalSignal = init.signal;
  let abortedByExternal = false;

  const onExternalAbort = () => {
    abortedByExternal = true;
    controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    if (!abortedByExternal) {
      controller.abort();
    }
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}
