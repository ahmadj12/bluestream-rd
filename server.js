// server.js — Real-Debrid + OpenSubtitles + Torrentio + HLS live transcoding

// v7.5: HLS Proxy — يحول أي فيديو (MKV/HEVC/AVI) إلى HLS MP4 live

//        المتصفح يستقبل m3u8 عادي ← يشتغل بدون أي مشاكل


const express = require("express");

const https = require("https");

const http = require("http");

const { URL } = require("url");

const path = require("path");

const fs = require("fs");

const { spawn } = require("child_process");

const crypto = require("crypto");

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

const TORRENTIO_BASE = "https://torrentio.strem.fun";


// 🆕 مجلد الـ HLS segments

const HLS_DIR = path.join(process.cwd(), "hls_cache");

try { fs.mkdirSync(HLS_DIR, { recursive: true }); } catch {}


// تتبع الـ active streams (لكي ما نشغل ffmpeg مرتين لنفس الفيديو)

const activeStreams = new Map();


const BROWSER_HEADERS = {

  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',

  'Connection': 'keep-alive',

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


    const response = await fetchURL(url, { timeout: 20000 });

    if (response.status !== 200) return [];


    const data = response.data;

    if (!data?.streams?.length) return [];


    const results = [];

    for (const stream of data.streams) {

      if (!stream.infoHash) continue;

      const title = stream.title || "";

      const lower = title.toLowerCase();

      let quality = "?";

      if (lower.includes('4k') || lower.includes('2160p') || lower.includes('uhd')) quality = "4K";

      else if (lower.includes('1080p')) quality = "1080p";

      else if (lower.includes('720p')) quality = "720p";

      else if (lower.includes('480p')) quality = "480p";


      const sizeMatch = title.match(/💾\s*([\d.]+\s*[GMK]B)/);

      const sizeStr = sizeMatch ? sizeMatch[1] : "";

      const sourceMatch = title.match(/⚙️\s*([^\n🇬🇧🇸🇦]+)/);

      const source = sourceMatch ? sourceMatch[1].trim() : "torrentio";


      const magnet = buildMagnet(stream.infoHash, title, stream.sources || []);


      results.push({

        name: title.split('\n')[0] || title,

        title, url_path: null, magnet, quality,

        size_str: sizeStr, size: parseSize(sizeStr), seeds: 0,

        source: `torrentio-${source.toLowerCase().replace(/\s+/g, '')}`,

        infoHash: stream.infoHash, fileIdx: stream.fileIdx || 0,

      });

    }

    return results;

  } catch (err) {

    console.warn(`   ⚠ Torrentio error: ${err.message}`);

    return [];

  }

}


