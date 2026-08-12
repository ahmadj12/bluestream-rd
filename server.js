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


// Short-lived cache for fresh Real-Debrid direct URLs.
// HTML5 video sends multiple Range requests; without this cache
// every Range request would call RD again.
const freshStreamUrlCache = new Map();
const FRESH_STREAM_CACHE_TTL = 90 * 1000;

function getFreshStreamCache(key) {
  const entry = freshStreamUrlCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    freshStreamUrlCache.delete(key);
    return null;
  }
  return entry;
}

function setFreshStreamCache(key, value) {
  freshStreamUrlCache.set(key, {
    ...value,
    expiresAt: Date.now() + FRESH_STREAM_CACHE_TTL
  });
}


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


// 🔑 Browser-Playability Score: نرتب حسب اللي يشتغل في المتصفح

//  - mp4 + x264/h264: ✅ يشتغل native (الأعلى أولوية)

//  - mkv + hevc/x264: ⚠️ يحتاج transcoding (أولوية أقل)

//  - webm: ✅ يشتغل في Chrome

function getQualityScore(item) {

  const f = (item.name || item.title || "").toLowerCase();


  // نوع الملف (الأهم)

  const isMp4 = f.includes('mp4') || (!f.includes('mkv') && !f.includes('remux') && !f.includes('avi'));

  const isMkv = f.includes('mkv') || f.includes('remux');

  const isWebm = f.includes('webm');


  // الكوديك

  const isHevc = f.includes('hevc') || f.includes('h.265') || f.includes('h265') || f.includes('x265') || f.includes('av1');

  const isX264 = f.includes('x264') || f.includes('h.264') || f.includes('h264');


  // الجودة

  let resScore = 50;

  if (f.includes('2160p') || f.includes('4k') || f.includes('uhd')) resScore = 400;

  else if (f.includes('1080p') || f.includes('fhd')) resScore = 300;

  else if (f.includes('720p') || f.includes('hdrip')) resScore = 200;

  else if (f.includes('480p') || f.includes('dvdrip')) resScore = 100;


  // playability bonus

  let playBonus = 0;

  if (isMp4 && isX264) playBonus = 1000;        // الأفضل: mp4 + x264

  else if (isMp4 && !isHevc) playBonus = 800;   // mp4 + أي كوديك غير HEVC

  else if (isWebm) playBonus = 600;

  else if (isMkv && isX264) playBonus = 200;     // mkv + x264 (شغال في بعض المتصفحات)

  else if (isMkv && isHevc) playBonus = -500;   // الأسوأ: mkv + HEVC (يحتاج transcoding)

  // Remux دائماً HEVC → عقوبة كبيرة

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
// REAL-DEBRID STREAMING / MEDIA INFO / TRANSCODE
// =============================================================

// Real-Debrid documents these endpoints as:
// GET /streaming/mediaInfos/{id}
// GET /streaming/transcode/{id}
// The {id} comes from /unrestrict/link.
// We intentionally inspect mediaInfos first, then ask RD for
// streaming/transcode variants before falling back to the raw link.

async function rdGetMediaInfos(streamingId) {
  try {
    const response = await fetchURL(
      `https://api.real-debrid.com/rest/1.0/streaming/mediaInfos/${encodeURIComponent(streamingId)}`,
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${RD_TOKEN}` },
        timeout: 15000,
      }
    );

    if (response.status !== 200) {
      console.warn(`   ⚠ mediaInfos ${response.status} for ${streamingId}`);
      return null;
    }

    return response.data;
  } catch (err) {
    console.warn(`   ⚠ mediaInfos error: ${err.message}`);
    return null;
  }
}


async function rdGetTranscodedLinks(streamingId) {
  try {
    const response = await fetchURL(
      `https://api.real-debrid.com/rest/1.0/streaming/transcode/${encodeURIComponent(streamingId)}`,
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${RD_TOKEN}` },
        timeout: 15000,
      }
    );

    if (response.status !== 200) {
      console.warn(`   ⚠ transcode ${response.status} for ${streamingId}`);
      return null;
    }

    return response.data;
  } catch (err) {
    console.warn(`   ⚠ transcode error: ${err.message}`);
    return null;
  }
}


function firstVideoTrack(mediaInfo) {
  const videos = mediaInfo?.details?.video;

  if (!videos || typeof videos !== 'object') return null;

  const first = Object.values(videos).find(v => v && typeof v === 'object');

  return first || null;
}


function firstAudioTrack(mediaInfo) {
  const audios = mediaInfo?.details?.audio;

  if (!audios || typeof audios !== 'object') return null;

  const first = Object.values(audios).find(v => v && typeof v === 'object');

  return first || null;
}

function allAudioTracks(mediaInfo) {
  const audios = mediaInfo?.details?.audio;
  if (!audios || typeof audios !== 'object') return [];
  return Object.values(audios).filter(v => v && typeof v === 'object');
}

function getAudioCompatibility({ filename = '', mediaInfo = null } = {}) {
  const name = String(filename).toLowerCase();
  const tracks = allAudioTracks(mediaInfo);

  const explicitGood = /(aac|mp4a|he-aac|lc-aac|\bmp3\b|opus)/i.test(name);
  const explicitBad = /(truehd|dts[- .]?hd|\bdts\b|eac3|e-ac-3|\bac3\b|\bddp\b|dolby[ .-]?digital|\batmos\b|flac)/i.test(name);

  let bestScore = -10000;
  let bestCodec = null;
  let anyGood = false;
  let anyUnknown = false;

  for (const track of tracks) {
    const codec = normalizeCodec(track.codec);
    if (/^(aac|mp3|opus|mp4a)/.test(codec)) {
      anyGood = true;
      bestScore = Math.max(bestScore, 1200);
      bestCodec = bestCodec || codec;
    } else if (/^(ac3|eac3|ec3|ddp|dolbydigital|truehd|dts|dtshd|flac)/.test(codec)) {
      bestScore = Math.max(bestScore, -3000);
      bestCodec = bestCodec || codec;
    } else {
      anyUnknown = true;
      bestScore = Math.max(bestScore, 0);
      bestCodec = bestCodec || codec;
    }
  }

  if (explicitGood || anyGood) {
    return { score: 1200, incompatible: false, codec: bestCodec || null };
  }

  if (explicitBad && !anyGood) {
    return { score: -3000, incompatible: true, codec: bestCodec || null };
  }

  if (bestScore < 0) {
    return { score: bestScore, incompatible: true, codec: bestCodec || null };
  }

  return { score: 0, incompatible: false, codec: bestCodec || null };
}


function normalizeCodec(codec) {
  return String(codec || '').toLowerCase().replace(/[.\s_-]/g, '');
}


function getMediaContainer(filename, mimeType) {
  const name = String(filename || '').toLowerCase();

  if (name.endsWith('.mp4') || String(mimeType || '').includes('mp4')) return 'mp4';
  if (name.endsWith('.webm') || String(mimeType || '').includes('webm')) return 'webm';
  if (name.endsWith('.mkv') || String(mimeType || '').includes('matroska')) return 'mkv';
  if (name.endsWith('.mov') || String(mimeType || '').includes('quicktime')) return 'mov';
  if (name.endsWith('.avi') || String(mimeType || '').includes('avi')) return 'avi';

  return 'unknown';
}


function isBrowserNativeMedia(mediaInfo, unrestricted) {
  const filename = unrestricted?.filename || mediaInfo?.filename || '';
  const mimeType = unrestricted?.mimeType || '';
  const container = getMediaContainer(filename, mimeType);
  const video = firstVideoTrack(mediaInfo);
  const codec = normalizeCodec(video?.codec);
  const audio = getAudioCompatibility({ filename, mediaInfo });

  const h264 = codec === 'h264' || codec === 'avc' || codec.includes('avc1');
  const vp8 = codec === 'vp8';
  const vp9 = codec === 'vp9';

  const mp4Native = container === 'mp4' && h264;
  const webmNative = container === 'webm' && (vp8 || vp9 || h264);

  return (mp4Native || webmNative) && !audio.incompatible;
}


// Recursively extract URL strings from the transcoder response.
// RD's documented schema exposes formats such as:
// apple (M3U8/HLS), dash (MPD), liveMP4 and h264WebM.
// The quality names/shape can vary, so do not assume arrays.
function collectUrls(value, out = []) {
  if (!value) return out;

  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) out.push(value);
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, out);
    return out;
  }

  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectUrls(item, out);
    }
  }

  return out;
}


function pickBestTranscodeUrl(transcoded) {
  if (!transcoded || typeof transcoded !== 'object') return null;

  // HLS first. In RD API this is the "apple" format.
  const hlsUrls = collectUrls(transcoded.apple);

  if (hlsUrls.length) {
    const full = hlsUrls.find(u => /full\.m3u8/i.test(u));
    const m3u8 = hlsUrls.find(u => /\.m3u8(?:$|\?)/i.test(u));

    return {
      url: full || m3u8 || hlsUrls[0],
      type: 'hls'
    };
  }

  // Then live MP4.
  const mp4Urls = collectUrls(transcoded.liveMP4);

  if (mp4Urls.length) {
    return {
      url: mp4Urls[0],
      type: 'mp4'
    };
  }

  // Then H264 WebM.
  const webmUrls = collectUrls(transcoded.h264WebM);

  if (webmUrls.length) {
    return {
      url: webmUrls[0],
      type: 'webm'
    };
  }

  // Finally DASH.
  const dashUrls = collectUrls(transcoded.dash);

  if (dashUrls.length) {
    const mpd = dashUrls.find(u => /\.mpd(?:$|\?)/i.test(u));

    return {
      url: mpd || dashUrls[0],
      type: 'dash'
    };
  }

  // Compatibility with older/alternate response shapes.
  const legacyHls = collectUrls(transcoded.hls);

  if (legacyHls.length) {
    return {
      url: legacyHls.find(u => /\.m3u8(?:$|\?)/i.test(u)) || legacyHls[0],
      type: 'hls'
    };
  }

  const legacyMp4 = collectUrls(transcoded.mp4);

  if (legacyMp4.length) {
    return {
      url: legacyMp4[0],
      type: 'mp4'
    };
  }

  const legacyWebm = collectUrls(transcoded.webm);

  if (legacyWebm.length) {
    return {
      url: legacyWebm[0],
      type: 'webm'
    };
  }

  return null;
}


function getNativeScore(mediaInfo, unrestricted) {
  const filename = unrestricted?.filename || mediaInfo?.filename || '';
  const mimeType = unrestricted?.mimeType || '';
  const container = getMediaContainer(filename, mimeType);
  const video = firstVideoTrack(mediaInfo);
  const audio = firstAudioTrack(mediaInfo);

  const codec = normalizeCodec(video?.codec);
  const audioCodec = normalizeCodec(audio?.codec);

  let score = 0;

  if (container === 'mp4') score += 5000;
  else if (container === 'webm') score += 3000;
  else if (container === 'mkv') score += 500;
  else score -= 1000;

  if (codec === 'h264' || codec === 'avc' || codec.includes('avc1')) {
    score += 3000;
  } else if (codec === 'vp9' || codec === 'vp8') {
    score += container === 'webm' ? 2500 : 500;
  } else if (
    codec.includes('hevc') ||
    codec.includes('h265') ||
    codec.includes('x265') ||
    codec.includes('av1')
  ) {
    score -= 2500;
  } else {
    score -= 1000;
  }

  if (audioCodec === 'aac' || audioCodec.includes('mp3') || audioCodec.includes('opus')) {
    score += 500;
  }

  const width = Number(video?.width || 0);
  const height = Number(video?.height || 0);

  if (width >= 3840 || height >= 2160) score += 400;
  else if (width >= 1920 || height >= 1080) score += 300;
  else if (width >= 1280 || height >= 720) score += 200;

  return score;
}


async function rdInspectLink(unrestrictedLink) {
  if (!unrestrictedLink) return null;

  const data = await rdUnrestrict(unrestrictedLink);
  if (!data?.download) {
    return null;
  }

  const filename = String(data.filename || "");
  const mimeType = String(data.mimeType || "");
  const lowerName = filename.toLowerCase();

  let mediaInfo = null;
  if (data.id) {
    mediaInfo = await rdGetMediaInfos(data.id);
  }

  const video = firstVideoTrack(mediaInfo);
  const codec = String(video?.codec || "").toLowerCase();
  const container = getMediaContainer(filename, mimeType);

  const looksHevc =
    lowerName.includes("hevc") ||
    lowerName.includes("h.265") ||
    lowerName.includes("h265") ||
    lowerName.includes("x265") ||
    lowerName.includes("av1") ||
    codec.includes("hevc") ||
    codec.includes("h265") ||
    codec.includes("x265") ||
    codec.includes("av1");

  const h264Like =
    lowerName.includes("x264") ||
    lowerName.includes("h.264") ||
    lowerName.includes("h264") ||
    lowerName.includes("avc") ||
    codec.includes("h264") ||
    codec.includes("avc");

  const streamable =
    data.streamable === true ||
    Number(data.streamable) === 1 ||
    String(data.streamable).toLowerCase() === "true";

  const filenameLooksMp4 =
    lowerName.endsWith(".mp4") ||
    mimeType.toLowerCase().includes("video/mp4");

  const filenameLooksWebm =
    lowerName.endsWith(".webm") ||
    mimeType.toLowerCase().includes("video/webm");

  const audioCompatibility = getAudioCompatibility({ filename, mediaInfo });

  const nativeBrowser =
    streamable &&
    !looksHevc &&
    !audioCompatibility.incompatible &&
    (filenameLooksMp4 || filenameLooksWebm) &&
    (h264Like || !mediaInfo || !codec);

  return {
    ...data,
    filename,
    mimeType,
    mediaInfo,
    video,
    codec,
    container,
    looksHevc,
    h264Like,
    streamable,
    filenameLooksMp4,
    filenameLooksWebm,
    audioCompatibility,
    nativeBrowser,
    link: unrestrictedLink,
  };
}

async function rdGetPlayableUrlFromInspection(info) {
  if (!info?.download) return null;

  // 1) Ask RD for transcoding first.
  // HLS is preferred because it works well with the existing web player.
  if (info.id) {
    const transcoded = await rdGetTranscodedLinks(info.id);
    const transcodedPlayable = pickBestTranscodeUrl(transcoded);

    if (transcodedPlayable?.url) {
      console.log(`   🎬 RD transcode: ${transcodedPlayable.type}`);

      return {
        url: transcodedPlayable.url,
        type: transcodedPlayable.type,
        formats: transcoded,
        mediaInfo: info.mediaInfo,
        streamingId: info.id,
        filename: info.filename,
        filesize: Number(info.filesize || 0),
        mimeType: info.mimeType || null,
        native: false,
        link: info.link,
      };
    }
  }

  // 2) No transcode: native MP4/WebM is perfectly valid for streaming.
  // mediaInfos is optional and a 400 must NOT kill a valid MP4.
  if (info.nativeBrowser) {
    console.log(
      `   ✅ Native stream: ${info.filename} | ${info.mimeType || "unknown"}`
    );

    return {
      url: info.download,
      type: info.filenameLooksWebm ? "webm" : "mp4",
      formats: null,
      mediaInfo: info.mediaInfo,
      streamingId: info.id || null,
      filename: info.filename,
      filesize: Number(info.filesize || 0),
      mimeType: info.mimeType || null,
      native: true,
      link: info.link,
    };
  }

  // 3) If RD explicitly says it is streamable and the name is MP4,
  // allow it even when mediaInfos/transcode are unavailable.
  if (
    info.streamable &&
    info.filenameLooksMp4 &&
    !info.looksHevc &&
    !info.audioCompatibility?.incompatible
  ) {
    console.log(
      `   ✅ Streamable MP4 fallback: ${info.filename}`
    );

    return {
      url: info.download,
      type: "mp4",
      formats: null,
      mediaInfo: info.mediaInfo,
      streamingId: info.id || null,
      filename: info.filename,
      filesize: Number(info.filesize || 0),
      mimeType: info.mimeType || "video/mp4",
      native: true,
      link: info.link,
    };
  }

  console.warn(
    `   ❌ No playable stream for ${info.filename || "unknown file"} (${info.container}/${info.codec || "unknown"})`
  );

  return null;
}

async function rdGetPlayableUrl(unrestrictedLink) {
  const info = await rdInspectLink(unrestrictedLink);
  if (!info) return null;
  return rdGetPlayableUrlFromInspection(info);
}

function browserFileScore(info) {
  if (!info) return -10000;

  const name = String(info.filename || "").toLowerCase();
  const codec = String(info.codec || "").toLowerCase();

  let score = 0;

  const isMp4 = info.filenameLooksMp4;
  const isWebm = info.filenameLooksWebm;
  const isMkv = info.container === "mkv" || name.endsWith(".mkv");
  const hevc = info.looksHevc;
  const h264 = info.h264Like;

  if (isMp4) score += 5000;
  else if (isWebm) score += 3500;
  else if (isMkv) score += 1000;
  else score -= 1000;

  if (h264 && !hevc) score += 3000;
  else if (!hevc && (codec.includes("vp9") || codec.includes("vp8"))) score += 2200;
  else if (hevc) score -= 2500;
  else score += 100;

  if (info.nativeBrowser) score += 2500;
  if (info.streamable) score += 1000;
  score += Number(info.audioCompatibility?.score || 0);

  const width = Number(info.video?.width || 0);
  const height = Number(info.video?.height || 0);

  if (width >= 3840 || height >= 2160) score += 400;
  else if (width >= 1920 || height >= 1080) score += 300;
  else if (width >= 1280 || height >= 720) score += 200;

  return score;
}

// Inspect all returned RD links. mediaInfos is optional: if it returns 400,
// filename/mimeType/streamable from unrestrict are still enough to recognize
// a directly streamable MP4/WebM.
async function rdFindBestPlayableLink(torrentInfo) {
  const links = Array.isArray(torrentInfo?.links)
    ? torrentInfo.links
    : [];

  if (!links.length) return null;

  const files = Array.isArray(torrentInfo?.files)
    ? torrentInfo.files
    : [];

  const candidates = [];

  for (let i = 0; i < links.length; i++) {
    const link = links[i];

    try {
      const info = await rdInspectLink(link);

      if (!info) {
        console.log(`   ⚠ Link ${i + 1}: unrestrict failed`);
        continue;
      }

      const fileMeta = files[i] || {};

      if (!info.filename && fileMeta.path) {
        info.filename = fileMeta.path;
      }

      const size = Number(
        info.filesize ||
        fileMeta.bytes ||
        0
      );

      const score = browserFileScore(info);

      candidates.push({
        link,
        info,
        filename: info.filename || fileMeta.path || torrentInfo.filename || "",
        score,
        size,
        index: i,
      });

      console.log(
        `   🔎 [${i + 1}/${links.length}] ${
          info.filename || fileMeta.path || torrentInfo.filename || "unknown"
        } | ${info.codec || "?"} | ${info.video?.width || "?"}x${
          info.video?.height || "?"
        } | ${info.mimeType || "?"} | score ${score}`
      );
    } catch (err) {
      console.warn(
        `   ⚠ Link inspection failed: ${err.message}`
      );
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.size - a.size;
  });

  // The first candidate may not have a playable transcode. Try candidates
  // in score order until one actually produces HLS/MP4/WebM/native playback.
  for (const candidate of candidates) {
    const playable = await rdGetPlayableUrlFromInspection(candidate.info);

    if (playable?.url) {
      return {
        ...playable,
        link: candidate.link,
        filename:
          playable.filename ||
          candidate.filename ||
          torrentInfo.filename,
        filesize:
          playable.filesize ||
          candidate.size ||
          0,
        mediaInfo:
          playable.mediaInfo ||
          candidate.info.mediaInfo ||
          null,
      };
    }
  }

  return null;
}

async function rdResolveBestPlayableLink(torrentInfo) {
  const playable = await rdFindBestPlayableLink(torrentInfo);

  if (!playable) {
    console.log(
      "   ❌ No browser-compatible stream found in this torrent"
    );

    return null;
  }

  console.log(
    `   🎯 Selected: ${playable.filename} | ${playable.type}`
  );

  return playable;
}

function makeStreamProxyUrl({ id, type, season, episode }) {
  const params = new URLSearchParams();
  params.set("id", String(id));
  params.set("type", String(type));

  if (type === "tv") {
    params.set("season", String(season || 1));
    params.set("episode", String(episode || 1));
  }

  return `/api/stream?${params.toString()}`;
}

async function resolveCachedPlayback({ id, type, season, episode }) {
  const cached = await cache.getCache(
    id,
    type,
    season,
    episode
  );

  if (!cached?.hit || !cached.data) {
    return null;
  }

  let playable = null;

  if (cached.data.rd_link) {
    playable = await rdGetPlayableUrl(cached.data.rd_link);
  }

  if (!playable?.url && cached.data.rd_torrent_id) {
    const info = await rdGetTorrentInfo(
      cached.data.rd_torrent_id
    );

    if (info?.status === "downloaded" && info.links?.length) {
      playable = await rdResolveBestPlayableLink(info);
    }
  }

  if (!playable?.url) {
    return null;
  }

  return {
    playable,
    cached,
  };
}

// =============================================================

// OPENSUBTITLES

// =============================================================


function srtToWebVTT(srt) {
  let text = String(srt || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  if (!text) return 'WEBVTT\n\n';

  text = text.replace(
    /(\d{2}:\d{2}:\d{2}),(\d{3})/g,
    '$1.$2'
  );

  const blocks = text.split(/\n{2,}/);
  const out = ['WEBVTT', ''];

  for (const block of blocks) {
    const lines = block.split('\n');
    const timeIndex = lines.findIndex((line) =>
      /^\s*\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(line)
    );

    if (timeIndex < 0) continue;

    const timing = lines[timeIndex].trim();
    const cueText = lines.slice(timeIndex + 1).join('\n').trim();
    if (!cueText) continue;

    out.push(timing);
    out.push(cueText);
    out.push('');
  }

  return out.join('\n');
}


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


    let results = searchRes.status === 200 && Array.isArray(searchRes.data?.data)
      ? searchRes.data.data
      : [];

    let candidates = results.filter(s => Array.isArray(languages)
      ? languages.includes(s.attributes?.language) && s.attributes?.files?.length
      : s.attributes?.language === languages && s.attributes?.files?.length);

    // Fallback: some titles have imperfect TMDB linkage in OpenSubtitles.
    // Retry by title/year for movies or by title for TV if the exact TMDB lookup is empty.
    if (!candidates.length && title) {
      const fallbackQuery = encodeURIComponent(year ? `${title} ${year}` : title);
      const fallbackLanguages = Array.isArray(languages) && languages.includes('ar') ? ['en'] : ['ar'];
      const fallbackUrl =
        `${OS_BASE}/subtitles?query=${fallbackQuery}` +
        `&languages=${fallbackLanguages.join(',')}` +
        `&order_by=download_count` +
        `&order_direction=desc`;

      const fallbackRes = await fetchURL(fallbackUrl, {
        headers: {
          'Api-Key': OS_API_KEY,
          'User-Agent': 'BlueStream v1.0',
          'Accept': 'application/json',
        },
        timeout: 12000,
      });

      results = fallbackRes.status === 200 && Array.isArray(fallbackRes.data?.data)
        ? fallbackRes.data.data
        : [];

      candidates = results.filter(s => s.attributes?.language === 'ar' && s.attributes?.files?.length);
    }

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


    const srtContent = typeof srtRes.data === 'string'
      ? srtRes.data
      : String(srtRes.data);

    const webvtt = srtToWebVTT(srtContent);
    const subtitleBase64 = Buffer.from(webvtt, 'utf8').toString('base64');
    const dataUrl = `data:text/vtt;charset=utf-8;base64,${subtitleBase64}`;

    const language = top.attributes?.language || 'ar';
    const label = language === 'ar' ? 'العربية' : (language === 'en' ? 'English' : language);

    return {
      url: dataUrl,
      language,
      label,
      source: 'opensubtitles',
      format: 'vtt',
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
    // Never trust a previously cached RD playback URL.
    // Re-unrestrict the original RD link so the player receives a fresh URL.
    let playable = null;

    if (cached.data?.rd_link) {
      playable = await rdGetPlayableUrl(cached.data.rd_link);
    }

    if (playable?.url) {
      const subtitle = withSubs ? await searchOpenSubtitles({
        tmdbId: parseInt(id),
        type,
        season: sNum,
        episode: eNum,
        title: cached.data.title,
        year: cached.data.year,
      }) : null;

      return {
        success: true,
        provider: `real-debrid+${cached.data.source || 'cache'}`,
        quality: cached.data.quality,
        title: cached.data.title,
        year: cached.data.year,
        filename: playable.filename || cached.data.filename,
        stream_url: playable.type === "mp4" ? makeStreamProxyUrl({ id, type, season: sNum, episode: eNum }) : playable.url,
        stream_type: "mp4",
        subtitle,
        subtitles: subtitle ? [subtitle.url] : [],
        size_mb: Math.round((playable.filesize || cached.data.file_size_bytes || 0) / 1024 / 1024),
        seeds: cached.data.seeds || 0,
        poster: cached.data.poster_path ? `https://image.tmdb.org/t/p/w500${cached.data.poster_path}` : null,
        backdrop: cached.data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${cached.data.backdrop_path}` : null,
        cached: true,
        refreshed: true,
      };
    }

    console.log('   ⚠ Cached RD link is no longer playable; continuing with torrent search...');
  }

  // 2) Re-unrestrict

  if (cached.hit && !cached.fresh && cached.data?.magnet) {
    try {
      let playable = null;

      if (cached.data.rd_link) {
        playable = await rdGetPlayableUrl(cached.data.rd_link);
      }

      if (!playable?.url && cached.data.rd_torrent_id) {
        const info = await rdGetTorrentInfo(cached.data.rd_torrent_id);

        if (info?.status === 'downloaded' && info.links?.length) {
          const resolved = await rdResolveBestPlayableLink(info);

          if (resolved?.url) playable = resolved;
        }
      }

      if (!playable?.url) {
        const added = await rdAddMagnet(cached.data.magnet);

        if (added?.id) {
          await rdSelectFiles(added.id, 'all');

          const info = await rdWaitForTorrent(added.id, 180000);

          if (info?.links?.length) {
            const resolved = await rdResolveBestPlayableLink(info);

            if (resolved?.url) playable = resolved;
          }
        }
      }

      if (playable?.url) {
        await cache.setCache({
          tmdb_id: parseInt(id),
          media_type: type,
          season: sNum,
          episode: eNum,
          title: cached.data.title,
          year: cached.data.year,
          stream_url: playable.type === "mp4" ? makeStreamProxyUrl({ id, type, season: sNum, episode: eNum }) : playable.url,
          stream_type: playable.type === "mp4" ? "mp4-proxy" : playable.type,
          rd_torrent_id: cached.data.rd_torrent_id,
          rd_link: playable.link || cached.data.rd_link,
          magnet: cached.data.magnet,
          source: cached.data.source,
          status: 'ready',
          file_size_bytes: playable.filesize || cached.data.file_size_bytes,
          quality: cached.data.quality,
          filename: playable.filename || cached.data.filename,
          seeds: cached.data.seeds,
          poster_path: cached.data.poster_path,
          backdrop_path: cached.data.backdrop_path,
        });

        const subtitle = withSubs ? await searchOpenSubtitles({
          tmdbId: parseInt(id),
          type,
          season: sNum,
          episode: eNum,
          title: cached.data.title,
          year: cached.data.year,
        }) : null;

        return {
          success: true,
          provider: `real-debrid+${cached.data.source || 'cache'}`,
          quality: cached.data.quality,
          title: cached.data.title,
          stream_url: playable.type === "mp4" ? makeStreamProxyUrl({ id, type, season: sNum, episode: eNum }) : playable.url,
          stream_type: playable.type === "mp4" ? "mp4-proxy" : playable.type,
          subtitle,
          subtitles: subtitle ? [subtitle.url] : [],
          poster: cached.data.poster_path ? `https://image.tmdb.org/t/p/w500${cached.data.poster_path}` : null,
          backdrop: cached.data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${cached.data.backdrop_path}` : null,
          cached: true,
          refreshed: true,
        };
      }
    } catch (err) {
      console.warn('re-unrestrict failed:', err.message);
    }
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


    // Inspect all returned files through mediaInfos and choose the
    // most browser-friendly one (MP4/H264 first), rather than simply
    // choosing the largest MKV.
    const playable = await rdResolveBestPlayableLink(torrentInfo);

    if (!playable?.url) {
      console.log(`   ❌ No browser-compatible RD stream for this torrent`);
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

      rd_torrent_id: added.id, rd_link: playable.link,

      stream_url: playable.url, stream_type: playable.type,

      filename: playable.filename || torrentInfo.filename,

      file_size_bytes: playable.filesize || torrent.size || 0, quality: torrent.quality,

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

      filename: playable.filename || torrentInfo.filename,

      stream_url: playable.url,

      stream_type: playable.type,

      subtitle, subtitles: subtitle ? [subtitle.url] : [],

      size_mb: Math.round((playable.filesize || torrent.size || 0) / 1024 / 1024),

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


app.get("/api/stream", async (req, res) => {

  const { id, type, season, episode } = req.query;

  if (!id || !type) {
    return res.status(400).json({
      success: false,
      error: "Missing id or type"
    });
  }

  const sNum = type === "tv" ? parseInt(season || 1, 10) : null;
  const eNum = type === "tv" ? parseInt(episode || 1, 10) : null;

  try {
    // IMPORTANT: /api/stream is hit repeatedly by HTML5 Range requests.
    // It must NOT call mediaInfos/transcode/torrent inspection.
    const cached = await cache.getCache(id, type, sNum, eNum);

    if (!cached?.hit || !cached.data) {
      return res.status(404).json({
        success: false,
        error: "stream_cache_not_found"
      });
    }

    let rdLink = cached.data.rd_link || null;

    // Recover a source link only when the cache is missing one.
    if (!rdLink && cached.data.rd_torrent_id) {
      const torrentInfo = await rdGetTorrentInfo(cached.data.rd_torrent_id);

      if (
        torrentInfo?.status === "downloaded" &&
        Array.isArray(torrentInfo.links) &&
        torrentInfo.links.length
      ) {
        rdLink = torrentInfo.links[0];
      }
    }

    if (!rdLink) {
      return res.status(404).json({
        success: false,
        error: "rd_link_not_found"
      });
    }

    // Cache the fresh direct RD URL for a short period so multiple Range
    // requests do not hammer the Real-Debrid unrestrict endpoint.
    let fresh = getFreshStreamCache(rdLink);

    if (!fresh) {
      const unrestricted = await rdUnrestrict(rdLink);

      if (unrestricted?.download) {
        fresh = {
          downloadURL: unrestricted.download,
          mimeType: unrestricted.mimeType || "video/mp4",
          filename: unrestricted.filename || cached.data.filename || "video.mp4"
        };

        setFreshStreamCache(rdLink, fresh);
      } else if (cached.data.rd_torrent_id) {
        // One recovery attempt if the old source link expired.
        const torrentInfo = await rdGetTorrentInfo(cached.data.rd_torrent_id);

        if (
          torrentInfo?.status === "downloaded" &&
          Array.isArray(torrentInfo.links) &&
          torrentInfo.links.length
        ) {
          const fallbackLink = torrentInfo.links[0];
          const fallback = await rdUnrestrict(fallbackLink);

          if (fallback?.download) {
            rdLink = fallbackLink;
            fresh = {
              downloadURL: fallback.download,
              mimeType: fallback.mimeType || "video/mp4",
              filename: fallback.filename || cached.data.filename || "video.mp4"
            };

            setFreshStreamCache(rdLink, fresh);
          }
        }
      }
    }

    if (!fresh?.downloadURL) {
      return res.status(410).json({
        success: false,
        error: "real_debrid_link_expired"
      });
    }

    const parsed = new URL(fresh.downloadURL);
    const lib = parsed.protocol === "https:" ? https : http;

    const headers = {
      "User-Agent": BROWSER_HEADERS["User-Agent"],
      Accept: "*/*",
      Connection: "keep-alive"
    };

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const proxy = lib.request(
      {
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers,
        timeout: 30000
      },
      (proxyRes) => {
        const passthrough = [
          "content-type",
          "content-length",
          "content-range",
          "accept-ranges",
          "etag",
          "last-modified",
          "cache-control"
        ];

        for (const header of passthrough) {
          const value = proxyRes.headers[header];
          if (value !== undefined) {
            res.setHeader(header, value);
          }
        }

        if (!res.getHeader("Content-Type")) {
          res.setHeader(
            "Content-Type",
            fresh.mimeType || "video/mp4"
          );
        }

        res.setHeader("Accept-Ranges", "bytes");
        res.status(proxyRes.statusCode || 502);
        proxyRes.pipe(res);
      }
    );

    proxy.on("timeout", () => {
      proxy.destroy(new Error("Real-Debrid stream timeout"));
    });

    proxy.on("error", (err) => {
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          error: "stream_proxy_error",
          message: err.message
        });
      } else {
        res.destroy(err);
      }
    });

    req.on("close", () => {
      if (!res.writableEnded) {
        proxy.destroy();
      }
    });

    proxy.end();
  } catch (err) {
    console.error("❌ /api/stream error:", err.message);

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
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

    if (result.success) {
      // When the player frontend is hosted on a different domain than Railway,
      // a relative /api/stream URL would incorrectly point to the frontend host.
      // Convert local stream-proxy URLs into absolute Railway/API URLs.
      if (typeof result.stream_url === "string" && result.stream_url.startsWith("/")) {
        const forwardedProto = req.headers["x-forwarded-proto"];
        const forwardedHost = req.headers["x-forwarded-host"];

        const protocol = forwardedProto
          ? String(forwardedProto).split(",")[0].trim()
          : (req.protocol || "https");

        const host = forwardedHost
          ? String(forwardedHost).split(",")[0].trim()
          : req.get("host");

        result.stream_url = `${protocol}://${host}${result.stream_url}`;
      }

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

    status: "✅ BlueStream API v7.6.2 (Streaming + Real-Debrid + Transcode)",

    version: "7.6.2",

    features: ["Torrentio aggregator", "Real-Debrid streaming", "mediaInfos optional", "HLS first", "MP4/H264 priority", "automatic Arabic subtitles", "fresh stream proxy"],

    sources: ["1337x", "ThePirateBay", "RARBG", "TorrentGalaxy", "YTS", "EZTV", "NyaaSi", "AniDex", "MagnetDL", "Limetorrent", "Torrent9", "ilCorSaRoNeRo", "Rutracker", "Comando", "BluDV", "+10 more"],

    endpoints: {

      play: "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1&with_subs=1",

      subtitles: "/api/subtitles?tmdb_id=...&type=movie&title=...",
      stream: "/api/stream?id={tmdb_id}&type={movie|tv}&season=1&episode=1",

    },

  });

});


app.listen(PORT, "0.0.0.0", () => {

  console.log(`\n🎬 BlueStream API v7.6.2 running on port ${PORT}`);

  console.log(`✅ RD Token: ${RD_TOKEN ? 'Loaded' : 'MISSING'}`);

  console.log(`✅ TMDB Key: ${TMDB_KEY ? 'Loaded' : 'MISSING'}`);

  console.log(`✅ OpenSubtitles: ${OS_API_KEY ? 'Loaded' : 'MISSING'}`);

  console.log(`✅ Torrentio: configured`);

});

