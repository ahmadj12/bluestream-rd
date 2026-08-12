// ============================================================
// BlueStream API v7.6.1
// Streaming-first:
// Torrentio -> Real-Debrid -> HLS / MP4 / WebM / DASH
//
// Important:
// - mediaInfos is optional.
// - transcode is optional.
// - MP4 streamable fallback is supported.
// - /api/stream returns an absolute URL through /api/play.
// - No old Real-Debrid playback URL is trusted from cache.
// ============================================================

const express = require("express");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const cache = require("./cache");


// ============================================================
// DATABASE
// ============================================================

try {
  cache.initPool();

  cache
    .runMigrations()
    .catch((err) => {
      console.warn(
        "⚠️ Auto-migration skipped:",
        err.message
      );
    });
} catch (err) {
  console.warn(
    "⚠️ MySQL init failed:",
    err.message
  );
}


// ============================================================
// APP
// ============================================================

const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.header(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.header(
    "Access-Control-Allow-Headers",
    "*"
  );

  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});


// ============================================================
// CONFIG
// ============================================================

const PORT =
  process.env.PORT || 3000;

const RD_TOKEN =
  process.env.RD_TOKEN;

if (!RD_TOKEN) {
  console.error(
    "❌ خطأ: لم يتم تعيين RD_TOKEN"
  );

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


// ============================================================
// HTTP HEADERS
// ============================================================

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",

  "Accept":
    "application/json,text/html,application/xhtml+xml,*/*",

  "Accept-Language":
    "en-US,en;q=0.5",

  "Connection":
    "keep-alive"
};


// ============================================================
// GENERIC HTTP REQUEST
// ============================================================

function fetchURL(
  url,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      let parsed;

      try {
        parsed = new URL(url);
      } catch (err) {
        return reject(err);
      }

      const isHttps =
        parsed.protocol === "https:";

      const lib =
        isHttps
          ? https
          : http;

      const requestOptions = {
        method:
          options.method || "GET",

        hostname:
          parsed.hostname,

        port:
          parsed.port ||
          (isHttps ? 443 : 80),

        path:
          parsed.pathname +
          parsed.search,

        headers: {
          ...BROWSER_HEADERS,
          ...(options.headers || {})
        },

        timeout:
          options.timeout || 15000
      };

      delete requestOptions.headers[
        "Accept-Encoding"
      ];

      const request =
        lib.request(
          requestOptions,
          (response) => {
            let body = "";

            response.on(
              "data",
              (chunk) => {
                body += chunk;
              }
            );

            response.on(
              "end",
              () => {
                let data = body;

                try {
                  data =
                    JSON.parse(body);
                } catch {}

                resolve({
                  status:
                    response.statusCode,

                  headers:
                    response.headers,

                  data
                });
              }
            );
          }
        );

      request.on(
        "timeout",
        () => {
          request.destroy(
            new Error(
              "Request timeout"
            )
          );
        }
      );

      request.on(
        "error",
        reject
      );

      if (options.body) {
        request.write(
          options.body
        );
      }

      request.end();
    }
  );
}


// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function parseSize(
  size
) {
  if (!size) {
    return 0;
  }

  const match =
    String(size).match(
      /([\d.]+)\s*(KB|MB|GB|TB)/i
    );

  if (!match) {
    return 0;
  }

  const value =
    parseFloat(match[1]);

  const unit =
    match[2].toUpperCase();

  const multipliers = {
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024
  };

  return Math.round(
    value *
      (multipliers[unit] || 0)
  );
}

function getPoster(
  path
) {
  return path
    ? `https://image.tmdb.org/t/p/w500${path}`
    : null;
}

function getBackdrop(
  path
) {
  return path
    ? `https://image.tmdb.org/t/p/w1280${path}`
    : null;
}


// ============================================================
// TMDB
// ============================================================

async function getTMDBMeta(
  id,
  type
) {
  try {
    const mediaPath =
      type === "movie"
        ? "movie"
        : "tv";

    const url =
      `https://api.themoviedb.org/3/${mediaPath}/${id}` +
      `?api_key=${TMDB_KEY}` +
      `&language=en-US` +
      `&append_to_response=external_ids`;

    const response =
      await fetchURL(
        url,
        {
          timeout: 10000
        }
      );

    if (
      response.status !== 200
    ) {
      return null;
    }

    return response.data;
  } catch {
    return null;
  }
}


// ============================================================
// TORRENTIO
// ============================================================

