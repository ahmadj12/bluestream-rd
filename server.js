// BlueStream server.js v7.6
// Streaming-first: Torrentio -> Real-Debrid -> HLS/MP4/WebM/DASH
// mediaInfos is optional; a 400 from mediaInfos/transcode does not reject a valid MP4 stream.

const express = require('express');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const cache = require('./cache');

try {
  cache.initPool();
  cache.runMigrations().catch(e => console.warn('⚠️ Auto-migration skipped:', e.message));
} catch (e) {
  console.warn('⚠️ MySQL init failed (cache will be disabled):', e.message);
}

const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

const PORT = process.env.PORT || 3000;

const RD_TOKEN = process.env.RD_TOKEN;

if (!RD_TOKEN) {
  console.error('❌ خطأ: لم يتم تعيين RD_TOKEN');
  process.exit(1);
}

const TMDB_KEY =
  process.env.TMDB_KEY ||
  '570589dd8a1dac1a24fc6f98c18d1e59';

const OS_API_KEY =
  process.env.OPENSUBTITLES_API_KEY ||
  'p9i6HLoYyyJVPbVIBM5c9swo5MjqCV8I';

const OS_BASE =
  'https://api.opensubtitles.com/api/v1';

const TORRENTIO_BASE =
  'https://torrentio.strem.fun';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',

  Accept:
    'application/json,text/html,application/xhtml+xml,*/*',

  'Accept-Language':
    'en-US,en;q=0.5',

  Connection:
    'keep-alive'
};

function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;

    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(e);
    }

    const lib =
      parsed.protocol === 'https:'
        ? https
        : http;

    const req =
      lib.request(
        {
          method:
            options.method || 'GET',

          hostname:
            parsed.hostname,

          port:
            parsed.port ||
            (parsed.protocol === 'https:'
              ? 443
              : 80),

          path:
            parsed.pathname +
            parsed.search,

          headers: {
            ...HEADERS,
            ...(options.headers || {})
          },

          timeout:
            options.timeout || 15000
        },
        res => {
          let body = '';

          res.on('data', c => {
            body += c;
          });

          res.on('end', () => {
            let data = body;

            try {
              data = JSON.parse(body);
            } catch {}

            resolve({
              status:
                res.statusCode,

              headers:
                res.headers,

              data
            });
          });
        }
      );

    req.on(
      'timeout',
      () =>
        req.destroy(
          new Error(
            'Request timeout'
          )
        )
    );

    req.on(
      'error',
      reject
    );

    if (options.body) {
      req.write(
        options.body
      );
    }

    req.end();
  });
}

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function parseSize(s) {
  const m =
    String(s || '').match(
      /([\d.]+)\s*(KB|MB|GB|TB)/i
    );

  if (!m) {
    return 0;
  }

  const mult = {
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4
  };

  return Math.round(
    parseFloat(m[1]) *
      mult[
        m[2].toUpperCase()
      ]
  );
}

function moviePoster(path) {
  return path
    ? `https://image.tmdb.org/t/p/w500${path}`
    : null;
}

function movieBackdrop(path) {
  return path
    ? `https://image.tmdb.org/t/p/w1280${path}`
    : null;
}

/* ============================================================
   TMDB
============================================================ */

async function getTMDBMeta(
  id,
  type
) {
  try {
    const path =
      type === 'movie'
        ? 'movie'
        : 'tv';

    const r =
      await fetchURL(
        `https://api.themoviedb.org/3/${path}/${id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=external_ids`,
        {
          timeout: 10000
        }
      );

    return r.status === 200
      ? r.data
      : null;
  } catch {
    return null;
  }
}

/* ============================================================
   TORRENTIO
============================================================ */

function buildMagnet(
  hash,
  title,
  trackers = []
) {
  const defaults = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.openbittorrent.com:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://open.stealth.si:80/announce'
  ];

  const trs = [
    ...new Set([
      ...trackers
        .filter(x =>
          String(x).startsWith(
            'tracker:'
          )
        )
        .map(x =>
          String(x).slice(8)
        ),

      ...defaults
    ])
  ]
    .map(
      x =>
        `&tr=${encodeURIComponent(
          x
        )}`
    )
    .join('');

  return (
    `magnet:?xt=urn:btih:${hash}` +
    `&dn=${encodeURIComponent(
      String(title).split(
        '\n'
      )[0] || 'video'
    )}` +
    trs
  );
}

function torrentScore(item) {
  const f =
    String(
      item.name ||
        item.title ||
        ''
    ).toLowerCase();

  const mp4 =
    /\.mp4\b|\bmp4\b/.test(
      f
    );

  const webm =
    /\.webm\b|\bwebm\b/.test(
      f
    );

  const mkv =
    /\.mkv\b|\bmkv\b|remux/.test(
      f
    );

  const h264 =
    /x264|h\.264|h264|avc/.test(
      f
    );

  const hevc =
    /hevc|h\.265|h265|x265|av1/.test(
      f
    );

  let score = 0;

  if (mp4) {
    score += 5000;
  } else if (webm) {
    score += 3500;
  } else if (mkv) {
    score += 1000;
  } else {
    score -= 1000;
  }

  if (
    h264 &&
    !hevc
  ) {
    score += 3000;
  } else if (hevc) {
    score -= 2500;
  }

  if (
    /2160p|4k|uhd/.test(
      f
    )
  ) {
    score += 400;
  } else if (
    /1080p|fhd/.test(
      f
    )
  ) {
    score += 300;
  } else if (
    /720p|hdrip/.test(
      f
    )
  ) {
    score += 200;
  } else if (
    /480p|dvdrip/.test(
      f
    )
  ) {
    score += 100;
  }

  if (
    /remux/.test(
      f
    )
  ) {
    score -= 1000;
  }

  return score;
}

