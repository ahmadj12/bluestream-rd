// server.js — Real-Debrid + OpenSubtitles + Torrentio (25+ source aggregator)

// v7.3: Torrentio يضمن البحث في 25+ موقع بنقرة واحدة


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


// 🆕 Torrentio — 25+ مصدر مدمج، بدون API key، يدعم Real-Debrid

const TORRENTIO_BASE = "https://torrentio.strem.fun";


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

    const url = `https://api.themoviedb.org/3/${path}/${id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=external_ids`;

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

// 🆕 Torrentio: يبحث في 25+ موقع ويعطي infoHash

// =============================================================

async function searchTorrentio(imdbId, type, season, episode) {

  try {

    let url;

    if (type === 'movie') {

      url = `${TORRENTIO_BASE}/stream/movie/${imdbId}.json`;

    } else {

      url = `${TORRENTIO_BASE}/stream/series/${imdbId}:${season || 1}:${episode || 1}.json`;

    }


    console.log(`   🔍 Torrentio: ${url.replace(TORRENTIO_BASE, '')}`);

    const response = await fetchURL(url, { timeout: 20000 });

    if (response.status !== 200) {

      console.log(`   ⚠ Torrentio returned ${response.status}`);

      return [];

    }


    const data = response.data;

    if (!data?.streams?.length) {

      console.log(`   📭 Torrentio: لا نتائج`);

      return [];

    }


    // استخراج الجودة من title Torrentio

    const results = [];

    for (const stream of data.streams) {

      if (!stream.infoHash) continue;


      const title = stream.title || "";

      const lower = title.toLowerCase();


      // استخراج الجودة من title

      let quality = "?";

      if (lower.includes('4k') || lower.includes('2160p') || lower.includes('uhd')) quality = "4K";

      else if (lower.includes('1080p')) quality = "1080p";

      else if (lower.includes('720p')) quality = "720p";

      else if (lower.includes('480p')) quality = "480p";


      // استخراج source من title (آخر سطر قبل ال emoji)

      const sourceMatch = title.match(/⚙️\s*([^\n🇬🇧🇸🇦🇪🇸🇫🇷🇩🇪🇮🇹🇯🇵🇰🇷🇨🇳🇷🇺🇵🇹🇮🇳]+)/);

      const source = sourceMatch ? sourceMatch[1].trim() : "torrentio";


      // استخراج الحجم من title

      const sizeMatch = title.match(/💾\s*([\d.]+\s*[GMK]B)/);

      const sizeStr = sizeMatch ? sizeMatch[1] : "";


      // بناء magnet من infoHash

      const magnet = buildMagnet(stream.infoHash, title, stream.sources || []);


      results.push({

        name: title.split('\n')[0] || title,

        title,

        url_path: null,

        magnet,

        quality,

        size_str: sizeStr,

        size: parseSize(sizeStr),

        seeds: 0, // Torrentio ما يعطي seeds

        source: `torrentio-${source.toLowerCase().replace(/\s+/g, '')}`,

        infoHash: stream.infoHash,

        fileIdx: stream.fileIdx || 0,

      });

    }


    console.log(`   ✅ Torrentio: ${results.length} نتيجة`);

    return results;

  } catch (err) {

    console.warn(`   ⚠ Torrentio error: ${err.message}`);

    return [];

  }

}


