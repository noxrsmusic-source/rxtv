import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const UPSTREAM = 'https://ottbox.sbs:5002';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
};

app.use((req, res, next) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Helper: build absolute upstream URL
function toUpstream(pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (pathOrUrl.startsWith('/')) return UPSTREAM + pathOrUrl;
  return UPSTREAM + '/' + pathOrUrl;
}

// --- HELPER FUNCTION: M3U8 aur Keys (render.key) ko rewrite karne ke liye ---
function rewriteManifest(text, manifestUrl, proxyHostUrl, refererUrl) {
  const base = new URL(manifestUrl);
  const self = `${proxyHostUrl}/seg`;
  const refParam = encodeURIComponent(refererUrl);

  return text.split('\n').map(line => {
    const s = line.trim();
    if (!s) return line;

    // 1. Encryption Keys (URI="...") ko proxy karein
    if (s.startsWith('#')) {
      if (s.includes('URI="')) {
        return s.replace(/URI="([^"]+)"/g, (match, uri) => {
          try {
            const abs = new URL(uri, base).href;
            return `URI="${self}?u=${encodeURIComponent(abs)}&r=${refParam}"`;
          } catch { return match; }
        });
      } else if (s.includes('URI=')) {
        return s.replace(/URI=([^,]+)/g, (match, uri) => {
          try {
            const abs = new URL(uri, base).href;
            return `URI="${self}?u=${encodeURIComponent(abs)}&r=${refParam}"`;
          } catch { return match; }
        });
      }
      return line;
    }

    // 2. Video segments (.ts)
    try {
      const abs = new URL(s, base).href;
      return `${self}?u=${encodeURIComponent(abs)}&r=${refParam}`;
    } catch { return line; }
  }).join('\n');
}

// ---------------- MAIN PLAY ROUTE (Vercel Optimized) ----------------
app.get('/play/:id', async (req, res) => {
  const channelId = req.params.id;
  const playerUrl = `${UPSTREAM}/player/${channelId}?q=auto&pm=auto`;

  let browser = null;
  try {
    // Vercel ke liye Chromium launch karein
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    
    const page = await browser.newPage();

    let m3u8Url = null;
    const m3u8Promise = new Promise((resolve, reject) => {
      page.on('request', (request) => {
        const url = request.url();
        if (url.includes('/render.m3u8') && url.includes('auth=')) {
          m3u8Url = url;
          resolve(url);
        }
      });
      // 15 seconds timeout for extraction
      setTimeout(() => reject(new Error('Timeout: render.m3u8 URL nahi mila')), 15000);
    });

    // Player page load karein
    await page.goto(playerUrl, { waitUntil: 'networkidle2', timeout: 25000 });

    const resolvedM3u8Url = await m3u8Promise;
    
    // Kaam khatam, browser band karein
    await browser.close();
    browser = null;

    // M3U8 file fetch karein
    const m3u8Res = await fetch(resolvedM3u8Url, {
      headers: {
        'Referer': playerUrl,
        'Origin': UPSTREAM,
        'User-Agent': UA,
        'Accept': '*/*',
      },
    });

    if (!m3u8Res.ok) {
      throw new Error(`m3u8 fetch failed: ${m3u8Res.status}`);
    }

    const m3u8Text = await m3u8Res.text();

    // Rewrite Manifest (Video URL + Encryption Keys)
    const proxyHostUrl = `${req.protocol}://${req.get('host')}`;
    const rewritten = rewriteManifest(m3u8Text, resolvedM3u8Url, proxyHostUrl, playerUrl);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.send(rewritten);

  } catch (err) {
    console.error('[/play] error:', err.message);
    if (browser) await browser.close();
    res.status(502).json({ error: err.message });
  }
});

// ---------------- SEGMENT ROUTE ----------------
app.get('/seg', async (req, res) => {
  const targetUrl = req.query.u;
  const refererUrl = req.query.r || (UPSTREAM + '/');

  if (!targetUrl) return res.status(400).send('Missing u=');

  try {
    const upstreamRes = await fetch(targetUrl, {
      headers: {
        'Referer': refererUrl,
        'Origin': UPSTREAM,
        'User-Agent': UA,
        'Accept': '*/*',
      },
      redirect: 'follow',
    });

    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).send(`Upstream ${upstreamRes.status}`);
    }

    const ct = (upstreamRes.headers.get('content-type') || '').toLowerCase();

    // Nested M3U8 playlists
    if (ct.includes('mpegurl') || targetUrl.split('?')[0].endsWith('.m3u8')) {
      const text = await upstreamRes.text();
      const proxyHostUrl = `${req.protocol}://${req.get('host')}`;
      const rewritten = rewriteManifest(text, upstreamRes.url || targetUrl, proxyHostUrl, refererUrl);

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(rewritten);
    }

    // Binary files (.ts, .mp4, render.key)
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    const cl = upstreamRes.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    res.setHeader('Cache-Control', 'public, max-age=60');

    const reader = upstreamRes.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        res.write(value);
      }
    };
    pump().catch(err => {
      console.error('[/seg] stream error:', err);
      res.end();
    });
  } catch (err) {
    console.error('[/seg] error:', err);
    if (!res.headersSent) res.status(502).send('Segment fetch failed: ' + err.message);
    else res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ R TV+ running on port ${PORT}`);
});