function buildMagnet(infoHash, title, trackers) {

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

  const allTrackers = [

    ...(trackers || []).filter(s => s.startsWith('tracker:')).map(s => s.replace('tracker:', '')),

    ...defaultTrackers,

  ];

  const uniqueTrackers = [...new Set(allTrackers)];

  const encodedName = encodeURIComponent(title.split('\n')[0] || "video");

  const tr = uniqueTrackers.map(t => `&tr=${encodeURIComponent(t)}`).join('');

  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodedName}${tr}`;

}


// Browser-Playability Score

function getQualityScore(item) {

  const f = (item.name || item.title || "").toLowerCase();

  const isMp4 = f.includes('mp4') || (!f.includes('mkv') && !f.includes('remux') && !f.includes('avi'));

  const isMkv = f.includes('mkv') || f.includes('remux');

  const isWebm = f.includes('webm');

  const isHevc = f.includes('hevc') || f.includes('h.265') || f.includes('h265') || f.includes('x265') || f.includes('av1');

  const isX264 = f.includes('x264') || f.includes('h.264') || f.includes('h264');


  let resScore = 50;

  if (f.includes('2160p') || f.includes('4k') || f.includes('uhd')) resScore = 400;

  else if (f.includes('1080p') || f.includes('fhd')) resScore = 300;

  else if (f.includes('720p') || f.includes('hdrip')) resScore = 200;

  else if (f.includes('480p') || f.includes('dvdrip')) resScore = 100;


  let playBonus = 0;

  if (isMp4 && isX264) playBonus = 1000;

  else if (isMp4 && !isHevc) playBonus = 800;

  else if (isWebm) playBonus = 600;

  else if (isMkv && isX264) playBonus = 200;

  else if (isMkv && isHevc) playBonus = -500;

  if (f.includes('remux')) playBonus = Math.min(playBonus, -300);


  return resScore + playBonus;

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

// 🆕 HLS LIVE TRANSCODING — يحوّل أي تنسيق (MKV/HEVC/AVI) لـ HLS

// =============================================================


function generateStreamId() {

  return crypto.randomBytes(16).toString('hex');

}


function startHlsTranscode(rdUrl, streamId) {

  const streamDir = path.join(HLS_DIR, streamId);

  fs.mkdirSync(streamDir, { recursive: true });

  const playlistPath = path.join(streamDir, 'index.m3u8');

  const segmentPattern = path.join(streamDir, 'seg_%05d.ts');


  // 🔥 ffmpeg يحول أي تنسيق إلى HLS MP4 (x264 + AAC)

  // - preset ultrafast: real-time transcoding بأقل CPU

  // - hls_time 4: مقاطع 4 ثواني

  // - hls_list_size 5: يحتفظ بآخر 5 مقاطع (تأخير منخفض)

  // - c:v libx264: كوديك عالمي مدعوم في كل المتصفحات

  // - c:a aac: صوت MP4

  // - pix_fmt yuv420p: توافق

  const ffmpegArgs = [

    '-hide_banner',

    '-loglevel', 'error',

    '-fflags', '+genpts+igndts',

    '-i', rdUrl,

    '-map', '0:v:0?',

    '-map', '0:a:0?',

    '-map', '0:s?',         // ترجمات داخلية (لو موجودة)

    '-c:v', 'libx264',

    '-preset', 'ultrafast',

    '-crf', '23',

    '-pix_fmt', 'yuv420p',

    '-c:a', 'aac',

    '-b:a', '128k',

    '-c:s', 'mov_text',     // ترجمات نصية mp4

    '-f', 'hls',

    '-hls_time', '4',

    '-hls_list_size', '5',

    '-hls_flags', 'delete_segments+independent_segments',

    '-hls_segment_filename', segmentPattern,

    playlistPath,

  ];


  console.log(`   🎬 Starting ffmpeg HLS transcode for ${streamId}`);

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);


  let errorOutput = '';

  ffmpeg.stderr.on('data', (data) => { errorOutput += data.toString(); });

  ffmpeg.on('error', (err) => {

    console.error(`   ❌ ffmpeg error: ${err.message}`);

  });

  ffmpeg.on('exit', (code) => {

    if (code !== 0) {

      console.error(`   ❌ ffmpeg exit ${code}: ${errorOutput.substring(0, 500)}`);

    } else {

      console.log(`   ✅ ffmpeg transcode complete for ${streamId}`);

    }

    // تنظيف

    setTimeout(() => {

      try { fs.rmSync(streamDir, { recursive: true, force: true }); } catch {}

      activeStreams.delete(streamId);

    }, 30000);

  });


  return ffmpeg;

}


function isHlsReady(streamId) {

  const playlistPath = path.join(HLS_DIR, streamId, 'index.m3u8');

  try {

    return fs.existsSync(playlistPath) && fs.statSync(playlistPath).size > 0;

  } catch { return false; }

}


// =============================================================

// OPENSUBTITLES

// =============================================================


async function searchOpenSubtitles({ tmdbId, type, season, episode, title, year }) {

  if (!OS_API_KEY) return null;

  try {

    let searchUrl;

    if (tmdbId) {

      const tmdbParam = type === 'movie' ? `tmdb_id=${tmdbId}` : `tmdb_id=${tmdbId}&season_number=${season || 1}&episode_number=${episode || 1}`;

      searchUrl = `${OS_BASE}/subtitles?${tmdbParam}&languages=ar&order_by=download_count&order_direction=desc`;

    } else if (title) {

      const query = encodeURIComponent(year ? `${title} ${year}` : title);

      searchUrl = `${OS_BASE}/subtitles?query=${query}&languages=ar&order_by=download_count&order_direction=desc`;

    } else {

      return null;

    }


    const searchRes = await fetchURL(searchUrl, {

      headers: { 'Api-Key': OS_API_KEY, 'User-Agent': 'BlueStream v1.0', 'Accept': 'application/json' },

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

      headers: { 'Api-Key': OS_API_KEY, 'User-Agent': 'BlueStream v1.0', 'Content-Type': 'application/json', 'Accept': 'application/json' },

      body: JSON.stringify({ file_id: fileId, sub_format: 'srt' }),

      timeout: 15000,

    });

    if (dlRes.status !== 200 || !dlRes.data?.link) return null;


    const srtRes = await fetchURL(dlRes.data.link, { timeout: 15000 });

    if (srtRes.status !== 200 || !srtRes.data) return null;


    const srtContent = typeof srtRes.data === 'string' ? srtRes.data : String(srtRes.data);

    const srtBase64 = Buffer.from(srtContent, 'utf8').toString('base64');

    return {

      url: `data:text/plain;charset=utf-8;base64,${srtBase64}`,

      language: 'ar', label: 'العربية', source: 'opensubtitles',

      release: top.attributes?.release || '',

    };

  } catch (err) { console.warn('OS error:', err.message); return null; }

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

    // 🔑 HLS proxy URL بدل raw link

    const streamId = generateStreamId();

    const streamUrl = `/stream/${streamId}/index.m3u8`;

    return {

      success: true,

      provider: `real-debrid+${cached.data.source || 'cache'}`,

      quality: cached.data.quality,

      title: cached.data.title, year: cached.data.year,

      stream_url: streamUrl,

      stream_type: 'hls',

      raw_url: cached.data.stream_url,

      rd_link: cached.data.rd_link,

      subtitle, subtitles: subtitle ? [subtitle.url] : [],

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

      let unrestricted = null;

      if (cached.data.rd_link) unrestricted = await rdUnrestrict(cached.data.rd_link);

      if (!unrestricted && cached.data.magnet) {

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

          rd_torrent_id: cached.data.rd_torrent_id, rd_link: unrestricted.download,

          magnet: cached.data.magnet, source: cached.data.source, status: 'ready',

          file_size_bytes: cached.data.file_size_bytes, quality: cached.data.quality,

          filename: cached.data.filename, seeds: cached.data.seeds,

          poster_path: cached.data.poster_path, backdrop_path: cached.data.backdrop_path,

        });

        const subtitle = withSubs ? await searchOpenSubtitles({

          tmdbId: parseInt(id), type, season: sNum, episode: eNum,

          title: cached.data.title, year: cached.data.year,

        }) : null;

        const streamId = generateStreamId();

        return {

          success: true,

          provider: `real-debrid+${cached.data.source || 'cache'}`,

          quality: cached.data.quality,

          title: cached.data.title,

          stream_url: `/stream/${streamId}/index.m3u8`,

          stream_type: 'hls',

          raw_url: unrestricted.download,

          rd_link: unrestricted.download,

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


  const imdbId = meta.imdb_id || meta.external_ids?.imdb_id;

  if (!imdbId) return { success: false, error: "IMDB ID not found" };


  console.log(`   📺 IMDB: ${imdbId}`);


  const torrents = await searchTorrentio(imdbId, type, sNum, eNum);

  if (torrents.length === 0) return { success: false, error: `لم يتم العثور على "${displayTitle}"` };


  console.log(`📊 إجمالي النتائج: ${torrents.length} torrent`);

  torrents.sort((a, b) => getQualityScore(b) - getQualityScore(a));

  // 🔑 نزيد عدد المحاولات لأن Torrentio يعطي نتائج كثيرة تالفة

  const maxAttempts = Math.min(30, torrents.length);


  for (let i = 0; i < maxAttempts; i++) {

    const torrent = torrents[i];


    // 🔑 Validation: نتأكد من infoHash قبل ما نرسل لـ RD

    if (!torrent.infoHash || torrent.infoHash.length !== 40 || !/^[a-f0-9]{40}$/i.test(torrent.infoHash)) {

      console.log(`\n🔄 [${i + 1}/${maxAttempts}] ${torrent.quality} | ${(torrent.name || '').substring(0, 50)}`);

      console.log(`   ⚠ Invalid infoHash, skipping`);

      continue;

    }


    console.log(`\n🔄 [${i + 1}/${maxAttempts}] ${torrent.quality} | ${(torrent.name || '').substring(0, 50)}`);


    let added;

    let retryCount = 0;

    while (retryCount < 3) {

      added = await rdAddMagnet(torrent.magnet);

      if (added?.id) break;

      console.log(`   ⚠ Add failed (attempt ${retryCount + 1}/3), retrying...`);

      retryCount++;

      await new Promise(r => setTimeout(r, 1000));

    }

    if (!added?.id) { console.log(`   ❌ Failed to add after 3 attempts`); continue; }

    console.log(`   ✓ Added to RD: ${added.id}`);


    await rdSelectFiles(added.id, 'all');

    const torrentInfo = await rdWaitForTorrent(added.id, 300000);

    if (!torrentInfo) { console.log(`   ❌ Download timeout/error`); continue; }

    console.log(`   ✓ Downloaded: ${torrentInfo.filename}`);


    const links = torrentInfo.links || [];

    if (links.length === 0) { console.log(`   ❌ No links`); continue; }


    let bestLink = links[0];

    if (torrentInfo.files && Array.isArray(torrentInfo.files) && links.length > 1) {

      let bestSize = 0;

      for (let j = 0; j < Math.min(links.length, torrentInfo.files.length); j++) {

        const fs = torrentInfo.files[j]?.bytes || 0;

        if (fs > bestSize) { bestSize = fs; bestLink = links[j]; }

      }

    }


    const unrestricted = await rdUnrestrict(bestLink);

    if (!unrestricted?.download) { console.log(`   ❌ Unrestrict failed`); continue; }

    console.log(`   ✅ Got stream URL!`);


    await cache.setCache({

      tmdb_id: parseInt(id), media_type: type, season: sNum, episode: eNum,

      title: displayTitle, year,

      original_title: meta.original_title || meta.original_name,

      overview: meta.overview, poster_path: meta.poster_path, backdrop_path: meta.backdrop_path,

      runtime: meta.runtime || (meta.episode_run_time?.[0]) || null,

      vote_average: meta.vote_average,

      genres: meta.genres?.map(g => g.name).join(', ') || null,

      rd_torrent_id: added.id, rd_link: unrestricted.download,

      stream_url: unrestricted.download, filename: torrentInfo.filename,

      file_size_bytes: 0, quality: torrent.quality,

      source: torrent.source, magnet: torrent.magnet, seeds: torrent.seeds || 0,

      info_hash: torrent.infoHash, status: 'ready',

    });


    const subtitle = withSubs ? await searchOpenSubtitles({

      tmdbId: parseInt(id), type, season: sNum, episode: eNum,

      title: displayTitle, year,

    }) : null;


    // 🔑 إرجاع رابط HLS proxy

    const streamId = generateStreamId();

    return {

      success: true,

      provider: `real-debrid+${torrent.source}`,

      quality: torrent.quality,

      title: displayTitle, year,

      stream_url: `/stream/${streamId}/index.m3u8`,

      stream_type: 'hls',

      raw_url: unrestricted.download,

      rd_link: unrestricted.download,

      subtitle, subtitles: subtitle ? [subtitle.url] : [],

      size_mb: 0,

      seeds: torrent.seeds || 0,

      poster, backdrop, cached: false,

    };

  }


  return { success: false, error: `فشل تحميل أي من ${torrents.length} torrents` };

}


// =============================================================

// 🆕 HLS Proxy Endpoints

// =============================================================


// POST /api/proxy/start — يبدأ تحويل HLS ويرجع stream_id

app.post("/api/proxy/start", (req, res) => {

  const { rd_url } = req.body;

  if (!rd_url) return res.status(400).json({ success: false, error: "rd_url required" });


  const streamId = generateStreamId();

  const ffmpeg = startHlsTranscode(rd_url, streamId);

  activeStreams.set(streamId, { ffmpeg, rd_url, startedAt: Date.now() });


  res.json({ success: true, stream_id: streamId, playlist_url: `/stream/${streamId}/index.m3u8` });

});


// 🆕 تخزين raw_url لكل streamId (نبدأ ffmpeg lazy)

const pendingStreams = new Map(); // streamId -> { rd_url }


// POST /api/proxy/start — يبدأ تحويل HLS ويرجع stream_id

app.post("/api/proxy/start", (req, res) => {

  const { rd_url, stream_id } = req.body;

  if (!rd_url) return res.status(400).json({ success: false, error: "rd_url required" });

  const streamId = stream_id || generateStreamId();

  pendingStreams.set(streamId, { rd_url });

  res.json({ success: true, stream_id: streamId, playlist_url: `/stream/${streamId}/index.m3u8` });

});


// GET /stream/:streamId/index.m3u8 — الـ playlist

app.get("/stream/:streamId/index.m3u8", (req, res) => {

  const { streamId } = req.params;

  const playlistPath = path.join(HLS_DIR, streamId, 'index.m3u8');


  // Lazy start: إذا ما بدأ ffmpeg بعد، نبدأه الآن

  if (!activeStreams.has(streamId) && pendingStreams.has(streamId)) {

    const { rd_url } = pendingStreams.get(streamId);

    const ffmpeg = startHlsTranscode(rd_url, streamId);

    activeStreams.set(streamId, { ffmpeg, rd_url, startedAt: Date.now() });

    pendingStreams.delete(streamId);

  }


  // إذا الـ playlist ما جهز بعد، نرجع placeholder (المتصفح يعيد المحاولة)

  if (!fs.existsSync(playlistPath)) {

    res.set('Content-Type', 'application/vnd.apple.mpegurl');

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');

    return res.send(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLACEHOLDER\n#EXTINF:4.0,\nseg_00000.ts\n#EXT-X-ENDLIST\n`);

  }


  res.set('Content-Type', 'application/vnd.apple.mpegurl');

  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');

  res.set('Access-Control-Allow-Origin', '*');

  fs.createReadStream(playlistPath).pipe(res);

});