function buildMagnet(infoHash, title, trackers) {

  // Default trackers (DHT/PEX + public)

  const defaultTrackers = [

    "udp://tracker.opentrackr.org:1337/announce",

    "udp://open.demonii.com:1337/announce",

    "udp://tracker.openbittorrent.com:80/announce",

    "udp://tracker.torrent.eu.org:451/announce",

    "udp://exodus.desync.com:6969/announce",

    "udp://open.stealth.si:80/announce",

    "udp://tracker.peerfect.org:6969/announce",

    "udp://tracker.ducks.party:1984/announce",

  ];


  // Trackers من Torrentio (عادة أكتر)

  const allTrackers = [

    ...(trackers || [])

      .filter(s => s.startsWith('tracker:'))

      .map(s => s.replace('tracker:', '')),

    ...defaultTrackers,

  ];


  // إزالة المكرر

  const uniqueTrackers = [...new Set(allTrackers)];


  const encodedName = encodeURIComponent(title.split('\n')[0] || "video");

  const tr = uniqueTrackers.map(t => `&tr=${encodeURIComponent(t)}`).join('');

  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodedName}${tr}`;

}


function getQualityScore(item) {

  const f = (item.name || item.title || "").toLowerCase();

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


// 🆕 Real-Debrid Transcoding — يحوّل MKV/HEVC لـ HLS/MP4 صديق للمتصفح

// الـ response يحتوي streaming ID نقدر نحصل منه على m3u8 playlist

async function rdGetTranscodedLinks(streamingId) {

  try {

    const response = await fetchURL(

      `https://api.real-debrid.com/rest/1.0/streaming/transcode/${streamingId}`,

      {

        method: 'GET',

        headers: { 'Authorization': `Bearer ${RD_TOKEN}` },

        timeout: 10000,

      }

    );

    return response.status === 200 ? response.data : null;

  } catch { return null; }

}


// يحول رابط raw (MKV) إلى HLS playlist مدمج (friendly للمتصفح)