function buildMagnet(
  infoHash,
  title,
  trackers = []
) {
  const defaultTrackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.openbittorrent.com:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://open.stealth.si:80/announce"
  ];

  const torrentTrackers =
    trackers
      .filter((item) =>
        String(item).startsWith(
          "tracker:"
        )
      )
      .map((item) =>
        String(item).replace(
          "tracker:",
          ""
        )
      );

  const uniqueTrackers =
    [
      ...new Set([
        ...torrentTrackers,
        ...defaultTrackers
      ])
    ];

  const name =
    encodeURIComponent(
      String(title).split(
        "\n"
      )[0] || "video"
    );

  const query =
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
    `&dn=${name}` +
    query
  );
}

function getTorrentScore(
  item
) {
  const filename =
    String(
      item?.name ||
      item?.title ||
      ""
    ).toLowerCase();

  const isMP4 =
    filename.includes(
      ".mp4"
    ) ||
    filename.includes(
      " mp4"
    );

  const isWebM =
    filename.includes(
      ".webm"
    ) ||
    filename.includes(
      " webm"
    );

  const isMKV =
    filename.includes(
      ".mkv"
    ) ||
    filename.includes(
      " mkv"
    ) ||
    filename.includes(
      "remux"
    );

  const isH264 =
    filename.includes(
      "x264"
    ) ||
    filename.includes(
      "h.264"
    ) ||
    filename.includes(
      "h264"
    ) ||
    filename.includes(
      "avc"
    );

  const isHEVC =
    filename.includes(
      "hevc"
    ) ||
    filename.includes(
      "h.265"
    ) ||
    filename.includes(
      "h265"
    ) ||
    filename.includes(
      "x265"
    ) ||
    filename.includes(
      "av1"
    );

  let score = 0;

  if (isMP4) {
    score += 5000;
  } else if (isWebM) {
    score += 3500;
  } else if (isMKV) {
    score += 1000;
  }

  if (
    isH264 &&
    !isHEVC
  ) {
    score += 3000;
  }

  if (isHEVC) {
    score -= 2500;
  }

  if (
    filename.includes(
      "2160p"
    ) ||
    filename.includes(
      "4k"
    ) ||
    filename.includes(
      "uhd"
    )
  ) {
    score += 400;
  } else if (
    filename.includes(
      "1080p"
    ) ||
    filename.includes(
      "fhd"
    )
  ) {
    score += 300;
  } else if (
    filename.includes(
      "720p"
    )
  ) {
    score += 200;
  } else if (
    filename.includes(
      "480p"
    )
  ) {
    score += 100;
  }

  if (
    filename.includes(
      "remux"
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
    let url;

    if (
      type === "movie"
    ) {
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
        {
          timeout: 20000
        }
      );

    if (
      response.status !== 200
    ) {
      return [];
    }

    const streams =
      response.data?.streams;

    if (
      !Array.isArray(streams) ||
      streams.length === 0
    ) {
      return [];
    }

    const results = [];

    for (
      const stream of streams
    ) {
      if (
        !stream.infoHash
      ) {
        continue;
      }

      const title =
        stream.title ||
        "";

      const lower =
        title.toLowerCase();

      let quality = "?";

      if (
        lower.includes("2160p") ||
        lower.includes("4k") ||
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
          /💾\s*([\d.]+\s*[GMK]B)/i
        );

      const sizeString =
        sizeMatch
          ? sizeMatch[1]
          : "";

      results.push({
        name:
          title.split(
            "\n"
          )[0] || title,

        title,

        magnet:
          buildMagnet(
            stream.infoHash,
            title,
            stream.sources ||
              []
          ),

        quality,

        size:
          parseSize(
            sizeString
          ),

        size_str:
          sizeString,

        seeds: 0,

        source:
          `torrentio-${source
            .toLowerCase()
            .replace(
              /\s+/g,
              ""
            )}`,

        infoHash:
          stream.infoHash,

        fileIdx:
          stream.fileIdx ||
          0
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


// ============================================================
// REAL-DEBRID BASIC API
// ============================================================

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
              `Bearer ${RD_TOKEN}`
          },

          timeout: 15000
        }
      );

    if (
      response.status === 200 ||
      response.status === 201
    ) {
      return response.data;
    }

    console.warn(
      `   ❌ RD addMagnet ${response.status}`,
      response.data
    );

    return null;
  } catch (err) {
    console.warn(
      `   ❌ RD addMagnet error: ${err.message}`
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
          method: "POST",

          body:
            `files=${encodeURIComponent(
              files
            )}`,

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded",

            Authorization:
              `Bearer ${RD_TOKEN}`
          },

          timeout: 10000
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
              `Bearer ${RD_TOKEN}`
          },

          timeout: 10000
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
    Date.now() -
      start <
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
          "dead"
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
              `Bearer ${RD_TOKEN}`
          },

          timeout: 15000
        }
      );

    if (
      response.status === 200 ||
      response.status === 201
    ) {
      return response.data;
    }

    return null;
  } catch {
    return null;
  }
}


