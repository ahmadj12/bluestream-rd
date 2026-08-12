const express = require("express");
const https = require("https");
const http = require("http");
const querystring = require("querystring");

const app = express();
app.use(express.json());

// ====== CORS ======
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 8080;
const RD_TOKEN = process.env.RD_TOKEN;
const TMDB_KEY = "570589dd8a1dac1a24fc6f98c18d1e59";

if (!RD_TOKEN) {
  console.error("❌ RD_TOKEN is missing!");
  process.exit(1);
}

// ====== دالة طلبات HTTP عامة ونظيفة ======
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    let bodyData = '';

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      ...(options.headers || {}),
    };

    if (options.body) {
      if (typeof options.body === 'object') {
        bodyData = querystring.stringify(options.body);
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else {
        bodyData = options.body;
      }
      headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const req = protocol.request(url, { method: options.method || 'GET', headers, timeout: 12000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data }); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

// 1. جلب بيانات TMDB و IMDb ID
async function getTMDBMeta(id, type) {
  const path = type === 'movie' ? 'movie' : 'tv';
  const url = `https://api.themoviedb.org/3/${path}/${id}?api_key=${TMDB_KEY}&append_to_response=external_ids&language=en-US`;
  const res = await request(url);
  if (res.status !== 200) return { error: `TMDB returned status ${res.status}` };
  return { meta: res.data };
}

// 2. جلب Magnet من Torrentio بدون هيدرات RD
async function fetchTorrentio(type, imdbId, season, episode) {
  const queryPath = type === 'movie' ? `movie/${imdbId}` : `series/${imdbId}:${season}:${episode}`;
  const url = `https://torrentio.strem.fun/stream/${queryPath}.json`;
  const res = await request(url);

  if (res.status !== 200) return { error: `Torrentio returned status ${res.status}` };
  if (!res.data?.streams?.length) return { error: "No torrent streams found for this title" };

  const stream = res.data.streams.find(s => s.infoHash);
  if (!stream) return { error: "Valid infoHash not found in stream" };

  return {
    magnet: `magnet:?xt=urn:btih:${stream.infoHash}`,
    quality: stream.name?.includes('4K') ? '4K' : '1080p'
  };
}

// 3. معالجة التحويل مع Real-Debrid
async function processRealDebrid(magnet) {
  const rdHeaders = { 'Authorization': `Bearer ${RD_TOKEN}` };

  // إضافة المغناطيس
  const addRes = await request('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
    method: 'POST',
    headers: rdHeaders,
    body: { magnet }
  });

  if (!addRes.data?.id) return { error: `RD AddMagnet Failed (${addRes.status}): ${JSON.stringify(addRes.data)}` };
  const torrentId = addRes.data.id;

  // اختيار كافة الملفات
  await request(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, {
    method: 'POST',
    headers: rdHeaders,
    body: { files: 'all' }
  });

  // الانتظار حتى اكتمال المعالجة
  let torrentInfo = null;
  for (let i = 0; i < 15; i++) {
    const info = await request(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, { headers: rdHeaders });
    if (info.data?.status === 'downloaded') {
      torrentInfo = info.data;
      break;
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  if (!torrentInfo || !torrentInfo.links?.length) {
    return { error: `RD Download Timeout or No Links generated` };
  }

  // فك التشفير للحصول على رابط مباشر
  const unrestrict = await request('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
    method: 'POST',
    headers: rdHeaders,
    body: { link: torrentInfo.links[0] }
  });

  if (!unrestrict.data?.download) {
    return { error: `RD Unrestrict Link Failed: ${JSON.stringify(unrestrict.data)}` };
  }

  return { url: unrestrict.data.download, filename: torrentInfo.filename };
}

// ====== API Main Endpoint ======
app.get("/api/play", async (req, res) => {
  const { id, type, season = 1, episode = 1 } = req.query;

  if (!id || !type) return res.status(400).json({ success: false, error: "Missing parameters" });

  try {
    // الخطوة الأولى: TMDB
    const tmdbRes = await getTMDBMeta(id, type);
    if (tmdbRes.error) return res.status(404).json({ success: false, step: "TMDB", error: tmdbRes.error });
    const meta = tmdbRes.meta;

    const imdbId = meta.external_ids?.imdb_id || meta.imdb_id;
    if (!imdbId) return res.status(404).json({ success: false, step: "IMDb_Check", error: "IMDb ID not found for this item" });

    // الخطوة الثانية: Torrentio
    const torrentRes = await fetchTorrentio(type, imdbId, parseInt(season), parseInt(episode));
    if (torrentRes.error) return res.status(404).json({ success: false, step: "Torrentio", imdb_id: imdbId, error: torrentRes.error });

    // الخطوة الثالثة: Real-Debrid
    const rdRes = await processRealDebrid(torrentRes.magnet);
    if (rdRes.error) return res.status(500).json({ success: false, step: "Real-Debrid", error: rdRes.error });

    return res.json({
      success: true,
      title: meta.title || meta.name,
      imdb_id: imdbId,
      quality: torrentRes.quality,
      stream_url: rdRes.url,
      filename: rdRes.filename
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({ status: "✅ Server Ready and Working Perfectly" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});