async function rdGetPlayableUrl(unrestrictedLink) {

  // أولاً: استدعي unrestrict/link

  const data = await rdUnrestrict(unrestrictedLink);

  if (!data?.id) {

    // fallback: استخدم الـ download link مباشرة

    return { url: unrestrictedLink, type: 'raw' };

  }


  // ثانياً: احصل على روابط transcoding

  const transcoded = await rdGetTranscodedLinks(data.id);

  if (transcoded) {

    // أولوية: m3u8 (HLS) → mp4 → webm

    if (transcoded.hls && Array.isArray(transcoded.hls) && transcoded.hls.length > 0) {

      const fullHls = transcoded.hls.find(s => s.includes('/full.m3u8')) || transcoded.hls[0];

      return { url: fullHls, type: 'hls', formats: transcoded };

    }

    if (transcoded.mp4 && Array.isArray(transcoded.mp4) && transcoded.mp4.length > 0) {

      return { url: transcoded.mp4[0], type: 'mp4', formats: transcoded };

    }

    if (transcoded.webm && Array.isArray(transcoded.webm) && transcoded.webm.length > 0) {

      return { url: transcoded.webm[0], type: 'webm', formats: transcoded };

    }

    // dash

    if (transcoded.dash && Array.isArray(transcoded.dash) && transcoded.dash.length > 0) {

      return { url: transcoded.dash[0], type: 'dash', formats: transcoded };

    }

  }


  // fallback: استخدم raw link

  return { url: data.download, type: 'raw', formats: null };

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

      url: dataUrl, language: 'ar', label: 'العربية',

      source: 'opensubtitles', release: top.attributes?.release || '',

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

      title: cached.data.title, year: cached.data.year,

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

      let playable = null;

      if (cached.data.rd_link) {

        playable = await rdGetPlayableUrl(cached.data.rd_link);

      }

      if (!playable?.url) {

        const added = await rdAddMagnet(cached.data.magnet);

        if (added?.id) {

          await rdSelectFiles(added.id, 'all');

          const info = await rdWaitForTorrent(added.id, 180000);

          if (info?.links?.length) playable = await rdGetPlayableUrl(info.links[0]);

        }

      }

      if (playable?.url) {

        await cache.setCache({

          tmdb_id: parseInt(id), media_type: type, season: sNum, episode: eNum,

          title: cached.data.title, year: cached.data.year,

          stream_url: playable.url,

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

          stream_url: playable.url,

          stream_type: playable.type,

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


  // نحتاج IMDB ID لـ Torrentio

  const imdbId = meta.imdb_id || meta.external_ids?.imdb_id;

  if (!imdbId) {

    return { success: false, error: "IMDB ID not found for this title" };

  }


  console.log(`   📺 IMDB: ${imdbId}`);


  // 🆕 البحث عبر Torrentio فقط

  const torrents = await searchTorrentio(imdbId, type, sNum, eNum);


  if (torrents.length === 0) {

    return { success: false, error: `لم يتم العثور على "${displayTitle}"` };

  }


  console.log(`📊 إجمالي النتائج: ${torrents.length} torrent`);


  // ترتيب حسب الجودة

  torrents.sort((a, b) => getQualityScore(b) - getQualityScore(a));

  const maxAttempts = Math.min(8, torrents.length);


  for (let i = 0; i < maxAttempts; i++) {

    const torrent = torrents[i];

    console.log(`\n🔄 [${i + 1}/${maxAttempts}] ${torrent.quality} | ${(torrent.name || '').substring(0, 60)}`);


    const added = await rdAddMagnet(torrent.magnet);

    if (!added?.id) {

      console.log(`   ❌ Failed to add`);

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


    // أكبر ملف = أفضل جودة

    let bestLink = links[0], bestSize = 0;

    if (torrentInfo.files && Array.isArray(torrentInfo.files) && links.length > 1) {

      for (let j = 0; j < Math.min(links.length, torrentInfo.files.length); j++) {

        const fs = torrentInfo.files[j]?.bytes || 0;

        if (fs > bestSize) { bestSize = fs; bestLink = links[j]; }

      }

    }


    const playable = await rdGetPlayableUrl(bestLink);

    if (!playable?.url) {

      console.log(`   ❌ Unrestrict/transcode failed`);

      continue;

    }

    console.log(`   ✅ Got stream URL (${playable.type})!`);


    await cache.setCache({

      tmdb_id: parseInt(id), media_type: type, season: sNum, episode: eNum,

      title: displayTitle, year,

      original_title: meta.original_title || meta.original_name,

      overview: meta.overview, poster_path: meta.poster_path, backdrop_path: meta.backdrop_path,

      runtime: meta.runtime || (meta.episode_run_time?.[0]) || null,

      vote_average: meta.vote_average,

      genres: meta.genres?.map(g => g.name).join(', ') || null,

      rd_torrent_id: added.id, rd_link: bestLink,

      stream_url: playable.url, stream_type: playable.type,

      filename: torrentInfo.filename,

      file_size_bytes: bestSize || torrent.size || 0, quality: torrent.quality,

      source: torrent.source, magnet: torrent.magnet, seeds: torrent.seeds || 0,

      info_hash: torrent.infoHash, status: 'ready',

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

      stream_url: playable.url,

      stream_type: playable.type,

      subtitle, subtitles: subtitle ? [subtitle.url] : [],

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

  if (!tmdb_id && !title) return res.status(400).json({ success: false, error: "Missing tmdb_id or title" });

  try {

    const sub = await searchOpenSubtitles({

      tmdbId: tmdb_id ? parseInt(tmdb_id) : null, type, season, episode, title, year,

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

    const result = await tryGetStream({ id, type, sNum, eNum, withSubs: with_subs === '1' });

    if (result.success) return res.json(result);

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

    status: "✅ BlueStream API v7.3 (Torrentio + Real-Debrid)",

    version: "7.3",

    features: ["Torrentio aggregator (25+ sources)", "no rate limits", "no API key needed", "automatic Arabic subtitles"],

    sources: ["1337x", "ThePirateBay", "RARBG", "TorrentGalaxy", "YTS", "EZTV", "NyaaSi", "AniDex", "MagnetDL", "Limetorrent", "Torrent9", "ilCorSaRoNeRo", "Rutracker", "Comando", "BluDV", "+10 more"],

    endpoints: {

      play: "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1&with_subs=1",

      subtitles: "/api/subtitles?tmdb_id=...&type=movie&title=...",

    },

  });

});


app.listen(PORT, "0.0.0.0", () => {

  console.log(`\n🎬 BlueStream API v7.3 running on port ${PORT}`);

  console.log(`✅ RD Token: ${RD_TOKEN ? 'Loaded' : 'MISSING'}`);

  console.log(`✅ TMDB Key: ${TMDB_KEY ? 'Loaded' : 'MISSING'}`);

  console.log(`✅ OpenSubtitles: ${OS_API_KEY ? 'Loaded' : 'MISSING'}`);

  console.log(`✅ Torrentio: configured`);

});

