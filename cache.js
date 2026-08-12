// cache.js — MySQL cache layer for media streams
// Stores RD results so repeat plays are instant

const mysql = require('mysql2/promise');

let pool = null;

// ====== Initialize connection pool ======
function initPool() {
  if (pool) return pool;
  const config = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ahmadsayshi',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: '+00:00',
    enableKeepAlive: true,
  };
  pool = mysql.createPool(config);
  console.log(`✅ MySQL pool initialized: ${config.user}@${config.host}:${config.port}/${config.database}`);
  return pool;
}

// ====== Build cache key tuple ======
function buildKey(tmdbId, mediaType, season, episode) {
  return {
    tmdb_id: parseInt(tmdbId),
    media_type: mediaType,
    season: mediaType === 'tv' ? parseInt(season || 1) : null,
    episode: mediaType === 'tv' ? parseInt(episode || 1) : null,
  };
}

// ====== Get cached entry ======
// Returns the cache row if it's still usable (status='ready' and stream_url not expired)
// Returns { hit: false } if cache miss
// Returns { hit: true, needsRefresh: true } if cached but stream_url expired
async function getCache(tmdbId, mediaType, season, episode) {
  const p = initPool();
  const key = buildKey(tmdbId, mediaType, season, episode);

  try {
    const [rows] = await p.execute(
      `SELECT * FROM media_cache
       WHERE tmdb_id = ? AND media_type = ? AND season <=> ? AND episode <=> ?
       LIMIT 1`,
      [key.tmdb_id, key.media_type, key.season, key.episode]
    );

    if (rows.length === 0) {
      return { hit: false };
    }

    const row = rows[0];

    // Bump access counters
    await p.execute(
      `UPDATE media_cache
       SET access_count = access_count + 1, last_accessed_at = NOW()
       WHERE id = ?`,
      [row.id]
    ).catch(() => {}); // non-fatal

    // Check if the cached stream is still fresh
    if (row.status === 'ready' && row.stream_url) {
      const expiresAt = row.stream_url_expires_at ? new Date(row.stream_url_expires_at).getTime() : 0;
      const now = Date.now();

      if (expiresAt > now + 60_000) {
        // Still valid (with 60s safety margin)
        return { hit: true, fresh: true, data: row };
      } else {
        // Cached but expired — RD URLs typically last ~24h
        return { hit: true, fresh: false, data: row };
      }
    }

    if (row.status === 'pending') {
      // Another request is fetching it right now — caller should wait/retry
      return { hit: true, fresh: false, pending: true, data: row };
    }

    if (row.status === 'failed' && row.retry_count < 3) {
      // Failed before but worth retrying
      return { hit: true, fresh: false, retry: true, data: row };
    }

    if (row.status === 'error') {
      // Permanent error — don't use this cache
      return { hit: false, error: row.error_message };
    }

    return { hit: false, expired: true, data: row };
  } catch (err) {
    console.error('❌ Cache get error:', err.message);
    return { hit: false, dbError: err.message };
  }
}