// ============================================================
// MEDIA INFO
// ============================================================

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
          headers: {
            Authorization:
              `Bearer ${RD_TOKEN}`
          },

          timeout: 15000
        }
      );

    if (
      response.status !== 200
    ) {
      console.warn(
        `   ⚠ mediaInfos ${response.status}`,
        response.data
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


// ============================================================
// TRANSCODE
// ============================================================

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
          headers: {
            Authorization:
              `Bearer ${RD_TOKEN}`
          },

          timeout: 15000
        }
      );

    if (
      response.status !== 200
    ) {
      console.warn(
        `   ⚠ transcode ${response.status}`,
        response.data
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


// ============================================================
// URL EXTRACTOR
// ============================================================

function collectURLs(
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
      collectURLs(
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
      collectURLs(
        item,
        output
      );
    }
  }

  return output;
}


// ============================================================
// BEST TRANSCODE
// ============================================================

function pickBestTranscode(
  data
) {
  if (!data) {
    return null;
  }

  // HLS first

  const hls =
    collectURLs(
      data.apple
    );

  if (
    hls.length
  ) {
    return {
      url:
        hls.find(
          (url) =>
            /\.m3u8(?:$|\?)/i.test(
              url
            )
        ) ||
        hls[0],

      type:
        "hls"
    };
  }

  // Live MP4

  const mp4 =
    collectURLs(
      data.liveMP4
    );

  if (
    mp4.length
  ) {
    return {
      url:
        mp4[0],

      type:
        "mp4"
    };
  }

  // H264 WebM

  const webm =
    collectURLs(
      data.h264WebM
    );

  if (
    webm.length
  ) {
    return {
      url:
        webm[0],

      type:
        "webm"
    };
  }

  // DASH

  const dash =
    collectURLs(
      data.dash
    );

  if (
    dash.length
  ) {
    return {
      url:
        dash.find(
          (url) =>
            /\.mpd(?:$|\?)/i.test(
              url
            )
        ) ||
        dash[0],

      type:
        "dash"
    };
  }

  // Legacy HLS

  const oldHLS =
    collectURLs(
      data.hls
    );

  if (
    oldHLS.length
  ) {
    return {
      url:
        oldHLS.find(
          (url) =>
            /\.m3u8(?:$|\?)/i.test(
              url
            )
        ) ||
        oldHLS[0],

      type:
        "hls"
    };
  }

  // Legacy MP4

  const oldMP4 =
    collectURLs(
      data.mp4
    );

  if (
    oldMP4.length
  ) {
    return {
      url:
        oldMP4[0],

      type:
        "mp4"
    };
  }

  // Legacy WebM

  const oldWebM =
    collectURLs(
      data.webm
    );

  if (
    oldWebM.length
  ) {
    return {
      url:
        oldWebM[0],

      type:
        "webm"
    };
  }

  return null;
}


// ============================================================
// MEDIA HELPERS
// ============================================================

function getContainer(
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
    mime.includes(
      "video/mp4"
    )
  ) {
    return "mp4";
  }

  if (
    name.endsWith(".webm") ||
    mime.includes(
      "video/webm"
    )
  ) {
    return "webm";
  }

  if (
    name.endsWith(".mkv") ||
    mime.includes(
      "matroska"
    )
  ) {
    return "mkv";
  }

  return "unknown";
}

function isStreamable(
  value
) {
  return (
    value === true ||
    Number(value) === 1 ||
    String(
      value
    ).toLowerCase() ===
      "true"
  );
}

function looksHEVC(
  filename,
  mediaInfo
) {
  const filenameText =
    String(
      filename || ""
    ).toLowerCase();

  const codec =
    String(
      mediaInfo?.codec ||
        ""
    ).toLowerCase();

  return (
    /hevc|h\.265|h265|x265|av1/.test(
      filenameText
    ) ||
    /hevc|h265|x265|av1/.test(
      codec
    )
  );
}

function looksH264(
  filename,
  mediaInfo
) {
  const filenameText =
    String(
      filename || ""
    ).toLowerCase();

  const codec =
    String(
      mediaInfo?.codec ||
        ""
    ).toLowerCase();

  return (
    /x264|h\.264|h264|avc/.test(
      filenameText
    ) ||
    /h264|avc/.test(
      codec
    )
  );
}


// ============================================================
// SINGLE LINK INSPECTION
// ============================================================

