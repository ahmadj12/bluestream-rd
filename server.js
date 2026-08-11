const express = require("express");
const https = require("https");
const http = require("http");

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

const PORT = process.env.PORT;
const RD_TOKEN = process.env.RD_TOKEN;

if (!RD_TOKEN) {
  console.error("❌ خطأ: لم يتم تعيين RD_TOKEN");
  process.exit(1);
}

// ====== TMDB API ======
const TMDB_KEY = "570589dd8a1dac1a24fc6f98c18d1e59";

// ====== دالة طلب HTTP ======
function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const reqOpts = {
      method: options.method || 'GET',
      headers: {
        'Authorization': `Bearer ${RD_TOKEN}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(options.headers || {}),
      },
    };

    const req = protocol.request(url, reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ====== TMDB ======
async function getTMDBMeta(id, type) {
  try {
    const path = type === 'movie' ? 'movie' : 'tv';
    const url = `https://api.themoviedb.org/3/${path}/${id}?api_key=${TMDB_KEY}&language=en-US`;
    const response = await fetchURL(url);
    return response.status === 200 ? response.data : null;
  } catch (err) {
    return null;
  }
}

// ====== Torrentio API (محرك بحث تورنت) ======
// https://torrentio.strem.fun
async function searchTorrentio(tmdbId, type, season, episode) {
  try {
    let url;
    if (type === 'movie') {
      url = `https://torrentio.strem.fun/stream/movie/${tmdbId}.json`;
    } else {
      url = `https://torrentio.strem.fun/stream/series/${tmdbId}:${season || 1}:${episode || 1}.json`;
    }

    console.log(`🔍 Torrentio: ${url}`);
    
    const response = await fetchURL(url);
    if (response.status !== 200 || !response.data?.streams) {
      console.log(`❌ Torrentio returned ${response.status}`);
      return [];
    }

    console.log(`✓ Torrentio: ${response.data.streams.length} results`);
    
    // تحويل النتائج لـ magnet links
    return response.data.streams
      .filter(s => s.infoHash) // نتأكد إنه torrent
      .map(s => ({
        magnet: `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(s.title || '')}`,
        title: s.title || 'Unknown',
        quality: s.quality || '1080p',
        size: s.size || 0,
        source: 'torrentio',
        seeders: s.seeders || 0,
      }))
      .slice(0, 10); // أفضل 10 نتائج
  } catch (err) {
    console.error('Torrentio error:', err.message);
    return [];
  }
}

// ====== Torrentio Public Configs ======
const TORRENTIO_CONFIGS = [
  'https://torrentio.strem.fun/stream/movie/%s.json',
  'https://torrentio.strem.fun/stream/series/%s:%d:%d.json',
];

