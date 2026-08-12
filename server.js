const express = require("express");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const cache = require("./cache");

// Initialize MySQL connection pool on startup
try {
  cache.initPool();
  // Auto-create tables on first run
  cache.runMigrations().catch(err => console.warn('⚠️ Auto-migration skipped:', err.message));
} catch (err) {
  console.warn('⚠️ MySQL init failed (cache will be disabled):', err.message);
}

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

const PORT = process.env.PORT || 3000;
const RD_TOKEN = process.env.RD_TOKEN;

if (!RD_TOKEN) {
  console.error("❌ خطأ: لم يتم تعيين RD_TOKEN");
  process.exit(1);
}

// ====== TMDB API ======
const TMDB_KEY = process.env.TMDB_KEY || "570589dd8a1dac1a24fc6f98c18d1e59";

// ====== Browser-like headers ======
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

// ====== Generic HTTP request (HTTPS direct, no proxy) ======
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
        headers: {
          ...BROWSER_HEADERS,
          ...(options.headers || {}),
        },
        timeout: options.timeout || 15000,
      };

      // Remove Accept-Encoding so we get plain text; we'll handle gzip manually if needed
      delete reqOpts.headers['Accept-Encoding'];

      const req = lib.request(reqOpts, (res) => {
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

      req.on('timeout', () => {
        req.destroy(new Error('Request timeout'));
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ====== TMDB metadata ======
async function getTMDBMeta(id, type) {
  try {
    const path = type === 'movie' ? 'movie' : 'tv';
    const url = `https://api.themoviedb.org/3/${path}/${id}?api_key=${TMDB_KEY}&language=en-US`;
    const response = await fetchURL(url, { timeout: 10000 });
    return response.status === 200 ? response.data : null;
  } catch (err) {
    console.error('TMDB error:', err.message);
    return null;
  }
}

// ====== Decompose HTML entities (for clean display) ======
function decodeHTMLEntities(text) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'");
}

// ====== Parse size string (e.g. "1.86 GB", "700.29 MB") ======
function parseSize(sizeStr) {
  if (!sizeStr) return 0;
  const match = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|TB)/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers = { KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024, TB: 1024 * 1024 * 1024 * 1024 };
  return Math.round(value * (multipliers[unit] || 0));
}

// ====== Source 1: TorrentDownloads.pro (DIRECT, no proxy) ======
async function searchTorrentDownloads(query) {
  try {
    // Try multiple sort options for better results
    const targetUrl = `https://www.torrentdownloads.pro/search/?search=${encodeURIComponent(query)}&s_cat=4&srt=seeds&pp=50&order=desc`;
    console.log(`   → TorrentDownloads (direct)`);
    const response = await fetchURL(targetUrl, { timeout: 20000 });
    if (response.status !== 200) {
      console.warn(`   ⚠ TD returned status ${response.status}`);
      return [];
    }

    const html = response.data;
    if (typeof html !== 'string' || !html.includes('grey_bar3')) return [];

    const results = [];

    // Match each torrent row in the search results table
    // Structure: <div class="grey_bar3">...<a href="/torrent/ID/SLUG" title="...">NAME</a>...<span>SIZE</span>...</div>
    const rowRegex = /<div\s+class="grey_bar3[^"]*">\s*<p>.*?<a\s+href="\/torrent\/(\d+)\/([^"#]+)"\s+title="View torrent info : ([^"]+)"\s*>\s*(?:\[P\]\s*)?([^<]+?)\s*<\/a>/gs;

    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const torrentId = match[1];
      const urlSlug = match[2];
      const titleAttr = decodeHTMLEntities(match[3]);
      const displayName = decodeHTMLEntities(match[4]);

      // Extract size + seeds from the row's <span> elements
      const rowStart = match.index;
      const rowEnd = html.indexOf('</div>', rowStart);
      const rowContent = html.substring(rowStart, rowEnd);
      const spans = [...rowContent.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(m => m[1]);

      // Size span: contains GB/MB/KB/TB
      const sizeSpan = spans.find(s => /\b(GB|MB|KB|TB)\b/i.test(s));
      const sizeStr = sizeSpan ? decodeHTMLEntities(sizeSpan).trim() : '';
      const size = parseSize(sizeStr);

      // Seeds: numeric span after leech (the second numeric span, typically the last pure-number one)
      const numericSpans = spans.filter(s => /^\d+$/.test(s.trim()));
      const seeds = numericSpans.length >= 2 ? parseInt(numericSpans[numericSpans.length - 1]) : 0;

      const lower = displayName.toLowerCase();
      const lowerTitle = titleAttr.toLowerCase();

      // Filtering rules
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

      let skip = false;
      for (const term of blacklist) {
        if (lower.includes(term) || lowerTitle.includes(term)) {
          skip = true;
          break;
        }
      }
      if (skip) continue;

      // Bonus: prefer torrents with the year
      const hasYear = /\b(199[0-9]|20[0-2][0-9])\b/.test(lower);

      results.push({
        name: displayName,
        title: titleAttr,
        url_path: `/torrent/${torrentId}/${urlSlug}`,
        quality: lower.includes('2160p') || lower.includes('4k') || lower.includes('uhd') ? '4K' :
                lower.includes('1080p') || lower.includes('fhd') || lower.includes('bluray') || lower.includes('blu-ray') ? '1080p' :
                lower.includes('720p') ? '720p' :
                lower.includes('480p') ? '480p' : '?',
        size,
        size_str: sizeStr,
        seeds,
        source: 'torrentdownloads',
      });
    }

    // Dedupe by torrent ID
    const seen = new Set();
    const deduped = results.filter(r => {
      if (seen.has(r.url_path)) return false;
      seen.add(r.url_path);
      return true;
    });

    console.log(`      ✓ Found ${deduped.length} relevant torrents (raw: ${results.length})`);
    return deduped.slice(0, 15);
  } catch (err) {
    console.warn('TorrentDownloads search error:', err.message);
    return [];
  }
}

// ====== Source 2: YTS.mx (for movies - direct API) ======
async function searchYTS(query, year) {
  try {
    let url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=10&sort_by=seeds&order_by=desc`;
    if (year) url += `&year=${year}`;
    console.log(`   → YTS.mx`);
    const response = await fetchURL(url, { timeout: 12000 });
    if (response.status !== 200 || !response.data?.data?.movies) return [];
    const movies = response.data.data.movies || [];
    const results = [];
    for (const movie of movies) {
      for (const t of movie.torrents || []) {
        results.push({
          name: `${movie.title} ${movie.year} ${t.quality} ${t.type}`,
          title: `${movie.title} (${movie.year}) [${t.quality}]`,
          url_path: null,
          magnet: `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(movie.title + ' ' + t.quality)}&tr=udp://open.demonii.com:1337/announce&tr=udp://tracker.openbittorrent.com:80&tr=udp://tracker.coppersurfer.tk:6969&tr=udp://glotorrents.pw:6969/announce&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://torrent.gresille.org:80/announce&tr=udp://p4p.arenabg.com:1337&tr=udp://tracker.internetwarriors.net:1337`,
          quality: t.quality,
          size: parseInt(t.size_bytes || 0),
          size_str: t.size || '',
          seeds: parseInt(t.seeds || 0),
          source: 'yts',
        });
      }
    }
    console.log(`      ✓ Found ${results.length} YTS torrents`);
    return results;
  } catch (err) {
    console.warn('YTS search error:', err.message);
    return [];
  }
}