async function inspectRDLink(
  link
) {
  const unrestricted =
    await rdUnrestrict(
      link
    );

  if (
    !unrestricted?.download
  ) {
    return null;
  }

  const mediaInfo =
    unrestricted.id
      ? await rdGetMediaInfos(
          unrestricted.id
        )
      : null;

  const filename =
    unrestricted.filename ||
    "";

  const mimeType =
    unrestricted.mimeType ||
    "";

  const container =
    getContainer(
      filename,
      mimeType
    );

  const hevc =
    looksHEVC(
      filename,
      mediaInfo
    );

  const h264 =
    looksH264(
      filename,
      mediaInfo
    );

  const streamable =
    isStreamable(
      unrestricted.streamable
    );

  const nativeMP4 =
    container === "mp4" &&
    streamable &&
    !hevc;

  const nativeWebM =
    container === "webm" &&
    streamable &&
    !hevc;

  let score = 0;

  if (
    container === "mp4"
  ) {
    score += 5000;
  } else if (
    container === "webm"
  ) {
    score += 3500;
  } else if (
    container === "mkv"
  ) {
    score += 1000;
  }

  if (
    h264 &&
    !hevc
  ) {
    score += 3000;
  }

  if (hevc) {
    score -= 2500;
  }

  if (streamable) {
    score += 1000;
  }

  if (
    nativeMP4
  ) {
    score += 2500;
  }

  if (
    nativeWebM
  ) {
    score += 1500;
  }

  return {
    ...unrestricted,

    link,

    mediaInfo,

    filename,

    mimeType,

    container,

    hevc,

    h264,

    streamable,

    score
  };
}


// ============================================================
// GET PLAYABLE URL FROM ONE LINK
// ============================================================

