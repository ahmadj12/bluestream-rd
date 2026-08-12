// server.js — Real-Debrid + OpenSubtitles + Torrentio (25+ source aggregator)

// v8.0.0: إصلاح شامل من الجذور

//   - fetchURL مع Content-Length + logging مفصّل

//   - rdAddMagnet موثوق + تحديد حجم المغناطيس

//   - HLS-first بشكل ذكي (صوت AAC مضمون)

//   - mediaInfos/transcode fallback chain محسّن

//   - cache validation: التحقق من تطابق العنوان

//   - error reporting كامل في الاستجابة


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

app.use(express.json({ limit: '10mb' }));

app.use(express.urlencoded({ limit: '10mb', extended: true }));


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


const BROWSER_HEADERS = {

  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',

  'Accept-Language': 'en-US,en;q=0.5',

  'Connection': 'keep-alive',

  'Upgrade-Insecure-Requests': '1',

};


// =============================================================

// fetchURL — نسخة محسّنة (Content-Length, error logging)

// =============================================================

function fetchURL(url, options = {}) {

  return new Promise((resolve, reject) => {

    try {

      const parsed = new URL(url);

      const isHttps = parsed.protocol === 'https:';

      const lib = isHttps ? https : http;


      const headers = { ...BROWSER_HEADERS, ...(options.headers || {}) };


      // حساب Content-Length إذا فيه body (مهم لـ RD API)

      if (options.body && !headers['Content-Length']) {

        const body = options.body;

        const bodyLength = Buffer.byteLength(body, 'utf8');

        headers['Content-Length'] = bodyLength;

      }


      const reqOpts = {

        method: options.method || 'GET',

        hostname: parsed.hostname,

        port: parsed.port || (isHttps ? 443 : 80),

        path: parsed.pathname + parsed.search,

        headers,

        timeout: options.timeout || 15000,

      };


      // حذف Accept-Encoding لتجنب الاستجابة المضغوطة

      delete reqOpts.headers['Accept-Encoding'];


      const req = lib.request(reqOpts, (res) => {

        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));

        res.on('end', () => {

          const raw = Buffer.concat(chunks).toString('utf8');

          let data;

          try {

            data = raw ? JSON.parse(raw) : null;

          } catch {

            data = raw;

          }

          resolve({ status: res.statusCode, data, raw });

        });

      });


      req.on('timeout', () => {

        req.destroy(new Error('Request timeout'));

      });


      req.on('error', (err) => {

        reject(err);

      });


      if (options.body) {

        req.write(options.body, 'utf8');

      }

      req.end();

    } catch (err) {

      reject(err);

    }

  });

}


// Short-lived cache for fresh Real-Debrid direct URLs.

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


// =============================================================

// TMDB

// =============================================================

