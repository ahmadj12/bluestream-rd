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

// ====== دالة طلب HTTP عامة ======
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
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// ====== TMDB API ======
const TMDB_KEY = "570589dd8a1dac1a24fc6f98c18d1e59";

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

// ====== YTS.mx (أفلام فقط) ======
async function searchYTS(query) {
  try {
    const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=10`;
    const response = await fetchURL(url);
    if (response.status !== 200 || !response.data?.data?.movies) return [];
    
    return response.data.data.movies.map(m => ({
      filename: `${m.title_long || m.title} ${m.year || ''} [${m.quality || '1080p'}]`,
      magnet: `magnet:?xt=urn:btih:${m.hash}`,
      quality: m.quality || '1080p',
      size_mb: m.size_mb || 0,
      source: 'yts',
    }));
  } catch (err) {
    console.warn('YTS error:', err.message);
    return [];
  }
}

// ====== 1337x عبر AllOrigins Scraper ======
async function search1337x(query) {
  try {
    const targetUrl = `https://1337x.to/search/${encodeURIComponent(query)}/1/`;
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
    
    const response = await fetchURL(proxyUrl);
    if (response.status !== 200 || !response.data?.contents) return [];
    
    const html = response.data.contents;
    const magnets = [];
    
    // البحث عن Magnet Links
    const magnetRegex = /href="(magnet:\?xt=urn:btih:[a-fA-F0-9]{40}[^"]*)"/g;
    let match;
    while ((match = magnetRegex.exec(html)) !== null) {
      magnets.push({
        filename: `1337x-result-${match[1].substring(20, 40)}`,
        magnet: match[1],
        source: '1337x',
      });
    }
    return magnets.slice(0, 10);
  } catch (err) {
    console.warn('1337x error:', err.message);
    return [];
  }
}

// ====== PirateBay عبر Scraper ======
async function searchPirateBay(query) {
  try {
    const targetUrl = `https://thepiratebay.org/search/${encodeURIComponent(query)}/1/99/0`;
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
    
    const response = await fetchURL(proxyUrl);
    if (response.status !== 200 || !response.data?.contents) return [];
    
    const html = response.data.contents;
    const magnets = [];
    
    const magnetRegex = /href="(magnet:\?xt=urn:btih:[a-fA-F0-9]{40}[^"]*)"/g;
    let match;
    while ((match = magnetRegex.exec(html)) !== null) {
      magnets.push({
        filename: `piratebay-result-${match[1].substring(20, 40)}`,
        magnet: match[1],
        source: 'piratebay',
      });
    }
    return magnets.slice(0, 10);
  } catch (err) {
    console.warn('PirateBay error:', err.message);
    return [];
  }
}

// ====== Real-Debrid Search ======
async function searchRD(query) {
  try {
    const url = `https://api.real-debrid.com/rest/1.0/torrents?search=${encodeURIComponent(query)}&limit=20`;
    const response = await fetchURL(url);
    if (response.status !== 200) return [];
    return (response.data || []).map(t => ({
      filename: t.filename,
      magnet: t.magnet,
      source: 'rd',
    }));
  } catch (err) {
    return [];
  }
}

// ====== تقييم الجودة ======
function getQualityScore(filename) {
  if (!filename) return 0;
  const f = filename.toLowerCase();
  if (f.includes('2160p') || f.includes('4k') || f.includes('uhd')) return 400;
  if (f.includes('1080p') || f.includes('fhd')) return 300;
  if (f.includes('720p')) return 200;
  if (f.includes('480p')) return 100;
  return 50;
}

// ====== البحث الشامل في كل المصادر ======
async function searchAllSources(query) {
  const results = [];
  
  console.log(`   → Searching: "${query}"`);
  
  // 1) YTS (أفلام فقط، سريع)
  const ytsResults = await searchYTS(query);
  if (ytsResults.length > 0) {
    console.log(`      ✓ YTS: ${ytsResults.length} results`);
    results.push(...ytsResults);
  }
  
  // 2) 1337x (مسلسلات + أنمي + أفلام)
  const x1337Results = await search1337x(query);
  if (x1337Results.length > 0) {
    console.log(`      ✓ 1337x: ${x1337Results.length} results`);
    results.push(...x1337Results);
  }
  
  // 3) PirateBay (backup)
  if (results.length < 3) {
    const pbResults = await searchPirateBay(query);
    if (pbResults.length > 0) {
      console.log(`      ✓ PirateBay: ${pbResults.length} results`);
      results.push(...pbResults);
    }
  }
  
  // 4) Real-Debrid (إذا RD عنده نتائج)
  if (results.length < 3) {
    const rdResults = await searchRD(query);
    if (rdResults.length > 0) {
      console.log(`      ✓ RD: ${rdResults.length} results`);
      results.push(...rdResults);
    }
  }
  
  return results;
}

