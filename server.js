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
    // نستخدم en-US عشان نرجع English title (أهم للبحث في Torrents)
    const path = type === 'movie' ? 'movie' : 'tv';
    const url = `https://api.themoviedb.org/3/${path}/${id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=translations`;
    const response = await fetchURL(url);
    return response.status === 200 ? response.data : null;
  } catch (err) {
    return null;
  }
}

// ====== البحث في Real-Debrid ======
async function searchRD(query) {
  try {
    const url = `https://api.real-debrid.com/rest/1.0/torrents?search=${encodeURIComponent(query)}&limit=20`;
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
  if (!arabicTitle) return null;
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
    'صراع العروش': 'Game of Thrones',
    'الموتى': 'The Walking Dead',
    'العراب': 'The Godfather',
    'القائمة': 'The List',
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
    if (name.includes('.txt') || name.includes('.nfo')) return false;
    return /\.(mkv|mp4|avi|mov|webm)$/i.test(name);
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const scoreA = getQualityScore(a.path);
    const scoreB = getQualityScore(b.path);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return (b.bytes || 0) - (a.bytes || 0);
  });

  return candidates[0];
}

// ====== البحث الذكي عن Torrent ======
async function findTorrent(meta, type, season = null, episode = null) {
  if (!meta) return null;

  // ====== استخراج كل الأسماء الممكنة ======
  const originalTitle = (meta.original_title || meta.original_name || '').trim();
  const englishTitle = (meta.title || meta.name || '').trim(); // TMDB en-US
  const arabicTitle = ''; // ما نستخدمه - نفضل English للبحث

  // الأنمي: جرب الاسم الياباني
  const originalLanguage = meta.original_language || '';
  const isAnime = meta.genres?.some(g => g.id === 16) && originalLanguage === 'ja';

  const year = (meta.release_date || meta.first_air_date || '').slice(0, 4);

  // ====== بناء الاستعلامات ======
  const queries = [];
  const searchTerms = [];

  // 1. English title (الأولوية الأولى)
  if (originalTitle) searchTerms.push(originalTitle);
  if (englishTitle && englishTitle !== originalTitle) searchTerms.push(englishTitle);

  // 2. للأنمي: الاسم الياباني
  if (isAnime && originalTitle) {
    searchTerms.push(originalTitle);
  }

  // 3. أسماء إنجليزية محتملة من العربي
  if (arabicTitle) {
    const englishGuess = guessEnglishTitle(arabicTitle);
    if (englishGuess && !searchTerms.includes(englishGuess)) {
      searchTerms.push(englishGuess);
    }
  }

  // بناء الاستعلامات
  for (const term of searchTerms) {
    if (type === 'movie') {
      // أفلام: اسم + سنة
      if (year) queries.push(`${term} ${year}`);
      queries.push(term);
    } else {
      // مسلسل/أنمي: اسم + S01E01
      if (season && episode) {
        const s = String(season).padStart(2, '0');
        const e = String(episode).padStart(2, '0');
        queries.push(`${term} S${s}E${e}`);
        queries.push(`${term} ${season}x${episode}`);
      }
      if (year) queries.push(`${term} ${year}`);
      queries.push(term);
    }
  }

  console.log(`🔍 Will try ${queries.length} queries for: "${originalTitle || englishTitle}"`);

  // ====== تجربة كل الاستعلامات ======
  const allTorrents = [];
  for (const q of queries) {
    console.log(`   → "${q}"`);
    const results = await searchRD(q);
    if (results && results.length > 0) {
      console.log(`      Found ${results.length} results`);
      allTorrents.push(...results);
    }
  }

  // إزالة التكرار
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
  const titleLower = (originalTitle || englishTitle).toLowerCase();
  const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);

  for (const torrent of uniqueTorrents) {
    const filename = (torrent.filename || '').toLowerCase();
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

  // Fallback
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

async function waitForTorrent(torrentId, maxWaitMs = 120000) {
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
    // 1) جلب metadata من TMDB (بالإنجليزي)
    const meta = await getTMDBMeta(id, type);
    if (!meta) return res.status(404).json({ success: false, error: "TMDB not found" });

    const displayTitle = meta.title || meta.name || meta.original_title || meta.original_name;
    const year = (meta.release_date || meta.first_air_date || '').slice(0, 4);

    console.log(`\n🎬 ${displayTitle} (${year}) | ${type} S${season || 1}E${episode || 1}`);

    // 2) البحث في Real-Debrid (يستخدم original_title داخلياً)
    const found = await findTorrent(meta, type, season, episode);

    if (!found) {
      return res.status(404).json({
        success: false,
        error: `لم يتم العثور على "${displayTitle}"`,
        title: displayTitle,
        year,
      });
    }

    // 3) إضافة Magnet
    const magnetData = await addMagnet(found.magnet);
    if (!magnetData) return res.status(500).json({ success: false, error: "Failed to add magnet" });

    // 4) اختيار الملف
    await selectTorrentFile(magnetData.id, found.file.id);

    // 5) انتظار التحميل
    const torrentInfo = await waitForTorrent(magnetData.id);
    if (!torrentInfo) return res.status(500).json({ success: false, error: "Download timeout" });

    // 6) إيجاد رابط الملف
    const selectedFile = torrentInfo.files.find(f => f.id === found.file.id) || found.file;
    if (!selectedFile.links || selectedFile.links.length === 0) {
      return res.status(500).json({ success: false, error: "No links found" });
    }

    // 7) استخراج الرابط المباشر
    const unrestricted = await unrestrictLink(selectedFile.links[0]);
    if (!unrestricted) return res.status(500).json({ success: false, error: "Unrestrict failed" });

    return res.json({
      success: true,
      provider: 'real-debrid',
      quality: getQualityScore(found.torrent.filename) >= 300 ? '1080p' : '720p',
      title: displayTitle,
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
    version: "3.2",
    provider: "Real-Debrid + TMDB",
    endpoints: {
      play: "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1",
      metadata: "/api/metadata?id={tmdb_id}&type={movie|tv}",
    },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎬 Real-Debrid Scraper API v3.2 running on port ${PORT}`);
  console.log(`✅ Token: ${RD_TOKEN ? 'Loaded' : 'MISSING'}`);
});