// ====== Source 3: 1337x.to via scrape (no proxy) ======
async function search1337x(query) {
  try {
    const targetUrl = `https://1337x.to/search/${encodeURIComponent(query)}/1/`;
    console.log(`   → 1337x.to (direct)`);
    const response = await fetchURL(targetUrl, { timeout: 15000 });
    if (response.status !== 200) return [];
    const html = response.data;
    if (typeof html !== 'string') return [];

    const results = [];
    // Match /torrent/ID/NAME patterns from search results
    const linkRegex = /<a\s+href="\/torrent\/(\d+)\/([^"]+)"[^>]*>([^<]+)<\/a>/g;
    let match;
    const seen = new Set();
    while ((match = linkRegex.exec(html)) !== null) {
      const id = match[1];
      const name = decodeHTMLEntities(match[3]);
      if (seen.has(id)) continue;
      seen.add(id);

      const lower = name.toLowerCase();
      if (lower.includes('.mp3') || lower.includes('soundtrack')) continue;
      if (lower.includes('kms') || lower.includes('activator')) continue;
      if (lower.includes('crack') || lower.includes('patch')) continue;

      results.push({
        name,
        title: name,
        url_path: `/torrent/${id}/${match[2]}`,
        quality: lower.includes('2160p') || lower.includes('4k') ? '4K' :
                lower.includes('1080p') ? '1080p' :
                lower.includes('720p') ? '720p' : '?',
        size: 0,
        size_str: '',
        seeds: 0,
        source: '1337x',
      });
    }
    console.log(`      ✓ Found ${results.length} 1337x torrents`);
    return results.slice(0, 10);
  } catch (err) {
    console.warn('1337x search error:', err.message);
    return [];
  }
}