async function searchTorrentio(
  imdbId,
  type,
  season,
  episode
) {
  try {
    const url =
      type === 'movie'
        ? `${TORRENTIO_BASE}/stream/movie/${imdbId}.json`
        : `${TORRENTIO_BASE}/stream/series/${imdbId}:${season || 1}:${episode || 1}.json`;

    console.log(
      `   🔍 Torrentio: ${url.replace(
        TORRENTIO_BASE,
        ''
      )}`
    );

    const r =
      await fetchURL(
        url,
        {
          timeout: 20000
        }
      );

    if (
      r.status !== 200 ||
      !r.data?.streams?.length
    ) {
      return [];
    }

    const out = [];

    for (
      const s of r.data.streams
    ) {
      if (!s.infoHash) {
        continue;
      }

      const title =
        s.title || '';

      const l =
        title.toLowerCase();

      let quality = '?';

      if (
        /2160p|4k|uhd/.test(
          l
        )
      ) {
        quality =
          '4K';
      } else if (
        l.includes(
          '1080p'
        )
      ) {
        quality =
          '1080p';
      } else if (
        l.includes(
          '720p'
        )
      ) {
        quality =
          '720p';
      } else if (
        l.includes(
          '480p'
        )
      ) {
        quality =
          '480p';
      }

      const sm =
        title.match(
          /⚙️\s*([^\n🇬🇧🇸🇦🇪🇸🇫🇷🇩🇪🇮🇹🇯🇵🇰🇷🇨🇳🇷🇺🇵🇹🇮🇳]+)/
        );

      const source =
        sm
          ? sm[1].trim()
          : 'torrentio';

      const zm =
        title.match(
          /💾\s*([\d.]+\s*[GMK]B)/i
        );

      const sizeStr =
        zm
          ? zm[1]
          : '';

      out.push({
        name:
          title.split(
            '\n'
          )[0] ||
          title,

        title,

        magnet:
          buildMagnet(
            s.infoHash,
            title,
            s.sources ||
              []
          ),

        quality,

        size:
          parseSize(
            sizeStr
          ),

        size_str:
          sizeStr,

        source:
          `torrentio-${source
            .toLowerCase()
            .replace(
              /\s+/g,
              ''
            )}`,

        infoHash:
          s.infoHash,

        fileIdx:
          s.fileIdx || 0,

        seeds:
          0
      });
    }

    console.log(
      `   ✅ Torrentio: ${out.length} نتيجة`
    );

    return out;
  } catch (e) {
    console.warn(
      `   ⚠ Torrentio error: ${e.message}`
    );

    return [];
  }
}

/* ============================================================
   REAL-DEBRID
============================================================ */

async function rdAddMagnet(
  magnet
) {
  try {
    const r =
      await fetchURL(
        'https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
        {
          method: 'POST',

          body:
            `magnet=${encodeURIComponent(
              magnet
            )}`,

          headers: {
            'Content-Type':
              'application/x-www-form-urlencoded',

            Authorization:
              `Bearer ${RD_TOKEN}`
          },

          timeout:
            15000
        }
      );

    if (
      r.status === 200 ||
      r.status === 201
    ) {
      return r.data;
    }

    console.warn(
      `   ❌ RD addMagnet ${r.status}`,
      r.data
    );

    return null;
  } catch (e) {
    console.warn(
      `   ❌ RD addMagnet error: ${e.message}`
    );

    return null;
  }
}

async function rdSelectFiles(
  id,
  files = 'all'
) {
  try {
    const r =
      await fetchURL(
        `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${encodeURIComponent(
          id
        )}`,
        {
          method:
            'POST',

          body:
            `files=${encodeURIComponent(
              files
            )}`,

          headers: {
            'Content-Type':
              'application/x-www-form-urlencoded',

            Authorization:
              `Bearer ${RD_TOKEN}`
          },

          timeout:
            10000
        }
      );

    return (
      r.status === 200 ||
      r.status === 204
    );
  } catch {
    return false;
  }
}

