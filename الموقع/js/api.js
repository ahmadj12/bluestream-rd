/* =====================================================
   BlueStream — Live Catalog API
   TMDB + Jikan + TVMaze
   ===================================================== */

   const API = (() => {
    const JIKAN_COOLDOWN_MS = 5 * 60 * 1000;
    let jikanUnavailableUntil = 0;
    const tvmazeEpisodesCache = new Map();
    const tvmazeSeasonsCache = new Map();
    const tvmazeTMDBCache = new Map();
  
    const GENRE_ALIASES = [
      { words: ["اكشن", "أكشن", "action", "قتال"], movie: 28, tv: 10759 },
      { words: ["مغامرة", "مغامرات", "adventure"], movie: 12, tv: 10759 },
      { words: ["رعب", "horror"], movie: 27, tv: 9648 },
      { words: ["كوميدي", "كوميديا", "ضحك", "comedy"], movie: 35, tv: 35 },
      { words: ["رومانسي", "رومانسية", "romance"], movie: 10749, tv: 18 },
      { words: ["دراما", "drama"], movie: 18, tv: 18 },
      { words: ["جريمة", "crime"], movie: 80, tv: 80 },
      { words: ["خيال علمي", "خيال", "scifi", "sci-fi"], movie: 878, tv: 10765 },
      { words: ["غموض", "mystery"], movie: 9648, tv: 9648 },
      { words: ["وثائقي", "وثائقيات", "documentary"], movie: 99, tv: 99 },
      { words: ["عائلي", "عائلة", "family"], movie: 10751, tv: 10751 },
      { words: ["حرب", "حربي", "war"], movie: 10752, tv: 10768 },
    ];
  
    async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.REQUEST_TIMEOUT || 8000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    }
  
    async function fetchJSON(url) {
      try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        throw new Error(`API: فشل جلب البيانات — ${error.message}`);
      }
    }
  
    async function fetchJikanJSON(path) {
      if (Date.now() < jikanUnavailableUntil) {
        throw new Error("Jikan في فترة تهدئة مؤقتة");
      }
      try {
        return await fetchJSON(`${CONFIG.JIKAN_BASE}${path}`);
      } catch (error) {
        jikanUnavailableUntil = Date.now() + JIKAN_COOLDOWN_MS;
        throw error;
      }
    }
  
    function tmdbURL(path, params = {}) {
      const url = new URL(CONFIG.TMDB_BASE + path);
      url.searchParams.set("api_key", CONFIG.TMDB_API_KEY);
      url.searchParams.set("language", CONFIG.LANG);
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, value);
        }
      }
      return url.toString();
    }
  
    function isAnimeTMDB(item) {
      const genres = item.genre_ids || item.genres?.map((genre) => genre.id) || [];
      const countries = item.origin_country || item.production_countries?.map((country) => country.iso_3166_1) || [];
      return genres.includes(16) &&
        (item.original_language === "ja" || countries.includes("JP"));
    }
  
    function normalizeTMDB(item, forcedMediaType = null) {
      const mediaType = forcedMediaType || item.media_type || (item.title ? "movie" : "tv");
      const anime = isAnimeTMDB(item);
      return {
        id: item.id,
        type: anime ? "anime" : mediaType,
        mediaType,
        source: "tmdb",
        title: item.title || item.name || item.original_title || item.original_name || "بدون عنوان",
        originalTitle: item.original_title || item.original_name || "",
        poster: item.poster_path ? CONFIG.TMDB_IMG + item.poster_path : CONFIG.FALLBACK_POSTER,
        backdrop: item.backdrop_path ? CONFIG.TMDB_BACKDROP + item.backdrop_path : null,
        rating: item.vote_average ? Number(item.vote_average).toFixed(1) : "—",
        year: (item.release_date || item.first_air_date || "").slice(0, 4),
        overview: item.overview || "لا يوجد وصف عربي متاح لهذا العمل حالياً.",
        genreIds: item.genre_ids || [],
        popularity: Number(item.popularity) || 0,
        totalEpisodes: anime ? (item.number_of_episodes || null) : null,
      };
    }
  
    function normalizeJikan(item) {
      return {
        id: item.mal_id,
        type: "anime",
        mediaType: item.type === "Movie" ? "movie" : "tv",
        source: "jikan",
        title: item.title_english || item.title || item.title_japanese || "بدون عنوان",
        originalTitle: item.title || "",
        poster:
          item.images?.webp?.large_image_url ||
          item.images?.jpg?.large_image_url ||
          item.images?.jpg?.image_url ||
          CONFIG.FALLBACK_POSTER,
        backdrop: null,
        rating: item.score ? Number(item.score).toFixed(1) : "—",
        year: String(item.year || item.aired?.prop?.from?.year || ""),
        overview: item.synopsis || "لا يوجد وصف متاح لهذا الأنمي حالياً.",
        genreIds: [],
        popularity: Number(item.popularity) || 0,
        totalEpisodes: item.episodes || null,
        mal_id: item.mal_id,
      };
    }
  
    function stripHTML(value) {
      return String(value || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .trim();
    }
  
    function normalizeTVMaze(entry) {
      const show = entry.show || entry;
      return {
        id: show.id,
        type: "tv",
        mediaType: "tv",
        source: "tvmaze",
        title: show.name || "بدون عنوان",
        originalTitle: show.name || "",
        poster: show.image?.original || show.image?.medium || CONFIG.FALLBACK_POSTER,
        backdrop: show.image?.original || null,
        rating: show.rating?.average ? Number(show.rating.average).toFixed(1) : "—",
        year: String(show.premiered || "").slice(0, 4),
        overview: stripHTML(show.summary) || "لا يوجد وصف متاح لهذا المسلسل حالياً.",
        genreIds: [],
        popularity: Number(entry.score) || Number(show.weight) || 0,
        externalIds: {
          imdb: show.externals?.imdb || null,
          tvdb: show.externals?.thetvdb || null,
        },
        providerUrl: show.officialSite || show.url || null,
      };
    }
  
    function titleKey(value) {
      return String(value || "")
        .normalize("NFKD")
        .toLocaleLowerCase("ar")
        .replace(/[\u064B-\u065F\u0670]/g, "")
        .replace(/[أإآٱ]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    }
  
    function uniqueItems(items) {
      const ids = new Set();
      const titles = new Set();
      return (items || []).filter((item) => {
        if (!item?.id) return false;
        const idKey = `${item.source}:${item.id}`;
        const nameKey = `${titleKey(item.title)}:${item.year || ""}:${item.type}`;
        if (ids.has(idKey) || (nameKey.length > 3 && titles.has(nameKey))) return false;
        ids.add(idKey);
        titles.add(nameKey);
        return true;
      });
    }
  
    async function discoverTMDB(mediaType, page = 1, genreId = null) {
      const path = mediaType === "movie" ? "/discover/movie" : "/discover/tv";
      const data = await fetchJSON(
        tmdbURL(path, {
          page,
          sort_by: "popularity.desc",
          include_adult: "false",
          include_null_first_air_dates: mediaType === "tv" ? "false" : undefined,
          with_genres: genreId,
        })
      );
      return (data.results || [])
        .map((item) => normalizeTMDB(item, mediaType))
        .filter((item) => item.type === mediaType);
    }
  
    async function getTMDBAnime(page = 1) {
      const common = {
        page,
        sort_by: "popularity.desc",
        include_adult: "false",
        with_genres: "16",
        with_original_language: "ja",
      };
      const [tv, movies] = await Promise.allSettled([
        fetchJSON(tmdbURL("/discover/tv", { ...common, include_null_first_air_dates: "false" })),
        fetchJSON(tmdbURL("/discover/movie", common)),
      ]);
  
      const items = [];
      if (tv.status === "fulfilled") {
        items.push(...(tv.value.results || []).map((item) => normalizeTMDB(item, "tv")));
      }
      if (movies.status === "fulfilled") {
        items.push(...(movies.value.results || []).map((item) => normalizeTMDB(item, "movie")));
      }
      if (!items.length) throw new Error("تعذّر تحميل كتالوج الأنمي البديل");
      return uniqueItems(items).sort((a, b) => b.popularity - a.popularity);
    }
  
    async function getAnimePage(page = 1) {
      try {
        const data = await fetchJikanJSON(`/top/anime?filter=bypopularity&sfw=true&limit=24&page=${page}`);
        const items = (data.data || []).map(normalizeJikan);
        if (items.length) return uniqueItems(items);
      } catch (error) {
        console.warn("Jikan غير متاح؛ تم التحويل تلقائياً إلى TMDB:", error.message);
      }
      return getTMDBAnime(page);
    }
  
    async function getTrendingToday() {
      const data = await fetchJSON(tmdbURL("/trending/all/day", { include_adult: "false" }));
      return uniqueItems(
        (data.results || [])
          .filter((item) => item && (item.media_type === "movie" || item.media_type === "tv"))
          .map((item) => normalizeTMDB(item))
      );
    }
  
    async function getTopRatedMovies(page = 1) {
      const data = await fetchJSON(tmdbURL("/movie/top_rated", { page }));
      return (data.results || [])
        .map((item) => normalizeTMDB(item, "movie"))
        .filter((item) => item.type === "movie");
    }
  
    const getPopularAnime = () => getAnimePage(1);
    const getPopularMovies = (page = 1) => discoverTMDB("movie", page);
    const getPopularTV = (page = 1) => discoverTMDB("tv", page);
    const getTopAnime = (page = 1) => getAnimePage(page);
  
    function normalizeEpisode(episode) {
      return {
        season: episode.season_number,
        episode: episode.episode_number,
        title: episode.name || `الحلقة ${episode.episode_number}`,
        overview: episode.overview || "",
        still: episode.still_path ? CONFIG.TMDB_IMG + episode.still_path : null,
        runtime: episode.runtime || null,
      };
    }
  
    async function getTVDetails(id) {
      if (!id) return { seasons: [] };
      const data = await fetchJSON(tmdbURL(`/tv/${id}`));
      return {
        seasons: (data.seasons || [])
          .filter((season) => season && season.season_number > 0 && season.episode_count > 0)
          .map((season) => ({
            season: season.season_number,
            name: season.name || `الموسم ${season.season_number}`,
            episodeCount: season.episode_count,
          })),
      };
    }
  
    async function getSeasonEpisodes(id, seasonNumber) {
      if (!id || !seasonNumber) return [];
      const data = await fetchJSON(tmdbURL(`/tv/${id}/season/${seasonNumber}`));
      return (data.episodes || []).map(normalizeEpisode);
    }
  
    async function getTVMazeEpisodes(id) {
      if (!id) return [];
      if (tvmazeEpisodesCache.has(id)) return tvmazeEpisodesCache.get(id);
  
      const data = await fetchJSON(`${CONFIG.TVMAZE_BASE}/shows/${id}/episodes`);
      const episodes = (data || [])
        .filter((episode) => episode.season > 0 && episode.number)
        .map((episode) => ({
          season: episode.season,
          episode: episode.number,
          title: episode.name || `الحلقة ${episode.number}`,
          overview: stripHTML(episode.summary),
          still: episode.image?.original || episode.image?.medium || null,
          runtime: episode.runtime || null,
        }));
      tvmazeEpisodesCache.set(id, episodes);
      return episodes;
    }
  
    async function getTVMazeSeasons(id) {
      if (!id) return [];
      if (tvmazeSeasonsCache.has(id)) return tvmazeSeasonsCache.get(id);
  
      const data = await fetchJSON(`${CONFIG.TVMAZE_BASE}/shows/${id}/seasons`);
      let seasons = (data || [])
        .filter((season) => season.number > 0)
        .map((season) => ({
          season: season.number,
          name: season.name || `الموسم ${season.number}`,
          episodeCount: season.episodeOrder || 0,
        }));
  
      if (seasons.some((season) => !season.episodeCount)) {
        const episodes = await getTVMazeEpisodes(id);
        seasons = seasons.map((season) => ({
          ...season,
          episodeCount:
            season.episodeCount ||
            episodes.filter((episode) => episode.season === season.season).length,
        }));
      }
      tvmazeSeasonsCache.set(id, seasons);
      return seasons;
    }
  
    async function resolveTVMazeToTMDB(item) {
      if (!item || item.source !== "tvmaze") return null;
      if (tvmazeTMDBCache.has(item.id)) return tvmazeTMDBCache.get(item.id);
  
      let match = null;
      try {
        const imdb = item.externalIds?.imdb;
        const tvdb = item.externalIds?.tvdb;
        if (imdb || tvdb) {
          const externalId = imdb || tvdb;
          const externalSource = imdb ? "imdb_id" : "tvdb_id";
          const data = await fetchJSON(
            tmdbURL(`/find/${externalId}`, { external_source: externalSource })
          );
          const show = data.tv_results?.[0];
          if (show) match = normalizeTMDB(show, "tv");
        }
  
        if (!match && item.title) {
          const results = await searchTMDB(item.title);
          match =
            results.find(
              (candidate) =>
                candidate.mediaType === "tv" &&
                titleKey(candidate.title) === titleKey(item.title) &&
                (!item.year || candidate.year === item.year)
            ) || null;
        }
      } catch {
        match = null;
      }
  
      tvmazeTMDBCache.set(item.id, match);
      return match;
    }
  
    async function getWatchOptions(item) {
      if (!item) return null;
      const target = item.source === "tvmaze"
        ? await resolveTVMazeToTMDB(item)
        : item;
      if (!target || target.source !== "tmdb") return null;
  
      const mediaType = target.mediaType === "movie" ? "movie" : "tv";
      try {
        const data = await fetchJSON(tmdbURL(`/${mediaType}/${target.id}/watch/providers`));
        const region = data.results?.[CONFIG.WATCH_REGION || "SA"];
        if (!region) return null;
  
        const groups = [
          ["free", "مجاني"],
          ["ads", "مجاني مع إعلانات"],
          ["flatrate", "اشتراك"],
          ["rent", "إيجار"],
          ["buy", "شراء"],
        ];
        const seen = new Set();
        const providers = [];
        for (const [key, label] of groups) {
          for (const provider of region[key] || []) {
            if (seen.has(provider.provider_id)) continue;
            seen.add(provider.provider_id);
            providers.push({
              id: provider.provider_id,
              name: provider.provider_name,
              logo: provider.logo_path ? CONFIG.TMDB_LOGO + provider.logo_path : null,
              access: label,
            });
          }
        }
        return providers.length ? { link: region.link, providers } : null;
      } catch {
        return null;
      }
    }
  
    function intentFrom(query, context = "home") {
      if (context === "movies") return "movie";
      if (context === "tv") return "tv";
      if (context === "anime") return "anime";
  
      const normalized = titleKey(query);
      if (/(انمي|أنمي|anime|مانجا|manga)/i.test(normalized)) return "anime";
      if (/(مسلسل|مسلسلات|series|show|tv)/i.test(normalized)) return "tv";
      if (/(فيلم|افلام|أفلام|movie|film)/i.test(normalized)) return "movie";
      return "all";
    }
  
    function genreFrom(query) {
      const normalized = titleKey(query);
      return GENRE_ALIASES.find((genre) =>
        genre.words.some((word) => normalized.includes(titleKey(word)))
      ) || null;
    }
  
    function isGenreRequest(query, genre) {
      if (!genre) return false;
      const categoryWords = new Set([
        "فيلم", "افلام", "مسلسل", "مسلسلات", "انمي",
        "movie", "movies", "film", "series", "show", "tv", "anime",
      ]);
      const cleaned = titleKey(query)
        .split(/\s+/)
        .filter((word) => !categoryWords.has(word))
        .join(" ");
      return genre.words.some((word) => cleaned === titleKey(word));
    }
  
    async function searchTMDB(query) {
      const data = await fetchJSON(
        tmdbURL("/search/multi", {
          query,
          include_adult: "false",
          page: 1,
        })
      );
      return (data.results || [])
        .filter((item) => item && (item.media_type === "movie" || item.media_type === "tv"))
        .map((item) => normalizeTMDB(item));
    }
  
    async function searchJikan(query) {
      const data = await fetchJikanJSON(`/anime?q=${encodeURIComponent(query)}&limit=12&sfw=true`);
      return (data.data || []).map(normalizeJikan);
    }
  
    async function searchTVMaze(query) {
      const data = await fetchJSON(
        `${CONFIG.TVMAZE_BASE}/search/shows?q=${encodeURIComponent(query)}`
      );
      return (data || []).map(normalizeTVMaze);
    }
  
    async function getSimilar(item) {
      if (!item || item.source !== "tmdb") return [];
      const mediaType = item.mediaType === "movie" ? "movie" : "tv";
      try {
        const data = await fetchJSON(tmdbURL(`/${mediaType}/${item.id}/similar`, { page: 1 }));
        return (data.results || []).map((entry) => normalizeTMDB(entry, mediaType));
      } catch {
        return [];
      }
    }
  
    async function fallbackSuggestions(intent, genre) {
      if (intent === "anime") return getTMDBAnime(1);
      if (intent === "movie") return discoverTMDB("movie", 1, genre?.movie);
      if (intent === "tv") return discoverTMDB("tv", 1, genre?.tv);
  
      if (genre) {
        const [movies, tv] = await Promise.all([
          discoverTMDB("movie", 1, genre.movie),
          discoverTMDB("tv", 1, genre.tv),
        ]);
        return uniqueItems([...movies, ...tv]).sort((a, b) => b.popularity - a.popularity);
      }
      return getTrendingToday();
    }
  
    async function searchSmart(query, context = "home") {
      const value = String(query || "").trim();
      if (!value) return { items: [], fallback: false, title: "نتائج البحث" };
  
      const intent = intentFrom(value, context);
      const genre = genreFrom(value);
      if (isGenreRequest(value, genre)) {
        const suggestions = await fallbackSuggestions(intent, genre);
        return {
          items: uniqueItems(suggestions).slice(0, 48),
          fallback: false,
          title: `أعمال تصنيف «${value}»`,
        };
      }
  
      const [tmdbResult, jikanResult, tvmazeResult] = await Promise.allSettled([
        searchTMDB(value),
        intent === "all" || intent === "anime" ? searchJikan(value) : Promise.resolve([]),
        intent === "all" || intent === "tv" ? searchTVMaze(value) : Promise.resolve([]),
      ]);
  
      let direct = [];
      if (tmdbResult.status === "fulfilled") direct.push(...tmdbResult.value);
      if (jikanResult.status === "fulfilled") direct.push(...jikanResult.value);
      if (tvmazeResult.status === "fulfilled") direct.push(...tvmazeResult.value);
  
      if (intent !== "all") direct = direct.filter((item) => item.type === intent);
      direct = uniqueItems(direct);
  
      if (direct.length) {
        const bestTMDB = direct.find((item) => item.source === "tmdb");
        const similar = direct.length < 16 && bestTMDB ? await getSimilar(bestTMDB) : [];
        const filteredSimilar = intent === "all"
          ? similar
          : similar.filter((item) => item.type === intent);
        return {
          items: uniqueItems([...direct, ...filteredSimilar]).slice(0, 48),
          fallback: false,
          title: `نتائج البحث عن «${value}»`,
        };
      }
  
      const suggestions = await fallbackSuggestions(intent, genre);
      const sectionLabel = {
        movie: "الأفلام",
        tv: "المسلسلات",
        anime: "الأنمي",
        all: genre ? "نفس التصنيف" : "الأعمال الرائجة",
      }[intent];
  
      return {
        items: uniqueItems(suggestions).slice(0, 48),
        fallback: true,
        title: `لم نجد «${value}» — اقتراحات من ${sectionLabel}`,
      };
    }
  
    async function searchAll(query) {
      return (await searchSmart(query)).items;
    }
  
    return {
      getTrendingToday,
      getTopRatedMovies,
      getPopularAnime,
      getPopularMovies,
      getPopularTV,
      getTopAnime,
      getTVDetails,
      getSeasonEpisodes,
      getTVMazeSeasons,
      getTVMazeEpisodes,
      resolveTVMazeToTMDB,
      getWatchOptions,
      searchAll,
      searchSmart,
    };
  })();
  