async function getTMDBMeta(id, type) {

  try {

    const path = type === 'movie' ? 'movie' : 'tv';

    const url = `https://api.themoviedb.org/3/${path}/${id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=external_ids`;

    const response = await fetchURL(url, { timeout: 10000 });

    return response.status === 200 ? response.data : null;

  } catch {

    return null;

  }

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

// Torrentio — 25+ مصدر

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


      const sourceMatch = title.match(/⚙️\s*([^\n🇬🇧🇸🇦🇪🇸🇫🇷🇩🇪🇮🇹🇯🇵🇰🇷🇨🇳🇷🇺🇵🇹🇮🇳]+)/);

      const source = sourceMatch ? sourceMatch[1].trim() : "torrentio";


      const sizeMatch = title.match(/💾\s*([\d.]+\s*[GMK]B)/);

      const sizeStr = sizeMatch ? sizeMatch[1] : "";


      const magnet = buildMagnet(stream.infoHash, title, stream.sources || []);


      results.push({

        name: title.split('\n')[0] || title,

        title,

        url_path: null,

        magnet,

        quality,

        size_str: sizeStr,

        size: parseSize(sizeStr),

        seeds: 0,

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


// =============================================================

// buildMagnet — مع تحديد الحجم (max 2KB لتفادي رفض RD)

// =============================================================

function buildMagnet(infoHash, title, trackers) {

  // trackers افتراضية قوية وسريعة

  const defaultTrackers = [

    "udp://tracker.opentrackr.org:1337/announce",

    "udp://open.demonii.com:1337/announce",

    "udp://tracker.openbittorrent.com:80/announce",

    "udp://exodus.desync.com:6969/announce",

    "udp://open.stealth.si:80/announce",

    "udp://tracker.torrent.eu.org:451/announce",

  ];


  // تحديد عدد trackers من Torrentio (الأكثر أولوية) — max 6

  const torrentioTrackers = (trackers || [])

    .filter(s => typeof s === 'string' && s.startsWith('tracker:'))

    .map(s => s.replace('tracker:', ''))

    .slice(0, 6);


  // دمج وإزالة المكرر، max 8 trackers

  const allTrackers = [...new Set([...torrentioTrackers, ...defaultTrackers])].slice(0, 8);


  // اسم قصير (max 80 حرف لتفادي مغناطيس ضخم)

  const shortName = (title.split('\n')[0] || "video").slice(0, 80);

  const encodedName = encodeURIComponent(shortName);


  // بناء المغناطيس

  const tr = allTrackers.map(t => `&tr=${encodeURIComponent(t)}`).join('');

  let magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodedName}${tr}`;


  // ضمان أن المغناطيس ليس ضخماً — RD يقبل حتى 4KB لكن الأمان 2KB

  if (magnet.length > 2000) {

    // إزالة بعض trackers

    const reducedTrackers = allTrackers.slice(0, 4);

    const reducedTr = reducedTrackers.map(t => `&tr=${encodeURIComponent(t)}`).join('');

    magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodedName}${reducedTr}`;

  }


  return magnet;

}


// =============================================================

// الجودة: ترتيب حسب اللي يشتغل في المتصفح

// =============================================================

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

// REAL-DEBRID — نسخة محسّنة مع error reporting

// =============================================================

async function rdAddMagnet(magnet) {

  try {

    if (!magnet || typeof magnet !== 'string') {

      console.warn('   ❌ rdAddMagnet: magnet is empty/invalid');

      return null;

    }


    const response = await fetchURL('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {

      method: 'POST',

      body: `magnet=${encodeURIComponent(magnet)}`,

      headers: {

        'Content-Type': 'application/x-www-form-urlencoded',

        'Authorization': `Bearer ${RD_TOKEN}`,

      },

      timeout: 15000,

    });


    if (response.status === 200 || response.status === 201) {

      return response.data;

    }


    // log الخطأ الفعلي

    console.warn(`   ❌ RD addMagnet HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 300)}`);

    return null;

  } catch (err) {

    console.warn(`   ❌ rdAddMagnet error: ${err.message}`);

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

  } catch {

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

  } catch {

    return null;

  }

}


async function rdWaitForTorrent(torrentId, maxWaitMs = 240000) {

  const start = Date.now();

  let lastStatus = '';

  while (Date.now() - start < maxWaitMs) {

    const info = await rdGetTorrentInfo(torrentId);

    if (info) {

      if (info.status !== lastStatus) {

        console.log(`   ⏳ Torrent status: ${info.status}`);

        lastStatus = info.status;

      }

      if (info.status === 'downloaded') return info;

      if (info.status === 'waiting_files_selection') await rdSelectFiles(torrentId, 'all');

      if (['error', 'magnet_error', 'virus', 'dead'].includes(info.status)) {

        console.warn(`   ❌ Torrent failed: ${info.status}`);

        return null;

      }

    }

    await new Promise(r => setTimeout(r, 3000));

  }

  console.warn(`   ⏱ Torrent timeout after ${maxWaitMs / 1000}s`);

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

    if (response.status === 200 || response.status === 201) {

      return response.data;

    }

    console.warn(`   ❌ RD unrestrict HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 200)}`);

    return null;

  } catch (err) {

    console.warn(`   ❌ rdUnrestrict error: ${err.message}`);

    return null;

  }

}


