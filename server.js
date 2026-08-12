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
  console.error("❌ خطأ: لم يتم تعيين RD_TOKEN");
  process.exit(1);
}

// ====== دالة طلب HTTP عامة لـ Real-Debrid ======
function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    let bodyData = '';
    
    const headers = {
      'Authorization': `Bearer ${RD_TOKEN}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
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

    const req = protocol.request(url, { method: options.method || 'GET', headers, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
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

// ====== TMDB Metadata ======
async function getTMDBMeta(id, type) {
  try {
    const path = type === 'movie' ? 'movie' : 'tv';
    const response = await fetchURL(`https://api.themoviedb.org/3/${path}/${id}?api_key=${TMDB_KEY}&language=en-US`);
    return response.status === 200 ? response.data : null;
  } catch (err) {
    return null;
  }
}

// ====== جلب Magnet خارجي (Torrentio + Backup Scrap Search) ======
async function fetchExternalMagnet(type, id, season, episode, meta) {
  try {
    // 1. المحاولة الأولى: عبر TMDB ID المباشر
    const queryPath = type === 'movie' ? `movie/${id}` : `series/${id}:${season}:${episode}`;
    const response = await fetchURL(`https://torrentio.strem.fun/stream/${queryPath}.json`);
    
    if (response.status === 200 && response.data?.streams?.length > 0) {
      const stream = response.data.streams.find(s => s.infoHash);
      if (stream) {
        return {
          magnet: `magnet:?xt=urn:btih:${stream.infoHash}`,
          quality: stream.name?.includes('4K') ? '4K' : '1080p'
        };
      }
    }

    // 2. المحاولة الثانية الاحتياطية: بالاسم والسنة
    const title = meta.title || meta.name;
    const year = (meta.release_date || meta.first_air_date || '').slice(0, 4);
    const searchQuery = type === 'movie' ? `${title} ${year}` : `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    
    const searchUrl = `https://torrentio.strem.fun/stream/${type === 'movie' ? 'movie' : 'series'}/${encodeURIComponent(searchQuery)}.json`;
    const backupRes = await fetchURL(searchUrl);

    if (backupRes.status === 200 && backupRes.data?.streams?.length > 0) {
      const stream = backupRes.data.streams.find(s => s.infoHash);
      if (stream) {
        return {
          magnet: `magnet:?xt=urn:btih:${stream.infoHash}`,
          quality: stream.name?.includes('4K') ? '4K' : '1080p'
        };
      }
    }

    return null;
  } catch (err) {
    return null;
  }
}

// ====== معالجة Real-Debrid ======
async function processRealDebrid(magnet) {
  const addRes = await fetchURL('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', { method: 'POST', body: { magnet } });
  if (!addRes.data?.id) return null;
  const torrentId = addRes.data.id;

  await fetchURL(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, { method: 'POST', body: { files: 'all' } });

  let torrentInfo = null;
  for (let i = 0; i < 15; i++) {
    const info = await fetchURL(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`);
    if (info.data?.status === 'downloaded') {
      torrentInfo = info.data;
      break;
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  if (!torrentInfo || !torrentInfo.links?.length) return null;

  const unrestrict = await fetchURL('https://api.real-debrid.com/rest/1.0/unrestrict/link', { method: 'POST', body: { link: torrentInfo.links[0] } });
  return unrestrict.data?.download ? { url: unrestrict.data.download, filename: torrentInfo.filename } : null;
}

// ====== API الرئيسي ======
app.get("/api/play", async (req, res) => {
  const { id, type, season = 1, episode = 1 } = req.query;

  if (!id || !type) return res.status(400).json({ success: false, error: "Missing parameters" });

  try {
    const meta = await getTMDBMeta(id, type);
    if (!meta) return res.status(404).json({ success: false, error: "TMDB Meta not found" });

    // جلب التورنت بالذكاء المزدوج
    const streamData = await fetchExternalMagnet(type, id, season, episode, meta);
    if (!streamData) return res.status(404).json({ success: false, error: "No torrent found" });

    // معالجة عبر Real-Debrid
    const rdResult = await processRealDebrid(streamData.magnet);
    if (!rdResult) return res.status(500).json({ success: false, error: "Real-Debrid processing failed" });

    return res.json({
      success: true,
      title: meta.title || meta.name,
      quality: streamData.quality,
      stream_url: rdResult.url,
      filename: rdResult.filename
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({ status: "✅ Fast Stream Test API Active" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Fast API running on port ${PORT}`);
});