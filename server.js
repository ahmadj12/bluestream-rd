// server.js — Real-Debrid + OpenSubtitles (Arabic) + MySQL cache
// الإصدار 7.1: يبحث بطرق متعددة (مع وبدون S01E01) + يدعم الأفلام بدون year

const express = require("express");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const cache = require("./cache");

try {
  cache.initPool();
  cache.runMigrations().catch(err => console.warn('⚠️ Auto-migration skipped:', err.message));
} catch (err) {
  console.warn('⚠️ MySQL init failed (cache will be disabled):', err.message);
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const RD_TOKEN = process.env.RD_TOKEN;

if (!RD_TOKEN) {
  console.error("❌ خطأ: لم يتم تعيين RD_TOKEN");
  process.exit(1);
}

const TMDB_KEY = process.env.TMDB_KEY || "570589dd8a1dac1a24fc6f98c18d1e59";
const OS_API_KEY = process.env.OPENSUBTITLES_API_KEY || "p9i6HLoYyyJVPbVIBM5c9swo5MjqCV8I";
const OS_BASE = "https://api.opensubtitles.com/api/v1";

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const reqOpts = {
        method: options.method || 'GET',
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: { ...BROWSER_HEADERS, ...(options.headers || {}) },
        timeout: options.timeout || 15000,
      };
      delete reqOpts.headers['Accept-Encoding'];
      const req = lib.request(reqOpts, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, data }); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Request timeout')));
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    } catch (err) { reject(err); }
  });
}

async function getTMDBMeta(id, type) {
  try {
    const path = type === 'movie' ? 'movie' : 'tv';
    const url = `https://api.themoviedb.org/3/${path}/${id}?api_key=${TMDB_KEY}&language=en-US`;
    const response = await fetchURL(url, { timeout: 10000 });
    return response.status === 200 ? response.data : null;
  } catch { return null; }
}

function decodeHTMLEntities(text) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x2F;/g, '/').replace(/&#x27;/g, "'");
}

function parseSize(sizeStr) {
  if (!sizeStr) return 0;
  const m = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|TB)/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  const mult = { KB: 1024, MB: 1024*1024, GB: 1024*1024*1024, TB: 1024*1024*1024*1024 };
  return Math.round(v * (mult[u] || 0));
}

// =============================================================
// SOURCES
// =============================================================

async function searchTorrentDownloads(query) {
  try {
    const targetUrl = `https://www.torrentdownloads.pro/search/?search=${encodeURIComponent(query)}&s_cat=4&srt=seeds&pp=50&order=desc`;
    const response = await fetchURL(targetUrl, { timeout: 20000 });
    if (response.status !== 200) return [];
    const html = response.data;
    if (typeof html !== 'string' || !html.includes('grey_bar3')) return [];

    const results = [];
    const rowRegex = /<div\s+class="grey_bar3[^"]*">\s*<p>.*?<a\s+href="\/torrent\/(\d+)\/([^"#]+)"\s+title="View torrent info : ([^"]+)"\s*>\s*(?:\[P\]\s*)?([^<]+?)\s*<\/a>/gs;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const torrentId = match[1];
      const urlSlug = match[2];
      const titleAttr = decodeHTMLEntities(match[3]);
      const displayName = decodeHTMLEntities(match[4]);

      const rowStart = match.index;
      const rowEnd = html.indexOf('</div>', rowStart);
      const rowContent = html.substring(rowStart, rowEnd);
      const spans = [...rowContent.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(m => m[1]);
      const sizeSpan = spans.find(s => /\b(GB|MB|KB|TB)\b/i.test(s));
      const sizeStr = sizeSpan ? decodeHTMLEntities(sizeSpan).trim() : '';
      const size = parseSize(sizeStr);
      const numericSpans = spans.filter(s => /^\d+$/.test(s.trim()));
      const seeds = numericSpans.length >= 2 ? parseInt(numericSpans[numericSpans.length - 1]) : 0;

      const lower = displayName.toLowerCase();
      const lowerTitle = titleAttr.toLowerCase();
      const blacklist = [
        'soundtrack', '.mp3', 'kms', 'activator', 'crack', 'patch',
        'android game', 'iphone app', 'windows activator', 'office 20',
        'training', 'tutorial', 'udemy', 'coursera', 'lynda',
        'roots of the matrix', 'matrix of power', 'jordan maxwell',
        'threat matrix', 'animatrix', 'burly brawl',
        'iso', 'pal dvd5', 'ntsc', 'ratdvd', 'trylogia',
        'french hdrip', 'lektor', 'napisy', 'trilogie', 'reloaded french',
        'revolution french', 'french wmv9', 'matrix reaktywacja',
      ];
      if (blacklist.some(b => lower.includes(b) || lowerTitle.includes(b))) continue;

      results.push({
        name: displayName, title: titleAttr,
        url_path: `/torrent/${torrentId}/${urlSlug}`,
        quality: lower.includes('2160p') || lower.includes('4k') || lower.includes('uhd') ? '4K' :
                lower.includes('1080p') || lower.includes('fhd') || lower.includes('bluray') || lower.includes('blu-ray') ? '1080p' :
                lower.includes('720p') ? '720p' : lower.includes('480p') ? '480p' : '?',
        size, size_str: sizeStr, seeds, source: 'torrentdownloads',
      });
    }
    const seen = new Set();
    return results.filter(r => seen.has(r.url_path) ? false : (seen.add(r.url_path), true)).slice(0, 15);
  } catch { return []; }
}