// =============================================================

// RD mediaInfos + transcode

// =============================================================

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

      // 400 يعني الـ ID قديم/غير مدعوم — لا نريد ان نوقف البحث

      return null;

    }

    return response.data;

  } catch {

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

      return null;

    }

    return response.data;

  } catch {

    return null;

  }

}


// =============================================================

// Media analysis — استخراج codec/container/audio

// =============================================================

function firstVideoTrack(mediaInfo) {

  const videos = mediaInfo?.details?.video;

  if (!videos || typeof videos !== 'object') return null;

  const first = Object.values(videos).find(v => v && typeof v === 'object');

  return first || null;

}


function allAudioTracks(mediaInfo) {

  const audios = mediaInfo?.details?.audio;

  if (!audios || typeof audios !== 'object') return [];

  return Object.values(audios).filter(v => v && typeof v === 'object');

}


function normalizeCodec(codec) {

  return String(codec || '').toLowerCase().replace(/[.\s_-]/g, '');

}


function getAudioCompatibility({ filename = '', mediaInfo = null } = {}) {

  const name = String(filename).toLowerCase();

  const tracks = allAudioTracks(mediaInfo);

  const first = tracks[0] || null;

  const codec = normalizeCodec(first?.codec);


  const explicitGood = /(aac|mp4a|he-aac|lc-aac|\bmp3\b|opus)/i.test(name);

  const explicitBad = /(truehd|dts[- .]?hd|\bdts\b|eac3|e-ac-3|\bac3\b|\bddp\b|dolby[ .-]?digital|\batmos\b|flac)/i.test(name);


  const goodCodec = /^(aac|mp3|opus|mp4a)/.test(codec);

  const badCodec = /^(ac3|eac3|ec3|ddp|dolbydigital|truehd|dts|dtshd|flac)/.test(codec);


  if (goodCodec || explicitGood) {

    return { score: 1200, incompatible: false, codec: codec || null };

  }


  if (badCodec || explicitBad) {

    return { score: -3000, incompatible: true, codec: codec || null };

  }


  return { score: 0, incompatible: false, codec: codec || null };

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


// استخراج URLs من response transcode (recursive)

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


  // HLS أولاً (يضمن صوت AAC)

  const hlsUrls = collectUrls(transcoded.apple);

  if (hlsUrls.length) {

    const full = hlsUrls.find(u => /full\.m3u8/i.test(u));

    const m3u8 = hlsUrls.find(u => /\.m3u8(?:$|\?)/i.test(u));

    if (full || m3u8 || hlsUrls[0]) {

      return { url: full || m3u8 || hlsUrls[0], type: 'hls' };

    }

  }


  // MP4 مباشر

  const mp4Urls = collectUrls(transcoded.liveMP4);

  if (mp4Urls.length) {

    return { url: mp4Urls[0], type: 'mp4' };

  }


  // H264 WebM

  const webmUrls = collectUrls(transcoded.h264WebM);

  if (webmUrls.length) {

    return { url: webmUrls[0], type: 'webm' };

  }


  // DASH

  const dashUrls = collectUrls(transcoded.dash);

  if (dashUrls.length) {

    const mpd = dashUrls.find(u => /\.mpd(?:$|\?)/i.test(u));

    return { url: mpd || dashUrls[0], type: 'dash' };

  }


  // legacy formats

  const legacyHls = collectUrls(transcoded.hls);

  if (legacyHls.length) {

    return { url: legacyHls.find(u => /\.m3u8(?:$|\?)/i.test(u)) || legacyHls[0], type: 'hls' };

  }

  const legacyMp4 = collectUrls(transcoded.mp4);

  if (legacyMp4.length) {

    return { url: legacyMp4[0], type: 'mp4' };

  }

  const legacyWebm = collectUrls(transcoded.webm);

  if (legacyWebm.length) {

    return { url: legacyWebm[0], type: 'webm' };

  }


  return null;

}


// =============================================================

