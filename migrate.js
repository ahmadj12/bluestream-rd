// migrate.js — One-shot script to create tables on first deploy
// Run automatically if media_cache table doesn't exist

const cache = require('./cache');

async function migrate() {
  const pool = cache.initPool();
  console.log('🔧 Running migrations...');

  const statements = [
    `CREATE TABLE IF NOT EXISTS media_cache (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tmdb_id INT UNSIGNED NOT NULL,
      media_type ENUM('movie', 'tv') NOT NULL,
      season SMALLINT UNSIGNED DEFAULT NULL,
      episode SMALLINT UNSIGNED DEFAULT NULL,
      title VARCHAR(255) NOT NULL,
      original_title VARCHAR(255) DEFAULT NULL,
      year SMALLINT DEFAULT NULL,
      overview TEXT DEFAULT NULL,
      poster_path VARCHAR(255) DEFAULT NULL,
      backdrop_path VARCHAR(255) DEFAULT NULL,
      runtime SMALLINT UNSIGNED DEFAULT NULL,
      vote_average DECIMAL(3,1) DEFAULT NULL,
      genres VARCHAR(255) DEFAULT NULL,
      rd_torrent_id VARCHAR(64) DEFAULT NULL,
      rd_link VARCHAR(512) DEFAULT NULL,
      stream_url TEXT DEFAULT NULL,
      stream_url_expires_at DATETIME DEFAULT NULL,
      filename VARCHAR(512) DEFAULT NULL,
      file_size_bytes BIGINT UNSIGNED DEFAULT NULL,
      quality VARCHAR(20) DEFAULT NULL,
      video_format VARCHAR(50) DEFAULT NULL,
      video_codec VARCHAR(50) DEFAULT NULL,
      audio_codec VARCHAR(100) DEFAULT NULL,
      source VARCHAR(50) DEFAULT NULL,
      magnet TEXT DEFAULT NULL,
      info_hash CHAR(40) DEFAULT NULL,
      seeds INT UNSIGNED DEFAULT 0,
      status ENUM('pending', 'ready', 'expired', 'failed', 'error') NOT NULL DEFAULT 'pending',
      error_message VARCHAR(500) DEFAULT NULL,
      retry_count TINYINT UNSIGNED DEFAULT 0,
      access_count INT UNSIGNED DEFAULT 0,
      last_accessed_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      fetched_at DATETIME DEFAULT NULL,
      refreshed_at DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY unique_media (tmdb_id, media_type, season, episode),
      KEY idx_status (status),
      KEY idx_expires (stream_url_expires_at),
      KEY idx_last_accessed (last_accessed_at),
      KEY idx_info_hash (info_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS user_watch_progress (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id VARCHAR(64) NOT NULL,
      tmdb_id INT UNSIGNED NOT NULL,
      media_type ENUM('movie', 'tv') NOT NULL,
      season SMALLINT UNSIGNED DEFAULT NULL,
      episode SMALLINT UNSIGNED DEFAULT NULL,
      position_seconds INT UNSIGNED DEFAULT 0,
      duration_seconds INT UNSIGNED DEFAULT 0,
      completed TINYINT(1) NOT NULL DEFAULT 0,
      last_watched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_user_media (user_id, tmdb_id, media_type, season, episode),
      KEY idx_user_last (user_id, last_watched_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS search_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id VARCHAR(64) DEFAULT NULL,
      query VARCHAR(255) NOT NULL,
      result_count INT UNSIGNED DEFAULT 0,
      clicked_tmdb_id INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_user_time (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE OR REPLACE VIEW v_cache_stats AS
      SELECT
        media_type,
        status,
        COUNT(*) AS count,
        AVG(access_count) AS avg_access_count,
        SUM(file_size_bytes) / 1024 / 1024 / 1024 AS total_size_gb
      FROM media_cache
      GROUP BY media_type, status`,
  ];

  for (const sql of statements) {
    try {
      await pool.query(sql);
      console.log('✅', sql.substring(0, 50) + '...');
    } catch (err) {
      console.error('❌ Migration failed:', err.message);
      throw err;
    }
  }

  console.log('🎉 All migrations completed');
  await pool.end();
}

migrate().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