async function getPlayableFromInspected(
  info
) {
  if (
    !info?.download
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // First: try HLS / transcode
  // ----------------------------------------------------------

  if (
    info.id
  ) {
    const transcoded =
      await rdGetTranscodedLinks(
        info.id
      );

    const transcodedResult =
      pickBestTranscode(
        transcoded
      );

    if (
      transcodedResult?.url
    ) {
      console.log(
        `   🎬 RD transcode: ${transcodedResult.type}`
      );

      return {
        url:
          transcodedResult.url,

        type:
          transcodedResult.type,

        link:
          info.link,

        filename:
          info.filename,

        filesize:
          Number(
            info.filesize || 0
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

  // ----------------------------------------------------------
  // Second: native stream
  // ----------------------------------------------------------

  if (
    info.streamable &&
    info.container ===
      "mp4" &&
    !info.hevc
  ) {
    console.log(
      `   ✅ Native MP4: ${info.filename}`
    );

    return {
      url:
        info.download,

      type:
        "mp4",

      link:
        info.link,

      filename:
        info.filename,

      filesize:
        Number(
          info.filesize || 0
        ),

      mimeType:
        info.mimeType ||
        "video/mp4",

      mediaInfo:
        info.mediaInfo ||
        null,

      streamingId:
        info.id ||
        null
    };
  }

  if (
    info.streamable &&
    info.container ===
      "webm" &&
    !info.hevc
  ) {
    console.log(
      `   ✅ Native WebM: ${info.filename}`
    );

    return {
      url:
        info.download,

      type:
        "webm",

      link:
        info.link,

      filename:
        info.filename,

      filesize:
        Number(
          info.filesize || 0
        ),

      mimeType:
        info.mimeType ||
        "video/webm",

      mediaInfo:
        info.mediaInfo ||
        null,

      streamingId:
        info.id ||
        null
    };
  }

  // ----------------------------------------------------------
  // Third: MP4 fallback even if mediaInfos failed
  // ----------------------------------------------------------

  if (
    info.container ===
      "mp4" &&
    info.streamable &&
    !info.hevc
  ) {
    console.log(
      `   ✅ Streamable MP4 fallback: ${info.filename}`
    );

    return {
      url:
        info.download,

      type:
        "mp4",

      link:
        info.link,

      filename:
        info.filename,

      filesize:
        Number(
          info.filesize || 0
        ),

      mimeType:
        info.mimeType ||
        "video/mp4",

      mediaInfo:
        info.mediaInfo ||
        null,

      streamingId:
        info.id ||
        null
    };
  }

  return null;
}


// ============================================================
// FIND BEST PLAYABLE FILE
// ============================================================

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

  if (
    links.length === 0
  ) {
    return null;
  }

  const candidates = [];

  for (
    let index = 0;
    index < links.length;
    index++
  ) {
    try {
      const info =
        await inspectRDLink(
          links[index]
        );

      if (!info) {
        continue;
      }

      if (
        !info.filename &&
        files[index]?.path
      ) {
        info.filename =
          files[index].path;
      }

      const fileSize =
        Number(
          info.filesize ||
            files[index]?.bytes ||
            0
        );

      candidates.push({
        info,

        link:
          links[index],

        size:
          fileSize,

        score:
          info.score
      });

      console.log(
        `   🔎 [${index + 1}/${links.length}] ${info.filename || "unknown"} | ${info.mimeType || "?"} | score ${info.score}`
      );
    } catch (err) {
      console.warn(
        `   ⚠ inspect link ${index + 1} failed: ${err.message}`
      );
    }
  }

  candidates.sort(
    (a, b) =>
      (b.score - a.score) ||
      (b.size - a.size)
  );

  for (
    const candidate of candidates
  ) {
    const playable =
      await getPlayableFromInspected(
        candidate.info
      );

    if (
      playable?.url
    ) {
      return {
        ...playable,

        link:
          candidate.link,

        filesize:
          playable.filesize ||
          candidate.size
      };
    }
  }

  return null;
}


// ============================================================
// STREAM URL HELPERS
// ============================================================

function buildLocalStreamURL(
  {
    id,
    type,
    season,
    episode
  }
) {
  const params =
    new URLSearchParams();

  params.set(
    "id",
    String(id)
  );

  params.set(
    "type",
    String(type)
  );

  if (
    type === "tv"
  ) {
    params.set(
      "season",
      String(
        season || 1
      )
    );

    params.set(
      "episode",
      String(
        episode || 1
      )
    );
  }

  return (
    `/api/stream?${params.toString()}`
  );
}

function getAbsoluteAPIUrl(
  req,
  relativeURL
) {
  if (
    !relativeURL
  ) {
    return relativeURL;
  }

  if (
    /^https?:\/\//i.test(
      relativeURL
    )
  ) {
    return relativeURL;
  }

  const forwardedProto =
    req.headers[
      "x-forwarded-proto"
    ];

  const forwardedHost =
    req.headers[
      "x-forwarded-host"
    ];

  const protocol =
    forwardedProto
      ? String(
          forwardedProto
        )
          .split(",")[0]
          .trim()
      : (
          req.protocol ||
          "https"
        );

  const host =
    forwardedHost
      ? String(
          forwardedHost
        )
          .split(",")[0]
          .trim()
      : req.get("host");

  return (
    `${protocol}://${host}${relativeURL}`
  );
}


// ============================================================
// CACHE PLAYBACK RESOLVER
// ============================================================

async function resolveCachedPlayback(
  {
    id,
    type,
    season,
    episode
  }
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

  let playable =
    null;

  // Always generate a fresh RD URL.

  if (
    cached.data.rd_link
  ) {
    playable =
      await rdGetPlayableUrl(
        cached.data.rd_link
      );
  }

  // If old RD link no longer works,
  // use the RD torrent again.

  if (
    !playable?.url &&
    cached.data.rd_torrent_id
  ) {
    const info =
      await rdGetTorrentInfo(
        cached.data.rd_torrent_id
      );

    if (
      info?.status ===
        "downloaded" &&
      info.links?.length
    ) {
      playable =
        await rdResolveBestPlayableLink(
          info
        );
    }
  }

  if (
    !playable?.url
  ) {
    return null;
  }

  return {
    playable,

    cached
  };
}


// ============================================================
// OPENSUBTITLES
// ============================================================

async function searchOpenSubtitles(
  {
    tmdbId,
    type,
    season,
    episode,
    title,
    year
  }
) {
  if (
    !OS_API_KEY
  ) {
    return null;
  }

  try {
    let searchURL;

    if (
      tmdbId
    ) {
      const tmdbQuery =
        type === "movie"
          ? `tmdb_id=${tmdbId}`
          : `tmdb_id=${tmdbId}&season_number=${season || 1}&episode_number=${episode || 1}`;

      searchURL =
        `${OS_BASE}/subtitles?${tmdbQuery}` +
        `&languages=ar` +
        `&order_by=download_count` +
        `&order_direction=desc`;
    } else if (
      title
    ) {
      searchURL =
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
        searchURL,
        {
          headers: {
            "Api-Key":
              OS_API_KEY,

            "User-Agent":
              "BlueStream v1.0",

            Accept:
              "application/json"
          },

          timeout: 12000
        }
      );

    if (
      search.status !== 200 ||
      !search.data?.data?.length
    ) {
      return null;
    }

    const candidate =
      search.data.data.find(
        (item) =>
          item.attributes
            ?.language === "ar"
      );

    if (!candidate) {
      return null;
    }

    const fileId =
      candidate.attributes
        ?.files?.[0]
        ?.file_id;

    if (!fileId) {
      return null;
    }

    const download =
      await fetchURL(
        `${OS_BASE}/download`,
        {
          method: "POST",

          headers: {
            "Api-Key":
              OS_API_KEY,

            "User-Agent":
              "BlueStream v1.0",

            "Content-Type":
              "application/json",

            Accept:
              "application/json"
          },

          body:
            JSON.stringify({
              file_id:
                fileId,

              sub_format:
                "srt"
            }),

          timeout: 15000
        }
      );

    if (
      download.status !==
        200 ||
      !download.data?.link
    ) {
      return null;
    }

    const subtitleResponse =
      await fetchURL(
        download.data.link,
        {
          timeout: 15000
        }
      );

    if (
      subtitleResponse.status !==
        200 ||
      !subtitleResponse.data
    ) {
      return null;
    }

    const content =
      typeof subtitleResponse.data ===
      "string"
        ? subtitleResponse.data
        : String(
            subtitleResponse.data
          );

    const base64 =
      Buffer
        .from(
          content,
          "utf8"
        )
        .toString(
          "base64"
        );

    return {
      url:
        `data:text/plain;charset=utf-8;base64,${base64}`,

      language:
        "ar",

      label:
        "العربية",

      source:
        "opensubtitles",

      release:
        candidate.attributes
          ?.release ||
        ""
    };
  } catch (err) {
    console.warn(
      "OS error:",
      err.message
    );

    return null;
  }
}


// ============================================================
// CORE PLAY
// ============================================================

async function tryGetStream(
  {
    id,
    type,
    sNum,
    eNum,
    withSubs
  }
) {
  // ----------------------------------------------------------
  // CACHE FIRST
  // ----------------------------------------------------------

  const cached =
    await resolveCachedPlayback(
      {
        id,
        type,
        season:
          sNum,
        episode:
          eNum
      }
    );

  if (
    cached?.playable?.url
  ) {
    const playable =
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

    const localURL =
      playable.type === "mp4"
        ? buildLocalStreamURL(
            {
              id,
              type,
              season:
                sNum,
              episode:
                eNum
            }
          )
        : playable.url;

    return {
      success:
        true,

      provider:
        `real-debrid+${
          cached.cached
            .data
            .source ||
          "cache"
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
        playable.filename ||
        cached.cached
          .data
          .filename,

      stream_url:
        localURL,

      stream_type:
        playable.type ===
        "mp4"
          ? "mp4-proxy"
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
        getPoster(
          cached.cached
            .data
            .poster_path
        ),

      backdrop:
        getBackdrop(
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

  // ----------------------------------------------------------
  // TMDB
  // ----------------------------------------------------------

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
        "TMDB not found"
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
    ).slice(
      0,
      4
    );

  const poster =
    getPoster(
      meta.poster_path
    );

  const backdrop =
    getBackdrop(
      meta.backdrop_path
    );

  const imdbId =
    meta.imdb_id ||
    meta.external_ids
      ?.imdb_id;

  if (
    !imdbId
  ) {
    return {
      success:
        false,

      error:
        "IMDB ID not found for this title"
    };
  }

  console.log(
    `\n🎬 ${displayTitle} (${year || "?"}) | ${type} S${sNum || 1}E${eNum || 1}`
  );

  console.log(
    `📺 IMDB: ${imdbId}`
  );

  // ----------------------------------------------------------
  // TORRENTIO
  // ----------------------------------------------------------

  let torrents =
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
        `لم يتم العثور على "${displayTitle}"`
    };
  }

  console.log(
    `📊 إجمالي النتائج: ${torrents.length} torrent`
  );

  torrents.sort(
    (a, b) =>
      getTorrentScore(
        b
      ) -
      getTorrentScore(
        a
      )
  );

  // ----------------------------------------------------------
  // ATTEMPTS
  // ----------------------------------------------------------

  const maxAttempts =
    Math.min(
      12,
      torrents.length
    );

  for (
    let index = 0;
    index < maxAttempts;
    index++
  ) {
    const torrent =
      torrents[index];

    console.log(
      `🔄 [${index + 1}/${maxAttempts}] ${torrent.quality} | ${String(
        torrent.name || ""
      ).slice(
        0,
        100
      )}`
    );

    const added =
      await rdAddMagnet(
        torrent.magnet
      );

    // 451 / infringing_file is skipped.
    if (
      !added?.id
    ) {
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

    if (
      !torrentInfo
    ) {
      console.log(
        "   ❌ Torrent did not become ready"
      );

      continue;
    }

    console.log(
      `   ✓ Prepared by RD: ${
        torrentInfo.filename ||
        "ready"
      }`
    );

    if (
      !torrentInfo.links?.length
    ) {
      console.log(
        "   ❌ No links"
      );

      continue;
    }

    // --------------------------------------------------------
    // BEST PLAYABLE
    // --------------------------------------------------------

    const playable =
      await rdResolveBestPlayableLink(
        torrentInfo
      );

    if (
      !playable?.url
    ) {
      console.log(
        "   ❌ No browser-compatible stream"
      );

      continue;
    }

    console.log(
      `   ✅ Got stream URL (${playable.type})!`
    );

    const streamURL =
      playable.type ===
      "mp4"
        ? buildLocalStreamURL(
            {
              id,
              type,
              season:
                sNum,
              episode:
                eNum
            }
          )
        : playable.url;

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
              (genre) =>
                genre.name
            )
            .join(
              ", "
            ) ||
          null,

        rd_torrent_id:
          added.id,

        rd_link:
          playable.link,

        stream_url:
          streamURL,

        stream_type:
          playable.type ===
          "mp4"
            ? "mp4-proxy"
            : playable.type,

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
          "ready"
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

              title:
                displayTitle,

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

      title:
        displayTitle,

      year,

      filename:
        playable.filename ||
        torrentInfo.filename,

      stream_url:
        streamURL,

      stream_type:
        playable.type ===
        "mp4"
          ? "mp4-proxy"
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
      `فشل تحميل/تجهيز أي من ${torrents.length} torrents`
  };
}


// ============================================================
// SUBTITLES API
// ============================================================

app.get(
  "/api/subtitles",
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
        .json({
          success:
            false,

          error:
            "Missing tmdb_id or title"
        });
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

      if (!subtitle) {
        return res.json({
          success:
            false,

          error:
            "no_subtitles_found"
        });
      }

      return res.json({
        success:
          true,

        subtitle
      });
    } catch (err) {
      return res
        .status(500)
        .json({
          success:
            false,

          error:
            err.message
        });
    }
  }
);


// ============================================================
// STREAM PROXY
// ============================================================

app.get(
  "/api/stream",
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
        .json({
          success:
            false,

          error:
            "Missing id or type"
        });
    }

    const sNum =
      type === "tv"
        ? parseInt(
            season || 1
          )
        : null;

    const eNum =
      type === "tv"
        ? parseInt(
            episode || 1
          )
        : null;

    try {
      const resolved =
        await resolveCachedPlayback(
          {
            id,
            type,

            season:
              sNum,

            episode:
              eNum
          }
        );

      if (
        !resolved?.playable?.url
      ) {
        return res
          .status(404)
          .json({
            success:
              false,

            error:
              "stream_unavailable"
          });
      }

      const playable =
        resolved.playable;

      // HLS

      if (
        playable.type ===
        "hls"
      ) {
        return res.redirect(
          307,
          playable.url
        );
      }

      // DASH

      if (
        playable.type ===
        "dash"
      ) {
        return res.redirect(
          307,
          playable.url
        );
      }

      // WebM can be passed through directly.

      if (
        playable.type ===
        "webm"
      ) {
        return res.redirect(
          307,
          playable.url
        );
      }

      // Only MP4 is proxied here.

      if (
        playable.type !==
        "mp4"
      ) {
        return res
          .status(415)
          .json({
            success:
              false,

            error:
              "unsupported_stream_type"
          });
      }

      const parsed =
        new URL(
          playable.url
        );

      const lib =
        parsed.protocol ===
        "https:"
          ? https
          : http;

      const headers = {
        "User-Agent":
          BROWSER_HEADERS[
            "User-Agent"
          ],

        Accept:
          "*/*",

        Connection:
          "keep-alive"
      };

      if (
        req.headers.range
      ) {
        headers.Range =
          req.headers.range;
      }

      const proxy =
        lib.request(
          {
            method:
              "GET",

            hostname:
              parsed.hostname,

            port:
              parsed.port ||
              (
                parsed.protocol ===
                "https:"
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

          (response) => {
            const passthroughHeaders = [
              "content-type",
              "content-length",
              "content-range",
              "accept-ranges",
              "etag",
              "last-modified",
              "cache-control"
            ];

            for (
              const header of passthroughHeaders
            ) {
              const value =
                response.headers[
                  header
                ];

              if (
                value !==
                undefined
              ) {
                res.setHeader(
                  header,
                  value
                );
              }
            }

            if (
              !res.getHeader(
                "Content-Type"
              )
            ) {
              res.setHeader(
                "Content-Type",
                playable.mimeType ||
                  "video/mp4"
              );
            }

            res.status(
              response.statusCode ||
                502
            );

            response.pipe(
              res
            );
          }
        );

      proxy.on(
        "timeout",
        () => {
          proxy.destroy(
            new Error(
              "Real-Debrid stream timeout"
            )
          );
        }
      );

      proxy.on(
        "error",
        (err) => {
          if (
            !res.headersSent
          ) {
            res
              .status(502)
              .json({
                success:
                  false,

                error:
                  "stream_proxy_error",

                message:
                  err.message
              });
          } else {
            res.destroy(
              err
            );
          }
        }
      );

      req.on(
        "close",
        () => {
          if (
            !res.writableEnded
          ) {
            proxy.destroy();
          }
        }
      );

      proxy.end();
    } catch (err) {
      console.error(
        "❌ Stream endpoint error:",
        err.message
      );

      if (
        !res.headersSent
      ) {
        res
          .status(500)
          .json({
            success:
              false,

            error:
              err.message
          });
      }
    }
  }
);


// ============================================================
// PLAY API
// ============================================================

app.get(
  "/api/play",
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
        "1"
    } = req.query;

    if (
      !id ||
      !type
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "Missing id or type"
        });
    }

    req.setTimeout(
      300000
    );

    res.setTimeout(
      300000
    );

    const sNum =
      type === "tv"
        ? parseInt(
            season || 1
          )
        : null;

    const eNum =
      type === "tv"
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
              with_subs === "1"
          }
        );

      if (
        result.success
      ) {
        /*
         * IMPORTANT:
         *
         * The frontend is hosted separately from Railway.
         * A relative /api/stream URL would point to the frontend domain.
         *
         * Convert it into:
         *
         * https://bluestream-rd-production.up.railway.app/api/stream?...
         */

        if (
          typeof result.stream_url ===
            "string" &&
          result.stream_url.startsWith(
            "/"
          )
        ) {
          const forwardedProto =
            req.headers[
              "x-forwarded-proto"
            ];

          const forwardedHost =
            req.headers[
              "x-forwarded-host"
            ];

          const protocol =
            forwardedProto
              ? String(
                  forwardedProto
                )
                  .split(
                    ","
                  )[0]
                  .trim()
              : (
                  req.protocol ||
                  "https"
                );

          const host =
            forwardedHost
              ? String(
                  forwardedHost
                )
                  .split(
                    ","
                  )[0]
                  .trim()
              : req.get(
                  "host"
                );

          result.stream_url =
            `${protocol}://${host}${result.stream_url}`;
        }

        return res.json(
          result
        );
      }

      return res
        .status(404)
        .json(
          result
        );
    } catch (err) {
      console.error(
        "❌ Error:",
        err
      );

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            err.message
        });
    }
  }
);