// rdInspectLink — محسّن مع cache للـ transcode

// =============================================================


// Cache للـ streaming IDs الناجحة لكل torrent

const transcodedCache = new Map(); // key: torrentId:fileId → { mediaInfo, transcoded }


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


// =============================================================

// rdGetPlayableUrlFromInspection — HLS-first بشكل ذكي

// =============================================================

async function rdGetPlayableUrlFromInspection(info) {

  if (!info?.download) return null;


  // 1) transcode أولاً (HLS يضمن AAC audio)

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

        needsProxy: transcodedPlayable.type === 'mp4', // MP4 عبر proxy لتفادي CORS

      };

    }

    console.log(`   ⚠ Transcode غير متاح لـ ${info.id} — نجرّب native`);

  }


  // 2) Native MP4/WebM

  if (info.nativeBrowser) {

    console.log(`   ✅ Native stream: ${info.filename} | ${info.mimeType || "unknown"}`);


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

      needsProxy: true, // MP4/WebM direct → نمرّر عبر proxy

    };

  }


  // 3) Fallback: streamable MP4

  if (

    info.streamable &&

    info.filenameLooksMp4 &&

    !info.looksHevc &&

    !info.audioCompatibility?.incompatible

  ) {

    console.log(`   ✅ Streamable MP4 fallback: ${info.filename}`);


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

      needsProxy: true,

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


// =============================================================

// rdFindBestPlayableLink — يجرب كل الملفات حتى يلاقي playable

// =============================================================

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

        `   🔎 [${i + 1}/${links.length}] ${(info.filename || fileMeta.path || "?").slice(0, 50)} | ${info.codec || "?"} | ${info.video?.width || "?"}x${info.video?.height || "?"} | score ${score}`

      );

    } catch (err) {

      console.warn(`   ⚠ Link inspection failed: ${err.message}`);

    }

  }


  if (!candidates.length) return null;


  candidates.sort((a, b) => {

    if (b.score !== a.score) return b.score - a.score;

    return b.size - a.size;

  });


  // نجرب كل candidates بالترتيب حتى يلاقي واحد playable

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

    console.log("   ❌ No browser-compatible stream found in this torrent");

    return null;

  }


  console.log(`   🎯 Selected: ${playable.filename} | ${playable.type}`);


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


// =============================================================

// OpenSubtitles — نسخة محسّنة

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


  // منطق مبسّط: 3 استعلامات (ar → en) مع fallback ذكي

  const languages = ['ar', 'en'];

  for (const lang of languages) {

    try {

      let candidates = [];


      // 1) محاولة بـ TMDB ID

      if (tmdbId) {

        const tmdbParam = type === 'movie'

          ? `tmdb_id=${tmdbId}`

          : `tmdb_id=${tmdbId}&season_number=${season || 1}&episode_number=${episode || 1}`;

        const searchUrl = `${OS_BASE}/subtitles?${tmdbParam}&languages=${lang}&order_by=download_count&order_direction=desc`;


        try {

          const searchRes = await fetchURL(searchUrl, {

            headers: {

              'Api-Key': OS_API_KEY,

              'User-Agent': 'BlueStream v1.0',

              'Accept': 'application/json',

            },

            timeout: 12000,

          });


          if (searchRes.status === 200 && Array.isArray(searchRes.data?.data)) {

            candidates = searchRes.data.data.filter(s =>

              s.attributes?.language === lang && s.attributes?.files?.length

            );

          }

        } catch {}

      }


      // 2) Fallback: search by title

      if (!candidates.length && title) {

        const query = encodeURIComponent(year ? `${title} ${year}` : title);

        const searchUrl = `${OS_BASE}/subtitles?query=${query}&languages=${lang}&order_by=download_count&order_direction=desc`;


        try {

          const searchRes = await fetchURL(searchUrl, {

            headers: {

              'Api-Key': OS_API_KEY,

              'User-Agent': 'BlueStream v1.0',

              'Accept': 'application/json',

            },

            timeout: 12000,

          });


          if (searchRes.status === 200 && Array.isArray(searchRes.data?.data)) {

            candidates = searchRes.data.data.filter(s =>

              s.attributes?.language === lang && s.attributes?.files?.length

            );

          }

        } catch {}

      }


      if (!candidates.length) continue;


      // جرّب أول 3 نتائج للعثور على SRT صالح

      for (let i = 0; i < Math.min(3, candidates.length); i++) {

        const top = candidates[i];

        const fileId = top.attributes?.files?.[0]?.file_id;

        if (!fileId) continue;


        try {

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


          if (dlRes.status !== 200 || !dlRes.data?.link) continue;


          const srtRes = await fetchURL(dlRes.data.link, { timeout: 15000 });

          if (srtRes.status !== 200 || !srtRes.data) continue;


          const srtContent = typeof srtRes.data === 'string'

            ? srtRes.data

            : String(srtRes.data);


          const webvtt = srtToWebVTT(srtContent);


          // إذا كانت النتيجة < 200 bytes، فهي تالفة

          if (webvtt.length < 200) continue;


          const subtitleBase64 = Buffer.from(webvtt, 'utf8').toString('base64');

          const dataUrl = `data:text/vtt;charset=utf-8;base64,${subtitleBase64}`;


          return {

            url: dataUrl,

            language: lang,

            label: lang === 'ar' ? 'العربية' : 'English',

            source: 'opensubtitles',

            format: 'vtt',

            release: top.attributes?.release || '',

          };

        } catch (err) {

          // جرّب التالي

          continue;

        }

      }

    } catch (err) {

      console.warn(`OS error (${lang}):`, err.message);

      continue;

    }

  }


  return null;

}


