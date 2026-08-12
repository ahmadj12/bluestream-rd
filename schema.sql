-- =============================================
-- BlueStream RD Cache Schema (HeidiSQL)
-- =============================================
-- Create database first:
-- CREATE DATABASE IF NOT EXISTS ahmadsayshi CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- USE ahmadsayshi;

DROP TABLE IF EXISTS media_cache;

CREATE TABLE media_cache (
  -- ===== Identification =====
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tmdb_id INT UNSIGNED NOT NULL,
  media_type ENUM('movie', 'tv') NOT NULL,
  season SMALLINT UNSIGNED DEFAULT NULL,
  episode SMALLINT UNSIGNED DEFAULT NULL,

  -- ===== TMDB Metadata (cached) =====
  title VARCHAR(255) NOT NULL,
  original_title VARCHAR(255) DEFAULT NULL,
  year SMALLINT DEFAULT NULL,
  overview TEXT DEFAULT NULL,
  poster_path VARCHAR(255) DEFAULT NULL,
  backdrop_path VARCHAR(255) DEFAULT NULL,
  runtime SMALLINT UNSIGNED DEFAULT NULL,
  vote_average DECIMAL(3,1) DEFAULT NULL,
  genres VARCHAR(255) DEFAULT NULL,

  -- ===== Stream info (the real deal) =====
  rd_torrent_id VARCHAR(64) DEFAULT NULL,           -- Real-Debrid internal torrent ID
  rd_link VARCHAR(512) DEFAULT NULL,                -- Real-Debrid link (before unrestrict)
  stream_url TEXT DEFAULT NULL,                     -- Unrestricted direct URL (cached, may expire)
  stream_url_expires_at DATETIME DEFAULT NULL,      -- When the URL becomes invalid (RD URLs last ~24h)
  filename VARCHAR(512) DEFAULT NULL,
  file_size_bytes BIGINT UNSIGNED DEFAULT NULL,
  quality VARCHAR(20) DEFAULT NULL,                 -- 4K / 1080p / 720p / 480p
  video_format VARCHAR(50) DEFAULT NULL,            -- mkv, mp4, avi
  video_codec VARCHAR(50) DEFAULT NULL,             -- x264, x265, hevc, av1
  audio_codec VARCHAR(100) DEFAULT NULL,            -- TrueHD Atmos, DTS-HD, AC3, AAC

  -- ===== Source info =====
  source VARCHAR(50) DEFAULT NULL,                  -- torrentdownloads, yts, 1337x
  magnet TEXT DEFAULT NULL,                         -- Original magnet (for re-unrestrict)
  info_hash CHAR(40) DEFAULT NULL,                  -- Extracted from magnet (40-char hex)
  seeds INT UNSIGNED DEFAULT 0,

  -- ===== Status / state machine =====
  -- pending: in progress of being fetched
  -- ready:   stream_url is valid
  -- expired: stream_url expired, needs refresh
  -- failed:  fetch failed, will retry on next request
  -- error:   permanent error (e.g. magnet dead on RD)
  status ENUM('pending', 'ready', 'expired', 'failed', 'error') NOT NULL DEFAULT 'pending',
  error_message VARCHAR(500) DEFAULT NULL,
  retry_count TINYINT UNSIGNED DEFAULT 0,

  -- ===== Usage tracking =====
  access_count INT UNSIGNED DEFAULT 0,              -- How many times this was played
  last_accessed_at DATETIME DEFAULT NULL,

  -- ===== Timestamps =====
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  fetched_at DATETIME DEFAULT NULL,                 -- When the stream was first fetched from RD
  refreshed_at DATETIME DEFAULT NULL,               -- Last time we refreshed stream_url

  -- ===== Indexes & constraints =====
  PRIMARY KEY (id),
  UNIQUE KEY unique_media (tmdb_id, media_type, season, episode),
  KEY idx_status (status),
  KEY idx_expires (stream_url_expires_at),
  KEY idx_last_accessed (last_accessed_at),
  KEY idx_info_hash (info_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================
-- Optional: user watch progress (bonus)
-- =============================================
DROP TABLE IF EXISTS user_watch_progress;

CREATE TABLE user_watch_progress (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id VARCHAR(64) NOT NULL,                     -- From your auth system
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================
-- Optional: search history (bonus)
-- =============================================
DROP TABLE IF EXISTS search_history;

CREATE TABLE search_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id VARCHAR(64) DEFAULT NULL,
  query VARCHAR(255) NOT NULL,
  result_count INT UNSIGNED DEFAULT 0,
  clicked_tmdb_id INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_time (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================
-- Stats view (for admin panel)
-- =============================================
CREATE OR REPLACE VIEW v_cache_stats AS
SELECT
  media_type,
  status,
  COUNT(*) AS count,
  AVG(access_count) AS avg_access_count,
  SUM(file_size_bytes) / 1024 / 1024 / 1024 AS total_size_gb
FROM media_cache
GROUP BY media_type, status;