// ============================================================
// CACHE STATS
// ============================================================

app.get(
  "/api/cache/stats",
  async (
    req,
    res
  ) => {
    try {
      res.json({
        success:
          true,

        stats:
          await cache.getStats()
      });
    } catch (err) {
      res
        .status(500)
        .json({
          success:
            false,

          error:
            err.message
        });
    }
  }
);


// ============================================================
// CACHE CLEAN
// ============================================================

app.post(
  "/api/cache/clean",
  async (
    req,
    res
  ) => {
    try {
      res.json({
        success:
          true,

        expired_marked:
          await cache.cleanExpired()
      });
    } catch (err) {
      res
        .status(500)
        .json({
          success:
            false,

          error:
            err.message
        });
    }
  }
);


// ============================================================
// DELETE CACHE
// ============================================================

app.delete(
  "/api/cache/:tmdb_id/:type",
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

      const pool =
        cache.initPool();

      const [
        result
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
              null
          ]
        );

      res.json({
        success:
          true,

        deleted:
          result.affectedRows
      });
    } catch (err) {
      res
        .status(500)
        .json({
          success:
            false,

          error:
            err.message
        });
    }
  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/",
  (
    req,
    res
  ) => {
    res.json({
      status:
        "✅ BlueStream API v7.6.1",

      version:
        "7.6.1",

      features: [
        "Torrentio aggregator",
        "Real-Debrid streaming",
        "mediaInfos optional",
        "HLS first",
        "MP4/H264 priority",
        "fresh MP4 proxy",
        "automatic Arabic subtitles",
        "absolute Railway stream URLs"
      ],

      endpoints: {
        play:
          "/api/play?id={tmdb_id}&type={movie|tv}&season=1&episode=1&with_subs=1",

        stream:
          "/api/stream?id={tmdb_id}&type={movie|tv}&season=1&episode=1",

        subtitles:
          "/api/subtitles?tmdb_id=...&type=movie&title=..."
      }
    });
  }
);


// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `\n🎬 BlueStream API v7.6.1 running on port ${PORT}`
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
      "✅ Torrentio: configured"
    );

    console.log(
      "✅ Real-Debrid mediaInfos: optional"
    );

    console.log(
      "✅ Real-Debrid transcode: HLS first"
    );

    console.log(
      "✅ Streaming proxy: enabled"
    );

    console.log(
      "✅ Absolute Railway stream URLs: enabled"
    );
  }
);