// =============================================================

// tryGetStream — الجلب الرئيسي مع cache validation

// =============================================================

async function tryGetStream({ id, type, sNum, eNum, withSubs }) {

  // 1) Cache check

  const cached = await cache.getCache(id, type, sNum, eNum);


  if (cached.hit && cached.data) {

    // تحقق من أن الـ cache يطابق الفيلم المطلوب

    // (في بعض الحالات الـ cache قد يكون لـ movie مختلف بسبب خطأ سابق)

    const cacheValid = await isCacheValidForRequest(cached.data, id, type, sNum, eNum);


    if (cacheValid) {

      let playable = null;


      if (cached.data.rd_link) {

        playable = await rdGetPlayableUrl(cached.data.rd_link);

      }


      // fallback: جلب من torrent ID

      if (!playable?.url && cached.data.rd_torrent_id) {

        const info = await rdGetTorrentInfo(cached.data.rd_torrent_id);

        if (info?.status === 'downloaded' && info.links?.length) {

          playable = await rdResolveBestPlayableLink(info);

        }

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


        // حفظ stream_url محدّث

        const finalStreamUrl = playable.type === "mp4" && playable.needsProxy

          ? makeStreamProxyUrl({ id, type, season: sNum, episode: eNum })

          : playable.url;


        if (playable.type === "mp4" && playable.needsProxy) {

          await cache.setCache({

            ...cached.data,

            stream_url: finalStreamUrl,

            stream_type: "mp4-proxy",

            rd_link: playable.link || cached.data.rd_link,

          });

        }


        return {

          success: true,

          provider: `real-debrid+${cached.data.source || 'cache'}`,

          quality: cached.data.quality,

          title: cached.data.title,

          year: cached.data.year,

          filename: playable.filename || cached.data.filename,

          stream_url: finalStreamUrl,

          stream_type: playable.type === "mp4" && playable.needsProxy ? "mp4-proxy" : playable.type,

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


      console.log('   ⚠ Cached RD link is no longer playable; will re-fetch...');

      // الـ cache قديم — نحذفه

      try {

        await cache.invalidateEntry(id, type, sNum, eNum);

      } catch {}

    } else {

      console.log('   ⚠ Cache mismatch — حذف الـ cache الفاسد');

      try {

        await cache.invalidateEntry(id, type, sNum, eNum);

      } catch {}

    }

  }


  // 2) Fresh fetch

  const meta = await getTMDBMeta(id, type);

  if (!meta) return { success: false, error: "TMDB not found" };


  const displayTitle = meta.title || meta.name || meta.original_title || meta.original_name;

  const year = (meta.release_date || meta.first_air_date || '').slice(0, 4);

  const poster = meta.poster_path ? `https://image.tmdb.org/t/p/w500${meta.poster_path}` : null;

  const backdrop = meta.backdrop_path ? `https://image.tmdb.org/t/p/w1280${meta.backdrop_path}` : null;


  console.log(`\n🎬 ${displayTitle} (${year || "?"}) | ${type} S${sNum || 1}E${eNum || 1}`);


  const imdbId = meta.imdb_id || meta.external_ids?.imdb_id;

  if (!imdbId) {

    return { success: false, error: "IMDB ID not found for this title" };

  }

  console.log(`   📺 IMDB: ${imdbId}`);


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

      console.log(`   ❌ Failed to add (continuing...)`);

      continue;

    }

    console.log(`   ✓ Added to RD: ${added.id}`);


    await rdSelectFiles(added.id, 'all');


    const torrentInfo = await rdWaitForTorrent(added.id, 180000);

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


    const playable = await rdResolveBestPlayableLink(torrentInfo);

    if (!playable?.url) {

      console.log(`   ❌ No browser-compatible RD stream for this torrent`);

      continue;

    }


    console.log(`   ✅ Got stream URL (${playable.type})!`);


    // بناء stream URL النهائي

    const finalStreamUrl = playable.type === "mp4" && playable.needsProxy

      ? makeStreamProxyUrl({ id, type, season: sNum, episode: eNum })

      : playable.url;


    await cache.setCache({

      tmdb_id: parseInt(id),

      media_type: type,

      season: sNum,

      episode: eNum,

      title: displayTitle,

      year,

      original_title: meta.original_title || meta.original_name,

      overview: meta.overview,

      poster_path: meta.poster_path,

      backdrop_path: meta.backdrop_path,

      runtime: meta.runtime || (meta.episode_run_time?.[0]) || null,

      vote_average: meta.vote_average,

      genres: meta.genres?.map(g => g.name).join(', ') || null,

      rd_torrent_id: added.id,

      rd_link: playable.link,

      stream_url: finalStreamUrl,

      stream_type: playable.type === "mp4" && playable.needsProxy ? "mp4-proxy" : playable.type,

      filename: playable.filename || torrentInfo.filename,

      file_size_bytes: playable.filesize || torrent.size || 0,

      quality: torrent.quality,

      source: torrent.source,

      magnet: torrent.magnet,

      seeds: torrent.seeds || 0,

      info_hash: torrent.infoHash,

      status: 'ready',

    });


    const subtitle = withSubs ? await searchOpenSubtitles({

      tmdbId: parseInt(id),

      type,

      season: sNum,

      episode: eNum,

      title: displayTitle,

      year,

    }) : null;


    return {

      success: true,

      provider: `real-debrid+${torrent.source}`,

      quality: torrent.quality,

      title: displayTitle,

      year,

      filename: playable.filename || torrentInfo.filename,

      stream_url: finalStreamUrl,

      stream_type: playable.type === "mp4" && playable.needsProxy ? "mp4-proxy" : playable.type,

      subtitle,

      subtitles: subtitle ? [subtitle.url] : [],

      size_mb: Math.round((playable.filesize || torrent.size || 0) / 1024 / 1024),

      seeds: torrent.seeds || 0,

      poster,

      backdrop,

      cached: false,

    };

  }


  return { success: false, error: `فشل تحميل أي من ${torrents.length} torrents` };

}