// ====== Real-Debrid: إضافة Magnet ======
async function rdAddMagnet(magnet) {
  try {
    const response = await fetchURL('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
      method: 'POST',
      body: `magnet=${encodeURIComponent(magnet)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (response.status === 200 || response.status === 201) {
      return response.data; // { id, uri }
    }
    console.error(`❌ RD addMagnet: ${response.status}`, response.data);
    return null;
  } catch (err) {
    console.error('RD addMagnet error:', err.message);
    return null;
  }
}

// ====== Real-Debrid: اختيار الملفات ======
async function rdSelectFiles(torrentId, files = 'all') {
  try {
    const response = await fetchURL(
      `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      {
        method: 'POST',
        body: `files=${files}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );
    return response.status === 200 || response.status === 204;
  } catch (err) {
    return false;
  }
}

// ====== Real-Debrid: معلومات Torrent ======
async function rdGetTorrentInfo(torrentId) {
  try {
    const response = await fetchURL(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`);
    return response.status === 200 ? response.data : null;
  } catch (err) {
    return null;
  }
}

// ====== Real-Debrid: انتظار حتى يكتمل ======
async function rdWaitForTorrent(torrentId, maxWaitMs = 180000) {
  const startTime = Date.now();
  const interval = 3000;

  while (Date.now() - startTime < maxWaitMs) {
    const info = await rdGetTorrentInfo(torrentId);
    if (info) {
      const status = info.status;
      console.log(`📊 RD Status: ${status} | Progress: ${(info.progress || 0).toFixed(0)}%`);
      
      if (status === 'downloaded') return info;
      if (status === 'waiting_files_selection') {
        // اختر كل الملفات تلقائياً
        await rdSelectFiles(torrentId, 'all');
        return info;
      }
      if (status === 'error' || status === 'magnet_error') {
        console.error(`❌ Torrent error: ${status}`);
        return null;
      }
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return null;
}

// ====== Real-Debrid: Unrestrict Link ======
async function rdUnrestrict(link) {
  try {
    const response = await fetchURL('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
      method: 'POST',
      body: `link=${encodeURIComponent(link)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (response.status === 200 || response.status === 201) {
      return response.data;
    }
    console.error(`❌ RD Unrestrict: ${response.status}`, response.data);
    return null;
  } catch (err) {
    return null;
  }
}

// ====== تقييم الجودة ======
function getQualityScore(title) {
  if (!title) return 50;
  const f = title.toLowerCase();
  if (f.includes('2160p') || f.includes('4k') || f.includes('uhd')) return 400;
  if (f.includes('1080p') || f.includes('fhd') || f.includes('bluray')) return 300;
  if (f.includes('720p')) return 200;
  if (f.includes('480p')) return 100;
  return 50;
}

// ====== API الرئيسي ======
app.get("/api/play", async (req, res) => {
  const { id, type, season, episode } = req.query;

  if (!id || !type) {
    return res.status(400).json({ success: false, error: "Missing id or type" });
  }

  try {
    // 1) TMDB metadata
    const meta = await getTMDBMeta(id, type);
    if (!meta) return res.status(404).json({ success: false, error: "TMDB not found" });

    const displayTitle = meta.title || meta.name || meta.original_title || meta.original_name;
    const year = (meta.release_date || meta.first_air_date || '').slice(0, 4);
    const poster = meta.poster_path ? `https://image.tmdb.org/t/p/w500${meta.poster_path}` : null;

    console.log(`\n🎬 ${displayTitle} (${year}) | ${type} S${season || 1}E${episode || 1}`);

    // 2) Torrentio: بحث عن torrents
    const torrents = await searchTorrentio(id, type, season, episode);

    if (torrents.length === 0) {
      return res.status(404).json({
        success: false,
        error: `لم يتم العثور على "${displayTitle}" في Torrentio`,
        title: displayTitle,
        year,
      });
    }

    // ترتيب حسب الجودة (الأعلى أولاً)
    torrents.sort((a, b) => getQualityScore(b.title) - getQualityScore(a.title));

    console.log(`📋 Trying ${torrents.length} torrents...`);

    // 3) جرب كل torrent مع RD
    for (let i = 0; i < Math.min(5, torrents.length); i++) {
      const torrent = torrents[i];
      console.log(`\n🔄 [${i + 1}] ${torrent.title.substring(0, 50)} (${torrent.quality})`);

      // إضافة لـ Real-Debrid
      const added = await rdAddMagnet(torrent.magnet);
      if (!added || !added.id) {
        console.log(`   ❌ Failed to add to RD`);
        continue;
      }

      console.log(`   ✓ Added to RD: ID ${added.id}`);

      // اختيار كل الملفات تلقائياً
      await rdSelectFiles(added.id, 'all');

      // انتظار التحميل
      const torrentInfo = await rdWaitForTorrent(added.id);
      if (!torrentInfo) {
        console.log(`   ❌ Download timeout`);
        continue;
      }

      console.log(`   ✓ Downloaded: ${torrentInfo.filename}`);

      // إيجاد رابط الملف
      const links = torrentInfo.links || [];
      if (links.length === 0) {
        console.log(`   ❌ No links found`);
        continue;
      }

      // Unrestrict أول ملف فيديو
      const unrestricted = await rdUnrestrict(links[0]);
      if (!unrestricted) {
        console.log(`   ❌ Unrestrict failed`);
        continue;
      }

      console.log(`   ✅ Got stream URL!`);

      return res.json({
        success: true,
        provider: `real-debrid+torrentio`,
        quality: torrent.quality,
        title: displayTitle,
        year,
        filename: torrentInfo.filename,
        stream_url: unrestricted.download,
        subtitles: [],
        size_mb: Math.round((torrent.size || 0) / 1024 / 1024),
        poster,
      });
    }

    // لو كل المحاولات فشلت
    return res.status(500).json({
      success: false,
      error: `فشل تحميل أي من ${torrents.length} torrents`,
      title: displayTitle,
    });

  } catch (err) {
    console.error("❌ Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ====== Health Check ======
app.get("/", (req, res) => {
  res.json({
    status: "✅ Real-Debrid + Torrentio API",
    version: "4.0",
    endpoints: {
      play: "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1",
    },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎬 Real-Debrid + Torrentio API v4.0 running on port ${PORT}`);
  console.log(`✅ RD Token: ${RD_TOKEN ? 'Loaded' : 'MISSING'}`);
});