async function searchYTS(query, year) {
  try {
    let url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=10&sort_by=seeds&order_by=desc`;
    if (year) url += `&year=${year}`;
    const response = await fetchURL(url, { timeout: 12000 });
    if (response.status !== 200 || !response.data?.data?.movies) return [];
    const results = [];
    for (const movie of response.data.data.movies) {
      for (const t of movie.torrents || []) {
        results.push({
          name: `${movie.title} ${movie.year} ${t.quality} ${t.type}`,
          title: `${movie.title} (${movie.year}) [${t.quality}]`,
          url_path: null,
          magnet: `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(movie.title + ' ' + t.quality)}&tr=udp://open.demonii.com:1337/announce&tr=udp://tracker.openbittorrent.com:80&tr=udp://tracker.coppersurfer.tk:6969&tr=udp://glotorrants.pw:6969/announce&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://torrent.gresille.org:80/announce&tr=udp://p4p.arenabg.com:1337&tr=udp://tracker.internetwarriors.net:1337`,
          quality: t.quality, size: parseInt(t.size_bytes || 0), size_str: t.size || '',
          seeds: parseInt(t.seeds || 0), source: 'yts',
        });
      }
    }
    return results;
  } catch { return []; }
}

async function search1337x(query) {
  try {
    const response = await fetchURL(`https://1337x.to/search/${encodeURIComponent(query)}/1/`, { timeout: 15000 });
    if (response.status !== 200) return [];
    const html = response.data;
    if (typeof html !== 'string') return [];
    const results = [];
    const linkRegex = /<a\s+href="\/torrent\/(\d+)\/([^"]+)"[^>]*>([^<]+)<\/a>/g;
    let match; const seen = new Set();
    while ((match = linkRegex.exec(html)) !== null) {
      const id = match[1];
      const name = decodeHTMLEntities(match[3]);
      if (seen.has(id)) continue;
      seen.add(id);
      const lower = name.toLowerCase();
      if (lower.includes('.mp3') || lower.includes('soundtrack') || lower.includes('kms') || lower.includes('crack')) continue;
      results.push({
        name, title: name, url_path: `/torrent/${id}/${match[2]}`,
        quality: lower.includes('2160p') || lower.includes('4k') ? '4K' : lower.includes('1080p') ? '1080p' : lower.includes('720p') ? '720p' : '?',
        size: 0, size_str: '', seeds: 0, source: '1337x',
      });
    }
    return results.slice(0, 10);
  } catch { return []; }
}

