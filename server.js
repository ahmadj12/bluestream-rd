// server.js — Real-Debrid + OpenSubtitles + Torrentio
// v7.5 — MediaInfo + Transcode + Browser Friendly Selection

const express = require("express");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const cache = require("./cache");

try {
  cache.initPool();

  cache.runMigrations().catch((err) =>
    console.warn("⚠️ Auto-migration skipped:", err.message)
  );
} catch (err) {
  console.warn(
    "⚠️ MySQL init failed (cache will be disabled):",
    err.message
  );
}

const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

const PORT = process.env.PORT || 3000;
const RD_TOKEN = process.env.RD_TOKEN;

if (!RD_TOKEN) {
  console.error("❌ خطأ: لم يتم تعيين RD_TOKEN");
  process.exit(1);
}

const TMDB_KEY =
  process.env.TMDB_KEY ||
  "570589dd8a1dac1a24fc6f98c18d1e59";

const OS_API_KEY =
  process.env.OPENSUBTITLES_API_KEY ||
  "p9i6HLoYyyJVPbVIBM5c9swo5MjqCV8I";

const OS_BASE =
  "https://api.opensubtitles.com/api/v1";

const TORRENTIO_BASE =
  "https://torrentio.strem.fun";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",

  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",

  "Accept-Language":
    "en-US,en;q=0.5",

  Connection:
    "keep-alive",

  "Upgrade-Insecure-Requests":
    "1",
};

function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);

      const isHttps = parsed.protocol === "https:";
      const lib = isHttps ? https : http;

      const reqOpts = {
        method: options.method || "GET",
        hostname: parsed.hostname,
        port:
          parsed.port ||
          (isHttps ? 443 : 80),

        path:
          parsed.pathname +
          parsed.search,

        headers: {
          ...BROWSER_HEADERS,
          ...(options.headers || {}),
        },

        timeout:
          options.timeout ||
          15000,
      };

      delete reqOpts.headers["Accept-Encoding"];

      const req = lib.request(
        reqOpts,
        (res) => {
          let data = "";

          res.on("data", (chunk) => {
            data += chunk;
          });

          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode,
                data: JSON.parse(data),
              });
            } catch {
              resolve({
                status: res.statusCode,
                data,
              });
            }
          });
        }
      );

      req.on("timeout", () => {
        req.destroy(
          new Error("Request timeout")
        );
      });

      req.on("error", reject);

      if (options.body) {
        req.write(options.body);
      }

      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/* ============================================================
   TMDB
============================================================ */

async function getTMDBMeta(id, type) {
  try {
    const path =
      type === "movie"
        ? "movie"
        : "tv";

    const url =
      `https://api.themoviedb.org/3/${path}/${id}` +
      `?api_key=${TMDB_KEY}` +
      `&language=en-US` +
      `&append_to_response=external_ids`;

    const response = await fetchURL(
      url,
      { timeout: 10000 }
    );

    return response.status === 200
      ? response.data
      : null;
  } catch {
    return null;
  }
}

/* ============================================================
   HELPERS
============================================================ */

function decodeHTMLEntities(text) {
  if (!text) return "";

  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x27;/g, "'");
}

function parseSize(sizeStr) {
  if (!sizeStr) return 0;

  const m =
    String(sizeStr).match(
      /([\d.]+)\s*(GB|MB|KB|TB)/i
    );

  if (!m) return 0;

  const value =
    parseFloat(m[1]);

  const unit =
    m[2].toUpperCase();

  const multipliers = {
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  };

  return Math.round(
    value *
      (multipliers[unit] || 0)
  );
}

/* ============================================================
   TORRENTIO
============================================================ */

async function searchTorrentio(
  imdbId,
  type,
  season,
  episode
) {
  try {
    let url;

    if (type === "movie") {
      url =
        `${TORRENTIO_BASE}/stream/movie/${imdbId}.json`;
    } else {
      url =
        `${TORRENTIO_BASE}/stream/series/${imdbId}:${season || 1}:${episode || 1}.json`;
    }

    console.log(
      `   🔍 Torrentio: ${url.replace(
        TORRENTIO_BASE,
        ""
      )}`
    );

    const response =
      await fetchURL(
        url,
        { timeout: 20000 }
      );

    if (response.status !== 200) {
      console.log(
        `   ⚠ Torrentio returned ${response.status}`
      );

      return [];
    }

    const data =
      response.data;

    if (!data?.streams?.length) {
      console.log(
        "   📭 Torrentio: لا نتائج"
      );

      return [];
    }

    const results = [];

    for (const stream of data.streams) {
      if (!stream.infoHash) {
        continue;
      }

      const title =
        stream.title || "";

      const lower =
        title.toLowerCase();

      let quality = "?";

      if (
        lower.includes("4k") ||
        lower.includes("2160p") ||
        lower.includes("uhd")
      ) {
        quality = "4K";
      } else if (
        lower.includes("1080p")
      ) {
        quality = "1080p";
      } else if (
        lower.includes("720p")
      ) {
        quality = "720p";
      } else if (
        lower.includes("480p")
      ) {
        quality = "480p";
      }

      const sourceMatch =
        title.match(
          /⚙️\s*([^\n🇬🇧🇸🇦🇪🇸🇫🇷🇩🇪🇮🇹🇯🇵🇰🇷🇨🇳🇷🇺🇵🇹🇮🇳]+)/
        );

      const source =
        sourceMatch
          ? sourceMatch[1].trim()
          : "torrentio";

      const sizeMatch =
        title.match(
          /💾\s*([\d.]+\s*[GMK]B)/
        );

      const sizeStr =
        sizeMatch
          ? sizeMatch[1]
          : "";

      const magnet =
        buildMagnet(
          stream.infoHash,
          title,
          stream.sources || []
        );

      results.push({
        name:
          title.split("\n")[0] ||
          title,

        title,

        url_path:
          null,

        magnet,

        quality,

        size_str:
          sizeStr,

        size:
          parseSize(sizeStr),

        seeds:
          0,

        source:
          `torrentio-${source
            .toLowerCase()
            .replace(/\s+/g, "")}`,

        infoHash:
          stream.infoHash,

        fileIdx:
          stream.fileIdx || 0,
      });
    }

    console.log(
      `   ✅ Torrentio: ${results.length} نتيجة`
    );

    return results;
  } catch (err) {
    console.warn(
      `   ⚠ Torrentio error: ${err.message}`
    );

    return [];
  }
}

