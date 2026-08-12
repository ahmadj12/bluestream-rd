/* =====================================================
   BlueStream — مشغل التضمين (HTML5 video + Plyr)
   - يفتح ويشتغل فوراً بدون أي خطوة وسطى
   - ترجمة عربية تلقائية
   - بدون أزرار "اختيار مشغل آخر"
   ===================================================== */

const EmbedPlayer = (() => {
  const $ = (id) => document.getElementById(id);
  const overlay = $("embed-overlay");
  const iframe = $("embed-iframe");
  const titleEl = $("embed-title");
  const backBtn = $("embed-back");
  const errorEl = $("embed-error");
  const loadingEl = $("embed-loading");
  const loadingText = $("embed-loading-text");
  const loadingServer = $("embed-loading-server");
  const serverSelect = $("embed-server");
  const nextServerBtn = $("embed-next-server");
  const workspace = $("embed-workspace");
  const episodesPanel = $("embed-episodes-panel");
  const sidebarToggle = $("embed-sidebar-toggle");
  const seasonSelect = $("embed-season");
  const episodesList = $("embed-episodes-list");
  const verificationEl = $("embed-verification");

  // إخفاء عناصر اختيار المشغّل فوراً عند تحميل الملف
  function hideServerControls() {
    if (serverSelect) {
      serverSelect.replaceChildren();
      const opt = document.createElement("option");
      opt.textContent = "⚡ Real-Debrid";
      opt.selected = true;
      serverSelect.appendChild(opt);
      serverSelect.disabled = true;
      serverSelect.style.display = "none";
    }
    if (nextServerBtn) nextServerBtn.style.display = "none";
  }

  const RD_API =
    (window.CONFIG?.RD_API_BASE && String(window.CONFIG.RD_API_BASE).replace(/\/$/, "")) ||
    "https://bluestream-rd-production.up.railway.app";

  let videoEl = null;
  let hls = null;
  let plyr = null;
  let activeItem = null;
  let activeEpisode = null;
  let catalogToken = 0;
  let catalog = null;
  let progressTimer = null;
  let pollTimer = null;

  const isOpen = () => overlay && !overlay.classList.contains("hidden");

  function clearTimers() {
    clearInterval(progressTimer);
    clearInterval(pollTimer);
    progressTimer = null;
    pollTimer = null;
  }

  function show() {
    if (!overlay) return;
    overlay.classList.remove("hidden", "hide-chrome");
    document.body.style.overflow = "hidden";
    hideError();
  }

  function hide() {
    if (!overlay) return;
    catalogToken += 1;
    clearTimers();
    overlay.classList.add("hidden", "hide-chrome");
    document.body.style.overflow = "";
    if (plyr) { try { plyr.pause(); } catch {} }
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    if (videoEl) {
      try { videoEl.pause(); videoEl.removeAttribute("src"); videoEl.load(); } catch {}
    }
    if (iframe) { try { iframe.removeAttribute("src"); } catch {} }
    hideLoading();
    hideVerification();
    activeItem = null;
    activeEpisode = null;
    catalog = null;
  }

  function showLoading(text, server) {
    if (!loadingEl) return;
    if (loadingText) loadingText.textContent = text || "جاري التحميل...";
    if (loadingServer) loadingServer.textContent = server || "";
    loadingEl.classList.remove("hidden");
  }

  function hideLoading() {
    loadingEl?.classList.add("hidden");
  }

  function showError(message) {
    const messageEl = errorEl?.querySelector(".embed-error-msg");
    if (messageEl) messageEl.textContent = message || "تعذّر تشغيل المحتوى.";
    errorEl?.classList.remove("hidden");
    overlay?.classList.remove("hide-chrome");
  }

  function hideError() {
    errorEl?.classList.add("hidden");
  }

  function hideVerification() {
    verificationEl?.classList.add("hidden");
  }

  // ===== Fetch with auto-retry على pending =====
  async function fetchRDStream(item, episode) {
    if (!item) return null;
    const typeParam = item.type === "anime" ? "tv" : (item.mediaType || "movie");
    const params = new URLSearchParams({
      id: String(item.id),
      type: typeParam,
      with_subs: "1",
    });
    if (typeParam === "tv" || item.type === "anime") {
      params.set("season", String(episode?.season || 1));
      params.set("episode", String(episode?.episode || 1));
    }
    const apiUrl = `${RD_API}/api/play?${params.toString()}`;

    // polling: نكرر كل 3 ثواني حتى 90 ثانية
    const maxAttempts = 30;
    const intervalMs = 3000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (attempt === 0) {
          showLoading("⏳ جاري البحث في TorrentDownloads...", "بدون إعلانات ✨");
        } else if (attempt === 1) {
          showLoading("⏳ جاري جلب رابط Real-Debrid...", "⏱ قد يستغرق 10-30 ثانية");
        } else {
          showLoading(`⏳ جاري التحضير... (${attempt * 3}ث)`, "⏱ يتم تجهيز أعلى جودة متاحة");
        }

        const response = await fetch(apiUrl, {
          method: "GET",
          headers: { "Accept": "application/json" },
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          if (errData.status === "pending") {
            await new Promise(r => setTimeout(r, intervalMs));
            continue;
          }
          return { success: false, error: errData.error || `HTTP ${response.status}` };
        }
        const data = await response.json();
        if (data?.success && data.stream_url) {
          return data;
        }
        if (data?.status === "pending") {
          await new Promise(r => setTimeout(r, intervalMs));
          continue;
        }
        return { success: false, error: data?.error || "no_stream" };
      } catch (err) {
        if (attempt === maxAttempts - 1) {
          return { success: false, error: err.message };
        }
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }
    return { success: false, error: "انتهت مهلة الانتظار. حاول مرة ثانية." };
  }

  // ===== Build / destroy video element =====
  function ensureVideo() {
    if (videoEl && overlay?.contains(videoEl)) return videoEl;
    if (iframe) iframe.style.display = "none";
    videoEl = document.createElement("video");
    videoEl.id = "main-player";
    videoEl.className = "embed-video";
    videoEl.setAttribute("playsinline", "");
    videoEl.setAttribute("preload", "metadata");
    videoEl.setAttribute("controlsList", "nodownload");
    videoEl.style.width = "100%";
    videoEl.style.height = "100%";
    videoEl.style.background = "#000";
    videoEl.style.display = "block";
    if (iframe?.parentNode) {
      iframe.parentNode.insertBefore(videoEl, iframe);
    } else {
      overlay?.querySelector(".embed-frame")?.appendChild(videoEl);
    }
    return videoEl;
  }

  function destroyPlyr() {
    if (plyr) { try { plyr.destroy(); } catch {} plyr = null; }
  }

  function initPlyr() {
    if (plyr || !videoEl || typeof Plyr === "undefined") return;
    plyr = new Plyr(videoEl, {
      controls: [
        "play-large", "play", "restart", "rewind", "fast-forward",
        "progress", "current-time", "duration", "mute", "volume",
        "captions", "settings", "pip", "fullscreen", "airplay",
      ],
      settings: ["captions", "quality", "speed"],
      speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
      seekTime: 10,
      captions: { active: true, language: "ar", update: true },
      i18n: {
        restart: "إعادة",
        rewind: "رجوع 10 ثواني",
        play: "تشغيل",
        pause: "إيقاف",
        fastForward: "تقدم 10 ثواني",
        seek: "بحث",
        played: "مشغّل",
        buffered: "محمل",
        currentTime: "الوقت الحالي",
        duration: "المدة",
        volume: "الصوت",
        mute: "كتم",
        unmute: "إلغاء الكتم",
        enableCaptions: "تفعيل الترجمة",
        disableCaptions: "إيقاف الترجمة",
        download: "تحميل",
        enterFullscreen: "شاشة كاملة",
        exitFullscreen: "خروج من شاشة كاملة",
        settings: "الإعدادات",
        pip: "صورة داخل صورة",
        menuBack: "رجوع",
        speed: "السرعة",
        normal: "عادي",
        quality: "الجودة",
        loop: "تكرار",
        start: "بداية",
        end: "نهاية",
        all: "الكل",
        reset: "إعادة ضبط",
      },
    });
  }

  async function playUrl(streamUrl, subtitle) {
    const v = ensureVideo();
    hideError();
    destroyPlyr();

    [...v.querySelectorAll("track")].forEach((t) => t.remove());
    if (subtitle?.url) {
      const track = document.createElement("track");
      track.kind = "captions";
      track.label = subtitle.label || "العربية";
      track.srclang = subtitle.language || "ar";
      track.src = subtitle.url;
      track.default = true;
      v.appendChild(track);
    }

    if (streamUrl.includes(".m3u8") && window.Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      hls.loadSource(streamUrl);
      hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        initPlyr();
        v.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (e, data) => {
        if (data?.fatal) {
          console.error("HLS fatal:", data);
          showError("تعذّر تشغيل الفيديو. حاول مرة ثانية.");
        }
      });
    } else if (streamUrl.includes(".m3u8") && v.canPlayType("application/vnd.apple.mpegurl")) {
      v.src = streamUrl;
      v.addEventListener("loadedmetadata", () => { initPlyr(); v.play().catch(() => {}); }, { once: true });
    } else {
      v.src = streamUrl;
      v.addEventListener("loadedmetadata", () => { initPlyr(); v.play().catch(() => {}); }, { once: true });
    }

    v.addEventListener("error", () => {
      console.error("video error");
      showError("تعذّر تشغيل الفيديو. حاول مرة ثانية.");
    }, { once: true });
  }

  function startProgressTracker() {
    clearTimers();
    progressTimer = setInterval(() => {
      if (!videoEl || !activeItem) return;
      const cur = videoEl.currentTime || 0;
      const dur = videoEl.duration || 0;
      if (cur > 5 && typeof PROGRESS !== "undefined" && PROGRESS.update) {
        try { PROGRESS.update(activeItem, activeEpisode, cur, dur); } catch {}
      }
    }, 10000);
  }

  async function play() {
    if (!activeItem) return;
    hideError();
    hideVerification();

    if (typeof PROGRESS !== "undefined" && PROGRESS.start) {
      const durationHint = Number(activeEpisode?.runtime || activeItem.runtime || 0) * 60;
      try { PROGRESS.start(activeItem, activeEpisode, durationHint); } catch {}
    }

    const data = await fetchRDStream(activeItem, activeEpisode);

    if (!data?.stream_url) {
      hideLoading();
      showError(data?.error || "تعذّر جلب رابط التشغيل.");
      return;
    }

    if (titleEl) {
      const subBadge = data.subtitle ? " · 🇸🇦 ترجمة" : "";
      titleEl.textContent = `${data.title || activeItem.title || ""} — ${data.quality || ""}${subBadge}`;
    }

    await playUrl(data.stream_url, data.subtitle);
    startProgressTracker();
    setTimeout(() => hideLoading(), 1000);
  }

  // ===== Episode catalog =====
  function isSeries(item) {
    if (!item) return false;
    if (typeof SOURCES !== "undefined" && SOURCES.isLibrarySeries?.(item)) return true;
    return item.mediaType === "tv" || item.type === "tv" || item.type === "anime";
  }

  async function buildEpisodeCatalog(item) {
    if (!isSeries(item)) return null;
    if (typeof SOURCES !== "undefined" && SOURCES.isLibrarySeries?.(item)) {
      const data = await SOURCES.getSeriesData();
      return {
        seasons: data.seasons,
        getEpisodes: async (s) => data.episodes.filter((e) => e.season === s),
      };
    }
    if (item.source === "tvmaze" && typeof API !== "undefined") {
      const [seasons, allEpisodes] = await Promise.all([
        API.getTVMazeSeasons(item.id), API.getTVMazeEpisodes(item.id),
      ]);
      return { seasons, getEpisodes: async (s) => allEpisodes.filter((e) => e.season === s) };
    }
    if (item.source === "tmdb" && typeof API !== "undefined") {
      const details = await API.getTVDetails(item.id);
      return {
        seasons: details.seasons || [],
        getEpisodes: (s) => API.getSeasonEpisodes(item.id, s),
      };
    }
    const total = Math.max(0, Number(item.totalEpisodes || 0));
    if (!total) return null;
    const episodes = Array.from({ length: total }, (_, i) => ({
      season: 1, episode: i + 1, title: `الحلقة ${i + 1}`, runtime: item.runtime || null,
    }));
    return {
      seasons: [{ season: 1, name: "الموسم 1", episodeCount: total }],
      getEpisodes: async () => episodes,
    };
  }

  function setSidebarAvailable(available) {
    sidebarToggle?.classList.toggle("hidden", !available);
    if (!available) {
      episodesPanel?.classList.add("hidden");
      workspace?.classList.remove("has-sidebar");
      sidebarToggle?.setAttribute("aria-expanded", "false");
    }
  }

  function setSidebarOpen(open) {
    if (!catalog) return;
    episodesPanel?.classList.toggle("hidden", !open);
    workspace?.classList.toggle("has-sidebar", open);
    sidebarToggle?.setAttribute("aria-expanded", String(open));
    overlay?.classList.remove("hide-chrome");
  }

  function renderSeasonOptions(selectedSeason) {
    if (!seasonSelect || !catalog) return;
    seasonSelect.replaceChildren();
    for (const season of catalog.seasons) {
      const option = document.createElement("option");
      option.value = String(season.season);
      option.textContent = (season.name || `الموسم ${season.season}`) +
        (season.episodeCount ? ` · ${season.episodeCount} حلقة` : "");
      option.selected = season.season === selectedSeason;
      seasonSelect.appendChild(option);
    }
  }

  function episodeIsWatched(episode) {
    try { return typeof WATCHED !== "undefined" && WATCHED.has(activeItem, episode); }
    catch { return false; }
  }

  function renderEpisodes(episodes) {
    if (!episodesList) return;
    episodesList.replaceChildren();
    if (!episodes.length) {
      const message = document.createElement("p");
      message.className = "embed-panel-message";
      message.textContent = "لا توجد حلقات متاحة لهذا الموسم.";
      episodesList.appendChild(message);
      return;
    }
    for (const episode of episodes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "embed-episode-item";
      button.classList.toggle(
        "active",
        Number(activeEpisode?.season) === Number(episode.season) &&
        Number(activeEpisode?.episode) === Number(episode.episode)
      );
      button.classList.toggle("watched", episodeIsWatched(episode));

      const number = document.createElement("span");
      number.className = "embed-episode-number";
      number.textContent = String(episode.episode);

      const copy = document.createElement("span");
      copy.className = "embed-episode-copy";
      const title = document.createElement("strong");
      title.textContent = episode.title || `الحلقة ${episode.episode}`;
      const meta = document.createElement("span");
      meta.textContent = episode.runtime ? `${episode.runtime} دقيقة` : `الموسم ${episode.season}`;
      copy.append(title, meta);
      button.append(number, copy);
      button.addEventListener("click", () => selectEpisode(episode));
      episodesList.appendChild(button);
    }
    requestAnimationFrame(() => {
      episodesList.querySelector(".embed-episode-item.active")?.scrollIntoView({ block: "nearest" });
    });
  }

  async function loadSeason(seasonNumber) {
    if (!catalog || !episodesList) return;
    const token = ++catalogToken;
    episodesList.innerHTML = '<p class="embed-panel-message">جارِ تحميل الحلقات...</p>';
    try {
      const episodes = await catalog.getEpisodes(Number(seasonNumber));
      if (token !== catalogToken || !activeItem) return;
      renderEpisodes(Array.isArray(episodes) ? episodes : []);
    } catch (err) {
      console.error("episode list error:", err);
      if (token === catalogToken) {
        episodesList.innerHTML = '<p class="embed-panel-message">تعذّر تحميل حلقات هذا الموسم.</p>';
      }
    }
  }

  async function setupEpisodeSidebar(item) {
    setSidebarAvailable(false);
    if (!isSeries(item)) return;
    if (episodesList) {
      episodesList.innerHTML = '<p class="embed-panel-message">جارِ تجهيز المواسم والحلقات...</p>';
    }
    const token = ++catalogToken;
    try {
      catalog = await buildEpisodeCatalog(item);
      if (token !== catalogToken || item !== activeItem || !catalog?.seasons?.length) return;
      const requestedSeason = Number(activeEpisode?.season || 0);
      const selectedSeason = catalog.seasons.some((s) => Number(s.season) === requestedSeason)
        ? requestedSeason
        : Number(catalog.seasons[0].season);
      renderSeasonOptions(selectedSeason);
      setSidebarAvailable(true);
      setSidebarOpen(true);
      await loadSeason(selectedSeason);
    } catch (err) {
      console.error("episode catalog error:", err);
      setSidebarAvailable(false);
    }
  }

  async function selectEpisode(episode) {
    if (!activeItem || !episode) return;
    activeEpisode = {
      season: Number(episode.season || 1),
      episode: Number(episode.episode || 1),
      title: episode.title || "",
      runtime: episode.runtime || null,
    };
    await loadSeason(activeEpisode.season);
    await play();
    if (window.matchMedia?.("(max-width: 820px)").matches) setSidebarOpen(false);
  }

  async function open(item, episode = null) {
    if (!item || !overlay) return;
    activeItem = item;
    activeEpisode = episode
      ? { ...episode, season: Number(episode.season || 1), episode: Number(episode.episode || 1) }
      : isSeries(item) ? { season: 1, episode: 1 } : null;
    catalog = null;
    if (titleEl) titleEl.textContent = item.title || "جاري التحميل...";
    show();
    setupEpisodeSidebar(item);
    await play();
  }

  function setup() {
    hideServerControls();
    backBtn?.addEventListener("click", hide);
    $("embed-panel-close")?.addEventListener("click", () => setSidebarOpen(false));
    seasonSelect?.addEventListener("change", () => loadSeason(Number(seasonSelect.value)));
    sidebarToggle?.addEventListener("click", () => {
      setSidebarOpen(episodesPanel?.classList.contains("hidden"));
    });
    errorEl?.querySelector(".embed-error-retry")?.addEventListener("click", () => { hideError(); play(); });
    errorEl?.querySelector(".embed-error-close")?.addEventListener("click", hide);
    errorEl?.querySelector(".embed-error-next")?.addEventListener("click", () => { hideError(); play(); });

    overlay?.addEventListener("mousemove", () => { overlay.classList.remove("hide-chrome"); });
    document.addEventListener("keydown", (event) => {
      if (!isOpen()) return;
      if (event.key === "Escape") hide();
    });
  }

  setup();

  return { open, close: hide };
})();
