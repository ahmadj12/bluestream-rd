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

// ====== Real-Debrid Token ======
const RD_TOKEN = process.env.RD_TOKEN;

if (!RD_TOKEN) {
  console.error("❌ خطأ: لم يتم تعيين RD_TOKEN");
  process.exit(1);
}

// ====== دالة طلب HTTP ======
function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const reqOpts = {
      method: options.method || 'GET',
      headers: {
        'Authorization': `Bearer ${RD_TOKEN}`,
        'User-Agent': 'BlueStream/3.0',
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
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// ====== TMDB API ======
const TMDB_KEY = "570589dd8a1dac1a24fc6f98c18d1e59";

async function getTMDBMeta(id, type) {
  try {
    const path = type === 'movie' ? 'movie' : 'tv';
    const url = `https://api.themoviedb.org/3/${path}/${id}?api_key=${TMDB_KEY}&language=ar-SA`;
    const response = await fetchURL(url);
    return response.status === 200 ? response.data : null;
  } catch (err) {
    return null;
  }
}

// ====== البحث في Real-Debrid ======
async function searchRD(query) {
  try {
    const url = `https://api.real-debrid.com/rest/1.0/torrents?search=${encodeURIComponent(query)}&limit=10`;
    const response = await fetchURL(url);
    if (response.status !== 200) return [];
    return response.data || [];
  } catch (err) {
    return [];
  }
}

// ====== تقييم الجودة ======
function getQualityScore(filename) {
  const f = filename.toLowerCase();
  if (f.includes('2160p') || f.includes('4k') || f.includes('uhd')) return 400;
  if (f.includes('1080p') || f.includes('fhd')) return 300;
  if (f.includes('720p')) return 200;
  if (f.includes('480p')) return 100;
  return 50;
}

// ====== قاموس عربي → إنجليزي ======
function guessEnglishTitle(arabicTitle) {
  const dictionary = {
    'الماتريكس': 'The Matrix',
    'البداية': 'Inception',
    'بين النجوم': 'Interstellar',
    'الخلاص': 'The Avengers',
    'العمق': 'Avatar',
    'الأسود': 'Black Panther',
    'العنكبوت': 'Spider-Man',
    'البطل': 'Hero',
    'الفارس': 'The Dark Knight',
    'الحرب': 'War',
    'الزمن': 'Time',
    'الوعد': 'The Promise',
  };
  for (const [ar, en] of Object.entries(dictionary)) {
    if (arabicTitle.includes(ar)) return en;
  }
  return null;
}

// ====== اختيار أفضل ملف ======
function pickBestFile(torrent) {
  if (!torrent.files || torrent.files.length === 0) return null;

  let candidates = torrent.files.filter(f => {
    const name = (f.path || '').toLowerCase();
    if (name.includes('sample') || name.includes('trailer')) return false;
    if (name.includes('cam') || name.includes('ts')) return false;
    return /\.(mkv|mp4|avi|mov|webm)$/i.test(name);
  });

  if (candidates.length === 0) return null;

  // ترتيب حسب الجودة
  candidates.sort((a, b) => {
    const scoreA = getQualityScore(a.path);
    const scoreB = getQualityScore(b.path);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return (b.bytes || 0) - (a.bytes || 0);
  });

  return candidates[0];
}

// ====== البحث الذكي عن Torrent ======
async function findTorrent(title, year, type, season = null, episode = null) {
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  const titleNoYear = cleanTitle.replace(/\s*\(\d{4}\)\s*/g, '').trim();
  const titleLower = cleanTitle.toLowerCase();

  const queries = [];

  if (type === 'movie') {
    if (year) queries.push(`${cleanTitle} ${year}`);
    queries.push(cleanTitle);
    if (year) queries.push(`${titleNoYear} ${year}`);
    const englishGuess = guessEnglishTitle(cleanTitle);
    if (englishGuess && englishGuess !== cleanTitle) {
      queries.push(`${englishGuess} ${year}`);
      queries.push(englishGuess);
    }
  } else {
    if (season && episode) {
      const s = String(season).padStart(2, '0');
      const e = String(episode).padStart(2, '0');
      queries.push(`${cleanTitle} S${s}E${e}`);
      queries.push(`${cleanTitle} ${season}x${episode}`);
      queries.push(`${titleNoYear} S${s}E${e}`);
    }
    if (year) queries.push(`${cleanTitle} ${year}`);
    queries.push(cleanTitle);
  }

  console.log(`🔍 Will try ${queries.length} queries`);

  const allTorrents = [];
  for (const q of queries) {
    console.log(`   → "${q}"`);
    const results = await searchRD(q);
    if (results && results.length > 0) {
      allTorrents.push(...results);
    }
  }

  const uniqueTorrents = Array.from(
    new Map(allTorrents.map(t => [t.id || t.hash, t])).values()
  );

  console.log(`📊 Total unique torrents: ${uniqueTorrents.length}`);

  if (uniqueTorrents.length === 0) return null;

  // ترتيب حسب الجودة
  uniqueTorrents.sort((a, b) => {
    const qualityA = getQualityScore(a.filename || '');
    const qualityB = getQualityScore(b.filename || '');
    return qualityB - qualityA;
  });

  // تجربة كل torrent
  for (const torrent of uniqueTorrents) {
    const filename = (torrent.filename || '').toLowerCase();
    const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);
    
    const matchCount = titleWords.filter(word => filename.includes(word)).length;
    const matchRatio = titleWords.length > 0 ? matchCount / titleWords.length : 0;

    if (matchRatio >= 0.5) {
      const file = pickBestFile(torrent);
      if (file) {
        console.log(`✅ Match: ${torrent.filename} (${Math.round(matchRatio * 100)}%)`);
        return { torrent, file, magnet: torrent.magnet };
      }
    }
  }

  // Fallback: أول نتيجة
  const firstTorrent = uniqueTorrents[0];
  const firstFile = pickBestFile(firstTorrent);
  if (firstFile) {
    console.log(`⚠️ Fallback: ${firstTorrent.filename}`);
    return { torrent: firstTorrent, file: firstFile, magnet: firstTorrent.magnet };
  }

  return null;
}

// ====== RD API calls ======
async function addMagnet(magnet) {
  try {
    const response = await fetchURL('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { magnet },
    });
    return (response.status === 200 || response.status === 201) ? response.data : null;
  } catch (err) {
    return null;
  }
}

