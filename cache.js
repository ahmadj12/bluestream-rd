// cache.js — MySQL cache with validation & invalidation

// v2.0.0: إضافة invalidateEntry + setCache محسّن + timestamps


const mysql = require('mysql2/promise');


let pool = null;


function initPool() {

  if (pool) return pool;


  pool = mysql.createPool({

    host: process.env.MYSQL_HOST || 'mysql.railway.internal',

    port: Number(process.env.MYSQL_PORT || 3306),

    user: process.env.MYSQL_USER || 'root',

    password: process.env.MYSQL_PASSWORD || '',

    database: process.env.MYSQL_DATABASE || 'railway',

    waitForConnections: true,

    connectionLimit: 10,

    queueLimit: 0,

    enableKeepAlive: true,

    keepAliveInitialDelay: 10000,

  });


  return pool;

}


async function runMigrations() {

  const p = initPool();

  await p.execute(`

    CREATE TABLE IF NOT EXISTS media_cache (

      id INT AUTO_INCREMENT PRIMARY KEY,

      tmdb_id INT NOT NULL,

      media_type VARCHAR(10) NOT NULL,

      season INT NULL,

      episode INT NULL,

      title VARCHAR(500),

      year VARCHAR(10),

      original_title VARCHAR(500),

      overview TEXT,

      poster_path VARCHAR(255),

      backdrop_path VARCHAR(255),

      runtime INT NULL,

      vote_average DECIMAL(3,1) NULL,

      genres VARCHAR(500),

      rd_torrent_id VARCHAR(100),

      rd_link TEXT,

      stream_url TEXT,

      stream_type VARCHAR(50),

      filename VARCHAR(500),

      file_size_bytes BIGINT,

      quality VARCHAR(20),

      source VARCHAR(100),

      magnet TEXT,

      seeds INT DEFAULT 0,

      info_hash VARCHAR(100),

      status VARCHAR(20) DEFAULT 'ready',

      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

      expires_at TIMESTAMP NULL,

      INDEX idx_lookup (tmdb_id, media_type, season, episode),

      INDEX idx_expires (expires_at)

    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4

  `);

}


// TTL افتراضي: 30 يوم

const DEFAULT_TTL_DAYS = 30;


async function getCache(tmdbId, mediaType, season, episode) {

  try {

    const p = initPool();

    const [rows] = await p.execute(

      `SELECT * FROM media_cache

       WHERE tmdb_id = ? AND media_type = ? AND season <=> ? AND episode <=> ?

       ORDER BY updated_at DESC LIMIT 1`,

      [Number(tmdbId), String(mediaType), season ?? null, episode ?? null]

    );


    if (!rows.length) {

      return { hit: false, fresh: false, data: null };

    }


    const row = rows[0];

    const now = new Date();

    let fresh = true;


    // التحقق من انتهاء الصلاحية

    if (row.expires_at && new Date(row.expires_at) < now) {

      fresh = false;

    }


    // التحقق من أن الـ stream_url ليس قديماً جداً (أكثر من 12 ساعة)

    if (row.updated_at) {

      const ageHours = (now - new Date(row.updated_at)) / (1000 * 60 * 60);

      if (ageHours > 12) fresh = false;

    }


    return {

      hit: true,

      fresh,

      data: row,

    };

  } catch (err) {

    console.warn('cache.getCache error:', err.message);

    return { hit: false, fresh: false, data: null };

  }

}


async function setCache(data) {

  try {

    const p = initPool();


    const expiresAt = new Date();

    expiresAt.setDate(expiresAt.getDate() + DEFAULT_TTL_DAYS);


    // الحقول المسموح بها

    const allowed = {

      tmdb_id: data.tmdb_id,

      media_type: data.media_type,

      season: data.season ?? null,

      episode: data.episode ?? null,

      title: data.title || null,

      year: data.year || null,

      original_title: data.original_title || null,

      overview: data.overview || null,

      poster_path: data.poster_path || null,

      backdrop_path: data.backdrop_path || null,

      runtime: data.runtime || null,

      vote_average: data.vote_average || null,

      genres: data.genres || null,

      rd_torrent_id: data.rd_torrent_id || null,

      rd_link: data.rd_link || null,

      stream_url: data.stream_url || null,

      stream_type: data.stream_type || null,

      filename: data.filename || null,

      file_size_bytes: data.file_size_bytes || null,

      quality: data.quality || null,

      source: data.source || null,

      magnet: data.magnet || null,

      seeds: data.seeds || 0,

      info_hash: data.info_hash || null,

      status: data.status || 'ready',

      expires_at: expiresAt,

    };


    // بناء الاستعلام ديناميكياً

    const fields = Object.keys(allowed);

    const values = fields.map(f => allowed[f]);

    const placeholders = fields.map(() => '?').join(', ');


    const sql = `INSERT INTO media_cache (${fields.join(', ')}) VALUES (${placeholders})

                 ON DUPLICATE KEY UPDATE

                   title = VALUES(title),

                   year = VALUES(year),

                   original_title = VALUES(original_title),

                   overview = VALUES(overview),

                   poster_path = VALUES(poster_path),

                   backdrop_path = VALUES(backdrop_path),

                   runtime = VALUES(runtime),

                   vote_average = VALUES(vote_average),

                   genres = VALUES(genres),

                   rd_torrent_id = VALUES(rd_torrent_id),

                   rd_link = VALUES(rd_link),

                   stream_url = VALUES(stream_url),

                   stream_type = VALUES(stream_type),

                   filename = VALUES(filename),

                   file_size_bytes = VALUES(file_size_bytes),

                   quality = VALUES(quality),

                   source = VALUES(source),

                   magnet = VALUES(magnet),

                   seeds = VALUES(seeds),

                   info_hash = VALUES(info_hash),

                   status = VALUES(status),

                   expires_at = VALUES(expires_at)`;


    await p.execute(sql, values);

    return true;

  } catch (err) {

    console.warn('cache.setCache error:', err.message);

    return false;

  }

}


async function invalidateEntry(tmdbId, mediaType, season, episode) {

  try {

    const p = initPool();

    const [result] = await p.execute(

      `DELETE FROM media_cache

       WHERE tmdb_id = ? AND media_type = ? AND season <=> ? AND episode <=> ?`,

      [Number(tmdbId), String(mediaType), season ?? null, episode ?? null]

    );

    return result.affectedRows;

  } catch (err) {

    console.warn('cache.invalidateEntry error:', err.message);

    return 0;

  }

}


async function getStats() {

  try {

    const p = initPool();

    const [rows] = await p.query(`SELECT

      COUNT(*) as total,

      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready,

      SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < NOW() THEN 1 ELSE 0 END) as expired,

      MAX(updated_at) as last_update

    FROM media_cache`);


    return rows[0] || {};

  } catch (err) {

    console.warn('cache.getStats error:', err.message);

    return {};

  }

}


async function cleanExpired() {

  try {

    const p = initPool();

    const [result] = await p.execute(

      `UPDATE media_cache SET status = 'expired' WHERE expires_at < NOW() AND status != 'expired'`

    );

    return result.affectedRows;

  } catch (err) {

    console.warn('cache.cleanExpired error:', err.message);

    return 0;

  }

}


module.exports = {

  initPool,

  runMigrations,

  getCache,

  setCache,

  invalidateEntry,

  getStats,

  cleanExpired,

};

