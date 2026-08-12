/* =====================================================
   BlueStream — Embed System (مشغل نظيف واحد فقط)
   - بدون إعلانات
   - Real-Debrid مباشر (video HTML5 عبر embed-player.v2.js)
   ===================================================== */

const EMBED = (() => {
  // مشغل واحد فقط
  const PROVIDERS = {
    clean: {
      name: "المشغل النظيف",
      emoji: "⚡",
      // ما يفتح iframe، الـ embed-player يستخدم video HTML5 من stream_url
      buildURL: () => "about:blank",
    },
  };

  // ترتيب ثابت
  const ORDER_BY_TYPE = {
    movie: ["clean"],
    tv: ["clean"],
    anime: ["clean"],
  };

  async function getAnimeMALId(item) {
    if (!item || item.type !== "anime") return null;
    if (item.mal_id) return item.mal_id;
    try {
      const res = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(item.title)}&limit=1`);
      const data = await res.json();
      return data?.data?.[0]?.mal_id || null;
    } catch { return null; }
  }

  async function buildSources(item, episode = null) {
    if (!item) return [];

    let resolvedItem = item;
    if (
      item.source === "tvmaze" &&
      typeof API !== "undefined" &&
      typeof API.resolveTVMazeToTMDB === "function"
    ) {
      resolvedItem = (await API.resolveTVMazeToTMDB(item)) || null;
      if (!resolvedItem) return [];
    }

    // سيرفر واحد فقط
    return [{
      key: "clean",
      name: `${PROVIDERS.clean.emoji} ${PROVIDERS.clean.name}`,
      url: PROVIDERS.clean.buildURL(),
      type: resolvedItem.mediaType || resolvedItem.type || "movie",
    }];
  }

  return { buildSources, getAnimeMALId, PROVIDERS };
})();