async function selectTorrentFile(torrentId, fileId) {
  try {
    const response = await fetchURL(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { files: [fileId] },
    });
    return response.status === 200 || response.status === 204;
  } catch (err) {
    return false;
  }
}

async function waitForTorrent(torrentId, maxWaitMs = 90000) {
  const startTime = Date.now();
  const interval = 3000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetchURL(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`);
      if (response.status === 200) {
        const status = response.data.status;
        console.log(`📊 Status: ${status}`);
        if (status === 'downloaded' || status === 'waiting_files_selection') {
          return response.data;
        }
        if (status === 'error' || status === 'magnet_error') return null;
      }
    } catch (err) {}
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return null;
}

async function unrestrictLink(link) {
  try {
    const response = await fetchURL('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { link },
    });
    return (response.status === 200 || response.status === 201) ? response.data : null;
  } catch (err) {
    return null;
  }
}

// ====== API: تشغيل ======
app.get("/api/play", async (req, res) => {
  const { id, type, season, episode } = req.query;

  if (!id || !type) {
    return res.status(400).json({ success: false, error: "Missing id or type" });
  }

  try {
    const meta = await getTMDBMeta(id, type);
    if (!meta) return res.status(404).json({ success: false, error: "TMDB not found" });

    const title = meta.title || meta.name || meta.original_title || meta.original_name;
    const year = (meta.release_date || meta.first_air_date || '').slice(0, 4);

    console.log(`\n🎬 ${title} (${year}) | ${type} S${season || 1}E${episode || 1}`);

    const found = await findTorrent(title, year, type, season, episode);
    
    if (!found) {
      return res.status(404).json({
        success: false,
        error: `لم يتم العثور على "${title}"`,
        title,
        year,
      });
    }

    const magnetData = await addMagnet(found.magnet);
    if (!magnetData) return res.status(500).json({ success: false, error: "Failed to add magnet" });

    await selectTorrentFile(magnetData.id, found.file.id);

    const torrentInfo = await waitForTorrent(magnetData.id);
    if (!torrentInfo) return res.status(500).json({ success: false, error: "Download timeout" });

    const selectedFile = torrentInfo.files.find(f => f.id === found.file.id) || found.file;
    if (!selectedFile.links || selectedFile.links.length === 0) {
      return res.status(500).json({ success: false, error: "No links found" });
    }

    const unrestricted = await unrestrictLink(selectedFile.links[0]);
    if (!unrestricted) return res.status(500).json({ success: false, error: "Unrestrict failed" });

    return res.json({
      success: true,
      provider: 'real-debrid',
      quality: getQualityScore(found.torrent.filename) >= 300 ? '1080p' : '720p',
      title,
      year,
      filename: found.torrent.filename,
      stream_url: unrestricted.download,
      subtitles: [],
      size_mb: Math.round((selectedFile.bytes || 0) / 1024 / 1024),
      poster: meta.poster_path ? `https://image.tmdb.org/t/p/w500${meta.poster_path}` : null,
    });

  } catch (err) {
    console.error("❌ Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ====== API: Metadata ======
app.get("/api/metadata", async (req, res) => {
  const { id, type } = req.query;
  if (!id || !type) return res.status(400).json({ success: false, error: "Missing id or type" });
  const meta = await getTMDBMeta(id, type);
  if (!meta) return res.status(404).json({ success: false, error: "Not found" });
  return res.json({ success: true, ...meta });
});

// ====== Health Check ======
app.get("/", (req, res) => {
  res.json({
    status: "✅ Real-Debrid Scraper API",
    version: "3.1",
    endpoints: {
      play: "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1",
      metadata: "/api/metadata?id={tmdb_id}&type={movie|tv}",
    },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎬 Real-Debrid Scraper API v3.1 running on port ${PORT}`);
  console.log(`✅ Token: ${RD_TOKEN ? 'Loaded' : 'MISSING'}`);
});
