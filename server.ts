import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { ALL_TIMEFRAMES, type SelectedIndicatorConfig, type Timeframe } from './src/types/market.ts';
import { INDICATOR_CATALOG } from './src/constants/indicators.ts';
import { DataUnavailableError, NewsBlockedError, runFullAnalysis } from './server/analyzer.ts';
import { computeChartOverlays, computeHourlySentiment24h, computeSupportResistance } from './server/indicators.ts';
import { fetchCandles, fetchLiveXauUsdQuote, subscribeLiveQuotes } from './server/marketData.ts';
import {
  evaluateCurrentNewsProtection,
  getEconomicCalendarPayload,
  startNewsBackgroundMonitor,
  subscribeNewsStatusUpdates,
} from './server/newsCalendar.ts';
import { deleteReportById, getReportById, listReports } from './server/reportsStore.ts';
import {
  getSureSignalStatus,
  handleSureSignalDeleted,
  isSureStatusStaleForMinute,
  restoreActiveSureSignal,
  runSureSignalScan,
  startSureSignalBackgroundScanner,
  subscribeSureSignalUpdates,
} from './server/sureScanner.ts';
import { deleteSureSignalById } from './server/sureSignalsStore.ts';
import {
  getPushSubscriptionCount,
  getVapidPublicKey,
  removePushSubscription,
  sendTestPushToSubscription,
  upsertPushSubscription,
} from './server/webPushStore.ts';

interface CachedJpgExport {
  buffer: Buffer;
  filename: string;
  expiresAt: number;
}

const jpgExportCache = new Map<string, CachedJpgExport>();

function pruneJpgExportCache() {
  const now = Date.now();
  for (const [key, entry] of jpgExportCache.entries()) {
    if (entry.expiresAt <= now) {
      jpgExportCache.delete(key);
    }
  }
  while (jpgExportCache.size > 20) {
    const oldestKey = jpgExportCache.keys().next().value;
    if (!oldestKey) break;
    jpgExportCache.delete(oldestKey);
  }
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_INDICATOR_IDS = new Set(INDICATOR_CATALOG.map((c) => c.id));

function sanitizeIndicatorsInput(raw: unknown): SelectedIndicatorConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: SelectedIndicatorConfig[] = [];
  for (const item of raw.slice(0, 32)) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== 'string' || !VALID_INDICATOR_IDS.has(rec.id as SelectedIndicatorConfig['id'])) {
      continue;
    }
    const cleanParams: Record<string, number> = {};
    if (rec.params && typeof rec.params === 'object') {
      for (const [k, v] of Object.entries(rec.params as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000) {
          cleanParams[k] = v;
        }
      }
    }
    out.push({
      id: rec.id as SelectedIndicatorConfig['id'],
      enabled: Boolean(rec.enabled),
      params: cleanParams,
    });
  }
  return out;
}

