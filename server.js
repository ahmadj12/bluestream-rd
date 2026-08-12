const express = require("express");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

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
const CACHE_FILE = '/tmp/bluestream-cache.json';

if (!RD_TOKEN) {
  console.error("❌ خطأ: لم يتم تعيين RD_TOKEN");
  process.exit(1);
}

// ====== TMDB API ======
const TMDB_KEY = "570589dd8a1dac1a24fc6f98c18d1e59";

// ====== Cache System ======
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE));
    }
  } catch (e) {}
  return {};
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn('Cache save failed:', e.message);
  }
}

const memoryCache = loadCache();
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 أيام

// ====== Proxies ======
const PROXIES = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  (url) => `https://cors-anywhere.herokuapp.com/${url}`,
];

// ====== User-Agents ======
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
];

// ====== دالة طلب HTTP عامة مع User-Agent Rotation ======
function fetchURL(url, options = {}) {
  return new Promise(async (resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    for (const ua of USER_AGENTS) {
      try {
        const result = await new Promise((res, rej) => {
          const reqOpts = {
            method: options.method || 'GET',
            headers: {
              'Authorization': `Bearer ${RD_TOKEN}`,
              'User-Agent': ua,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Accept-Encoding': 'gzip, deflate',
              'Cache-Control': 'no-cache',
              ...(options.headers || {}),
            },
            timeout: 10000,
          };

          const req = protocol.request(url, reqOpts, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
              try {
                res({ status: res.statusCode, data: JSON.parse(data) });
              } catch (e) {
                res({ status: res.statusCode, data });
              }
            });
          });

          req.on('error', rej);
          req.on('timeout', () => req.destroy(rej));
          if (options.body) req.write(options.body);
          req.end();
        });

        if (result.status < 500) return resolve(result);
      } catch (err) {
        continue;
      }
    }
    reject(new Error('All User-Agents failed'));
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

// ====== TorrentDownloads - مع Proxy Rotation ======
async function searchTorrentDownloads(query) {
  const allResults = [];
  const seen = new Set();
  const queries = [
    query,
    query.replace(/:/g, ''),
    query.replace(/'/g, ''),
  ];

  for (const q of queries) {
    for (const proxyFn of PROXIES) {
      try {
        const targetUrl = `https://www.torrentdownloads.pro/search/?search=${encodeURIComponent(q)}&s_cat=4`;
        const proxyUrl = proxyFn(targetUrl);

        const response = await fetchURL(proxyUrl);
        if (response.status !== 200 || !response.data?.contents) continue;

        const html = response.data.contents;
        if (html.includes('Access Denied') || html.includes('Cloudflare') || html.length < 5000) continue;

        const torrentRegex = /<a\s+href="(\/torrent\/\d+\/[^"]+)"[^>]*>([^<]+)<\/a>/g;
        let match;
        while ((match = torrentRegex.exec(html)) !== null) {
          const torrentName = match[2].trim();
          const lower = torrentName.toLowerCase();
          if (lower.includes('.mp3') || lower.includes('soundtrack')) continue;
          if (lower.includes('kms') || lower.includes('activator')) continue;
          if (lower.includes('crack') || lower.includes('patch')) continue;
          if (lower.includes('game ') || lower.includes('android')) continue;

          const key = torrentName.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 30);
          if (seen.has(key)) continue;
          seen.add(key);

          allResults.push({
            name: torrentName,
            url_path: match[1],
            quality: lower.includes('1080p') ? '1080p' :
                    lower.includes('720p') ? '720p' :
                    lower.includes('2160p') || lower.includes('4k') ? '4K' : '480p',
            source: 'torrentdownloads',
            magnet: null,
          });
        }
        if (allResults.length >= 5) {
          console.log(`      ✓ Found ${allResults.length} from TD via proxy`);
          return allResults.slice(0, 10);
        }
      } catch (err) {
        continue;
      }
    }
  }
  console.log(`      ⚠️ Got ${allResults.length} from TD`);
  return allResults.slice(0, 10);
}

// ====== LimeTorrents ======
async function searchLimeTorrents(query) {
  for (const proxyFn of PROXIES) {
    try {
      const targetUrl = `https://www.limetorrents.info/search/all/${encodeURIComponent(query)}/`;
      const proxyUrl = proxyFn(targetUrl);
      const response = await fetchURL(proxyUrl);
      if (response.status !== 200 || !response.data?.contents) continue;

      const html = response.data.contents;
      const results = [];
      const torrentRegex = /<a\s+href="(\/torrent\/[^"]+)"[^>]*>([^<]+)<\/a>/g;
      let match;
      while ((match = torrentRegex.exec(html)) !== null) {
        const name = match[2].trim();
        const lower = name.toLowerCase();
        if (lower.includes('.mp3') || lower.includes('soundtrack')) continue;
        if (lower.includes('game') || lower.includes('android')) continue;
        results.push({
          name,
          url_path: match[1],
          quality: lower.includes('1080p') ? '1080p' :
                  lower.includes('720p') ? '720p' :
                  lower.includes('2160p') || lower.includes('4k') ? '4K' : '480p',
          source: 'limetorrents',
          magnet: null,
        });
      }
      if (results.length) {
        console.log(`      ✓ Got ${results.length} from LT`);
        return results.slice(0, 5);
      }
    } catch (err) {
      continue;
    }
  }
  return [];
}

