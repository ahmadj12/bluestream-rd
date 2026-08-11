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

// ====== TorrentDownloads.pro - Scraper ======
// ====== TorrentDownloads.pro - بحث متقدم ======
async function searchTorrentDownloads(query) {
  const allResults = [];
  const seen = new Set();
  
  // جرب عدة صيغ بحث
  const queries = [
    query,
    query.replace(/:/g, ''), // بدون :
    query.replace(/'/g, ''), // بدون '
  ];
  
  for (const q of queries) {
    try {
      const targetUrl = `https://www.torrentdownloads.pro/search/?search=${encodeURIComponent(q)}`;
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
      
      const response = await fetchURL(proxyUrl);
      if (response.status !== 200 || !response.data?.contents) continue;
      
      const html = response.data.contents;
      
      // البحث عن روابط الـ torrents
      const torrentRegex = /<a\s+href="(\/torrent\/\d+\/[^"]+)"[^>]*>([^<]+)<\/a>/g;
      let match;
      while ((match = torrentRegex.exec(html)) !== null) {
        const torrentName = match[2].trim();
        const lower = torrentName.toLowerCase();
        
        // فلترة المحتوى الغير مرغوب
        if (lower.includes('.mp3') || lower.includes('soundtrack')) continue;
        if (lower.includes('kms') || lower.includes('activator')) continue;
        if (lower.includes('crack') || lower.includes('patch')) continue;
        if (lower.includes('game ') || lower.includes('android')) continue;
        
        // تجنب التكرار
        const key = torrentName.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 30);
        if (seen.has(key)) continue;
        seen.add(key);
        
        allResults.push({
          name: torrentName,
          url_path: match[1],
          quality: lower.includes('1080p') ? '1080p' : 
                  lower.includes('720p') ? '720p' : 
                  lower.includes('2160p') || lower.includes('4k') ? '4K' : '480p',
          size: 0,
          source: 'torrentdownloads',
          magnet: null,
        });
      }
    } catch (err) {
      console.warn(`TD error for "${q}":`, err.message);
    }
  }
  
  console.log(`      ✓ Found ${allResults.length} unique torrents`);
  return allResults.slice(0, 10);
}

// ====== LimeTorrents (يعمل غالباً) ======
async function searchLimeTorrents(query) {
  try {
    const targetUrl = `https://www.limetorrents.info/search/all/${encodeURIComponent(query)}/`;
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
    
    const response = await fetchURL(proxyUrl);
    if (response.status !== 200 || !response.data?.contents) return [];
    
    const html = response.data.contents;
    const results = [];
    
    // LimeTorrents له magnet في صفحات التفاصيل
    const torrentRegex = /<a\s+href="(\/torrent\/[^"]+)"[^>]*>([^<]+)<\/a>/g;
    let match;
    while ((match = torrentRegex.exec(html)) !== null) {
      const torrentName = match[2].trim();
      const lower = torrentName.toLowerCase();
      
      if (lower.includes('.mp3') || lower.includes('soundtrack')) continue;
      if (lower.includes('game') || lower.includes('android')) continue;
      
      results.push({
        name: torrentName,
        url_path: match[1],
        quality: lower.includes('1080p') ? '1080p' : 
                lower.includes('720p') ? '720p' : 
                lower.includes('2160p') || lower.includes('4k') ? '4K' : '480p',
        size: 0,
        source: 'limetorrents',
        magnet: null,
      });
    }
    
    return results.slice(0, 5);
  } catch (err) {
    return [];
  }
}