// ====== Get magnet from torrent detail page (DIRECT) ======
async function getMagnetFromTorrentPage(urlPath) {
  try {
    const targetUrl = urlPath.startsWith('http') ? urlPath : `https://www.torrentdownloads.pro${urlPath}`;
    console.log(`      → Fetching magnet page: ${targetUrl.substring(0, 80)}...`);
    const response = await fetchURL(targetUrl, { timeout: 15000 });
    if (response.status !== 200) return null;
    const html = response.data;
    if (typeof html !== 'string') return null;

    // Pattern 1: explicit magnet link in <a href="magnet:...">
    let magnetMatch = html.match(/href="(magnet:\?xt=urn:btih:[a-fA-F0-9]{40}[^"<\s']*?)"/);
    if (magnetMatch) return magnetMatch[1];

    // Pattern 2: raw magnet link in the HTML
    magnetMatch = html.match(/(magnet:\?xt=urn:btih:[a-fA-F0-9]{40}[^"<\s']*)/);
    if (magnetMatch) return magnetMatch[1];

    return null;
  } catch (err) {
    return null;
  }
}

async function getMagnetFrom1337xPage(urlPath) {
  try {
    const targetUrl = urlPath.startsWith('http') ? urlPath : `https://1337x.to${urlPath}`;
    const response = await fetchURL(targetUrl, { timeout: 15000 });
    if (response.status !== 200) return null;
    const html = response.data;
    if (typeof html !== 'string') return null;
    const magnetMatch = html.match(/href="(magnet:\?xt=urn:btih:[a-fA-F0-9]{40}[^"<\s']*?)"/);
    return magnetMatch ? magnetMatch[1] : null;
  } catch (err) {
    return null;
  }
}

// ====== Unified search: tries multiple sources in parallel ======
async function searchAllSources(query, type, year) {
  console.log(`🔍 Searching: "${query}" (${type})`);

  let tdResults = [];
  let ytsResults = [];
  let xResults = [];

  if (type === 'movie') {
    // For movies: TD + YTS in parallel
    [tdResults, ytsResults] = await Promise.all([
      searchTorrentDownloads(query),
      searchYTS(query, year),
    ]);
  } else {
    // For TV: TD + 1337x in parallel
    [tdResults, xResults] = await Promise.all([
      searchTorrentDownloads(query),
      search1337x(query),
    ]);
  }

  // Combine: YTS/1337x already have magnets; TD needs fetching
  const results = [...ytsResults, ...xResults, ...tdResults];

  if (results.length === 0) {
    console.log(`❌ No torrents found anywhere`);
    return [];
  }

  // For TD results, fetch magnets in parallel
  const needMagnet = results.filter(r => !r.magnet && r.url_path);
  if (needMagnet.length > 0) {
    console.log(`📥 Fetching magnets for ${needMagnet.length} torrents...`);
    const magnetPromises = needMagnet.map(async (torrent) => {
      const magnet = torrent.source === '1337x'
        ? await getMagnetFrom1337xPage(torrent.url_path)
        : await getMagnetFromTorrentPage(torrent.url_path);
      if (magnet) {
        torrent.magnet = magnet;
        return true;
      }
      return false;
    });
    await Promise.all(magnetPromises);
  }

  const withMagnets = results.filter(t => t.magnet);
  console.log(`📊 Got ${withMagnets.length} magnets total`);
  return withMagnets;
}

// ====== Quality score for sorting ======
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

// ====== RD: Add Magnet ======
async function rdAddMagnet(magnet) {
  try {
    const response = await fetchURL('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
      method: 'POST',
      body: `magnet=${encodeURIComponent(magnet)}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${RD_TOKEN}`,
      },
      timeout: 15000,
    });
    if (response.status === 200 || response.status === 201) return response.data;
    console.error(`❌ RD addMagnet: ${response.status}`, response.data);
    return null;
  } catch (err) {
    console.error('RD addMagnet error:', err.message);
    return null;
  }
}

async function rdSelectFiles(torrentId, files = 'all') {
  try {
    const response = await fetchURL(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, {
      method: 'POST',
      body: `files=${files}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${RD_TOKEN}`,
      },
      timeout: 10000,
    });
    return response.status === 200 || response.status === 204;
  } catch (err) {
    return false;
  }
}

async function rdGetTorrentInfo(torrentId) {
  try {
    const response = await fetchURL(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, {
      headers: { 'Authorization': `Bearer ${RD_TOKEN}` },
      timeout: 10000,
    });
    return response.status === 200 ? response.data : null;
  } catch (err) {
    return null;
  }
}

async function rdWaitForTorrent(torrentId, maxWaitMs = 240000) {
  const startTime = Date.now();
  const interval = 3000;
  while (Date.now() - startTime < maxWaitMs) {
    const info = await rdGetTorrentInfo(torrentId);
    if (info) {
      const status = info.status;
      const progress = (info.progress || 0).toFixed(0);
      console.log(`   📊 RD: ${status} | ${progress}%`);
      if (status === 'downloaded') return info;
      if (status === 'waiting_files_selection') {
        await rdSelectFiles(torrentId, 'all');
        // Don't return; let next poll check status
      }
      if (status === 'error' || status === 'magnet_error' || status === 'virus' || status === 'dead') {
        console.error(`   ❌ Torrent error: ${status}`);
        return null;
      }
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return null;
}

async function rdUnrestrict(link) {
  try {
    const response = await fetchURL('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
      method: 'POST',
      body: `link=${encodeURIComponent(link)}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${RD_TOKEN}`,
      },
      timeout: 15000,
    });
    if (response.status === 200 || response.status === 201) return response.data;
    console.error(`❌ RD Unrestrict: ${response.status}`, response.data);
    return null;
  } catch (err) {
    return null;
  }
}

// ====== Main API endpoint (cache-aware) ======
app.get("/api/play", async (req, res) => {
  const { id, type, season, episode, force_refresh } = req.query;
  if (!id || !type) {
    return res.status(400).json({ success: false, error: "Missing id or type" });
  }

  // Increase Railway timeout tolerance
  req.setTimeout(300000);
  res.setTimeout(300000);

  const sNum = type === 'tv' ? parseInt(season || 1) : null;
  const eNum = type === 'tv' ? parseInt(episode || 1) : null;

  try {
    // ====== STEP 1: Check cache ======
    if (force_refresh !== '1' && force_refresh !== 'true') {
      const cached = await cache.getCache(id, type, sNum, eNum);

      if (cached.hit && cached.fresh) {
        // 🎯 Cache hit — instant response
        console.log(`\n⚡ CACHE HIT: ${cached.data.title} (${cached.data.quality})`);
        return res.json({
          success: true,
          provider: `real-debrid+${cached.data.source || 'cache'}`,
          quality: cached.data.quality,
          title: cached.data.title,
          year: cached.data.year,
          filename: cached.data.filename,
          stream_url: cached.data.stream_url,
          subtitles: [],
          size_mb: Math.round((cached.data.file_size_bytes || 0) / 1024 / 1024),
          seeds: cached.data.seeds || 0,
          poster: cached.data.poster_path ? `https://image.tmdb.org/t/p/w500${cached.data.poster_path}` : null,
          cached: true,
          cache_id: cached.data.id,
          cached_at: cached.data.fetched_at,
        });
      }

      if (cached.hit && !cached.fresh && cached.data?.magnet && cached.data.magnet) {
        // Cached but stream_url expired — try to re-unrestrict with existing magnet
        console.log(`\n🔄 Cache expired, re-unrestricting from stored magnet: ${cached.data.title}`);
        try {
          const rdLink = cached.data.rd_link;
          let unrestricted;

          if (rdLink) {
            // Try the stored link first
            unrestricted = await rdUnrestrict(rdLink);
          }

          if (!unrestricted) {
            // Re-add the magnet and pick files
            const added = await rdAddMagnet(cached.data.magnet);
            if (added && added.id) {
              await rdSelectFiles(added.id, 'all');
              const info = await rdWaitForTorrent(added.id, 180000);
              if (info && info.links && info.links.length > 0) {
                unrestricted = await rdUnrestrict(info.links[0]);
              }
            }
          }

          if (unrestricted && unrestricted.download) {
            // Update cache with new stream_url
            await cache.setCache({
              tmdb_id: parseInt(id),
              media_type: type,
              season: sNum,
              episode: eNum,
              title: cached.data.title,
              original_title: cached.data.original_title,
              year: cached.data.year,
              poster_path: cached.data.poster_path,
              backdrop_path: cached.data.backdrop_path,
              overview: cached.data.overview,
              runtime: cached.data.runtime,
              vote_average: cached.data.vote_average,
              genres: cached.data.genres,
              rd_torrent_id: cached.data.rd_torrent_id,
              rd_link: cached.data.rd_link,
              stream_url: unrestricted.download,
              filename: cached.data.filename,
              file_size_bytes: cached.data.file_size_bytes,
              quality: cached.data.quality,
              video_format: cached.data.video_format,
              video_codec: cached.data.video_codec,
              audio_codec: cached.data.audio_codec,
              source: cached.data.source,
              magnet: cached.data.magnet,
              seeds: cached.data.seeds,
              status: 'ready',
            });

            console.log(`   ✅ Re-unrestricted from cache magnet`);
            return res.json({
              success: true,
              provider: `real-debrid+${cached.data.source || 'cache'}`,
              quality: cached.data.quality,
              title: cached.data.title,
              year: cached.data.year,
              filename: cached.data.filename,
              stream_url: unrestricted.download,
              subtitles: [],
              size_mb: Math.round((cached.data.file_size_bytes || 0) / 1024 / 1024),
              seeds: cached.data.seeds || 0,
              poster: cached.data.poster_path ? `https://image.tmdb.org/t/p/w500${cached.data.poster_path}` : null,
              cached: true,
              refreshed: true,
            });
          }
        } catch (err) {
          console.warn(`   ⚠️ Re-unrestrict failed: ${err.message} — falling through to fresh fetch`);
        }
      }

      if (cached.pending) {
        return res.status(202).json({
          success: false,
          status: 'pending',
          error: 'هذا المحتوى قيد التحضير، حاول بعد لحظات',
          cache_id: cached.data?.id,
        });
      }
    }

    // ====== STEP 2: Fresh fetch (no cache or expired) ======
    // 1) TMDB metadata
    const meta = await getTMDBMeta(id, type);
    if (!meta) return res.status(404).json({ success: false, error: "TMDB not found" });

    const displayTitle = meta.title || meta.name || meta.original_title || meta.original_name;
    const year = (meta.release_date || meta.first_air_date || '').slice(0, 4);
    const poster = meta.poster_path ? `https://image.tmdb.org/t/p/w500${meta.poster_path}` : null;

    console.log(`\n🎬 ${displayTitle} (${year}) | ${type} S${sNum || 1}E${eNum || 1}`);

    // Mark as pending so concurrent requests don't all fetch
    await cache.markPending(id, type, sNum, eNum);

    // 2) Build search query
    let searchQuery;
    if (type === 'movie') {
      searchQuery = year ? `${displayTitle} ${year}` : displayTitle;
    } else {
      searchQuery = `${displayTitle} S${String(sNum || 1).padStart(2, '0')}E${String(eNum || 1).padStart(2, '0')}`;
    }

    // 3) Search across sources
    const torrents = await searchAllSources(searchQuery, type, year);

    if (torrents.length === 0) {
      await cache.markFailed(id, type, sNum, eNum, 'No torrents found in any source');
      return res.status(404).json({
        success: false,
        error: `لم يتم العثور على "${displayTitle}"`,
        title: displayTitle,
        year,
        hint: 'حاول مع عنوان مختلف أو تحقق من اتصال الشبكة',
      });
    }

    // Sort by quality
    torrents.sort((a, b) => {
      const scoreA = getQualityScore(a.name) + (a.seeds || 0) * 0.1;
      const scoreB = getQualityScore(b.name) + (b.seeds || 0) * 0.1;
      return scoreB - scoreA;
    });

    console.log(`📋 Trying ${torrents.length} torrents...`);

    // 4) Try each torrent with RD
    const maxAttempts = Math.min(5, torrents.length);
    for (let i = 0; i < maxAttempts; i++) {
      const torrent = torrents[i];
      console.log(`\n🔄 [${i + 1}/${maxAttempts}] ${torrent.name.substring(0, 60)}`);
      console.log(`   Source: ${torrent.source} | Quality: ${torrent.quality} | Seeds: ${torrent.seeds || '?'}`);
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
        console.log(`   ❌ Download timeout/error`);
        continue;
      }

      console.log(`   ✓ Downloaded: ${torrentInfo.filename}`);

      const links = torrentInfo.links || [];
      if (links.length === 0) {
        console.log(`   ❌ No links found`);
        continue;
      }

      // Pick the largest video file (most bytes = best quality)
      let bestLink = links[0];
      let bestSize = 0;
      if (torrentInfo.files && Array.isArray(torrentInfo.files) && links.length > 1) {
        for (let j = 0; j < Math.min(links.length, torrentInfo.files.length); j++) {
          const fileSize = torrentInfo.files[j]?.bytes || 0;
          if (fileSize > bestSize) {
            bestSize = fileSize;
            bestLink = links[j];
          }
        }
      }

      const unrestricted = await rdUnrestrict(bestLink);
      if (!unrestricted) {
        console.log(`   ❌ Unrestrict failed`);
        continue;
      }

      console.log(`   ✅ Got stream URL!`);

      // ====== Save to cache ======
      await cache.setCache({
        tmdb_id: parseInt(id),
        media_type: type,
        season: sNum,
        episode: eNum,
        title: displayTitle,
        original_title: meta.original_title || meta.original_name,
        year: year,
        overview: meta.overview,
        poster_path: meta.poster_path,
        backdrop_path: meta.backdrop_path,
        runtime: meta.runtime || (meta.episode_run_time && meta.episode_run_time[0]) || null,
        vote_average: meta.vote_average,
        genres: meta.genres ? meta.genres.map(g => g.name).join(', ') : null,
        rd_torrent_id: added.id,
        rd_link: bestLink,
        stream_url: unrestricted.download,
        filename: torrentInfo.filename,
        file_size_bytes: bestSize || torrent.size || 0,
        quality: torrent.quality,
        audio_codec: torrentInfo.audioCodec || null,
        source: torrent.source,
        magnet: torrent.magnet,
        seeds: torrent.seeds || 0,
        status: 'ready',
      });

      return res.json({
        success: true,
        provider: `real-debrid+${torrent.source}`,
        quality: torrent.quality,
        title: displayTitle,
        year,
        filename: torrentInfo.filename,
        stream_url: unrestricted.download,
        subtitles: [],
        size_mb: Math.round((bestSize || torrent.size || 0) / 1024 / 1024),
        seeds: torrent.seeds || 0,
        poster,
        cached: false,
      });
    }

    await cache.markFailed(id, type, sNum, eNum, 'All torrent attempts failed');
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

// ====== Cache admin endpoints ======
app.get("/api/cache/stats", async (req, res) => {
  try {
    const stats = await cache.getStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/cache/clean", async (req, res) => {
  try {
    const count = await cache.cleanExpired();
    res.json({ success: true, expired_marked: count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({
    status: "✅ Real-Debrid Multi-Source API + MySQL Cache",
    version: "6.0",
    endpoints: {
      play: "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1",
      play_force: "/api/play?id={...}&type={...}&force_refresh=1",
      cache_stats: "GET /api/cache/stats",
      cache_clean: "POST /api/cache/clean",
      cache_delete: "DELETE /api/cache/:tmdb_id/:type?season=1&episode=1",
    },
    sources: ['torrentdownloads.pro (direct)', 'yts.mx (movies)', '1337x.to (TV)'],
    cache: {
      type: 'MySQL/HeidiSQL',
      table: 'media_cache',
      ttl_hours: 23,
    },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎬 RD Multi-Source API v5.0 running on port ${PORT}`);
  console.log(`✅ RD Token: ${RD_TOKEN ? 'Loaded' : 'MISSING'}`);
  console.log(`✅ TMDB Key: ${TMDB_KEY ? 'Loaded' : 'MISSING'}`);
});
