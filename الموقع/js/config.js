/* =====================================================
   BlueStream — إعدادات الواجهة
   تنبيه: أي مفتاح هنا ظاهر للزائر. في الإنتاج انقله إلى
   Cloudflare Pages Functions/Worker كمتغير Secret.
   ===================================================== */

const CONFIG = {
  // TMDB API Key v3: https://www.themoviedb.org/settings/api
  TMDB_API_KEY: "570589dd8a1dac1a24fc6f98c18d1e59",
  TMDB_BASE: "https://api.themoviedb.org/3",
  TMDB_IMG: "https://image.tmdb.org/t/p/w500",
  TMDB_IMG_LARGE: "https://image.tmdb.org/t/p/w780",
  TMDB_BACKDROP: "https://image.tmdb.org/t/p/w1280",
  TMDB_LOGO: "https://image.tmdb.org/t/p/w92",

  // Jikan مجاني ولا يحتاج مفتاحاً. عند تعطله ينتقل api.js إلى TMDB.
  JIKAN_BASE: "https://api.jikan.moe/v4",

  // TVMaze مجاني للبحث وبيانات المسلسلات والمواسم والحلقات.
  TVMAZE_BASE: "https://api.tvmaze.com",

  // اختياري للترجمات التلقائية:
  // https://www.opensubtitles.com/consumers
  OPENSUBTITLES_API_KEY: "p9i6HLoYyyJVPbVIBM5c9swo5MjqCV8I",

  LANG: "ar-SA",
  WATCH_REGION: "SA",
  REQUEST_TIMEOUT: 9000,

  FALLBACK_POSTER:
    "data:image/svg+xml;charset=utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450">
        <rect width="100%" height="100%" fill="#17171C"/>
        <circle cx="150" cy="225" r="45" fill="#1C1C22" stroke="#3B82F6" stroke-width="3"/>
        <path d="M138 200 L138 250 L176 225 Z" fill="#F4F4F5"/>
      </svg>`
    ),
};