function buildMagnet(
  infoHash,
  title,
  trackers
) {
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
    ...(trackers || [])
      .filter((item) =>
        String(item).startsWith("tracker:")
      )
      .map((item) =>
        String(item).replace(
          "tracker:",
          ""
        )
      ),

    ...defaultTrackers,
  ];

  const uniqueTrackers =
    [...new Set(allTrackers)];

  const encodedName =
    encodeURIComponent(
      String(title).split("\n")[0] ||
      "video"
    );

  const tr =
    uniqueTrackers
      .map(
        (tracker) =>
          `&tr=${encodeURIComponent(
            tracker
          )}`
      )
      .join("");

  return (
    `magnet:?xt=urn:btih:${infoHash}` +
    `&dn=${encodedName}` +
    tr
  );
}

/* ============================================================
   TORRENT QUALITY SCORE
============================================================ */

function getQualityScore(item) {
  const f =
    String(
      item?.name ||
      item?.title ||
      ""
    ).toLowerCase();

  const isMp4 =
    f.includes(".mp4") ||
    f.includes(" mp4") ||
    (
      !f.includes("mkv") &&
      !f.includes("remux") &&
      !f.includes("avi") &&
      !f.includes("webm")
    );

  const isMkv =
    f.includes(".mkv") ||
    f.includes(" mkv") ||
    f.includes("remux");

  const isWebm =
    f.includes(".webm") ||
    f.includes(" webm");

  const isHevc =
    f.includes("hevc") ||
    f.includes("h.265") ||
    f.includes("h265") ||
    f.includes("x265") ||
    f.includes("av1");

  const isH264 =
    f.includes("x264") ||
    f.includes("h.264") ||
    f.includes("h264") ||
    f.includes("avc");

  let resolutionScore = 0;

  if (
    f.includes("2160p") ||
    f.includes("4k") ||
    f.includes("uhd")
  ) {
    resolutionScore = 400;
  } else if (
    f.includes("1080p") ||
    f.includes("fhd")
  ) {
    resolutionScore = 300;
  } else if (
    f.includes("720p") ||
    f.includes("hdrip")
  ) {
    resolutionScore = 200;
  } else if (
    f.includes("480p") ||
    f.includes("dvdrip")
  ) {
    resolutionScore = 100;
  } else {
    resolutionScore = 50;
  }

  let compatibilityScore = 0;

  if (
    isMp4 &&
    isH264 &&
    !isHevc
  ) {
    compatibilityScore = 5000;
  } else if (
    isMp4 &&
    !isHevc
  ) {
    compatibilityScore = 4200;
  } else if (
    isWebm &&
    !isHevc
  ) {
    compatibilityScore = 3500;
  } else if (
    isMp4 &&
    isHevc
  ) {
    compatibilityScore = 2500;
  } else if (
    isMkv &&
    isH264 &&
    !isHevc
  ) {
    compatibilityScore = 1800;
  } else if (
    isMkv &&
    !isHevc
  ) {
    compatibilityScore = 1200;
  } else if (
    isMkv &&
    isHevc
  ) {
    compatibilityScore = 200;
  } else {
    compatibilityScore = -500;
  }

  if (f.includes("remux")) {
    compatibilityScore -= 1000;
  }

  return (
    compatibilityScore +
    resolutionScore
  );
}

/* ============================================================
   REAL-DEBRID
============================================================ */

async function rdAddMagnet(
  magnet
) {
  try {
    const response =
      await fetchURL(
        "https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
        {
          method: "POST",

          body:
            `magnet=${encodeURIComponent(
              magnet
            )}`,

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded",

            Authorization:
              `Bearer ${RD_TOKEN}`,
          },

          timeout:
            15000,
        }
      );

    if (
      response.status === 200 ||
      response.status === 201
    ) {
      return response.data;
    }

    console.error(
      `❌ RD addMagnet ${response.status}`,
      response.data
    );

    return null;
  } catch (err) {
    console.error(
      "❌ RD addMagnet error:",
      err.message
    );

    return null;
  }
}

async function rdSelectFiles(
  torrentId,
  files = "all"
) {
  try {
    const response =
      await fetchURL(
        `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${encodeURIComponent(
          torrentId
        )}`,
        {
          method:
            "POST",

          body:
            `files=${encodeURIComponent(
              files
            )}`,

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded",

            Authorization:
              `Bearer ${RD_TOKEN}`,
          },

          timeout:
            10000,
        }
      );

    return (
      response.status === 200 ||
      response.status === 204
    );
  } catch {
    return false;
  }
}