async function rdGetTorrentInfo(
  id
) {
  try {
    const r =
      await fetchURL(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${encodeURIComponent(
          id
        )}`,
        {
          headers: {
            Authorization:
              `Bearer ${RD_TOKEN}`
          },

          timeout:
            10000
        }
      );

    return r.status === 200
      ? r.data
      : null;
  } catch {
    return null;
  }
}

async function rdWaitForTorrent(
  id,
  maxWaitMs = 240000
) {
  const start =
    Date.now();

  while (
    Date.now() -
      start <
    maxWaitMs
  ) {
    const info =
      await rdGetTorrentInfo(
        id
      );

    if (info) {
      if (
        info.status ===
        'downloaded'
      ) {
        return info;
      }

      if (
        info.status ===
        'waiting_files_selection'
      ) {
        await rdSelectFiles(
          id,
          'all'
        );
      }

      if (
        [
          'error',
          'magnet_error',
          'virus',
          'dead'
        ].includes(
          info.status
        )
      ) {
        return null;
      }
    }

    await sleep(3000);
  }

  return null;
}

async function rdUnrestrict(
  link
) {
  try {
    const r =
      await fetchURL(
        'https://api.real-debrid.com/rest/1.0/unrestrict/link',
        {
          method:
            'POST',

          body:
            `link=${encodeURIComponent(
              link
            )}`,

          headers: {
            'Content-Type':
              'application/x-www-form-urlencoded',

            Authorization:
              `Bearer ${RD_TOKEN}`
          },

          timeout:
            15000
        }
      );

    return (
      r.status === 200 ||
      r.status === 201
    )
      ? r.data
      : null;
  } catch {
    return null;
  }
}

async function rdGetMediaInfos(
  id
) {
  try {
    const r =
      await fetchURL(
        `https://api.real-debrid.com/rest/1.0/streaming/mediaInfos/${encodeURIComponent(
          id
        )}`,
        {
          headers: {
            Authorization:
              `Bearer ${RD_TOKEN}`
          },

          timeout:
            15000
        }
      );

    if (
      r.status !== 200
    ) {
      console.warn(
        `   ⚠ mediaInfos ${r.status}`,
        r.data
      );

      return null;
    }

    return r.data;
  } catch (e) {
    console.warn(
      `   ⚠ mediaInfos error: ${e.message}`
    );

    return null;
  }
}

async function rdGetTranscodedLinks(
  id
) {
  try {
    const r =
      await fetchURL(
        `https://api.real-debrid.com/rest/1.0/streaming/transcode/${encodeURIComponent(
          id
        )}`,
        {
          headers: {
            Authorization:
              `Bearer ${RD_TOKEN}`
          },

          timeout:
            15000
        }
      );

    if (
      r.status !== 200
    ) {
      console.warn(
        `   ⚠ transcode ${r.status}`,
        r.data
      );

      return null;
    }

    return r.data;
  } catch (e) {
    console.warn(
      `   ⚠ transcode error: ${e.message}`
    );

    return null;
  }
}

/* ============================================================
   TRANSCODE HELPERS
============================================================ */

function allUrls(
  v,
  out = []
) {
  if (!v) {
    return out;
  }

  if (
    typeof v ===
    'string'
  ) {
    if (
      /^https?:\/\//i.test(
        v
      )
    ) {
      out.push(v);
    }

    return out;
  }

  if (
    Array.isArray(v)
  ) {
    for (
      const x of v
    ) {
      allUrls(
        x,
        out
      );
    }

    return out;
  }

  if (
    typeof v ===
    'object'
  ) {
    for (
      const x of Object.values(
        v
      )
    ) {
      allUrls(
        x,
        out
      );
    }
  }

  return out;
}

function pickBestTranscodeUrl(
  data
) {
  if (!data) {
    return null;
  }

  const hls =
    allUrls(
      data.apple
    );

  if (
    hls.length
  ) {
    return {
      url:
        hls.find(
          x =>
            /\.m3u8(?:$|\?)/i.test(
              x
            )
        ) ||
        hls[0],

      type:
        'hls'
    };
  }

  const mp4 =
    allUrls(
      data.liveMP4
    );

  if (
    mp4.length
  ) {
    return {
      url:
        mp4[0],

      type:
        'mp4'
    };
  }

  const webm =
    allUrls(
      data.h264WebM
    );

  if (
    webm.length
  ) {
    return {
      url:
        webm[0],

      type:
        'webm'
    };
  }

  const dash =
    allUrls(
      data.dash
    );

  if (
    dash.length
  ) {
    return {
      url:
        dash.find(
          x =>
            /\.mpd(?:$|\?)/i.test(
              x
            )
        ) ||
        dash[0],

      type:
        'dash'
    };
  }

  /* Older / alternate fields */
  const oldHls =
    allUrls(
      data.hls
    );

  if (
    oldHls.length
  ) {
    return {
      url:
        oldHls.find(
          x =>
            /\.m3u8(?:$|\?)/i.test(
              x
            )
        ) ||
        oldHls[0],

      type:
        'hls'
    };
  }

  const oldMp4 =
    allUrls(
      data.mp4
    );

  if (
    oldMp4.length
  ) {
    return {
      url:
        oldMp4[0],

      type:
        'mp4'
    };
  }

  const oldWebm =
    allUrls(
      data.webm
    );

  if (
    oldWebm.length
  ) {
    return {
      url:
        oldWebm[0],

      type:
        'webm'
    };
  }

  return null;
}

/* ============================================================
   MEDIA / BROWSER HELPERS
============================================================ */

function mediaContainer(
  filename,
  mime
) {
  const n =
    String(
      filename || ''
    ).toLowerCase();

  const m =
    String(
      mime || ''
    ).toLowerCase();

  if (
    n.endsWith(
      '.mp4'
    ) ||
    m.includes(
      'video/mp4'
    )
  ) {
    return 'mp4';
  }

  if (
    n.endsWith(
      '.webm'
    ) ||
    m.includes(
      'video/webm'
    )
  ) {
    return 'webm';
  }

  if (
    n.endsWith(
      '.mkv'
    ) ||
    m.includes(
      'matroska'
    )
  ) {
    return 'mkv';
  }

  if (
    n.endsWith(
      '.mov'
    ) ||
    m.includes(
      'quicktime'
    )
  ) {
    return 'mov';
  }

  return 'unknown';
}

function nativeCandidate(
  data,
  mediaInfo
) {
  const name =
    String(
      data.filename || ''
    ).toLowerCase();

  const mime =
    String(
      data.mimeType || ''
    ).toLowerCase();

  const streamable =
    data.streamable ===
      true ||
    Number(
      data.streamable
    ) === 1 ||
    String(
      data.streamable
    ).toLowerCase() ===
      'true';

  const h264Name =
    /x264|h\.264|h264|avc/.test(
      name
    );

  const hevcName =
    /hevc|h\.265|h265|x265|av1/.test(
      name
    );

  const codec =
    String(
      mediaInfo?.codec ||
        ''
    ).toLowerCase();

  const hevcCodec =
    /hevc|h265|x265|av1/.test(
      codec
    );

  const mp4 =
    name.endsWith(
      '.mp4'
    ) ||
    mime.includes(
      'video/mp4'
    );

  const webm =
    name.endsWith(
      '.webm'
    ) ||
    mime.includes(
      'video/webm'
    );

  return (
    streamable &&
    !hevcName &&
    !hevcCodec &&
    (mp4 || webm) &&
    (h264Name ||
      !codec)
  );
}

async function inspectLink(
  link
) {
  const data =
    await rdUnrestrict(
      link
    );

  if (
    !data?.download
  ) {
    return null;
  }

  const mediaInfo =
    data.id
      ? await rdGetMediaInfos(
          data.id
        )
      : null;

  const filename =
    data.filename ||
    '';

  const mime =
    data.mimeType ||
    '';

  const infoCodec =
    String(
      mediaInfo?.codec ||
        ''
    ).toLowerCase();

  const name =
    filename.toLowerCase();

  const hevc =
    /hevc|h\.265|h265|x265|av1/.test(
      name
    ) ||
    /hevc|h265|x265|av1/.test(
      infoCodec
    );

  const h264 =
    /x264|h\.264|h264|avc/.test(
      name
    ) ||
    /h264|avc/.test(
      infoCodec
    );

  const streamable =
    data.streamable ===
      true ||
    Number(
      data.streamable
    ) === 1 ||
    String(
      data.streamable
    ).toLowerCase() ===
      'true';

  return {
    ...data,

    mediaInfo,

    filename,

    mimeType:
      mime,

    container:
      mediaContainer(
        filename,
        mime
      ),

    hevc,

    h264,

    streamable,

    native:
      nativeCandidate(
        data,
        mediaInfo
      ),

    link
  };
}

function scoreInspected(
  x
) {
  if (!x) {
    return -10000;
  }

  let s = 0;

  if (
    x.container ===
    'mp4'
  ) {
    s += 5000;
  } else if (
    x.container ===
    'webm'
  ) {
    s += 3500;
  } else if (
    x.container ===
    'mkv'
  ) {
    s += 1000;
  } else {
    s -= 1000;
  }

  if (
    x.h264 &&
    !x.hevc
  ) {
    s += 3000;
  } else if (
    x.hevc
  ) {
    s -= 2500;
  }

  if (
    x.native
  ) {
    s += 2500;
  }

  if (
    x.streamable
  ) {
    s += 1000;
  }

  return s;
}

/* ============================================================
   PLAYABLE RESOLUTION
============================================================ */

async function rdGetPlayableUrlFromInfo(
  info
) {
  if (
    !info?.download
  ) {
    return null;
  }

  /*
   * أول شيء:
   * نطلب Transcode.
   *
   * الأولوية:
   * HLS
   * ثم Live MP4
   * ثم H264 WebM
   * ثم DASH
   */

  if (info.id) {
    const transcode =
      await rdGetTranscodedLinks(
        info.id
      );

    const picked =
      pickBestTranscodeUrl(
        transcode
      );

    if (
      picked?.url
    ) {
      console.log(
        `   🎬 RD transcode: ${picked.type}`
      );

      return {
        url:
          picked.url,

        type:
          picked.type,

        link:
          info.link,

        filename:
          info.filename,

        filesize:
          Number(
            info.filesize ||
              0
          ),

        mimeType:
          info.mimeType ||
          null,

        mediaInfo:
          info.mediaInfo ||
          null,

        streamingId:
          info.id
      };
    }
  }

  /*
   * إذا Transcode غير متوفر:
   *
   * mediaInfos 400 ليس سببًا لرفض MP4.
   *
   * إذا Real-Debrid يقول streamable
   * والملف MP4/WebM وغير HEVC:
   * نستخدم رابط unrestrict الحالي.
   */

  if (
    info.native
  ) {
    console.log(
      `   ✅ Native stream: ${info.filename}`
    );

    return {
      url:
        info.download,

      type:
        info.container ===
        'webm'
          ? 'webm'
          : 'mp4',

      link:
        info.link,

      filename:
        info.filename,

      filesize:
        Number(
          info.filesize ||
            0
        ),

      mimeType:
        info.mimeType ||
        (
          info.container ===
          'webm'
            ? 'video/webm'
            : 'video/mp4'
        ),

      mediaInfo:
        info.mediaInfo ||
        null,

      streamingId:
        info.id ||
        null
    };
  }

  /*
   * Fallback إضافي:
   * MP4 streamable حتى لو mediaInfos/transcode رجعوا 400.
   */

  const mp4 =
    info.container ===
    'mp4';

  if (
    info.streamable &&
    mp4 &&
    !info.hevc
  ) {
    console.log(
      `   ✅ Streamable MP4 fallback: ${info.filename}`
    );

    return {
      url:
        info.download,

      type:
        'mp4',

      link:
        info.link,

      filename:
        info.filename,

      filesize:
        Number(
          info.filesize ||
            0
        ),

      mimeType:
        info.mimeType ||
        'video/mp4',

      mediaInfo:
        info.mediaInfo ||
        null,

      streamingId:
        info.id ||
        null
    };
  }

  console.warn(
    `   ❌ No playable stream: ${info.filename || 'unknown'}`
  );

  return null;
}

async function rdGetPlayableUrl(
  link
) {
  const info =
    await inspectLink(
      link
    );

  return rdGetPlayableUrlFromInfo(
    info
  );
}

async function rdResolveBestPlayableLink(
  torrentInfo
) {
  const links =
    Array.isArray(
      torrentInfo?.links
    )
      ? torrentInfo.links
      : [];

  const files =
    Array.isArray(
      torrentInfo?.files
    )
      ? torrentInfo.files
      : [];

  if (!links.length) {
    return null;
  }

  const candidates = [];

  /*
   * نفحص الملفات.
   *
   * هنا mediaInfos مساعد فقط.
   * إذا رجع 400 نستخدم filename/mimeType/streamable.
   */

  for (
    let i = 0;
    i < links.length;
    i++
  ) {
    try {
      const info =
        await inspectLink(
          links[i]
        );

      if (!info) {
        continue;
      }

      if (
        !info.filename &&
        files[i]?.path
      ) {
        info.filename =
          files[i].path;
      }

      const size =
        Number(
          info.filesize ||
            files[i]
              ?.bytes ||
            0
        );

      const score =
        scoreInspected(
          info
        );

      candidates.push({
        info,

        link:
          links[i],

        score,

        size
      });

      console.log(
        `   🔎 [${i + 1}/${links.length}] ${
          info.filename ||
          files[i]?.path ||
          'unknown'
        } | ${
          info.mimeType ||
          '?'
        } | score ${score}`
      );
    } catch (e) {
      console.warn(
        `   ⚠ inspect ${i + 1} failed: ${e.message}`
      );
    }
  }

  candidates.sort(
    (a, b) =>
      b.score -
        a.score ||
      b.size -
        a.size
  );

  /*
   * نجرب بالترتيب حتى نحصل على Stream فعلي.
   */

  for (
    const candidate of candidates
  ) {
    const playable =
      await rdGetPlayableUrlFromInfo(
        candidate.info
      );

    if (
      playable?.url
    ) {
      return {
        ...playable,

        link:
          candidate.link,

        filename:
          playable.filename ||
          candidate.info
            .filename,

        filesize:
          playable.filesize ||
          candidate.size
      };
    }
  }

  return null;
}

/* ============================================================
   STREAM URL
============================================================ */

function proxyUrl(
  id,
  type,
  season,
  episode
) {
  const p =
    new URLSearchParams({
      id:
        String(id),

      type:
        String(type)
    });

  if (
    type ===
    'tv'
  ) {
    p.set(
      'season',
      String(
        season || 1
      )
    );

    p.set(
      'episode',
      String(
        episode || 1
      )
    );
  }

  return (
    `/api/stream?${p.toString()}`
  );
}

async function resolveFromCache(
  id,
  type,
  season,
  episode
) {
  const cached =
    await cache.getCache(
      id,
      type,
      season,
      episode
    );

  if (
    !cached?.hit ||
    !cached.data
  ) {
    return null;
  }

  if (
    cached.data.rd_link
  ) {
    const playable =
      await rdGetPlayableUrl(
        cached.data.rd_link
      );

    if (
      playable?.url
    ) {
      return {
        playable,
        cached
      };
    }
  }

  if (
    cached.data
      .rd_torrent_id
  ) {
    const info =
      await rdGetTorrentInfo(
        cached.data
          .rd_torrent_id
      );

    if (
      info?.status ===
        'downloaded' &&
      info.links?.length
    ) {
      const playable =
        await rdResolveBestPlayableLink(
          info
        );

      if (
        playable?.url
      ) {
        return {
          playable,
          cached
        };
      }
    }
  }

  return null;
}

/* ============================================================
   OPENSUBTITLES
============================================================ */

async function searchOpenSubtitles({
  tmdbId,
  type,
  season,
  episode,
  title,
  year
}) {
  if (!OS_API_KEY) {
    return null;
  }

  try {
    let url;

    if (
      tmdbId
    ) {
      const q =
        type ===
        'movie'
          ? `tmdb_id=${tmdbId}`
          : `tmdb_id=${tmdbId}&season_number=${season || 1}&episode_number=${episode || 1}`;

      url =
        `${OS_BASE}/subtitles?${q}` +
        `&languages=ar` +
        `&order_by=download_count` +
        `&order_direction=desc`;
    } else if (
      title
    ) {
      url =
        `${OS_BASE}/subtitles?query=${encodeURIComponent(
          year
            ? `${title} ${year}`
            : title
        )}` +
        `&languages=ar` +
        `&order_by=download_count` +
        `&order_direction=desc`;
    } else {
      return null;
    }

    const search =
      await fetchURL(
        url,
        {
          headers: {
            'Api-Key':
              OS_API_KEY,

            'User-Agent':
              'BlueStream v1.0',

            Accept:
              'application/json'
          },

          timeout:
            12000
        }
      );

    if (
      search.status !==
        200 ||
      !search.data?.data
        ?.length
    ) {
      return null;
    }

    const top =
      search.data.data.find(
        x =>
          x.attributes
            ?.language ===
          'ar'
      );

    const fileId =
      top?.attributes
        ?.files?.[0]
        ?.file_id;

    if (!fileId) {
      return null;
    }

    const dl =
      await fetchURL(
        `${OS_BASE}/download`,
        {
          method:
            'POST',

          headers: {
            'Api-Key':
              OS_API_KEY,

            'User-Agent':
              'BlueStream v1.0',

            'Content-Type':
              'application/json',

            Accept:
              'application/json'
          },

          body:
            JSON.stringify(
              {
                file_id:
                  fileId,

                sub_format:
                  'srt'
              }
            ),

          timeout:
            15000
        }
      );

    if (
      dl.status !==
        200 ||
      !dl.data?.link
    ) {
      return null;
    }

    const sr =
      await fetchURL(
        dl.data.link,
        {
          timeout:
            15000
        }
      );

    if (
      sr.status !==
        200 ||
      !sr.data
    ) {
      return null;
    }

    const content =
      typeof sr.data ===
      'string'
        ? sr.data
        : String(
            sr.data
          );

    return {
      url:
        `data:text/plain;charset=utf-8;base64,${Buffer.from(
          content,
          'utf8'
        ).toString(
          'base64'
        )}`,

      language:
        'ar',

      label:
        'العربية',

      source:
        'opensubtitles',

      release:
        top.attributes
          ?.release ||
        ''
    };
  } catch (e) {
    console.warn(
      'OS error:',
      e.message
    );

    return null;
  }
}

/* ============================================================
   CORE
============================================================ */

async function tryGetStream({
  id,
  type,
  sNum,
  eNum,
  withSubs
}) {
  /*
   * 1) Cache
   *
   * لا نستخدم stream_url القديم.
   * نعيد استخراج الرابط من rd_link.
   */

  const cached =
    await resolveFromCache(
      id,
      type,
      sNum,
      eNum
    );

  if (
    cached?.playable?.url
  ) {
    const p =
      cached.playable;

    const subtitle =
      withSubs
        ? await searchOpenSubtitles(
            {
              tmdbId:
                parseInt(
                  id
                ),

              type,

              season:
                sNum,

              episode:
                eNum,

              title:
                cached.cached
                  .data
                  .title,

              year:
                cached.cached
                  .data
                  .year
            }
          )
        : null;

    return {
      success:
        true,

      provider:
        `real-debrid+${
          cached.cached
            .data
            .source ||
          'cache'
        }`,

      quality:
        cached.cached
          .data
          .quality,

      title:
        cached.cached
          .data
          .title,

      year:
        cached.cached
          .data
          .year,

      filename:
        p.filename ||
        cached.cached
          .data
          .filename,

      stream_url:
        p.type ===
        'mp4'
          ? proxyUrl(
              id,
              type,
              sNum,
              eNum
            )
          : p.url,

      stream_type:
        p.type ===
        'mp4'
          ? 'mp4-proxy'
          : p.type,

      subtitle,

      subtitles:
        subtitle
          ? [subtitle.url]
          : [],

      size_mb:
        Math.round(
          (
            p.filesize ||
            cached.cached
              .data
              .file_size_bytes ||
            0
          ) /
            1024 /
            1024
        ),

      seeds:
        cached.cached
          .data
          .seeds ||
        0,

      poster:
        moviePoster(
          cached.cached
            .data
            .poster_path
        ),

      backdrop:
        movieBackdrop(
          cached.cached
            .data
            .backdrop_path
        ),

      cached:
        true,

      refreshed:
        true
    };
  }

  /* ----------------------------------------------------------
     TMDB
  ---------------------------------------------------------- */

  const meta =
    await getTMDBMeta(
      id,
      type
    );

  if (!meta) {
    return {
      success:
        false,

      error:
        'TMDB not found'
    };
  }

  const title =
    meta.title ||
    meta.name ||
    meta.original_title ||
    meta.original_name;

  const year =
    (
      meta.release_date ||
      meta.first_air_date ||
      ''
    ).slice(
      0,
      4
    );

  const poster =
    moviePoster(
      meta.poster_path
    );

  const backdrop =
    movieBackdrop(
      meta.backdrop_path
    );

  const imdbId =
    meta.imdb_id ||
    meta.external_ids
      ?.imdb_id;

  if (!imdbId) {
    return {
      success:
        false,

      error:
        'IMDB ID not found for this title'
    };
  }

  console.log(
    `\n🎬 ${title} (${year || '?'}) | ${type} S${
      sNum || 1
    }E${
      eNum || 1
    }`
  );

  console.log(
    `   📺 IMDB: ${imdbId}`
  );

  const torrents =
    await searchTorrentio(
      imdbId,
      type,
      sNum,
      eNum
    );

  if (
    !torrents.length
  ) {
    return {
      success:
        false,

      error:
        `لم يتم العثور على "${title}"`
    };
  }

  torrents.sort(
    (a, b) =>
      torrentScore(
        b
      ) -
      torrentScore(
        a
      )
  );

  console.log(
    `📊 إجمالي النتائج: ${torrents.length} torrent`
  );

  const maxAttempts =
    Math.min(
      12,
      torrents.length
    );

  let lastFailure =
    'no_playable_stream';

  for (
    let i = 0;
    i <
    maxAttempts;
    i++
  ) {
    const torrent =
      torrents[i];

    console.log(
      `🔄 [${i + 1}/${maxAttempts}] ${
        torrent.quality
      } | ${
        (
          torrent.name ||
          ''
        ).slice(
          0,
          100
        )}`
    );

    /*
     * 451 infringing_file
     * يتم تجاوزه ونكمل للمصدر التالي.
     */

    const added =
      await rdAddMagnet(
        torrent.magnet
      );

    if (
      !added?.id
    ) {
      lastFailure =
        'rd_add_failed';

      continue;
    }

    console.log(
      `   ✓ Added to RD: ${added.id}`
    );

    await rdSelectFiles(
      added.id,
      'all'
    );

    const info =
      await rdWaitForTorrent(
        added.id
      );

    if (!info) {
      lastFailure =
        'download_or_torrent_error';

      continue;
    }

    console.log(
      `   ✓ Prepared by RD: ${
        info.filename ||
        'torrent ready'
      }`
    );

    if (
      !info.links?.length
    ) {
      lastFailure =
        'no_links';

      continue;
    }

    /*
     * هنا يتم اختيار أفضل ملف:
     *
     * MP4/H264
     * ثم WebM
     * ثم MKV
     *
     * وبعدها:
     *
     * HLS
     * Live MP4
     * WebM
     * DASH
     *
     * ثم native MP4 fallback.
     */

    const playable =
      await rdResolveBestPlayableLink(
        info
      );

    if (
      !playable?.url
    ) {
      lastFailure =
        'no_browser_stream';

      console.log(
        '   ❌ No playable stream in this RD torrent'
      );

      continue;
    }

    console.log(
      `   ✅ Got stream URL (${playable.type})!`
    );

    await cache.setCache(
      {
        tmdb_id:
          parseInt(
            id
          ),

        media_type:
          type,

        season:
          sNum,

        episode:
          eNum,

        title,

        year,

        original_title:
          meta.original_title ||
          meta.original_name,

        overview:
          meta.overview,

        poster_path:
          meta.poster_path,

        backdrop_path:
          meta.backdrop_path,

        runtime:
          meta.runtime ||
          meta.episode_run_time
            ?. [0] ||
          null,

        vote_average:
          meta.vote_average,

        genres:
          meta.genres
            ?.map(
              g =>
                g.name
            )
            .join(
              ', '
            ) ||
          null,

        rd_torrent_id:
          added.id,

        rd_link:
          playable.link,

        stream_url:
          playable.url,

        stream_type:
          playable.type,

        filename:
          playable.filename ||
          info.filename,

        file_size_bytes:
          playable.filesize ||
          torrent.size ||
          0,

        quality:
          torrent.quality,

        source:
          torrent.source,

        magnet:
          torrent.magnet,

        seeds:
          torrent.seeds ||
          0,

        info_hash:
          torrent.infoHash,

        status:
          'ready'
      }
    );

    const subtitle =
      withSubs
        ? await searchOpenSubtitles(
            {
              tmdbId:
                parseInt(
                  id
                ),

              type,

              season:
                sNum,

              episode:
                eNum,

              title,

              year
            }
          )
        : null;

    return {
      success:
        true,

      provider:
        `real-debrid+${torrent.source}`,

      quality:
        torrent.quality,

      title,

      year,

      filename:
        playable.filename ||
        info.filename,

      stream_url:
        playable.type ===
        'mp4'
          ? proxyUrl(
              id,
              type,
              sNum,
              eNum
            )
          : playable.url,

      stream_type:
        playable.type ===
        'mp4'
          ? 'mp4-proxy'
          : playable.type,

      subtitle,

      subtitles:
        subtitle
          ? [subtitle.url]
          : [],

      size_mb:
        Math.round(
          (
            playable.filesize ||
            torrent.size ||
            0
          ) /
            1024 /
            1024
        ),

      seeds:
        torrent.seeds ||
        0,

      poster,

      backdrop,

      cached:
        false
    };
  }

  return {
    success:
      false,

    error:
      `فشل تحميل/تجهيز أي من ${torrents.length} torrents`,

    reason:
      lastFailure
  };
}

/* ============================================================
   STREAMING PROXY
============================================================ */

app.get(
  '/api/stream',
  async (
    req,
    res
  ) => {
    const {
      id,
      type,
      season,
      episode
    } = req.query;

    if (
      !id ||
      !type
    ) {
      return res
        .status(400)
        .json(
          {
            success:
              false,

            error:
              'Missing id or type'
          }
        );
    }

    const sNum =
      type ===
      'tv'
        ? parseInt(
            season || 1
          )
        : null;

    const eNum =
      type ===
      'tv'
        ? parseInt(
            episode || 1
          )
        : null;

    try {
      const resolved =
        await resolveFromCache(
          id,
          type,
          sNum,
          eNum
        );

      if (
        !resolved
          ?.playable
          ?.url
      ) {
        return res
          .status(404)
          .json(
            {
              success:
                false,

              error:
                'stream_unavailable'
            }
          );
      }

      const p =
        resolved.playable;

      /*
       * HLS/DASH/WebM:
       *
       * نخلي RD يخدم playlist/segments.
       */

      if (
        [
          'hls',
          'dash',
          'webm'
        ].includes(
          p.type
        )
      ) {
        return res.redirect(
          307,
          p.url
        );
      }

      if (
        p.type !==
        'mp4'
      ) {
        return res
          .status(415)
          .json(
            {
              success:
                false,

              error:
                'unsupported_stream_type'
            }
          );
      }

      /*
       * MP4:
       *
       * Proxy + Range.
       */

      const parsed =
        new URL(
          p.url
        );

      const lib =
        parsed.protocol ===
        'https:'
          ? https
          : http;

      const headers = {
        'User-Agent':
          HEADERS[
            'User-Agent'
          ],

        Accept:
          '*/*',

        Connection:
          'keep-alive'
      };

      if (
        req.headers.range
      ) {
        headers.Range =
          req.headers.range;
      }

      const rq =
        lib.request(
          {
            method:
              'GET',

            hostname:
              parsed.hostname,

            port:
              parsed.port ||
              (
                parsed.protocol ===
                'https:'
                  ? 443
                  : 80
              ),

            path:
              parsed.pathname +
              parsed.search,

            headers,

            timeout:
              30000
          },

          rr => {
            const passthrough =
              [
                'content-type',
                'content-length',
                'content-range',
                'accept-ranges',
                'etag',
                'last-modified',
                'cache-control'
              ];

            for (
              const h of passthrough
            ) {
              if (
                rr.headers[
                  h
                ] !==
                undefined
              ) {
                res.setHeader(
                  h,
                  rr.headers[h]
                );
              }
            }

            if (
              !res.getHeader(
                'Content-Type'
              )
            ) {
              res.setHeader(
                'Content-Type',
                p.mimeType ||
                  'video/mp4'
              );
            }

            res.status(
              rr.statusCode ||
                502
            );

            rr.pipe(
              res
            );
          }
        );

      rq.on(
        'timeout',
        () =>
          rq.destroy(
            new Error(
              'Real-Debrid stream timeout'
            )
          )
      );

      rq.on(
        'error',
        e => {
          if (
            !res.headersSent
          ) {
            res
              .status(502)
              .json(
                {
                  success:
                    false,

                  error:
                    'stream_proxy_error',

                  message:
                    e.message
                }
              );
          } else {
            res.destroy(
              e
            );
          }
        }
      );

      req.on(
        'close',
        () => {
          if (
            !res.writableEnded
          ) {
            rq.destroy();
          }
        }
      );

      rq.end();
    } catch (e) {
      console.error(
        '❌ Stream proxy error:',
        e.message
      );

      if (
        !res.headersSent
      ) {
        res
          .status(500)
          .json(
            {
              success:
                false,

              error:
                e.message
            }
          );
      }
    }
  }
);

/* ============================================================
   PLAY API
============================================================ */

app.get(
  '/api/play',
  async (
    req,
    res
  ) => {
    const {
      id,
      type,
      season,
      episode,
      with_subs =
        '1'
    } = req.query;

    if (
      !id ||
      !type
    ) {
      return res
        .status(400)
        .json(
          {
            success:
              false,

            error:
              'Missing id or type'
          }
        );
    }

    req.setTimeout(
      300000
    );

    res.setTimeout(
      300000
    );

    const sNum =
      type ===
      'tv'
        ? parseInt(
            season || 1
          )
        : null;

    const eNum =
      type ===
      'tv'
        ? parseInt(
            episode || 1
          )
        : null;

    try {
      const result =
        await tryGetStream(
          {
            id,

            type,

            sNum,

            eNum,

            withSubs:
              with_subs ===
              '1'
          }
        );

      return res
        .status(
          result.success
            ? 200
            : 404
        )
        .json(
          result
        );
    } catch (e) {
      console.error(
        '❌ Error:',
        e
      );

      return res
        .status(500)
        .json(
          {
            success:
              false,

            error:
              e.message
          }
        );
    }
  }
);

/* ============================================================
   SUBTITLES API
============================================================ */

app.get(
  '/api/subtitles',
  async (
    req,
    res
  ) => {
    const {
      tmdb_id,
      type,
      season,
      episode,
      title,
      year
    } = req.query;

    if (
      !tmdb_id &&
      !title
    ) {
      return res
        .status(400)
        .json(
          {
            success:
              false,

            error:
              'Missing tmdb_id or title'
          }
        );
    }

    try {
      const subtitle =
        await searchOpenSubtitles(
          {
            tmdbId:
              tmdb_id
                ? parseInt(
                    tmdb_id
                  )
                : null,

            type,

            season,

            episode,

            title,

            year
          }
        );

      return res.json(
        subtitle
          ? {
              success:
                true,

              subtitle
            }
          : {
              success:
                false,

              error:
                'no_subtitles_found'
            }
      );
    } catch (e) {
      return res
        .status(500)
        .json(
          {
            success:
              false,

            error:
              e.message
          }
        );
    }
  }
);

/* ============================================================
   CACHE
============================================================ */

app.get(
  '/api/cache/stats',
  async (
    req,
    res
  ) => {
    try {
      res.json(
        {
          success:
            true,

          stats:
            await cache.getStats()
        }
      );
    } catch (e) {
      res
        .status(500)
        .json(
          {
            success:
              false,

            error:
              e.message
          }
        );
    }
  }
);

app.post(
  '/api/cache/clean',
  async (
    req,
    res
  ) => {
    try {
      res.json(
        {
          success:
            true,

          expired_marked:
            await cache.cleanExpired()
        }
      );
    } catch (e) {
      res
        .status(500)
        .json(
          {
            success:
              false,

            error:
              e.message
          }
        );
    }
  }
);

app.delete(
  '/api/cache/:tmdb_id/:type',
  async (
    req,
    res
  ) => {
    try {
      const {
        tmdb_id,
        type
      } = req.params;

      const {
        season,
        episode
      } = req.query;

      const p =
        cache.initPool();

      const [
        result
      ] =
        await p.execute(
          'DELETE FROM media_cache WHERE tmdb_id = ? AND media_type = ? AND season <=> ? AND episode <=> ?',

          [
            parseInt(
              tmdb_id
            ),

            type,

            season ||
              null,

            episode ||
              null
          ]
        );

      res.json(
        {
          success:
            true,

          deleted:
            result.affectedRows
        }
      );
    } catch (e) {
      res
        .status(500)
        .json(
          {
            success:
              false,

            error:
              e.message
          }
        );
    }
  }
);

/* ============================================================
   HEALTH
============================================================ */

app.get(
  '/',
  (
    req,
    res
  ) => {
    res.json(
      {
        status:
          '✅ BlueStream API v7.6 (Streaming + Real-Debrid + Transcode)',

        version:
          '7.6',

        features: [
          'Torrentio aggregator',
          'Real-Debrid streaming',
          'mediaInfos optional',
          'HLS first',
          'MP4/H264 priority',
          'fresh MP4 proxy',
          'automatic Arabic subtitles'
        ],

        endpoints: {
          play:
            '/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1&with_subs=1',

          stream:
            '/api/stream?id={tmdb_id}&type={movie|tv}&season=1&episode=1',

          subtitles:
            '/api/subtitles?tmdb_id=...&type=movie&title=...'
        }
      }
    );
  }
);

/* ============================================================
   START
============================================================ */

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `\n🎬 BlueStream API v7.6 running on port ${PORT}`
    );

    console.log(
      `✅ RD Token: ${
        RD_TOKEN
          ? 'Loaded'
          : 'MISSING'
      }`
    );

    console.log(
      `✅ TMDB Key: ${
        TMDB_KEY
          ? 'Loaded'
          : 'MISSING'
      }`
    );

    console.log(
      `✅ OpenSubtitles: ${
        OS_API_KEY
          ? 'Loaded'
          : 'MISSING'
      }`
    );

    console.log(
      '✅ Torrentio: configured'
    );

    console.log(
      '✅ Real-Debrid mediaInfos: optional'
    );

    console.log(
      '✅ Real-Debrid transcode: HLS first'
    );

    console.log(
      '✅ Streaming proxy: enabled'
    );
  }
);