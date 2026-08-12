/* =====================================================

   وحدة الترجمة — OpenSubtitles API

   ----------------------------------------------------

   searchSubtitles(item) → عربي أولاً، ثم إنجليزي

   يحول SRT→VTT ويرجع مسارات Blob جاهزة للحقن في Video.js.

   تعمل فقط إذا وضعت مفتاح OpenSubtitles في config.js.

   مفتاح مجاني: https://www.opensubtitles.com/consumers

   ===================================================== */


   const SUBTITLES = (() => {

    const BASE = "https://api.opensubtitles.com/api/v1";
  
  
    function enabled() {
  
      return CONFIG.OPENSUBTITLES_API_KEY && CONFIG.OPENSUBTITLES_API_KEY !== "";
  
    }
  
  
    function headers() {
  
      return {
  
        "Api-Key": CONFIG.OPENSUBTITLES_API_KEY,
  
        "Content-Type": "application/json",
  
      };
  
    }
  
  
    // fetch مع timeout
  
    async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  
      const controller = new AbortController();
  
      const tid = setTimeout(() => controller.abort(), timeoutMs);
  
      try {
  
        return await fetch(url, { ...options, signal: controller.signal });
  
      } finally {
  
        clearTimeout(tid);
  
      }
  
    }
  
  
    /* تحويل SRT إلى WebVTT */
  
    function srtToVtt(srt) {
  
      const body = srt
  
        .replace(/\r/g, "")
  
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  
      return "WEBVTT\n\n" + body;
  
    }
  
  
    /* جلب أفضل ترجمة للغة معينة → مسار Blob (أو null) */
  
    async function fetchByLang(item, lang, label, isDefault) {
  
      if (!enabled() || !item) return null;
  
      try {
  
        // البحث بـ TMDB ID أولاً، ثم بالعنوان والسنة كاحتياط
  
        const params = new URLSearchParams({
  
          languages: lang,
  
          order_by: "download_count",
  
          order_direction: "desc",
  
        });
  
        if (item.source === "tmdb" || item.source === "library") {
  
          params.set("tmdb_id", String(item.id));
  
        } else {
  
          if (item.title) params.set("query", item.title);
  
          if (item.year) params.set("year", String(item.year));
  
        }
  
  
        const searchRes = await fetchWithTimeout(`${BASE}/subtitles?${params}`, { headers: headers() });
  
        if (!searchRes.ok) return null;
  
        const search = await searchRes.json();
  
        const fileId = search?.data?.[0]?.attributes?.files?.[0]?.file_id;
  
        if (!fileId) return null;
  
  
        const dlRes = await fetchWithTimeout(`${BASE}/download`, {
  
          method: "POST",
  
          headers: headers(),
  
          body: JSON.stringify({ file_id: fileId }),
  
        });
  
        if (!dlRes.ok) return null;
  
        const dl = await dlRes.json();
  
        if (!dl.link) return null;
  
  
        const rawRes = await fetchWithTimeout(dl.link);
  
        if (!rawRes.ok) return null;
  
        const raw = await rawRes.text();
  
        const vtt = raw.trimStart().startsWith("WEBVTT") ? raw : srtToVtt(raw);
  
        const blobURL = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
  
  
        return { src: blobURL, srclang: lang, label, default: !!isDefault };
  
      } catch (err) {
  
        console.warn(`OpenSubtitles (${lang}):`, err?.message || err);
  
        return null;
  
      }
  
    }
  
  
    /**
  
     * جلب الترجمة: عربي أولاً، ثم إنجليزي كخيار بديل.
  
     * ترجع مصفوفة مسارات (قد تكون فارغة).
  
     */
  
    async function fetchSubtitles(item) {
  
      if (!item) return [];
  
      const tracks = [];
  
  
      // 1) العربية أولاً
  
      const ar = await fetchByLang(item, "ar", "العربية", true);
  
      if (ar) tracks.push(ar);
  
  
      // 2) الإنجليزية كبديل/إضافي (افتراضية فقط إذا غابت العربية)
  
      const en = await fetchByLang(item, "en", "English", !ar);
  
      if (en) tracks.push(en);
  
  
      return tracks;
  
    }
  
  
    // توافق عكسي مع النداءات القديمة
  
    async function findArabic(item) {
  
      const ar = await fetchByLang(item, "ar", "العربية", true);
  
      return ar ? [ar] : [];
  
    }
  
  
    return { fetchSubtitles, findArabic };
  
  })();
  
  