async function getMagnetFromTorrentPage(urlPath) {
  try {
    const targetUrl = urlPath.startsWith('http') ? urlPath : `https://www.torrentdownloads.pro${urlPath}`;
    const response = await fetchURL(targetUrl, { timeout: 15000 });
    if (response.status !== 200) return null;
    const html = response.data;
    if (typeof html !== 'string') return null;
    let m = html.match(/href="(magnet:\?xt=urn:btih:[a-fA-F0-9]{40}[^"<\s']*?)"/);
    if (m) return m[1];
    m = html.match(/(magnet:\?xt=urn:btih:[a-fA-F0-9]{40}[^"<\s']*)/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function getMagnetFrom1337xPage(urlPath) {
  try {
    const targetUrl = urlPath.startsWith('http') ? urlPath : `https://1337x.to${urlPath}`;
    const response = await fetchURL(targetUrl, { timeout: 15000 });
    if (response.status !== 200) return null;
    const html = response.data;
    if (typeof html !== 'string') return null;
    const m = html.match(/href="(magnet:\?xt=urn:btih:[a-fA-F0-9]{40}[^"<\s']*?)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function searchAllSources(query, type, year) {
  let tdResults = [], ytsResults = [], xResults = [];
  if (type === 'movie') {
    [tdResults, ytsResults] = await Promise.all([searchTorrentDownloads(query), searchYTS(query, year)]);
  } else {
    [tdResults, xResults] = await Promise.all([searchTorrentDownloads(query), search1337x(query)]);
  }
  const results = [...ytsResults, ...xResults, ...tdResults];
  if (results.length === 0) return [];
  const needMagnet = results.filter(r => !r.magnet && r.url_path);
  if (needMagnet.length > 0) {
    await Promise.all(needMagnet.map(async (t) => {
      const m = t.source === '1337x' ? await getMagnetFrom1337xPage(t.url_path) : await getMagnetFromTorrentPage(t.url_path);
      if (m) t.magnet = m;
    }));
  }
  return results.filter(t => t.magnet);
}

// 🔑 دالة محسّنة: تبحث بطرق متعددة (مع/بدون S01E01، مع/بدون year)
async function searchTorrentsMulti(displayTitle, type, sNum, eNum, year) {
  const queries = [];

  if (type === 'movie') {
    // أفلام: نجرّب عدة تركيبات
    queries.push(year ? `${displayTitle} ${year}` : displayTitle);
    queries.push(displayTitle);
    if (year) queries.push(`${displayTitle} ${parseInt(year) - 1} ${parseInt(year) + 1}`);
  } else {
    // مسلسلات: نجرّب مع وبدون S01E01
    const epTag = `S${String(sNum || 1).padStart(2, '0')}E${String(eNum || 1).padStart(2, '0')}`;
    queries.push(`${displayTitle} ${epTag}`);
    queries.push(`${displayTitle} S${sNum || 1}E${eNum || 1}`); // بدون padding
    queries.push(`${displayTitle} ${epTag} ${year || ""}`.trim());
    queries.push(displayTitle); // بدون S/E أبداً
  }

  let allTorrents = [];
  const seen = new Set();
  for (const q of queries) {
    if (!q || q.trim().length < 2) continue;
    console.log(`   🔍 جرّب: "${q}"`);
    const r = await searchAllSources(q, type, year);
    for (const t of r) {
      const key = t.magnet || t.url_path;
      if (key && !seen.has(key)) {
        seen.add(key);
        allTorrents.push(t);
      }
    }
    if (allTorrents.length >= 5) break; // عندنا كفاية
  }
  return allTorrents;
}

function getQualityScore(title) {
  if (!title) return 50;
  const f = title.toLowerCase();
  if (f.includes('2160p') || f.includes('4k') || f.includes('uhd')) return 400;
  if (f.includes('1080p') || f.includes('fhd') || f.includes('bluray') || f.includes('blu-ray')) return 300;
  if (f.includes('remux')) return 350;
  if (f.includes('720p') || f.includes('hdrip')) return 200;
  if (f.includes('480p') || f.includes('dvdrip')) return 100;
  if (f.includes('web-dl') || f.includes('webrip')) return 250;
  return 50;
}

// =============================================================
// REAL-DEBRID
// =============================================================

async function rdAddMagnet(magnet) {
  try {
    const response = await fetchURL('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
      method: 'POST',
      body: `magnet=${encodeURIComponent(magnet)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Bearer ${RD_TOKEN}` },
      timeout: 15000,
    });
    return (response.status === 200 || response.status === 201) ? response.data : null;
  } catch { return null; }
}

async function rdSelectFiles(torrentId, files = 'all') {
  try {
    const response = await fetchURL(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, {
      method: 'POST',
      body: `files=${files}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Bearer ${RD_TOKEN}` },
      timeout: 10000,
    });
    return response.status === 200 || response.status === 204;
  } catch { return false; }
}

async function rdGetTorrentInfo(torrentId) {
  try {
    const response = await fetchURL(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, {
      headers: { 'Authorization': `Bearer ${RD_TOKEN}` }, timeout: 10000,
    });
    return response.status === 200 ? response.data : null;
  } catch { return null; }
}

async function rdWaitForTorrent(torrentId, maxWaitMs = 240000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const info = await rdGetTorrentInfo(torrentId);
    if (info) {
      if (info.status === 'downloaded') return info;
      if (info.status === 'waiting_files_selection') await rdSelectFiles(torrentId, 'all');
      if (['error','magnet_error','virus','dead'].includes(info.status)) return null;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

async function rdUnrestrict(link) {
  try {
    const response = await fetchURL('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
      method: 'POST',
      body: `link=${encodeURIComponent(link)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Bearer ${RD_TOKEN}` },
      timeout: 15000,
    });
    return (response.status === 200 || response.status === 201) ? response.data : null;
  } catch { return null; }
}

// =============================================================
// OPENSUBTITLES
// =============================================================

async function searchOpenSubtitles({ tmdbId, type, season, episode, title, year }) {
  if (!OS_API_KEY) return null;
  try {
    let searchUrl;
    if (tmdbId) {
      const tmdbParam = type === 'movie'
        ? `tmdb_id=${tmdbId}`
        : `tmdb_id=${tmdbId}&season_number=${season || 1}&episode_number=${episode || 1}`;
      searchUrl = `${OS_BASE}/subtitles?${tmdbParam}&languages=ar&order_by=download_count&order_direction=desc`;
    } else if (title) {
      const query = encodeURIComponent(year ? `${title} ${year}` : title);
      searchUrl = `${OS_BASE}/subtitles?query=${query}&languages=ar&order_by=download_count&order_direction=desc`;
    } else {
      return null;
    }

    const searchRes = await fetchURL(searchUrl, {
      headers: {
        'Api-Key': OS_API_KEY,
        'User-Agent': 'BlueStream v1.0',
        'Accept': 'application/json',
      },
      timeout: 12000,
    });

    if (searchRes.status !== 200 || !searchRes.data?.data?.length) return null;

    const candidates = searchRes.data.data.filter(s => s.attributes?.language === 'ar');
    if (!candidates.length) return null;

    const top = candidates[0];
    const fileId = top.attributes?.files?.[0]?.file_id;
    if (!fileId) return null;

    const dlRes = await fetchURL(`${OS_BASE}/download`, {
      method: 'POST',
      headers: {
        'Api-Key': OS_API_KEY,
        'User-Agent': 'BlueStream v1.0',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ file_id: fileId, sub_format: 'srt' }),
      timeout: 15000,
    });

    if (dlRes.status !== 200 || !dlRes.data?.link) return null;

    const srtRes = await fetchURL(dlRes.data.link, { timeout: 15000 });
    if (srtRes.status !== 200 || !srtRes.data) return null;

    const srtContent = typeof srtRes.data === 'string' ? srtRes.data : String(srtRes.data);
    const srtBase64 = Buffer.from(srtContent, 'utf8').toString('base64');
    const dataUrl = `data:text/plain;charset=utf-8;base64,${srtBase64}`;

    return {
      url: dataUrl,
      language: 'ar',
      label: 'العربية',
      source: 'opensubtitles',
      release: top.attributes?.release || '',
    };
  } catch (err) {
    console.warn('OS error:', err.message);
    return null;
  }
}

// =============================================================
// CORE
// =============================================================

async function tryGetStream({ id, type, sNum, eNum, withSubs }) {
  // 1) Cache
  const cached = await cache.getCache(id, type, sNum, eNum);

  if (cached.hit && cached.fresh) {
    let subtitle = null;
    if (withSubs) {
      subtitle = await searchOpenSubtitles({
        tmdbId: parseInt(id), type, season: sNum, episode: eNum,
        title: cached.data.title, year: cached.data.year,
      });
    }
    return {
      success: true,
      provider: `real-debrid+${cached.data.source || 'cache'}`,
      quality: cached.data.quality,
      title: cached.data.title,
      year: cached.data.year,
      filename: cached.data.filename,
      stream_url: cached.data.stream_url,
      subtitle,
      subtitles: subtitle ? [subtitle.url] : [],
      size_mb: Math.round((cached.data.file_size_bytes || 0) / 1024 / 1024),
      seeds: cached.data.seeds || 0,
      poster: cached.data.poster_path ? `https://image.tmdb.org/t/p/w500${cached.data.poster_path}` : null,
      backdrop: cached.data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${cached.data.backdrop_path}` : null,
      cached: true,
    };
  }

  // 2) Re-unrestrict
  if (cached.hit && !cached.fresh && cached.data?.magnet) {
    try {
      let unrestricted = cached.data.rd_link ? await rdUnrestrict(cached.data.rd_link) : null;
      if (!unrestricted) {
        const added = await rdAddMagnet(cached.data.magnet);
        if (added?.id) {
          await rdSelectFiles(added.id, 'all');
          const info = await rdWaitForTorrent(added.id, 180000);
          if (info?.links?.length) unrestricted = await rdUnrestrict(info.links[0]);
        }
      }
      if (unrestricted?.download) {
        await cache.setCache({
          tmdb_id: parseInt(id), media_type: type, season: sNum, episode: eNum,
          title: cached.data.title, year: cached.data.year,
          stream_url: unrestricted.download,
          rd_torrent_id: cached.data.rd_torrent_id, rd_link: cached.data.rd_link,
          magnet: cached.data.magnet, source: cached.data.source, status: 'ready',
          file_size_bytes: cached.data.file_size_bytes, quality: cached.data.quality,
          filename: cached.data.filename, seeds: cached.data.seeds,
          poster_path: cached.data.poster_path, backdrop_path: cached.data.backdrop_path,
        });
        const subtitle = withSubs ? await searchOpenSubtitles({
          tmdbId: parseInt(id), type, season: sNum, episode: eNum,
          title: cached.data.title, year: cached.data.year,
        }) : null;
        return {
          success: true,
          provider: `real-debrid+${cached.data.source || 'cache'}`,
          quality: cached.data.quality,
          title: cached.data.title,
          stream_url: unrestricted.download,
          subtitle, subtitles: subtitle ? [subtitle.url] : [],
          poster: cached.data.poster_path ? `https://image.tmdb.org/t/p/w500${cached.data.poster_path}` : null,
          backdrop: cached.data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${cached.data.backdrop_path}` : null,
          cached: true, refreshed: true,
        };
      }
    } catch (err) { console.warn('re-unrestrict failed:', err.message); }
  }

  // 3) Fresh fetch
  const meta = await getTMDBMeta(id, type);
  if (!meta) return { success: false, error: "TMDB not found" };

  const displayTitle = meta.title || meta.name || meta.original_title || meta.original_name;
  const year = (meta.release_date || meta.first_air_date || '').slice(0, 4);
  const poster = meta.poster_path ? `https://image.tmdb.org/t/p/w500${meta.poster_path}` : null;
  const backdrop = meta.backdrop_path ? `https://image.tmdb.org/t/p/w1280${meta.backdrop_path}` : null;

  console.log(`\n🎬 ${displayTitle} (${year || "?"}) | ${type} S${sNum || 1}E${eNum || 1}`);

  // 🔑 البحث الذكي بطرق متعددة
  const torrents = await searchTorrentsMulti(displayTitle, type, sNum, eNum, year);

  if (torrents.length === 0) {
    return { success: false, error: `لم يتم العثور على "${displayTitle}" — جرب حلقة أو موسم ثاني` };
  }

  console.log(`📊 إجمالي النتائج: ${torrents.length} torrent`);

  torrents.sort((a, b) => (getQualityScore(b.name) + (b.seeds||0)*0.1) - (getQualityScore(a.name) + (a.seeds||0)*0.1));
  const maxAttempts = Math.min(5, torrents.length);

  for (let i = 0; i < maxAttempts; i++) {
    const torrent = torrents[i];
    console.log(`\n🔄 [${i + 1}/${maxAttempts}] ${torrent.name.substring(0, 60)}`);

    const added = await rdAddMagnet(torrent.magnet);
    if (!added?.id) continue;
    await rdSelectFiles(added.id, 'all');
    const torrentInfo = await rdWaitForTorrent(added.id);
    if (!torrentInfo) continue;
    const links = torrentInfo.links || [];
    if (links.length === 0) continue;

    let bestLink = links[0], bestSize = 0;
    if (torrentInfo.files && Array.isArray(torrentInfo.files) && links.length > 1) {
      for (let j = 0; j < Math.min(links.length, torrentInfo.files.length); j++) {
        const fs = torrentInfo.files[j]?.bytes || 0;
        if (fs > bestSize) { bestSize = fs; bestLink = links[j]; }
      }
    }

    const unrestricted = await rdUnrestrict(bestLink);
    if (!unrestricted) continue;
    console.log(`   ✅ Got stream URL!`);

    await cache.setCache({
      tmdb_id: parseInt(id), media_type: type, season: sNum, episode: eNum,
      title: displayTitle, year,
      original_title: meta.original_title || meta.original_name,
      overview: meta.overview, poster_path: meta.poster_path, backdrop_path: meta.backdrop_path,
      runtime: meta.runtime || (meta.episode_run_time?.[0]) || null,
      vote_average: meta.vote_average,
      genres: meta.genres?.map(g => g.name).join(', ') || null,
      rd_torrent_id: added.id, rd_link: bestLink,
      stream_url: unrestricted.download, filename: torrentInfo.filename,
      file_size_bytes: bestSize || torrent.size || 0, quality: torrent.quality,
      source: torrent.source, magnet: torrent.magnet, seeds: torrent.seeds || 0,
      status: 'ready',
    });

    const subtitle = withSubs ? await searchOpenSubtitles({
      tmdbId: parseInt(id), type, season: sNum, episode: eNum,
      title: displayTitle, year,
    }) : null;

    return {
      success: true,
      provider: `real-debrid+${torrent.source}`,
      quality: torrent.quality,
      title: displayTitle, year,
      filename: torrentInfo.filename,
      stream_url: unrestricted.download,
      subtitle,
      subtitles: subtitle ? [subtitle.url] : [],
      size_mb: Math.round((bestSize || torrent.size || 0) / 1024 / 1024),
      seeds: torrent.seeds || 0,
      poster, backdrop, cached: false,
    };
  }

  return { success: false, error: `فشل تحميل أي من ${torrents.length} torrents` };
}

// =============================================================
// ENDPOINTS
// =============================================================

app.get("/api/subtitles", async (req, res) => {
  const { tmdb_id, type, season, episode, title, year } = req.query;
  if (!tmdb_id && !title) {
    return res.status(400).json({ success: false, error: "Missing tmdb_id or title" });
  }
  try {
    const sub = await searchOpenSubtitles({
      tmdbId: tmdb_id ? parseInt(tmdb_id) : null,
      type, season, episode, title, year,
    });
    if (!sub) return res.json({ success: false, error: "no_subtitles_found" });
    res.json({ success: true, subtitle: sub });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/play", async (req, res) => {
  const { id, type, season, episode, with_subs = '1' } = req.query;
  if (!id || !type) return res.status(400).json({ success: false, error: "Missing id or type" });

  req.setTimeout(300000);
  res.setTimeout(300000);

  const sNum = type === 'tv' ? parseInt(season || 1) : null;
  const eNum = type === 'tv' ? parseInt(episode || 1) : null;

  try {
    const result = await tryGetStream({
      id, type, sNum, eNum,
      withSubs: with_subs === '1',
    });
    if (result.success) {
      return res.json(result);
    }
    return res.status(404).json(result);
  } catch (err) {
    console.error("❌ Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/cache/stats", async (req, res) => {
  try { res.json({ success: true, stats: await cache.getStats() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post("/api/cache/clean", async (req, res) => {
  try { res.json({ success: true, expired_marked: await cache.cleanExpired() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete("/api/cache/:tmdb_id/:type", async (req, res) => {
  try {
    const { tmdb_id, type } = req.params;
    const { season, episode } = req.query;
    const p = cache.initPool();
    const [result] = await p.execute(
      `DELETE FROM media_cache WHERE tmdb_id = ? AND media_type = ? AND season <=> ? AND episode <=> ?`,
      [parseInt(tmdb_id), type, season || null, episode || null]
    );
    res.json({ success: true, deleted: result.affectedRows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/", (req, res) => {
  res.json({
    status: "✅ Real-Debrid + Arabic Subtitles API v7.1",
    version: "7.1",
    features: ["multi-query search", "smart TV matching", "arabic subtitles"],
    endpoints: {
      play: "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1&with_subs=1",
      subtitles: "/api/subtitles?tmdb_id=...&type=movie&title=...",
    },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎬 BlueStream API v7.1 running on port ${PORT}`);
  console.log(`✅ RD Token: ${RD_TOKEN ? 'Loaded' : 'MISSING'}`);
  console.log(`✅ TMDB Key: ${TMDB_KEY ? 'Loaded' : 'MISSING'}`);
  console.log(`✅ OpenSubtitles: ${OS_API_KEY ? 'Loaded' : 'MISSING'}`);
});