async function startServer() {
  const app = express();
  const jsonParser1Mb = express.json({ limit: '1mb' });
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.path === '/api/export/jpg') {
      next();
      return;
    }
    jsonParser1Mb(req, res, next);
  });

  app.use('/api', (req, res, next) => {
    if (req.path !== '/market/stream') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'LEADERS XAUUSD', time: new Date().toISOString() });
  });

  app.get('/api/market/quote', async (_req, res) => {
    try {
      const quote = await fetchLiveXauUsdQuote();
      if (quote.freshness === 'UNAVAILABLE') {
        res.status(503).json({ status: 'DATA UNAVAILABLE', quote });
        return;
      }
      res.json({ status: quote.freshness, quote });
    } catch (err) {
      res.status(503).json({
        status: 'DATA UNAVAILABLE',
        error: err instanceof Error ? err.message : 'Unable to fetch quote',
      });
    }
  });

  app.get('/api/market/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const sendQuote = (quote: Awaited<ReturnType<typeof fetchLiveXauUsdQuote>>) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ status: quote.freshness, quote })}\n\n`);
    };

    const unsubscribe = subscribeLiveQuotes(sendQuote);
    const unsubscribeSure = subscribeSureSignalUpdates((evt) => {
      if (res.writableEnded) return;
      res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
    });
    const unsubscribeNews = subscribeNewsStatusUpdates((evt) => {
      if (res.writableEnded) return;
      res.write(`event: news_status\ndata: ${JSON.stringify(evt)}\n\n`);
    });
    void fetchLiveXauUsdQuote().then((q) => {
      if (q.freshness !== 'UNAVAILABLE') {
        sendQuote(q);
      }
    });
    void evaluateCurrentNewsProtection()
      .then((protection) => {
        if (!res.writableEnded) {
          res.write(`event: news_status\ndata: ${JSON.stringify({ type: 'news_status', protection })}\n\n`);
        }
      })
      .catch(() => {
        // Initial news push failure is non-fatal for SSE stream
      });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': ping\n\n');
      }
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      unsubscribeSure();
      unsubscribeNews();
      if (!res.writableEnded) {
        res.end();
      }
    });
  });

  app.get('/api/news/calendar', async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
      const quote = await fetchLiveXauUsdQuote().catch(() => null);
      const calendar = await getEconomicCalendarPayload({ quote, forceRefresh });
      res.json({ status: calendar.feedStatus, calendar });
    } catch (err) {
      res.status(503).json({
        status: 'UNAVAILABLE',
        error: err instanceof Error ? err.message : 'Unable to load economic calendar data',
      });
    }
  });

  app.get('/api/news/status', async (_req, res) => {
    try {
      const quote = await fetchLiveXauUsdQuote().catch(() => null);
      const protection = await evaluateCurrentNewsProtection({ quote });
      res.json({ status: protection.status, protection });
    } catch (err) {
      res.status(503).json({
        status: 'UNAVAILABLE',
        error: err instanceof Error ? err.message : 'Unable to evaluate economic news status',
      });
    }
  });

  app.get('/api/market/sentiment', async (_req, res) => {
    try {
      const dataset = await fetchCandles('1H');
      const sentiment = computeHourlySentiment24h(
        dataset.candles,
        dataset.latestTimestamp,
        dataset.freshness,
        dataset.candleSource
      );
      res.json({ status: dataset.freshness, sentiment });
    } catch (err) {
      res.status(503).json({
        status: 'DATA UNAVAILABLE',
        error: err instanceof Error ? err.message : 'Unable to compute 24h market sentiment',
      });
    }
  });

  app.get('/api/market/candles', async (req, res) => {
    const tf = String(req.query.timeframe ?? '15m') as Timeframe;
    if (!ALL_TIMEFRAMES.includes(tf)) {
      res.status(400).json({ status: 'INVALID TIMEFRAME', error: `Unsupported timeframe: ${tf}` });
      return;
    }

    try {
      const dataset = await fetchCandles(tf);
      const levels = computeSupportResistance(dataset.candles);
      res.json({
        status: dataset.freshness,
        dataset,
        supportLevels: levels.supportLevels,
        resistanceLevels: levels.resistanceLevels,
      });
    } catch (err) {
      res.status(503).json({
        status: 'DATA UNAVAILABLE',
        error: err instanceof Error ? err.message : 'Unable to fetch market candle data',
      });
    }
  });

  app.post('/api/market/overlays', async (req, res) => {
    const tf = String(req.body?.timeframe ?? '15m') as Timeframe;
    const indicators = sanitizeIndicatorsInput(req.body?.indicators);

    if (!ALL_TIMEFRAMES.includes(tf)) {
      res.status(400).json({ error: `Unsupported timeframe: ${tf}` });
      return;
    }

    try {
      const dataset = await fetchCandles(tf);
      const overlays = computeChartOverlays(dataset.candles, indicators);
      res.json({ overlays });
    } catch (err) {
      res.status(503).json({
        status: 'DATA UNAVAILABLE',
        error: err instanceof Error ? err.message : 'Failed to compute chart overlays',
      });
    }
  });

  app.post('/api/analyze', async (req, res) => {
    const rawTimeframes = Array.isArray(req.body?.timeframes) ? req.body.timeframes : [];
    const indicators = sanitizeIndicatorsInput(req.body?.indicators);

    const validTimeframes = rawTimeframes.filter(
      (t: unknown): t is Timeframe => typeof t === 'string' && ALL_TIMEFRAMES.includes(t as Timeframe)
    );
    if (validTimeframes.length === 0) {
      res.status(400).json({ error: 'Select at least one valid timeframe before running analysis.' });
      return;
    }
    if (indicators.filter((i) => i.enabled).length === 0) {
      res.status(400).json({ error: 'Enable at least one valid technical indicator before running analysis.' });
      return;
    }

    try {
      const report = await runFullAnalysis(validTimeframes, indicators);
      res.json({ status: 'OK', report });
    } catch (err) {
      if (err instanceof NewsBlockedError) {
        res.status(423).json({
          status: err.protection.safeFallbackActive ? 'NEWS DATA UNVERIFIED' : 'HIGH IMPACT NEWS',
          error: err.message,
          newsProtection: err.protection,
        });
        return;
      }
      if (err instanceof DataUnavailableError) {
        res.status(503).json({ status: 'DATA UNAVAILABLE', error: err.message });
        return;
      }
      res.status(500).json({
        status: 'ANALYSIS ERROR',
        error: err instanceof Error ? err.message : 'Analysis calculation failed',
      });
    }
  });

  app.get('/api/reports', async (_req, res) => {
    try {
      const reports = await listReports();
      res.json({ reports });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load reports' });
    }
  });

  app.get('/api/reports/:id', async (req, res) => {
    if (!VALID_ID_REGEX.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid report identifier' });
      return;
    }
    try {
      const report = await getReportById(req.params.id);
      if (!report) {
        res.status(404).json({ error: 'Report not found' });
        return;
      }
      res.json({ report });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load report' });
    }
  });

  app.delete('/api/reports/:id', async (req, res) => {
    if (!VALID_ID_REGEX.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid report identifier' });
      return;
    }
    try {
      const deleted = await deleteReportById(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'Report not found' });
        return;
      }
      res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete report' });
    }
  });

  app.get('/api/sure-signals', async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
      let status = await getSureSignalStatus();
      if (!status.tradeLocked && (forceRefresh || isSureStatusStaleForMinute(status))) {
        status = await runSureSignalScan();
      }
      res.json({ status: 'OK', sureStatus: status });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to fetch sure signal status',
      });
    }
  });

  app.post('/api/sure-signals/sync-active', async (req, res) => {
    try {
      const entry = req.body?.entry;
      const sureStatus = await restoreActiveSureSignal(entry);
      res.json({ status: 'OK', sureStatus });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to restore active sure signal',
      });
    }
  });

  app.delete('/api/sure-signals/:id', async (req, res) => {
    if (!VALID_ID_REGEX.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid sure signal identifier' });
      return;
    }
    try {
      const existing = await getSureSignalStatus();
      const target = existing.history.find((item) => item.id === req.params.id);
      if (!target) {
        res.status(404).json({ error: 'Sure signal not found' });
        return;
      }
      if (target.status !== 'ACTIVE') {
        res.status(400).json({ error: 'Completed SURE signal history records are immutable and cannot be deleted.' });
        return;
      }
      const deleted = await deleteSureSignalById(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'Sure signal not found' });
        return;
      }
      const status = await handleSureSignalDeleted(req.params.id);
      res.json({ deleted: true, id: req.params.id, sureStatus: status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete sure signal' });
    }
  });

  app.get('/api/push/vapid-public-key', async (_req, res) => {
    try {
      const publicKey = await getVapidPublicKey();
      const subscriberCount = await getPushSubscriptionCount();
      res.json({ publicKey, supported: true, subscriberCount });
    } catch (err) {
      res.status(500).json({
        supported: false,
        error: err instanceof Error ? err.message : 'Unable to initialize Web Push keys',
      });
    }
  });

  app.post('/api/push/subscribe', async (req, res) => {
    try {
      const result = await upsertPushSubscription(
        req.body?.subscription,
        req.get('user-agent')
      );
      res.json({ subscribed: result.saved, count: result.count });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Invalid push subscription',
      });
    }
  });

  app.post('/api/push/unsubscribe', async (req, res) => {
    try {
      const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
      if (!endpoint) {
        res.status(400).json({ error: 'Missing endpoint' });
        return;
      }
      const removed = await removePushSubscription(endpoint);
      res.json({ unsubscribed: true, removed });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unable to unsubscribe push endpoint' });
    }
  });

  app.post('/api/push/test', async (req, res) => {
    try {
      const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : undefined;
      const result = await sendTestPushToSubscription(endpoint);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        delivered: false,
        error: err instanceof Error ? err.message : 'Failed to deliver Web Push test',
      });
    }
  });

  app.post('/api/export/jpg', express.json({ limit: '8mb' }), (req, res) => {
    const rawDataUrl = typeof req.body?.dataUrl === 'string' ? req.body.dataUrl : '';
    const rawFilename = typeof req.body?.filename === 'string' ? req.body.filename : 'LEADERS-XAUUSD-report.jpg';

    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(rawDataUrl);
    if (!match) {
      res.status(400).json({ error: 'Invalid JPEG payload' });
      return;
    }

    const buffer = Buffer.from(match[1], 'base64');
    if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) {
      res.status(400).json({ error: 'JPEG payload exceeds allowed size' });
      return;
    }

    const safeFilename =
      rawFilename.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 120) || 'LEADERS-XAUUSD-report.jpg';
    const token = crypto.randomUUID();

    pruneJpgExportCache();
    jpgExportCache.set(token, {
      buffer,
      filename: safeFilename.endsWith('.jpg') ? safeFilename : `${safeFilename}.jpg`,
      expiresAt: Date.now() + 5 * 60_000,
    });

    res.json({ downloadUrl: `/api/export/jpg/${encodeURIComponent(token)}` });
  });

  app.get('/api/export/jpg/:token', (req, res) => {
    if (!UUID_REGEX.test(req.params.token)) {
      res.status(400).send('Invalid export token');
      return;
    }
    pruneJpgExportCache();
    const entry = jpgExportCache.get(req.params.token);
    if (!entry) {
      res.status(404).send('Exported image expired or not found');
      return;
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
    res.setHeader('Content-Length', String(entry.buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.send(entry.buffer);
  });

  app.all('/api/*', (_req, res) => {
    res.status(404).json({ status: 'NOT FOUND', error: 'API endpoint not found.' });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    // Prevent Vite SPA index.html fallback when browsers check /sw.js in dev mode
    app.get('/sw.js', (_req, res) => {
      res.status(404).type('application/javascript').send('// Dev mode: Service worker inactive');
    });
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'spa',
      plugins: [
        {
          name: 'disable-vite-hmr-client-ws',
          enforce: 'post',
          transform(code, id) {
            const cleanId = id.split('?', 1)[0];
            if (
              cleanId.endsWith('/vite/dist/client/client.mjs') ||
              cleanId.endsWith('\\vite\\dist\\client\\client.mjs')
            ) {
              return {
                code: code.replace(
                  /const transport = normalizeModuleRunnerTransport\(\(\(\) => \{[\s\S]*?\}\)\(\)\);/,
                  'const transport = normalizeModuleRunnerTransport({ connect() {}, disconnect() {}, send() {} });'
                ),
                map: null,
              };
            }
          },
        },
      ],
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(
      express.static(distDir, {
        setHeaders(res, filePath) {
          if (filePath.endsWith('manifest.webmanifest')) {
            res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
          } else if (
            filePath.endsWith('sw.js') ||
            filePath.endsWith('sw-notifications.js') ||
            filePath.endsWith('registerSW.js')
          ) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (res.headersSent) return;
      const errObj = err as { type?: string; status?: number; message?: string };
      if (errObj?.type === 'entity.too.large' || errObj?.status === 413) {
        res.status(413).json({
          status: 'PAYLOAD TOO LARGE',
          error: 'Request payload exceeds allowed size limit.',
        });
        return;
      }
      if (err instanceof SyntaxError && (errObj?.status === 400 || errObj?.type === 'entity.parse.failed')) {
        res.status(400).json({
          status: 'BAD JSON',
          error: 'Malformed JSON request body.',
        });
        return;
      }
      console.error('Unhandled Express error:', err);
      res.status(500).json({
        status: 'SERVER ERROR',
        error: err instanceof Error ? err.message : 'Unexpected server error',
      });
    }
  );

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LEADERS XAUUSD server listening on http://0.0.0.0:${PORT}`);
    startNewsBackgroundMonitor(() => {
      void runSureSignalScan().catch(() => {});
    });
    startSureSignalBackgroundScanner();
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

startServer().catch((err) => {
  console.error('Failed to start LEADERS XAUUSD server:', err);
  process.exit(1);
});