async function rdGetTorrentInfo(
  torrentId
) {
  try {
    const response =
      await fetchURL(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${encodeURIComponent(
          torrentId
        )}`,
        {
          headers: {
            Authorization:
              `Bearer ${RD_TOKEN}`,
          },

          timeout:
            10000,
        }
      );

    return response.status === 200
      ? response.data
      : null;
  } catch {
    return null;
  }
}

async function rdWaitForTorrent(
  torrentId,
  maxWaitMs = 240000
) {
  const start =
    Date.now();

  while (
    Date.now() - start <
    maxWaitMs
  ) {
    const info =
      await rdGetTorrentInfo(
        torrentId
      );

    if (info) {
      if (
        info.status ===
        "downloaded"
      ) {
        return info;
      }

      if (
        info.status ===
        "waiting_files_selection"
      ) {
        await rdSelectFiles(
          torrentId,
          "all"
        );
      }

      if (
        [
          "error",
          "magnet_error",
          "virus",
          "dead",
        ].includes(
          info.status
        )
      ) {
        return null;
      }
    }

    await new Promise(
      (resolve) =>
        setTimeout(resolve, 3000)
    );
  }

  return null;
}

async function rdUnrestrict(
  link
) {
  try {
    const response =
      await fetchURL(
        "https://api.real-debrid.com/rest/1.0/unrestrict/link",
        {
          method: "POST",

          body:
            `link=${encodeURIComponent(
              link
            )}`,

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded",

            Authorization:
              `Bearer ${RD_TOKEN}`,
          },

          timeout:
            15000,
        }
      );

    if (
      response.status === 200 ||
      response.status === 201
    ) {
      return response.data;
    }

    console.warn(
      `   ⚠ unrestrict returned ${response.status}`
    );

    return null;
  } catch (err) {
    console.warn(
      `   ⚠ unrestrict error: ${err.message}`
    );

    return null;
  }
}

/* ============================================================
   REAL-DEBRID MEDIA INFOS
============================================================ */

async function rdGetMediaInfos(
  streamingId
) {
  try {
    const response =
      await fetchURL(
        `https://api.real-debrid.com/rest/1.0/streaming/mediaInfos/${encodeURIComponent(
          streamingId
        )}`,
        {
          method:
            "GET",

          headers: {
            Authorization:
              `Bearer ${RD_TOKEN}`,
          },

          timeout:
            15000,
        }
      );

    if (
      response.status !== 200
    ) {
      console.warn(
        `   ⚠ mediaInfos ${response.status} for ${streamingId}`
      );

      return null;
    }

    return response.data;
  } catch (err) {
    console.warn(
      `   ⚠ mediaInfos error: ${err.message}`
    );

    return null;
  }
}

/* ============================================================
   REAL-DEBRID TRANSCODE
============================================================ */

async function rdGetTranscodedLinks(
  streamingId
) {
  try {
    const response =
      await fetchURL(
        `https://api.real-debrid.com/rest/1.0/streaming/transcode/${encodeURIComponent(
          streamingId
        )}`,
        {
          method:
            "GET",

          headers: {
            Authorization:
              `Bearer ${RD_TOKEN}`,
          },

          timeout:
            15000,
        }
      );

    if (
      response.status !== 200
    ) {
      console.warn(
        `   ⚠ transcode ${response.status} for ${streamingId}`
      );

      return null;
    }

    return response.data;
  } catch (err) {
    console.warn(
      `   ⚠ transcode error: ${err.message}`
    );

    return null;
  }
}

/* ============================================================
   MEDIA INFO HELPERS
============================================================ */

function firstVideoTrack(
  mediaInfo
) {
  const videos =
    mediaInfo?.details?.video;

  if (
    !videos ||
    typeof videos !== "object"
  ) {
    return null;
  }

  return (
    Object.values(
      videos
    ).find(
      (entry) =>
        entry &&
        typeof entry === "object"
    ) || null
  );
}

function firstAudioTrack(
  mediaInfo
) {
  const audios =
    mediaInfo?.details?.audio;

  if (
    !audios ||
    typeof audios !== "object"
  ) {
    return null;
  }

  return (
    Object.values(
      audios
    ).find(
      (entry) =>
        entry &&
        typeof entry === "object"
    ) || null
  );
}

function normalizeCodec(
  codec
) {
  return String(
    codec || ""
  )
    .toLowerCase()
    .replace(
      /[.\s_-]/g,
      ""
    );
}

function getMediaContainer(
  filename,
  mimeType
) {
  const name =
    String(
      filename || ""
    ).toLowerCase();

  const mime =
    String(
      mimeType || ""
    ).toLowerCase();

  if (
    name.endsWith(".mp4") ||
    mime.includes("video/mp4")
  ) {
    return "mp4";
  }

  if (
    name.endsWith(".webm") ||
    mime.includes("video/webm")
  ) {
    return "webm";
  }

  if (
    name.endsWith(".mkv") ||
    mime.includes("matroska")
  ) {
    return "mkv";
  }

  if (
    name.endsWith(".mov") ||
    mime.includes("quicktime")
  ) {
    return "mov";
  }

  if (
    name.endsWith(".avi") ||
    mime.includes("avi")
  ) {
    return "avi";
  }

  return "unknown";
}

function isH264(
  codec
) {
  const normalized =
    normalizeCodec(
      codec
    );

  return (
    normalized === "h264" ||
    normalized === "avc" ||
    normalized.includes("avc1")
  );
}

function isH265(
  codec
) {
  const normalized =
    normalizeCodec(
      codec
    );

  return (
    normalized.includes("hevc") ||
    normalized.includes("h265") ||
    normalized.includes("x265")
  );
}

function isBrowserNativeMedia(
  mediaInfo,
  unrestricted
) {
  const filename =
    unrestricted?.filename ||
    mediaInfo?.filename ||
    "";

  const mimeType =
    unrestricted?.mimeType ||
    "";

  const container =
    getMediaContainer(
      filename,
      mimeType
    );

  const video =
    firstVideoTrack(
      mediaInfo
    );

  const codec =
    normalizeCodec(
      video?.codec
    );

  const mp4Native =
    container === "mp4" &&
    isH264(codec);

  const webmNative =
    container === "webm" &&
    (
      codec === "vp8" ||
      codec === "vp9" ||
      isH264(codec)
    );

  return (
    mp4Native ||
    webmNative
  );
}

/* ============================================================
   TRANSCODE URL PICKER
============================================================ */

function collectUrls(
  value,
  output = []
) {
  if (!value) {
    return output;
  }

  if (
    typeof value ===
    "string"
  ) {
    if (
      /^https?:\/\//i.test(
        value
      )
    ) {
      output.push(value);
    }

    return output;
  }

  if (
    Array.isArray(value)
  ) {
    for (
      const item of value
    ) {
      collectUrls(
        item,
        output
      );
    }

    return output;
  }

  if (
    typeof value ===
    "object"
  ) {
    for (
      const item of Object.values(
        value
      )
    ) {
      collectUrls(
        item,
        output
      );
    }
  }

  return output;
}

function pickBestTranscodeUrl(
  transcoded
) {
  if (
    !transcoded ||
    typeof transcoded !==
      "object"
  ) {
    return null;
  }

  /* HLS / Apple */
  const apple =
    collectUrls(
      transcoded.apple
    );

  if (
    apple.length
  ) {
    const full =
      apple.find(
        (url) =>
          /full\.m3u8/i.test(
            url
          )
      );

    const m3u8 =
      apple.find(
        (url) =>
          /\.m3u8(?:$|\?)/i.test(
            url
          )
      );

    return {
      url:
        full ||
        m3u8 ||
        apple[0],

      type:
        "hls",
    };
  }

  /* Live MP4 */
  const liveMP4 =
    collectUrls(
      transcoded.liveMP4
    );

  if (
    liveMP4.length
  ) {
    return {
      url:
        liveMP4[0],

      type:
        "mp4",
    };
  }

  /* H264 WebM */
  const h264WebM =
    collectUrls(
      transcoded.h264WebM
    );

  if (
    h264WebM.length
  ) {
    return {
      url:
        h264WebM[0],

      type:
        "webm",
    };
  }

  /* DASH */
  const dash =
    collectUrls(
      transcoded.dash
    );

  if (
    dash.length
  ) {
    const mpd =
      dash.find(
        (url) =>
          /\.mpd(?:$|\?)/i.test(
            url
          )
      );

    return {
      url:
        mpd ||
        dash[0],

      type:
        "dash",
    };
  }

  /* Legacy HLS */
  const legacyHls =
    collectUrls(
      transcoded.hls
    );

  if (
    legacyHls.length
  ) {
    return {
      url:
        legacyHls.find(
          (url) =>
            /\.m3u8(?:$|\?)/i.test(
              url
            )
        ) ||
        legacyHls[0],

      type:
        "hls",
    };
  }

  /* Legacy MP4 */
  const legacyMp4 =
    collectUrls(
      transcoded.mp4
    );

  if (
    legacyMp4.length
  ) {
    return {
      url:
        legacyMp4[0],

      type:
        "mp4",
    };
  }

  /* Legacy WebM */
  const legacyWebm =
    collectUrls(
      transcoded.webm
    );

  if (
    legacyWebm.length
  ) {
    return {
      url:
        legacyWebm[0],

      type:
        "webm",
    };
  }

  return null;
}

/* ============================================================
   MEDIA SCORING
============================================================ */

function getNativeScore(
  mediaInfo,
  unrestricted
) {
  const filename =
    unrestricted?.filename ||
    mediaInfo?.filename ||
    "";

  const mimeType =
    unrestricted?.mimeType ||
    "";

  const container =
    getMediaContainer(
      filename,
      mimeType
    );

  const video =
    firstVideoTrack(
      mediaInfo
    );

  const audio =
    firstAudioTrack(
      mediaInfo
    );

  const codec =
    normalizeCodec(
      video?.codec
    );

  const audioCodec =
    normalizeCodec(
      audio?.codec
    );

  let score = 0;

  if (
    container === "mp4"
  ) {
    score += 5000;
  } else if (
    container === "webm"
  ) {
    score += 3000;
  } else if (
    container === "mkv"
  ) {
    score += 800;
  } else {
    score -= 1500;
  }

  if (
    isH264(codec)
  ) {
    score += 3500;
  } else if (
    codec === "vp9" ||
    codec === "vp8"
  ) {
    score +=
      container ===
      "webm"
        ? 2500
        : 500;
  } else if (
    isH265(codec) ||
    codec.includes("av1")
  ) {
    score -= 2500;
  } else {
    score -= 1200;
  }

  if (
    audioCodec ===
      "aac" ||
    audioCodec.includes(
      "mp3"
    ) ||
    audioCodec ===
      "opus"
  ) {
    score += 500;
  }

  const width =
    Number(
      video?.width || 0
    );

  const height =
    Number(
      video?.height || 0
    );

  if (
    width >= 3840 ||
    height >= 2160
  ) {
    score += 400;
  } else if (
    width >= 1920 ||
    height >= 1080
  ) {
    score += 300;
  } else if (
    width >= 1280 ||
    height >= 720
  ) {
    score += 200;
  }

  return score;
}

/* ============================================================
   PLAYABLE URL RESOLVER
============================================================ */

async function rdGetPlayableUrl(
  unrestrictedLink
) {
  if (!unrestrictedLink) {
    return null;
  }

  /*
   * 1. Get fresh unrestricted URL.
   */
  const data =
    await rdUnrestrict(
      unrestrictedLink
    );

  if (!data?.id) {
    console.warn(
      "   ⚠ RD unrestrict did not return a streaming id"
    );

    return null;
  }

  const streamingId =
    data.id;

  /*
   * 2. Ask RD for actual media information.
   */
  const mediaInfo =
    await rdGetMediaInfos(
      streamingId
    );

  const filename =
    data.filename ||
    mediaInfo?.filename ||
    "unknown";

  const video =
    firstVideoTrack(
      mediaInfo
    );

  const container =
    getMediaContainer(
      filename,
      data.mimeType
    );

  console.log(
    `   🎞 MediaInfo: ${container} | ${
      video?.codec || "unknown"
    } | ${
      video?.width || "?"
    }x${
      video?.height || "?"
    }`
  );

  /*
   * 3. Ask RD for transcoding.
   *
   * HLS first.
   */
  const transcoded =
    await rdGetTranscodedLinks(
      streamingId
    );

  const transcodedPlayable =
    pickBestTranscodeUrl(
      transcoded
    );

  if (
    transcodedPlayable?.url
  ) {
    console.log(
      `   🎬 RD transcode: ${
        transcodedPlayable.type
      }`
    );

    return {
      url:
        transcodedPlayable.url,

      type:
        transcodedPlayable.type,

      formats:
        transcoded,

      mediaInfo,

      streamingId,

      filename,

      mimeType:
        data.mimeType ||
        null,

      native:
        false,
    };
  }

  /*
   * 4. If there is no transcode,
   *    only allow browser-native formats.
   */
  if (
    isBrowserNativeMedia(
      mediaInfo,
      data
    )
  ) {
    console.log(
      `   ▶ Native browser media: ${
        container
      }/${
        video?.codec ||
        "unknown"
      }`
    );

    return {
      url:
        data.download,

      type:
        container ===
        "webm"
          ? "webm"
          : "mp4",

      formats:
        null,

      mediaInfo,

      streamingId,

      filename,

      mimeType:
        data.mimeType ||
        null,

      native:
        true,
    };
  }

  /*
   * 5. Do not send MKV/HEVC raw.
   */
  console.warn(
    `   ❌ No browser-compatible RD stream for ${filename} (${container}/${video?.codec || "unknown"})`
  );

  return {
    url:
      null,

    type:
      "unsupported",

    formats:
      transcoded ||
      null,

    mediaInfo,

    streamingId,

    filename,

    mimeType:
      data.mimeType ||
      null,

    native:
      false,
  };
}

/* ============================================================
   FIND BEST LINK IN TORRENT
============================================================ */

async function rdFindBestPlayableLink(
  torrentInfo
) {
  const links =
    Array.isArray(
      torrentInfo?.links
    )
      ? torrentInfo.links
      : [];

  if (!links.length) {
    return null;
  }

  const files =
    Array.isArray(
      torrentInfo?.files
    )
      ? torrentInfo.files
      : [];

  const candidates = [];

  for (
    let i = 0;
    i < links.length;
    i++
  ) {
    const link =
      links[i];

    try {
      const unrestricted =
        await rdUnrestrict(
          link
        );

      if (
        !unrestricted?.id
      ) {
        console.log(
          `   ⚠ Link ${i + 1}: unrestrict failed`
        );

        continue;
      }

      const mediaInfo =
        await rdGetMediaInfos(
          unrestricted.id
        );

      const fileMeta =
        files[i] ||
        {};

      const filename =
        unrestricted.filename ||
        mediaInfo?.filename ||
        fileMeta.path ||
        torrentInfo.filename ||
        "";

      const score =
        getNativeScore(
          mediaInfo,
          {
            ...unrestricted,
            filename,
          }
        );

      const size =
        Number(
          unrestricted.filesize ||
          mediaInfo?.size ||
          fileMeta.bytes ||
          0
        );

      const video =
        firstVideoTrack(
          mediaInfo
        );

      candidates.push({
        link,

        filename,

        score,

        size,

        mediaInfo,

        unrestricted,

        video,

        index:
          i,
      });

      console.log(
        `   🔎 [${i + 1}/${links.length}] ${filename} | ${
          video?.codec || "?"
        } | ${
          video?.width || "?"
        }x${
          video?.height || "?"
        } | score ${score}`
      );
    } catch (err) {
      console.warn(
        `   ⚠ Media inspection failed: ${err.message}`
      );
    }
  }

  if (
    !candidates.length
  ) {
    return null;
  }

  candidates.sort(
    (a, b) => {
      if (
        b.score !==
        a.score
      ) {
        return (
          b.score -
          a.score
        );
      }

      return (
        b.size -
        a.size
      );
    }
  );

  return candidates[0];
}

async function rdResolveBestPlayableLink(
  torrentInfo
) {
  const candidate =
    await rdFindBestPlayableLink(
      torrentInfo
    );

  if (!candidate) {
    return null;
  }

  console.log(
    `   🎯 Selected: ${
      candidate.filename
    } | score ${
      candidate.score
    }`
  );

  const playable =
    await rdGetPlayableUrl(
      candidate.link
    );

  if (
    !playable?.url
  ) {
    console.log(
      "   ❌ Selected file has no browser-compatible stream"
    );

    return null;
  }

  return {
    ...playable,

    link:
      candidate.link,

    filename:
      candidate.filename,

    filesize:
      candidate.size,

    mediaInfo:
      playable.mediaInfo ||
      candidate.mediaInfo,
  };
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
  year,
}) {
  if (!OS_API_KEY) {
    return null;
  }

  try {
    let searchUrl;

    if (tmdbId) {
      const tmdbParam =
        type === "movie"
          ? `tmdb_id=${tmdbId}`
          : `tmdb_id=${tmdbId}&season_number=${season || 1}&episode_number=${episode || 1}`;

      searchUrl =
        `${OS_BASE}/subtitles?${tmdbParam}` +
        `&languages=ar` +
        `&order_by=download_count` +
        `&order_direction=desc`;
    } else if (title) {
      const query =
        encodeURIComponent(
          year
            ? `${title} ${year}`
            : title
        );

      searchUrl =
        `${OS_BASE}/subtitles?query=${query}` +
        `&languages=ar` +
        `&order_by=download_count` +
        `&order_direction=desc`;
    } else {
      return null;
    }

    const searchRes =
      await fetchURL(
        searchUrl,
        {
          headers: {
            "Api-Key":
              OS_API_KEY,

            "User-Agent":
              "BlueStream v1.0",

            Accept:
              "application/json",
          },

          timeout:
            12000,
        }
      );

    if (
      searchRes.status !==
        200 ||
      !searchRes.data?.data
        ?.length
    ) {
      return null;
    }

    const candidates =
      searchRes.data.data
        .filter(
          (item) =>
            item.attributes
              ?.language === "ar"
        );

    if (
      !candidates.length
    ) {
      return null;
    }

    const top =
      candidates[0];

    const fileId =
      top.attributes
        ?.files?.[0]
        ?.file_id;

    if (!fileId) {
      return null;
    }

    const dlRes =
      await fetchURL(
        `${OS_BASE}/download`,
        {
          method:
            "POST",

          headers: {
            "Api-Key":
              OS_API_KEY,

            "User-Agent":
              "BlueStream v1.0",

            "Content-Type":
              "application/json",

            Accept:
              "application/json",
          },

          body:
            JSON.stringify({
              file_id:
                fileId,

              sub_format:
                "srt",
            }),

          timeout:
            15000,
        }
      );

    if (
      dlRes.status !==
        200 ||
      !dlRes.data?.link
    ) {
      return null;
    }

    const srtRes =
      await fetchURL(
        dlRes.data.link,
        {
          timeout:
            15000,
        }
      );

    if (
      srtRes.status !==
        200 ||
      !srtRes.data
    ) {
      return null;
    }

    const srtContent =
      typeof srtRes.data ===
      "string"
        ? srtRes.data
        : String(
            srtRes.data
          );

    const srtBase64 =
      Buffer
        .from(
          srtContent,
          "utf8"
        )
        .toString(
          "base64"
        );

    const dataUrl =
      `data:text/plain;charset=utf-8;base64,${srtBase64}`;

    return {
      url:
        dataUrl,

      language:
        "ar",

      label:
        "العربية",

      source:
        "opensubtitles",

      release:
        top.attributes
          ?.release || "",
    };
  } catch (err) {
    console.warn(
      "OS error:",
      err.message
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
  withSubs,
}) {
  /* ----------------------------------------------------------
     CACHE
  ---------------------------------------------------------- */

  const cached =
    await cache.getCache(
      id,
      type,
      sNum,
      eNum
    );

  /*
   * Even if cache is fresh,
   * NEVER trust an old RD playback URL.
   * Use rd_link and generate a new playback URL.
   */
  if (
    cached.hit &&
    cached.fresh
  ) {
    let playable =
      null;

    if (
      cached.data?.rd_link
    ) {
      playable =
        await rdGetPlayableUrl(
          cached.data.rd_link
        );
    }

    if (
      playable?.url
    ) {
      const subtitle =
        withSubs
          ? await searchOpenSubtitles(
              {
                tmdbId:
                  parseInt(id),

                type,

                season:
                  sNum,

                episode:
                  eNum,

                title:
                  cached.data
                    .title,

                year:
                  cached.data
                    .year,
              }
            )
          : null;

      return {
        success:
          true,

        provider:
          `real-debrid+${
            cached.data
              .source ||
            "cache"
          }`,

        quality:
          cached.data
            .quality,

        title:
          cached.data
            .title,

        year:
          cached.data
            .year,

        filename:
          playable.filename ||
          cached.data
            .filename,

        stream_url:
          playable.url,

        stream_type:
          playable.type,

        subtitle,

        subtitles:
          subtitle
            ? [subtitle.url]
            : [],

        size_mb:
          Math.round(
            (
              playable.filesize ||
              cached.data
                .file_size_bytes ||
              0
            ) /
              1024 /
              1024
          ),

        seeds:
          cached.data
            .seeds || 0,

        poster:
          cached.data
            .poster_path
            ? `https://image.tmdb.org/t/p/w500${cached.data.poster_path}`
            : null,

        backdrop:
          cached.data
            .backdrop_path
            ? `https://image.tmdb.org/t/p/w1280${cached.data.backdrop_path}`
            : null,

        cached:
          true,

        refreshed:
          true,
      };
    }

    console.log(
      "   ⚠ Cached RD link is no longer playable; continuing with torrent search..."
    );
  }

  /* ----------------------------------------------------------
     RE-UNRESTRICT
  ---------------------------------------------------------- */

  if (
    cached.hit &&
    !cached.fresh &&
    cached.data?.magnet
  ) {
    try {
      let playable =
        null;

      if (
        cached.data.rd_link
      ) {
        playable =
          await rdGetPlayableUrl(
            cached.data.rd_link
          );
      }

      if (
        !playable?.url &&
        cached.data.rd_torrent_id
      ) {
        const info =
          await rdGetTorrentInfo(
            cached.data
              .rd_torrent_id
          );

        if (
          info?.status ===
            "downloaded" &&
          info.links?.length
        ) {
          const resolved =
            await rdResolveBestPlayableLink(
              info
            );

          if (
            resolved?.url
          ) {
            playable =
              resolved;
          }
        }
      }

      if (
        !playable?.url
      ) {
        const added =
          await rdAddMagnet(
            cached.data
              .magnet
          );

        if (added?.id) {
          await rdSelectFiles(
            added.id,
            "all"
          );

          const info =
            await rdWaitForTorrent(
              added.id,
              180000
            );

          if (
            info?.links?.length
          ) {
            const resolved =
              await rdResolveBestPlayableLink(
                info
              );

            if (
              resolved?.url
            ) {
              playable =
                resolved;
            }
          }
        }
      }

      if (
        playable?.url
      ) {
        await cache.setCache(
          {
            tmdb_id:
              parseInt(id),

            media_type:
              type,

            season:
              sNum,

            episode:
              eNum,

            title:
              cached.data
                .title,

            year:
              cached.data
                .year,

            stream_url:
              playable.url,

            stream_type:
              playable.type,

            rd_torrent_id:
              cached.data
                .rd_torrent_id,

            rd_link:
              playable.link ||
              cached.data
                .rd_link,

            magnet:
              cached.data
                .magnet,

            source:
              cached.data
                .source,

            status:
              "ready",

            file_size_bytes:
              playable.filesize ||
              cached.data
                .file_size_bytes,

            quality:
              cached.data
                .quality,

            filename:
              playable.filename ||
              cached.data
                .filename,

            seeds:
              cached.data
                .seeds,

            poster_path:
              cached.data
                .poster_path,

            backdrop_path:
              cached.data
                .backdrop_path,
          }
        );

        const subtitle =
          withSubs
            ? await searchOpenSubtitles(
                {
                  tmdbId:
                    parseInt(id),

                  type,

                  season:
                    sNum,

                  episode:
                    eNum,

                  title:
                    cached.data
                      .title,

                  year:
                    cached.data
                      .year,
                }
              )
            : null;

        return {
          success:
            true,

          provider:
            `real-debrid+${
              cached.data
                .source ||
              "cache"
            }`,

          quality:
            cached.data
              .quality,

          title:
            cached.data
              .title,

          stream_url:
            playable.url,

          stream_type:
            playable.type,

          subtitle,

          subtitles:
            subtitle
              ? [subtitle.url]
              : [],

          poster:
            cached.data
              .poster_path
              ? `https://image.tmdb.org/t/p/w500${cached.data.poster_path}`
              : null,

          backdrop:
            cached.data
              .backdrop_path
              ? `https://image.tmdb.org/t/p/w1280${cached.data.backdrop_path}`
              : null,

          cached:
            true,

          refreshed:
            true,
        };
      }
    } catch (err) {
      console.warn(
        "re-unrestrict failed:",
        err.message
      );
    }
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
        "TMDB not found",
    };
  }

  const displayTitle =
    meta.title ||
    meta.name ||
    meta.original_title ||
    meta.original_name;

  const year =
    (
      meta.release_date ||
      meta.first_air_date ||
      ""
    ).slice(0, 4);

  const poster =
    meta.poster_path
      ? `https://image.tmdb.org/t/p/w500${meta.poster_path}`
      : null;

  const backdrop =
    meta.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${meta.backdrop_path}`
      : null;

  console.log(
    `\n🎬 ${displayTitle} (${year || "?"}) | ${type} S${
      sNum || 1
    }E${
      eNum || 1
    }`
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
        "IMDB ID not found for this title",
    };
  }

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
    torrents.length ===
    0
  ) {
    return {
      success:
        false,

      error:
        `لم يتم العثور على "${displayTitle}"`,
    };
  }

  console.log(
    `📊 إجمالي النتائج: ${torrents.length} torrent`
  );

  /*
   * MP4/H264 first, then general browser compatibility,
   * then resolution.
   */
  torrents.sort(
    (a, b) =>
      getQualityScore(b) -
      getQualityScore(a)
  );

  /*
   * More attempts because some RD magnets may fail.
   */
  const maxAttempts =
    Math.min(
      10,
      torrents.length
    );

  for (
    let i = 0;
    i < maxAttempts;
    i++
  ) {
    const torrent =
      torrents[i];

    console.log(
      `\n🔄 [${i + 1}/${maxAttempts}] ${
        torrent.quality
      } | ${
        (
          torrent.name ||
          ""
        ).substring(
          0,
          90
        )
      }`
    );

    const added =
      await rdAddMagnet(
        torrent.magnet
      );

    if (
      !added?.id
    ) {
      console.log(
        "   ❌ Failed to add"
      );

      continue;
    }

    console.log(
      `   ✓ Added to RD: ${added.id}`
    );

    await rdSelectFiles(
      added.id,
      "all"
    );

    const torrentInfo =
      await rdWaitForTorrent(
        added.id
      );

    if (!torrentInfo) {
      console.log(
        "   ❌ Download timeout/error"
      );

      continue;
    }

    console.log(
      `   ✓ Downloaded: ${torrentInfo.filename}`
    );

    const links =
      torrentInfo.links ||
      [];

    if (
      !links.length
    ) {
      console.log(
        "   ❌ No links found"
      );

      continue;
    }

    /*
     * Important:
     * Do NOT choose biggest file.
     * Inspect each file using mediaInfos
     * and prefer browser-compatible content.
     */
    const playable =
      await rdResolveBestPlayableLink(
        torrentInfo
      );

    if (
      !playable?.url
    ) {
      console.log(
        "   ❌ No browser-compatible RD stream for this torrent"
      );

      continue;
    }

    console.log(
      `   ✅ Got stream URL (${playable.type})!`
    );

    await cache.setCache(
      {
        tmdb_id:
          parseInt(id),

        media_type:
          type,

        season:
          sNum,

        episode:
          eNum,

        title:
          displayTitle,

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
          meta.episode_run_time?.[0] ||
          null,

        vote_average:
          meta.vote_average,

        genres:
          meta.genres
            ?.map(
              (g) => g.name
            )
            .join(", ") ||
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
          torrentInfo.filename,

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
          "ready",
      }
    );

    const subtitle =
      withSubs
        ? await searchOpenSubtitles(
            {
              tmdbId:
                parseInt(id),

              type,

              season:
                sNum,

              episode:
                eNum,

              title:
                displayTitle,

              year,
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

      title:
        displayTitle,

      year,

      filename:
        playable.filename ||
        torrentInfo.filename,

      stream_url:
        playable.url,

      stream_type:
        playable.type,

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
        false,
    };
  }

  return {
    success:
      false,

    error:
      `فشل تحميل أي من ${torrents.length} torrents`,
  };
}

/* ============================================================
   ENDPOINTS
============================================================ */

app.get(
  "/api/subtitles",
  async (req, res) => {
    const {
      tmdb_id,
      type,
      season,
      episode,
      title,
      year,
    } = req.query;

    if (
      !tmdb_id &&
      !title
    ) {
      return res.status(400).json(
        {
          success:
            false,

          error:
            "Missing tmdb_id or title",
        }
      );
    }

    try {
      const sub =
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

            year,
          }
        );

      if (!sub) {
        return res.json(
          {
            success:
              false,

            error:
              "no_subtitles_found",
          }
        );
      }

      res.json(
        {
          success:
            true,

          subtitle:
            sub,
        }
      );
    } catch (err) {
      res.status(500).json(
        {
          success:
            false,

          error:
            err.message,
        }
      );
    }
  }
);

app.get(
  "/api/play",
  async (req, res) => {
    const {
      id,
      type,
      season,
      episode,
      with_subs =
        "1",
    } = req.query;

    if (
      !id ||
      !type
    ) {
      return res.status(400).json(
        {
          success:
            false,

          error:
            "Missing id or type",
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
      "tv"
        ? parseInt(
            season || 1
          )
        : null;

    const eNum =
      type ===
      "tv"
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
              "1",
          }
        );

      if (
        result.success
      ) {
        return res.json(
          result
        );
      }

      return res
        .status(404)
        .json(result);
    } catch (err) {
      console.error(
        "❌ Error:",
        err
      );

      return res
        .status(500)
        .json(
          {
            success:
              false,

            error:
              err.message,
          }
        );
    }
  }
);

app.get(
  "/api/cache/stats",
  async (req, res) => {
    try {
      res.json(
        {
          success:
            true,

          stats:
            await cache.getStats(),
        }
      );
    } catch (err) {
      res.status(500).json(
        {
          success:
            false,

          error:
            err.message,
        }
      );
    }
  }
);

app.post(
  "/api/cache/clean",
  async (req, res) => {
    try {
      res.json(
        {
          success:
            true,

          expired_marked:
            await cache.cleanExpired(),
        }
      );
    } catch (err) {
      res.status(500).json(
        {
          success:
            false,

          error:
            err.message,
        }
      );
    }
  }
);

app.delete(
  "/api/cache/:tmdb_id/:type",
  async (req, res) => {
    try {
      const {
        tmdb_id,
        type,
      } = req.params;

      const {
        season,
        episode,
      } = req.query;

      const pool =
        cache.initPool();

      const [
        result,
      ] =
        await pool.execute(
          `
            DELETE FROM media_cache
            WHERE tmdb_id = ?
              AND media_type = ?
              AND season <=> ?
              AND episode <=> ?
          `,
          [
            parseInt(
              tmdb_id
            ),

            type,

            season ||
              null,

            episode ||
              null,
          ]
        );

      res.json(
        {
          success:
            true,

          deleted:
            result.affectedRows,
        }
      );
    } catch (err) {
      res.status(500).json(
        {
          success:
            false,

          error:
            err.message,
        }
      );
    }
  }
);

/* ============================================================
   HEALTH
============================================================ */

app.get(
  "/",
  (req, res) => {
    res.json(
      {
        status:
          "✅ BlueStream API v7.5",

        version:
          "7.5",

        features: [
          "Torrentio aggregator",
          "Real-Debrid",
          "mediaInfos",
          "transcode",
          "HLS first",
          "MP4/H264 priority",
          "browser-compatible file selection",
          "automatic Arabic subtitles",
        ],

        sources: [
          "1337x",
          "ThePirateBay",
          "RARBG",
          "TorrentGalaxy",
          "YTS",
          "EZTV",
          "NyaaSi",
          "AniDex",
          "MagnetDL",
          "Limetorrent",
          "Torrent9",
          "Rutracker",
          "+10 more",
        ],

        endpoints: {
          play:
            "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1&with_subs=1",

          subtitles:
            "/api/subtitles?tmdb_id=...&type=movie&title=...",
        },
      }
    );
  }
);

/* ============================================================
   START SERVER
============================================================ */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `\n🎬 BlueStream API v7.5 running on port ${PORT}`
    );

    console.log(
      `✅ RD Token: ${
        RD_TOKEN
          ? "Loaded"
          : "MISSING"
      }`
    );

    console.log(
      `✅ TMDB Key: ${
        TMDB_KEY
          ? "Loaded"
          : "MISSING"
      }`
    );

    console.log(
      `✅ OpenSubtitles: ${
        OS_API_KEY
          ? "Loaded"
          : "MISSING"
      }`
    );

    console.log(
      `✅ Torrentio: configured`
    );

    console.log(
      `✅ Real-Debrid mediaInfos: enabled`
    );

    console.log(
      `✅ Real-Debrid transcode: enabled`
    );
  }
);