// ====== Save or update cache entry ======
async function setCache(payload) {
  const p = initPool();
  const key = buildKey(payload.tmdb_id, payload.media_type, payload.season, payload.episode);

  try {
    // Extract info_hash from magnet if present
    let infoHash = null;
    if (payload.magnet) {
      const m = payload.magnet.match(/urn:btih:([a-fA-F0-9]{40})/i);
      if (m) infoHash = m[1].toLowerCase();
    }

    // Extract video/audio info from filename if not provided
    const filename = payload.filename || '';
    let videoFormat = payload.video_format || null;
    if (!videoFormat) {
      const fm = filename.match(/\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i);
      if (fm) videoFormat = fm[1].toLowerCase();
    }
    let videoCodec = payload.video_codec || null;
    if (!videoCodec) {
      const cm = filename.match(/\b(x\.?264|x\.?265|h\.?264|h\.?265|hevc|av1|xvid|divx)\b/i);
      if (cm) videoCodec = cm[1].toLowerCase().replace(/\./g, '');
    }

    const sql = `
      INSERT INTO media_cache (
        tmdb_id, media_type, season, episode,
        title, original_title, year, overview, poster_path, backdrop_path,
        runtime, vote_average, genres,
        rd_torrent_id, rd_link, stream_url, stream_url_expires_at,
        filename, file_size_bytes, quality, video_format, video_codec, audio_codec,
        source, magnet, info_hash, seeds,
        status, error_message, retry_count,
        fetched_at, refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        original_title = VALUES(original_title),
        year = VALUES(year),
        overview = VALUES(overview),
        poster_path = VALUES(poster_path),
        backdrop_path = VALUES(backdrop_path),
        runtime = VALUES(runtime),
        vote_average = VALUES(vote_average),
        genres = VALUES(genres),
        rd_torrent_id = VALUES(rd_torrent_id),
        rd_link = VALUES(rd_link),
        stream_url = VALUES(stream_url),
        stream_url_expires_at = VALUES(stream_url_expires_at),
        filename = VALUES(filename),
        file_size_bytes = VALUES(file_size_bytes),
        quality = VALUES(quality),
        video_format = VALUES(video_format),
        video_codec = VALUES(video_codec),
        audio_codec = VALUES(audio_codec),
        source = VALUES(source),
        magnet = VALUES(magnet),
        info_hash = VALUES(info_hash),
        seeds = VALUES(seeds),
        status = VALUES(status),
        error_message = VALUES(error_message),
        refreshed_at = NOW(),
        retry_count = 0
    `;

    // RD unrestricted URLs typically last 24h. Set expiry to 23h to be safe.
    const expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');

    const params = [
      key.tmdb_id, key.media_type, key.season, key.episode,
      payload.title || null,
      payload.original_title || null,
      payload.year ? parseInt(payload.year) : null,
      payload.overview || null,
      payload.poster_path || null,
      payload.backdrop_path || null,
      payload.runtime || null,
      payload.vote_average || null,
      payload.genres || null,
      payload.rd_torrent_id || null,
      payload.rd_link || null,
      payload.stream_url || null,
      payload.stream_url ? expiresAt : null,
      payload.filename || null,
      payload.file_size_bytes || null,
      payload.quality || null,
      videoFormat,
      videoCodec,
      payload.audio_codec || null,
      payload.source || null,
      payload.magnet || null,
      infoHash,
      payload.seeds || 0,
      payload.status || 'ready',
      payload.error_message || null,
    ];

    await p.execute(sql, params);
    console.log(`💾 Cached [${key.media_type} ${key.tmdb_id} S${key.season || '-'}E${key.episode || '-'}] status=${payload.status}`);
    return { ok: true };
  } catch (err) {
    console.error('❌ Cache set error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ====== Mark as failed (and bump retry counter) ======
async function markFailed(tmdbId, mediaType, season, episode, errorMessage) {
  const p = initPool();
  const key = buildKey(tmdbId, mediaType, season, episode);
  try {
    await p.execute(
      `INSERT INTO media_cache (tmdb_id, media_type, season, episode, status, error_message, retry_count)
       VALUES (?, ?, ?, ?, 'failed', ?, 1)
       ON DUPLICATE KEY UPDATE
         status = 'failed',
         error_message = VALUES(error_message),
         retry_count = retry_count + 1`,
      [key.tmdb_id, key.media_type, key.season, key.episode, errorMessage?.substring(0, 500) || 'unknown']
    );
  } catch (err) {
    console.error('❌ markFailed error:', err.message);
  }
}

// ====== Mark as pending (to prevent duplicate fetches) ======
async function markPending(tmdbId, mediaType, season, episode) {
  const p = initPool();
  const key = buildKey(tmdbId, mediaType, season, episode);
  try {
    await p.execute(
      `INSERT IGNORE INTO media_cache (tmdb_id, media_type, season, episode, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [key.tmdb_id, key.media_type, key.season, key.episode]
    );
  } catch (err) {
    // ignore — not critical
  }
}

// ====== Get cache stats (for admin) ======
async function getStats() {
  const p = initPool();
  try {
    const [rows] = await p.execute(`
      SELECT
        media_type,
        status,
        COUNT(*) AS count,
        SUM(file_size_bytes) / 1024 / 1024 / 1024 AS total_gb,
        AVG(access_count) AS avg_plays
      FROM media_cache
      GROUP BY media_type, status
      ORDER BY media_type, status
    `);
    return rows;
  } catch (err) {
    return [];
  }
}

// ====== Clean expired entries (cron job) ======
async function cleanExpired() {
  const p = initPool();
  try {
    const [result] = await p.execute(`
      UPDATE media_cache
      SET status = 'expired'
      WHERE status = 'ready'
        AND stream_url_expires_at IS NOT NULL
        AND stream_url_expires_at < NOW()
    `);
    console.log(`🧹 Marked ${result.affectedRows} entries as expired`);
    return result.affectedRows;
  } catch (err) {
    console.error('❌ cleanExpired error:', err.message);
    return 0;
  }
}

module.exports = {
  initPool,
  getCache,
  setCache,
  markFailed,
  markPending,
  getStats,
  cleanExpired,
};