// ====== البحث الذكي ======
async function findTorrent(meta, type, season = null, episode = null) {
  if (!meta) return null;

  const originalTitle = (meta.original_title || meta.original_name || '').trim();
  const englishTitle = (meta.title || meta.name || '').trim();
  const year = (meta.release_date || meta.first_air_date || '').slice(0, 4);

  const searchTerms = [];
  if (originalTitle) searchTerms.push(originalTitle);
  if (englishTitle && englishTitle !== originalTitle) searchTerms.push(englishTitle);

  console.log(`🔍 Searching ${searchTerms.length} terms`);

  const allTorrents = [];
  for (const term of searchTerms) {
    const searchQuery = type === 'movie' 
      ? (year ? `${term} ${year}` : term)
      : (season && episode 
          ? `${term} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
          : term);

    const sources = await searchAllSources(searchQuery);
    allTorrents.push(...sources);
  }

  console.log(`📊 Total: ${allTorrents.length} torrents from all sources`);

  if (allTorrents.length === 0) return null;

  // ترتيب: YTS أولاً (أفلام بجودة عالية)، ثم حسب الجودة
  allTorrents.sort((a, b) => {
    // YTS تحصل أولوية (جودة مضمونة)
    if (a.source === 'yts' && b.source !== 'yts') return -1;
    if (b.source === 'yts' && a.source !== 'yts') return 1;
    
    const qa = getQualityScore(a.filename);
    const qb = getQualityScore(b.filename);
    return qb - qa;
  });

  // نحتاج نتأكد من تطابق الاسم
  const titleLower = (originalTitle || englishTitle).toLowerCase();
  const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);

  for (const torrent of allTorrents) {
    // YTS نتأكد من تطابق العنوان من الـ filename
    const filename = (torrent.filename || '').toLowerCase();
    
    // للـ YTS نتأكد من تطابق السنة
    if (torrent.source === 'yts' && year) {
      if (!filename.includes(year)) continue;
    }
    
    const matchCount = titleWords.filter(word => filename.includes(word)).length;
    const matchRatio = titleWords.length > 0 ? matchCount / titleWords.length : 0;

    if (matchRatio >= 0.4 || torrent.source === 'yts') {
      console.log(`✅ Found: ${torrent.filename.substring(0, 60)} (${torrent.source})`);
      return { 
        torrent: { 
          filename: torrent.filename,
          magnet: torrent.magnet,
        }, 
        file: { 
          id: torrent.source === 'rd' ? 0 : 0,
          path: torrent.filename,
          bytes: (torrent.size_mb || 0) * 1024 * 1024,
        },
        magnet: torrent.magnet,
        source: torrent.source,
      };
    }
  }

  // Fallback: أول نتيجة
  const first = allTorrents[0];
  console.log(`⚠️ Fallback: ${first.filename} (${first.source})`);
  return { 
    torrent: { filename: first.filename, magnet: first.magnet }, 
    file: { id: 0, path: first.filename, bytes: 0 },
    magnet: first.magnet,
    source: first.source,
  };
}

// ====== RD Operations ======
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

async function waitForTorrent(torrentId, maxWaitMs = 180000) {
  const startTime = Date.now();
  const interval = 3000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetchURL(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`);
      if (response.status === 200) {
        const status = response.data.status;
        console.log(`📊 RD Status: ${status}`);
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
    // 1) جلب metadata من TMDB
    const meta = await getTMDBMeta(id, type);
    if (!meta) return res.status(404).json({ success: false, error: "TMDB not found" });

    const displayTitle = meta.title || meta.name || meta.original_title || meta.original_name;
    const year = (meta.release_date || meta.first_air_date || '').slice(0, 4);

    console.log(`\n🎬 ${displayTitle} (${year}) | ${type} S${season || 1}E${episode || 1}`);

    // 2) البحث في كل المصادر
    const found = await findTorrent(meta, type, season, episode);

    if (!found) {
      return res.status(404).json({
        success: false,
        error: `لم يتم العثور على "${displayTitle}" في أي مصدر`,
        title: displayTitle,
        year,
      });
    }

    console.log(`📥 Adding magnet to RD from ${found.source}...`);

    // 3) إضافة Magnet لـ Real-Debrid
    const magnetData = await addMagnet(found.magnet);
    if (!magnetData) return res.status(500).json({ success: false, error: "Failed to add magnet to RD" });

    // 4) اختيار الملف (إذا من RD يحتاج ID، غير ذلك تخطي)
    if (found.source === 'rd') {
      await selectTorrentFile(magnetData.id, found.file.id);
    }

    // 5) انتظار التحميل في RD
    const torrentInfo = await waitForTorrent(magnetData.id);
    if (!torrentInfo) return res.status(500).json({ success: false, error: "Download timeout" });

    // 6) إيجاد رابط الملف
    let downloadLink = null;
    
    if (found.source === 'rd') {
      // من RD torrents
      const selectedFile = torrentInfo.files.find(f => f.id === found.file.id) || torrentInfo.files[0];
      downloadLink = selectedFile?.links?.[0];
    } else {
      // من YTS/1337x → RD unrestrict مباشرة
      downloadLink = torrentInfo.links?.[0];
    }

    if (!downloadLink) {
      return res.status(500).json({ success: false, error: "No download links found" });
    }

    // 7) استخراج الرابط المباشر
    const unrestricted = await unrestrictLink(downloadLink);
    if (!unrestricted) return res.status(500).json({ success: false, error: "Unrestrict failed" });

    return res.json({
      success: true,
      provider: `real-debrid+${found.source}`,
      quality: getQualityScore(found.torrent.filename) >= 300 ? '1080p' : '720p',
      title: displayTitle,
      year,
      filename: found.torrent.filename,
      stream_url: unrestricted.download,
      subtitles: [],
      size_mb: Math.round((unrestricted.filesize || 0) / 1024 / 1024),
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
    status: "✅ Real-Debrid Scraper API v3.3",
    provider: "Real-Debrid + YTS + 1337x + PirateBay",
    endpoints: {
      play: "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1",
      metadata: "/api/metadata?id={tmdb_id}&type={movie|tv}",
    },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎬 Real-Debrid Scraper API v3.3 running on port ${PORT}`);
  console.log(`✅ Token: ${RD_TOKEN ? 'Loaded' : 'MISSING'}`);
});