// =============================================================

// cache validation — يحذف cache قديم/فاسد

// =============================================================

async function isCacheValidForRequest(cachedData, requestedId, requestedType, requestedSeason, requestedEpisode) {

  if (!cachedData) return false;


  // تطابق TMDB ID والنوع

  const idMatch = Number(cachedData.tmdb_id) === Number(requestedId);

  const typeMatch = String(cachedData.media_type) === String(requestedType);


  if (!idMatch || !typeMatch) return false;


  // للمسلسلات: تطابق الموسم/الحلقة

  if (requestedType === 'tv') {

    const sMatch = Number(cachedData.season || 1) === Number(requestedSeason || 1);

    const eMatch = Number(cachedData.episode || 1) === Number(requestedEpisode || 1);

    if (!sMatch || !eMatch) return false;

  }


  // يجب أن يكون status = ready

  if (cachedData.status && cachedData.status !== 'ready') return false;


  // يجب أن يكون فيه rd_link أو rd_torrent_id

  if (!cachedData.rd_link && !cachedData.rd_torrent_id) return false;


  return true;

}


// =============================================================

// ENDPOINTS

// =============================================================


app.get("/api/subtitles", async (req, res) => {

  const { tmdb_id, type, season, episode, title, year } = req.query;

  if (!tmdb_id && !title) return res.status(400).json({ success: false, error: "Missing tmdb_id or title" });


  try {

    const sub = await searchOpenSubtitles({

      tmdbId: tmdb_id ? parseInt(tmdb_id) : null,

      type,

      season,

      episode,

      title,

      year,

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

    const cached = await cache.getCache(id, type, sNum, eNum);


    if (!cached?.hit || !cached.data) {

      return res.status(404).json({

        success: false,

        error: "stream_cache_not_found"

      });

    }


    // cache validation

    const valid = await isCacheValidForRequest(cached.data, id, type, sNum, eNum);

    if (!valid) {

      // حذف الـ cache الفاسد

      try { await cache.invalidateEntry(id, type, sNum, eNum); } catch {}

      return res.status(404).json({

        success: false,

        error: "cache_invalidated"

      });

    }


    let rdLink = cached.data.rd_link || null;


    // استرداد rd_link من torrent info إذا مفقود

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


    // short-lived cache للـ fresh URL

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

        // محاولة استرداد من torrent

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

          res.setHeader("Content-Type", fresh.mimeType || "video/mp4");

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

      // تحويل relative URLs إلى absolute

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


app.get("/health", (req, res) => {

  res.json({ status: "ok", uptime: process.uptime() });

});


app.get("/", (req, res) => {

  res.json({

    status: "✅ BlueStream API v8.0.0 (Full Root-Cause Fix)",

    version: "8.0.0",

    features: [

      "Torrentio 25+ source aggregator",

      "Real-Debrid streaming with detailed error logging",

      "HLS-first strategy (guaranteed AAC audio)",

      "Smart mediaInfos/transcode fallback",

      "Cache validation & invalidation",

      "Magnet size limiting",

      "Content-Length for POST requests",

      "Automatic Arabic subtitles"

    ],

    sources: ["1337x", "ThePirateBay", "RARBG", "TorrentGalaxy", "YTS", "EZTV", "NyaaSi", "AniDex", "MagnetDL", "Limetorrent", "Torrent9", "ilCorSaRoNeRo", "Rutracker", "Comando", "BluDV", "+10 more"],

    endpoints: {

      play: "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1&with_subs=1",

      subtitles: "/api/subtitles?tmdb_id=...&type=movie&title=...",

      stream: "/api/stream?id={tmdb_id}&type={movie|tv}&season=1&episode=1",

      health: "/health"

    },

  });

});


app.listen(PORT, "0.0.0.0", () => {

  console.log(`\n🎬 BlueStream API v8.0.0 running on port ${PORT}`);

  console.log(`✅ RD Token: ${RD_TOKEN ? 'Loaded' : 'MISSING'}`);

  console.log(`✅ TMDB Key: ${TMDB_KEY ? 'Loaded' : 'MISSING'}`);

  console.log(`✅ OpenSubtitles: ${OS_API_KEY ? 'Loaded' : 'MISSING'}`);

  console.log(`✅ Torrentio: configured`);

});