// ====== 1337x ======
async function search1337x(query) {
  for (const proxyFn of PROXIES) {
    try {
      const targetUrl = `https://1337x.to/search/${encodeURIComponent(query)}/1/`;
      const proxyUrl = proxyFn(targetUrl);
      const response = await fetchURL(proxyUrl);
      if (response.status !== 200 || !response.data?.contents) continue;

      const html = response.data.contents;
      const results = [];
      const torrentRegex = /<a\s+href="\/torrent\/(\d+\/[^"]+)"[^>]*>([^<]+)<\/a>/g;
      let match;
      while ((match = torrentRegex.exec(html)) !== null) {
        const name = match[2].trim();
        if (name.toLowerCase().includes('game')) continue;
        results.push({
          name,
          url_path: `/torrent/${match[1]}`,
          quality: name.toLowerCase().includes('1080p') ? '1080p' :
                  name.toLowerCase().includes('720p') ? '720p' : '480p',
          source: '1337x',
          magnet: null,
        });
      }
      if (results.length) {
        console.log(`      ✓ Got ${results.length} from 1337x`);
        return results.slice(0, 5);
      }
    } catch (err) {
      continue;
    }
  }
  return [];
}

// ====== جلب Magnet من TorrentDownloads ======
async function getMagnetFromTorrentPage(urlPath) {
  for (const proxyFn of PROXIES) {
    try {
      const targetUrl = `https://www.torrentdownloads.pro${urlPath}`;
      const proxyUrl = proxyFn(targetUrl);
      const response = await fetchURL(proxyUrl);
      if (response.status !== 200) continue;
      const html = response.data?.contents || '';
      const match = html.match(/(magnet:\?xt=urn:btih:[a-fA-F0-9]{40}[^"<\s']*)/);
      if (match) return match[1];
    } catch (err) {
      continue;
    }
  }
  return null;
}

// ====== جلب Magnet من LimeTorrents ======
async function getMagnetFromLimeTorrent(urlPath) {
  for (const proxyFn of PROXIES) {
    try {
      const targetUrl = `https://www.limetorrents.info${urlPath}`;
      const proxyUrl = proxyFn(targetUrl);
      const response = await fetchURL(proxyUrl);
      if (response.status !== 200) continue;
      const html = response.data?.contents || '';
      const match = html.match(/(magnet:\?xt=urn:btih:[a-fA-F0-9]{40}[^"<\s']*)/);
      if (match) return match[1];
    } catch (err) {
      continue;
    }
  }
  return null;
}

// ====== جلب Magnet من 1337x ======
async function getMagnetFrom1337x(urlPath) {
  for (const proxyFn of PROXIES) {
    try {
      const targetUrl = `https://1337x.to${urlPath}`;
      const proxyUrl = proxyFn(targetUrl);
      const response = await fetchURL(proxyUrl);
      if (response.status !== 200) continue;
      const html = response.data?.contents || '';
      const match = html.match(/(magnet:\?xt=urn:btih:[a-fA-F0-9]{40}[^"<\s']*)/);
      if (match) return match[1];
    } catch (err) {
      continue;
    }
  }
  return null;
}

// ====== البحث الموحد ======
async function searchAllSources(query, type) {
  console.log(`🔍 Searching: "${query}"`);

  console.log('   → TorrentDownloads');
  const tdResults = await searchTorrentDownloads(query);

  console.log('   → LimeTorrents');
  const ltResults = await searchLimeTorrents(query);

  console.log('   → 1337x');
  const x1337Results = await search1337x(query);

  const allResults = [...tdResults, ...ltResults, ...x1337Results];

  if (allResults.length === 0) {
    console.log(`❌ No torrents found anywhere`);
    return [];
  }

  console.log(`📥 Fetching magnets for ${allResults.length} torrents...`);

  await Promise.all(allResults.map(async (torrent) => {
    let magnet = null;
    if (torrent.source === 'torrentdownloads') {
      magnet = await getMagnetFromTorrentPage(torrent.url_path);
    } else if (torrent.source === 'limetorrents') {
      magnet = await getMagnetFromLimeTorrent(torrent.url_path);
    } else if (torrent.source === '1337x') {
      magnet = await getMagnetFrom1337x(torrent.url_path);
    }
    if (magnet) {
      torrent.magnet = magnet;
      torrent.filename = torrent.name;
    }
  }));

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
    if (response.status === 200 || response.status === 201) return response.data;
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
    if (response.status === 200 || response.status === 201) return response.data;
    console.error(`❌ RD Unrestrict: ${response.status}`, response.data);
    return null;
  } catch (err) {
    return null;
  }
}

// ====== API الرئيسي مع Cache ======
app.get("/api/play", async (req, res) => {
  const { id, type, season, episode } = req.query;

  if (!id || !type) {
    return res.status(400).json({ success: false, error: "Missing id or type" });
  }

  const cacheKey = `${type}:${id}:${season || 1}:${episode || 1}`;

  // ====== Cache Hit: رد فوري ======
  if (memoryCache[cacheKey] && Date.now() - memoryCache[cacheKey].cachedAt < CACHE_DURATION) {
    console.log(`⚡ Cache hit: ${cacheKey}`);
    return res.json(memoryCache[cacheKey]);
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

    // 3) البحث في كل المصادر
    const torrents = await searchAllSources(searchQuery, type);

    if (torrents.length === 0) {
      return res.status(404).json({
        success: false,
        error: `لم يتم العثور على "${displayTitle}"`,
        title: displayTitle,
        year,
      });
    }

    // ترتيب حسب الجودة
    torrents.sort((a, b) => getQualityScore(b.name) - getQualityScore(a.name));

    console.log(`📋 Trying ${torrents.length} torrents...`);

    // 4) جرب كل torrent مع RD
    for (let i = 0; i < Math.min(3, torrents.length); i++) {
      const torrent = torrents[i];
      console.log(`\n🔄 [${i + 1}] ${torrent.name.substring(0, 60)}`);
      console.log(`   Magnet: ${torrent.magnet.substring(0, 60)}...`);

      const added = await rdAddMagnet(torrent.magnet);
      if (!added || !added.id) {
        console.log(`   ❌ Failed to add to RD`);
        continue;
      }

      console.log(`   ✓ Added to RD: ${added.id}`);

      await rdSelectFiles(added.id, 'all');

      const torrentInfo = await rdWaitForTorrent(added.id);
      if (!torrentInfo) {
        console.log(`   ❌ Download timeout`);
        continue;
      }

      console.log(`   ✓ Downloaded: ${torrentInfo.filename}`);

      const links = torrentInfo.links || [];
      if (links.length === 0) {
        console.log(`   ❌ No links found`);
        continue;
      }

      const unrestricted = await rdUnrestrict(links[0]);
      if (!unrestricted) {
        console.log(`   ❌ Unrestrict failed`);
        continue;
      }

      console.log(`   ✅ Got stream URL!`);

      const result = {
        success: true,
        provider: `real-debrid+multi`,
        quality: torrent.quality,
        title: displayTitle,
        year,
        filename: torrentInfo.filename,
        stream_url: unrestricted.download,
        subtitles: [],
        size_mb: Math.round((torrentInfo.filesize || 0) / 1024 / 1024),
        poster,
        cachedAt: Date.now(),
      };

      // حفظ في Cache
      memoryCache[cacheKey] = result;
      saveCache(memoryCache);
      console.log(`💾 Cached: ${cacheKey}`);

      return res.json(result);
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

// ====== Cache Stats Endpoint ======
app.get("/api/cache", (req, res) => {
  const entries = Object.keys(memoryCache);
  res.json({
    total: entries.length,
    entries: entries.slice(0, 20).map(key => ({
      key,
      title: memoryCache[key]?.title,
      quality: memoryCache[key]?.quality,
      cachedAt: memoryCache[key]?.cachedAt,
      ageHours: Math.round((Date.now() - memoryCache[key]?.cachedAt) / (1000 * 60 * 60)),
    })),
  });
});

// ====== Health Check ======
app.get("/", (req, res) => {
  res.json({
    status: "✅ Real-Debrid + Multi-Source Cache API",
    version: "5.0",
    features: ["caching", "multi-source-search", "proxy-rotation", "user-agent-rotation"],
    cacheEntries: Object.keys(memoryCache).length,
    endpoints: {
      play: "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1",
      cache: "/api/cache",
    },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎬 BlueStream RD + Cache API v5.0 running on port ${PORT}`);
  console.log(`✅ RD Token: ${RD_TOKEN ? 'Loaded' : 'MISSING'}`);
  console.log(`💾 Cache entries: ${Object.keys(memoryCache).length}`);
});