// جلب magnet من LimeTorrents
async function getMagnetFromLimeTorrent(urlPath) {
  try {
    const targetUrl = `https://www.limetorrents.info${urlPath}`;
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
    
    const response = await fetchURL(proxyUrl);
    if (response.status !== 200 || !response.data?.contents) return null;
    
    const html = response.data.contents;
    const magnetMatch = html.match(/(magnet:\?xt=urn:btih:[a-fA-F0-9]{40}[^"<\s']*)/);
    return magnetMatch ? magnetMatch[1] : null;
  } catch (err) {
    return null;
  }
}

// ====== جلب magnet من صفحة تفاصيل torrent ======
async function getMagnetFromTorrentPage(urlPath) {
  try {
    const targetUrl = `https://www.torrentdownloads.pro${urlPath}`;
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
    
    const response = await fetchURL(proxyUrl);
    if (response.status !== 200 || !response.data?.contents) return null;
    
    const html = response.data.contents;
    
    // البحث عن magnet link في الـ HTML
    const magnetMatch = html.match(/(magnet:\?xt=urn:btih:[a-fA-F0-9]{40}[^"<\s']*)/);
    return magnetMatch ? magnetMatch[1] : null;
  } catch (err) {
    return null;
  }
}

// ====== البحث الموحد + جلب magnets بالتوازي ======
// ====== البحث الموحد + جلب magnets بالتوازي ======
async function searchAllSources(query, type) {
  console.log(`🔍 Searching: "${query}"`);
  
  // 1) torrentdownloads.pro (الأساسي)
  const tdResults = await searchTorrentDownloads(query);
  
  // 2) LimeTorrents (كمصدر إضافي)
  const ltResults = await searchLimeTorrents(query);
  
  const allResults = [...tdResults, ...ltResults];
  
  if (allResults.length === 0) {
    console.log(`❌ No torrents found`);
    return [];
  }
  
  // 3) جلب magnets لكل torrent
  console.log(`📥 Fetching magnets for ${allResults.length} torrents...`);
  
  const magnetPromises = allResults.map(async (torrent) => {
    let magnet = null;
    if (torrent.source === 'torrentdownloads') {
      magnet = await getMagnetFromTorrentPage(torrent.url_path);
    } else if (torrent.source === 'limetorrents') {
      magnet = await getMagnetFromLimeTorrent(torrent.url_path);
    }
    
    if (magnet) {
      torrent.magnet = magnet;
      torrent.filename = torrent.name;
    }
  });
  
  await Promise.all(magnetPromises);
  
  const withMagnets = allResults.filter(t => t.magnet);
  console.log(`📊 Got ${withMagnets.length} magnets`);
  
  return withMagnets;
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

// ====== RD: إضافة Magnet ======
async function rdAddMagnet(magnet) {
  try {
    const response = await fetchURL('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
      method: 'POST',
      body: `magnet=${encodeURIComponent(magnet)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (response.status === 200 || response.status === 201) {
      return response.data;
    }
    console.error(`❌ RD addMagnet: ${response.status}`, response.data);
    return null;
  } catch (err) {
    console.error('RD addMagnet error:', err.message);
    return null;
  }
}

// ====== RD: اختيار الملفات ======
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

// ====== RD: معلومات Torrent ======
async function rdGetTorrentInfo(torrentId) {
  try {
    const response = await fetchURL(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`);
    return response.status === 200 ? response.data : null;
  } catch (err) {
    return null;
  }
}

// ====== RD: انتظار حتى يكتمل التحميل ======
async function rdWaitForTorrent(torrentId, maxWaitMs = 300000) {
  const startTime = Date.now();
  const interval = 3000;

  while (Date.now() - startTime < maxWaitMs) {
    const info = await rdGetTorrentInfo(torrentId);
    if (info) {
      const status = info.status;
      console.log(`📊 RD: ${status} | ${(info.progress || 0).toFixed(0)}%`);
      
      if (status === 'downloaded') return info;
      if (status === 'waiting_files_selection') {
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

// ====== RD: Unrestrict Link ======
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

    // 2) بناء استعلام البحث
    let searchQuery;
    if (type === 'movie') {
      searchQuery = year ? `${displayTitle} ${year}` : displayTitle;
    } else {
      searchQuery = `${displayTitle} S${String(season || 1).padStart(2, '0')}E${String(episode || 1).padStart(2, '0')}`;
    }

    // 3) البحث في TorrentDownloads.pro
    const torrents = await searchAllSources(searchQuery, type);

    if (torrents.length === 0) {
      return res.status(404).json({
        success: false,
        error: `لم يتم العثور على "${displayTitle}"`,
        title: displayTitle,
        year,
      });
    }

    // ترتيب حسب الجودة (الأعلى أولاً)
    torrents.sort((a, b) => getQualityScore(b.name) - getQualityScore(a.name));

    console.log(`📋 Trying ${torrents.length} torrents...`);

    // 4) جرب كل torrent مع RD
    for (let i = 0; i < Math.min(3, torrents.length); i++) {
      const torrent = torrents[i];
      console.log(`\n🔄 [${i + 1}] ${torrent.name.substring(0, 60)}`);
      console.log(`   Magnet: ${torrent.magnet.substring(0, 60)}...`);

      // إضافة لـ Real-Debrid
      const added = await rdAddMagnet(torrent.magnet);
      if (!added || !added.id) {
        console.log(`   ❌ Failed to add to RD`);
        continue;
      }

      console.log(`   ✓ Added to RD: ${added.id}`);

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
        provider: `real-debrid+torrentdownloads`,
        quality: torrent.quality,
        title: displayTitle,
        year,
        filename: torrentInfo.filename,
        stream_url: unrestricted.download,
        subtitles: [],
        size_mb: Math.round((torrentInfo.filesize || 0) / 1024 / 1024),
        poster,
      });
    }

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
    status: "✅ Real-Debrid + TorrentDownloads API",
    version: "4.2",
    endpoints: {
      play: "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1",
    },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎬 RD + TorrentDownloads API v4.2 running on port ${PORT}`);
  console.log(`✅ RD Token: ${RD_TOKEN ? 'Loaded' : 'MISSING'}`);
});
