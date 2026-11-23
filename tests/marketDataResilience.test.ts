import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __resetMarketDataCachesForTest,
  fetchPureFuturesCandles,
} from '../server/marketData.ts';

function buildValidYahooPayload(nowSec: number, count = 45) {
  const timestamps: number[] = [];
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];

  const startSec = Math.floor(nowSec / 900) * 900 - count * 900;
  for (let i = 0; i < count; i++) {
    const t = startSec + i * 900;
    const base = 3600 + i * 0.5;
    timestamps.push(t);
    open.push(base);
    high.push(base + 2.2);
    low.push(base - 1.4);
    close.push(base + 1.1);
    volume.push(150 + i);
  }

  return {
    chart: {
      error: null,
      result: [
        {
          meta: {
            symbol: 'GC=F',
            regularMarketTime: nowSec,
            dataGranularity: '15m',
          },
          timestamp: timestamps,
          indicators: {
            quote: [{ open, high, low, close, volume }],
          },
        },
      ],
    },
  };
}

test('Concurrent fetchPureFuturesCandles calls deduplicate to a single Yahoo upstream request', async () => {
  __resetMarketDataCachesForTest();
  const origFetch = globalThis.fetch;
  let yahooCalls = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = buildValidYahooPayload(nowSec);

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('finance.yahoo.com')) {
      yahooCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  }) as typeof fetch;

  try {
    const [a, b, c] = await Promise.all([
      fetchPureFuturesCandles('15m'),
      fetchPureFuturesCandles('15m'),
      fetchPureFuturesCandles('15m'),
    ]);

    assert.equal(yahooCalls, 1);
    assert.equal(a.candles.length, 45);
    assert.equal(b.candles.length, 45);
    assert.equal(c.candles.length, 45);
  } finally {
    globalThis.fetch = origFetch;
    __resetMarketDataCachesForTest();
  }
});

test('Yahoo query1 HTTP 429 cleanly fails over to query2 host without failing', async () => {
  __resetMarketDataCachesForTest();
  const origFetch = globalThis.fetch;
  const hostsCalled: string[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = buildValidYahooPayload(nowSec);

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('query1.finance.yahoo.com')) {
      hostsCalled.push('query1');
      return new Response('Too Many Requests', { status: 429 });
    }
    if (url.includes('query2.finance.yahoo.com')) {
      hostsCalled.push('query2');
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  }) as typeof fetch;

  try {
    const ds = await fetchPureFuturesCandles('15m');
    assert.deepEqual(hostsCalled, ['query1', 'query2']);
    assert.equal(ds.candles.length, 45);
    assert.equal(ds.freshness, 'LIVE');
  } finally {
    globalThis.fetch = origFetch;
    __resetMarketDataCachesForTest();
  }
});

test('When both Yahoo hosts return HTTP 429 after cache expiry, cached candles are preserved and cooldown blocks hammer loops', async () => {
  __resetMarketDataCachesForTest();
  const origFetch = globalThis.fetch;
  const origNow = Date.now;
  let fakeNowMs = origNow();
  Date.now = () => fakeNowMs;

  let yahooCalls = 0;
  let force429 = false;
  const payload = buildValidYahooPayload(Math.floor(fakeNowMs / 1000));

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('finance.yahoo.com')) {
      yahooCalls++;
      if (force429) {
        return new Response('Rate limited', {
          status: 429,
          headers: { 'retry-after': '60' },
        });
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  }) as typeof fetch;

  try {
    // 1. Warm up 15m cache
    const initial = await fetchPureFuturesCandles('15m');
    assert.equal(initial.candles.length, 45);
    assert.equal(yahooCalls, 1);

    // 2. Advance clock past 15m TTL (120s) and force 429 on both query1 and query2
    fakeNowMs += 130_000;
    force429 = true;
    const recovered = await fetchPureFuturesCandles('15m');
    assert.equal(recovered.candles.length, 45);
    assert.notEqual(recovered.freshness, 'UNAVAILABLE');
    assert.equal(yahooCalls, 3); // tried query1 + query2 once

    // 3. Subsequent calls inside 60s rate-limit cooldown must NOT hit Yahoo at all
    const duringCooldown = await fetchPureFuturesCandles('15m');
    assert.equal(duringCooldown.candles.length, 45);
    assert.equal(yahooCalls, 3);
  } finally {
    Date.now = origNow;
    globalThis.fetch = origFetch;
    __resetMarketDataCachesForTest();
  }
});

test('fetchPureFuturesCandles drops unfinished delayed GC=F 5m stub bar whose close exceeds regularMarketTime', async () => {
  __resetMarketDataCachesForTest();
  const origFetch = globalThis.fetch;
  const nowSec = Math.floor(Date.now() / 1000);
  const delayedMarketTime = nowSec - 600; // ~10m COMEX delay
  const lastClosed5mStart = Math.floor(delayedMarketTime / 300) * 300 - 300;
  const unfinished5mStart = lastClosed5mStart + 300; // still forming at delayedMarketTime

  const timestamps: number[] = [];
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];

  for (let i = 39; i >= 0; i--) {
    const t = lastClosed5mStart - i * 300;
    timestamps.push(t);
    open.push(3610);
    high.push(3612);
    low.push(3609);
    close.push(3611);
    volume.push(500);
  }
  // Append unfinished partial bar (only 2m into 5m interval, tiny volume=61)
  timestamps.push(unfinished5mStart);
  open.push(3611);
  high.push(3611.5);
  low.push(3610.5);
  close.push(3611.2);
  volume.push(61);

  const payload = {
    chart: {
      error: null,
      result: [
        {
          meta: {
            symbol: 'GC=F',
            regularMarketTime: unfinished5mStart + 120,
            dataGranularity: '5m',
          },
          timestamp: timestamps,
          indicators: {
            quote: [{ open, high, low, close, volume }],
          },
        },
      ],
    },
  };

  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  try {
    const ds = await fetchPureFuturesCandles('5m');
    assert.equal(ds.candles.length, 40);
    assert.equal(ds.candles[ds.candles.length - 1].time, lastClosed5mStart);
    assert.equal(ds.candles[ds.candles.length - 1].volume, 500);
  } finally {
    globalThis.fetch = origFetch;
    __resetMarketDataCachesForTest();
  }
});