// GET /stream/:streamId/:segment — الـ segments

app.get("/stream/:streamId/:segment", (req, res) => {

  const { streamId, segment } = req.params;

  // أمان: نمنع path traversal

  if (segment.includes('..') || segment.includes('/')) {

    return res.status(400).end();

  }

  const segmentPath = path.join(HLS_DIR, streamId, segment);


  if (!fs.existsSync(segmentPath)) {

    return res.status(404).end();

  }


  res.set('Content-Type', 'video/mp2t');

  res.set('Cache-Control', 'public, max-age=3600');

  res.set('Access-Control-Allow-Origin', '*');

  fs.createReadStream(segmentPath).pipe(res);

});


// =============================================================

// API Endpoints

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

  } catch (err) { res.status(500).json({ success: false, error: err.message }); }

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

    status: "✅ BlueStream API v7.5 (HLS Live Transcoding)",

    version: "7.5",

    features: [

      "Torrentio aggregator (25+ sources)",

      "Real-Debrid downloader",

      "HLS live transcoding (MKV/HEVC → MP4)",

      "OpenSubtitles Arabic",

      "Browser-compatible streams (no extension errors)"

    ],

    endpoints: {

      play: "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1&with_subs=1",

      hls_proxy: "GET /stream/{streamId}/index.m3u8",

    },

  });

});


app.listen(PORT, "0.0.0.0", () => {

  console.log(`\n🎬 BlueStream API v7.5 running on port ${PORT}`);

  console.log(`✅ RD Token: ${RD_TOKEN ? 'Loaded' : 'MISSING'}`);

  console.log(`✅ TMDB Key: ${TMDB_KEY ? 'Loaded' : 'MISSING'}`);

  console.log(`✅ OpenSubtitles: ${OS_API_KEY ? 'Loaded' : 'MISSING'}`);

  console.log(`✅ Torrentio: configured`);

  console.log(`✅ ffmpeg: HLS transcoding ready`);

});

