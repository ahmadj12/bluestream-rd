const SOURCES = (() => {
  const HLS = "application/x-mpegURL";

  async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  const LIBRARY = [
    {
      tmdbId: 45745,
      fallbackTitle: "Sintel — سينتل",
      stream: { src: "https://cdn.theoplayer.com/video/sintel/nosubs.m3u8", type: HLS },
      subtitles: [
        { src: "subs/sintel-ar.vtt", srclang: "ar", label: "العربية", default: true },
        { src: "subs/sintel-en.vtt", srclang: "en", label: "English" },
      ],
    },
    {
      tmdbId: 10378,
      fallbackTitle: "Big Buck Bunny",
      stream: { src: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", type: HLS },
      subtitles: [],
    },
    {
      tmdbId: 133701,
      fallbackTitle: "Tears of Steel",
      stream: {
        src: "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8",
        type: HLS,
      },
      subtitles: [],
    },
  ];

  const libraryByTMDB = new Map(LIBRARY.map((entry) => [entry.tmdbId, entry]));

  const SERIES = {
    id: "blender-originals",
    type: "tv",
    mediaType: "tv",
    source: "library",
    title: "روائع بلندر",
    overview: "ثلاث تحف قصيرة من استوديو Blender مفتوح المصدر في مسلسل واحد.",
    episodes: [
      {
        season: 1, episode: 1, tmdbId: 10378, runtime: 10, title: "الأرنب الكبير",
        stream: { src: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", type: HLS },
        subtitles: [],
      },
      {
        season: 1, episode: 2, tmdbId: 45745, runtime: 15, title: "سينتل",
        stream: { src: "https://cdn.theoplayer.com/video/sintel/nosubs.m3u8", type: HLS },
        subtitles: [
          { src: "subs/sintel-ar.vtt", srclang: "ar", label: "العربية", default: true },
          { src: "subs/sintel-en.vtt", srclang: "en", label: "English" },
        ],
      },
      {
        season: 1, episode: 3, tmdbId: 133701, runtime: 12, title: "دموع من فولاذ",
        stream: {
          src: "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8",
          type: HLS,
        },
        subtitles: [],
      },
    ],
  };

  const isLibrarySeries = (item) => item?.id === SERIES.id && item?.source === "library";

  function isPlayable(item) {
    if (!item) return false;
    return isLibrarySeries(item) || libraryByTMDB.has(Number(item.id));
  }

  async function fetchMovieMeta(tmdbId) {
    const url = new URL(`${CONFIG.TMDB_BASE}/movie/${tmdbId}`);
    url.searchParams.set("api_key", CONFIG.TMDB_API_KEY);
    url.searchParams.set("language", CONFIG.LANG);
    try {
      const response = await fetchWithTimeout(url.toString());
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  }

  async function getLibraryItems() {
    const movies = await Promise.all(
      LIBRARY.map(async (entry) => {
        const base = {
          id: entry.tmdbId, type: "movie", mediaType: "movie", source: "library",
          title: entry.fallbackTitle, poster: CONFIG.FALLBACK_POSTER, backdrop: null,
          rating: "—", year: "", overview: "فيلم مجاني ومرخّص للمشاهدة.",
        };
        const data = await fetchMovieMeta(entry.tmdbId);
        if (!data) return base;
        return {
          ...base,
          title: data.title || base.title,
          poster: data.poster_path ? CONFIG.TMDB_IMG + data.poster_path : base.poster,
          backdrop: data.backdrop_path ? CONFIG.TMDB_BACKDROP + data.backdrop_path : null,
          rating: data.vote_average ? Number(data.vote_average).toFixed(1) : "—",
          year: (data.release_date || "").slice(0, 4),
          overview: data.overview || base.overview,
        };
      })
    );

    const sintel = movies.find((movie) => movie.id === 45745);
    const seriesItem = {
      id: SERIES.id, type: "tv", mediaType: "tv", source: "library",
      title: SERIES.title, poster: sintel?.poster || CONFIG.FALLBACK_POSTER,
      backdrop: sintel?.backdrop || null, rating: "9.0", year: "2012",
      overview: SERIES.overview,
    };
    return [seriesItem, ...movies];
  }

  let seriesCache = null;

  async function getSeriesData() {
    if (seriesCache) return seriesCache;
    const episodes = await Promise.all(
      SERIES.episodes.map(async (episode) => {
        const data = await fetchMovieMeta(episode.tmdbId);
        return {
          ...episode,
          still: data?.backdrop_path ? CONFIG.TMDB_IMG + data.backdrop_path : null,
          overview: data?.overview || "",
        };
      })
    );
    seriesCache = {
      seasons: [{ season: 1, name: "الموسم 1", episodeCount: episodes.length }],
      episodes,
    };
    return seriesCache;
  }

  async function getStream(item, type = "movie") {
    if (!item || type !== "movie") return null;
    const entry = libraryByTMDB.get(Number(item.id));
    return entry ? { ...entry.stream, provider: "licensed-library" } : null;
  }

  async function getSubtitles(item) {
    if (typeof SUBTITLES === "undefined" || typeof SUBTITLES.fetchSubtitles !== "function") {
      return [];
    }
    try {
      return await SUBTITLES.fetchSubtitles(item);
    } catch {
      return [];
    }
  }

  async function resolve(item, episode = null) {
    if (isLibrarySeries(item)) {
      const selected = episode
        ? SERIES.episodes.find(
            (entry) => entry.season === episode.season && entry.episode === episode.episode
          )
        : SERIES.episodes[0];
      if (!selected) return null;
      return {
        title: `${SERIES.title} — ح${selected.episode}: ${selected.title}`,
        stream: selected.stream,
        subtitles: selected.subtitles,
      };
    }

    const mediaType = item.mediaType || item.type;
    const stream = await getStream(item, mediaType);
    if (!stream) return null;

    const local = libraryByTMDB.get(Number(item.id))?.subtitles || [];
    const fetched = await getSubtitles(item);
    const subtitles = [...local];
    for (const track of fetched) {
      if (!subtitles.some((current) => current.srclang === track.srclang)) {
        subtitles.push(track);
      }
    }
    return { title: item.title, stream, subtitles };
  }

  async function buildPlayback(item, episode = null) {
    if (isLibrarySeries(item)) {
      const data = await getSeriesData();
      const entries = data.episodes.map((entry) => ({
        info: {
          title: `${SERIES.title} — ح${entry.episode}: ${entry.title}`,
          stream: entry.stream,
          subtitles: entry.subtitles,
        },
        episode: {
          season: entry.season,
          episode: entry.episode,
          title: entry.title,
          runtime: entry.runtime,
        },
      }));
      const requestedIndex = episode
        ? entries.findIndex(
            (entry) => entry.episode.season === episode.season && entry.episode.episode === episode.episode
          )
        : 0;
      return { entries, index: requestedIndex >= 0 ? requestedIndex : 0 };
    }

    const info = await resolve(item, episode);
    if (!info?.stream?.src) return { entries: [], index: 0 };
    return { entries: [{ info, episode: null }], index: 0 };
  }

  /* ---------- Embed System (Vidsrc + Alternatives) ---------- */
  async function getEmbedPlayback(item, episode = null) {
    if (!item || typeof EMBED === "undefined") return null;
    const sources = await EMBED.buildSources(item, episode);
    if (!sources.length) return null;
    return { sources, item, episode };
  }

  return {
    getLibraryItems,
    getSeriesData,
    isLibrarySeries,
    isPlayable,
    getStream,
    resolve,
    buildPlayback,
    getEmbedPlayback,
  };
})();
