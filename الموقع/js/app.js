/* =====================================================
   BlueStream — نقطة التشغيل الرئيسية
   ===================================================== */

   (() => {

    const topbar = document.getElementById("topbar");
    const viewHome = document.getElementById("view-home");
    const viewCategory = document.getElementById("view-category");
    const searchSection = document.getElementById("search-results");
    const searchGrid = document.getElementById("search-grid");
    const searchInput = document.getElementById("search-input");
    const searchTitle = document.getElementById("search-title");
  
    const categoryTitle = document.getElementById("category-title");
    const categoryGrid = document.getElementById("category-grid");
    const loadMoreBtn = document.getElementById("load-more");

    const profileLibraryView = document.getElementById("profile-library-view");
    const libraryGrid = document.getElementById("library-grid");
    const libraryTitle = document.getElementById("library-title");
    const libraryDescription = document.getElementById("library-description");
    const libraryEyebrow = document.getElementById("library-eyebrow");
  
    const continueSection = document.getElementById("continue-section");
    const continueRow = document.getElementById("row-continue");
  
    const heroEl = document.getElementById("hero");
    let heroItem = null;
  
    const CATEGORIES = {
      movies: { title: "جميع الأفلام", fetcher: (typeof API !== "undefined" && API.getPopularMovies) ? API.getPopularMovies : null },
      tv:     { title: "جميع المسلسلات", fetcher: (typeof API !== "undefined" && API.getPopularTV) ? API.getPopularTV : null },
      anime:  { title: "جميع الأنمي", fetcher: (typeof API !== "undefined" && API.getTopAnime) ? API.getTopAnime : null },
    };
  
    let activeTab = "home";
    let activeLibraryView = null;
    let categoryPage = 1;
  
    function showActiveView() {
      if (searchSection) searchSection.classList.add("hidden");
      if (activeLibraryView) {
        if (viewHome) viewHome.classList.add("hidden");
        if (viewCategory) viewCategory.classList.add("hidden");
        if (profileLibraryView) profileLibraryView.classList.remove("hidden");
        return;
      }
      if (profileLibraryView) profileLibraryView.classList.add("hidden");
      if (viewHome) viewHome.classList.toggle("hidden", activeTab !== "home");
      if (viewCategory) viewCategory.classList.toggle("hidden", activeTab === "home");
    }
  
    function setupNav() {
      const mainNav = document.getElementById("main-nav");
      if (!mainNav) return;
      mainNav.addEventListener("click", (e) => {
        const btn = e.target.closest(".nav-link");
        if (
          !btn ||
          (btn.dataset.view === activeTab && !activeLibraryView)
        ) return;
  
        document.querySelectorAll(".nav-link").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
  
        activeTab = btn.dataset.view;
        activeLibraryView = null;
        clearTimeout(debounceTimer);
        lastQueryId += 1;
        if (searchInput) searchInput.value = "";
        showActiveView();
        window.scrollTo({ top: 0 });
  
        if (activeTab !== "home") loadCategory(true);
      });
    }
  
    async function loadCategory(reset) {
      const cat = CATEGORIES[activeTab];
      if (!cat || !cat.fetcher) {
        if (categoryGrid) UI.showError(categoryGrid, "هذا القسم غير متاح حالياً.");
        return;
      }
  
      if (reset) {
        categoryPage = 1;
        if (categoryTitle) categoryTitle.textContent = cat.title;
        if (categoryGrid) UI.showSkeletons(categoryGrid, 14);
      }
  
      if (loadMoreBtn) loadMoreBtn.disabled = true;
      try {
        const items = await cat.fetcher(categoryPage);
        if (categoryGrid) UI.renderItems(categoryGrid, items || [], { append: !reset });
        if (loadMoreBtn) loadMoreBtn.classList.toggle("hidden", !items || items.length === 0);
      } catch (err) {
        console.error("loadCategory error:", err);
        if (reset && categoryGrid) UI.showError(categoryGrid, "تعذّر تحميل هذا القسم.");
      } finally {
        if (loadMoreBtn) loadMoreBtn.disabled = false;
      }
    }
  
    function setupLoadMore() {
      if (!loadMoreBtn) return;
      loadMoreBtn.addEventListener("click", () => {
        categoryPage += 1;
        loadCategory(false);
      });
    }
  
    /* ---------- الهيرو ---------- */
    function setupHero(items) {
      if (!Array.isArray(items) || !items.length) {
        if (heroEl) heroEl.classList.add("hidden");
        return;
      }
      heroItem = items.find((i) => i && i.backdrop) || null;
      if (!heroItem) {
        if (heroEl) heroEl.classList.add("hidden");
        return;
      }
      const hb = document.getElementById("hero-backdrop");
      if (hb) hb.src = heroItem.backdrop;
      const ht = document.getElementById("hero-title");
      if (ht) ht.textContent = heroItem.title || "";
      const hr = document.getElementById("hero-rating");
      if (hr) hr.textContent = `★ ${heroItem.rating || "—"}`;
      const hy = document.getElementById("hero-year");
      if (hy) hy.textContent = heroItem.year || "";
      const htype = document.getElementById("hero-type");
      if (htype) htype.textContent = ({ movie: "فيلم", tv: "مسلسل", anime: "أنمي" })[heroItem.type] || "";
      const ho = document.getElementById("hero-overview");
      if (ho) ho.textContent = heroItem.overview || "";
  
      const playButton = document.getElementById("hero-play");
      if (playButton) {
        playButton.innerHTML = "▶&nbsp;&nbsp;تشغيل";
      }
    }
  
    function setupHeroButtons() {
      const playBtn = document.getElementById("hero-play");
      const infoBtn = document.getElementById("hero-info");
  
      if (playBtn) {
        playBtn.addEventListener("click", async () => {
          if (!heroItem) return;
  
          // جرّب المصادر المحلية أولاً
          try {
            const saved = (typeof PROGRESS !== "undefined") ? PROGRESS.get(heroItem) : null;
            const playback = await SOURCES.buildPlayback(heroItem, saved?.episode || null);
            if (playback && playback.entries && playback.entries.length > 0) {
              Player.openPlaylist(
                heroItem,
                playback,
                saved && !saved.completed ? saved.position : 0
              );
              return;
            }
          } catch (err) {
            console.warn("local source failed, fallback to embed:", err);
          }
  
          // fallback: مشغل التضمين
          if (typeof EmbedPlayer !== "undefined") {
            await EmbedPlayer.open(heroItem);
          } else {
            UI.openModal(heroItem);
          }
        });
      }
  
      if (infoBtn) {
        infoBtn.addEventListener("click", () => {
          if (heroItem) UI.openModal(heroItem);
        });
      }
    }
  
    /* ---------- متابعة المشاهدة ---------- */
    async function resumeEntry(entry) {
      if (!entry || !entry.item) return;
      try {
        const playback = await SOURCES.buildPlayback(entry.item, entry.episode || null);
        if (playback && playback.entries && playback.entries.length > 0) {
          Player.openPlaylist(
            entry.item,
            playback,
            entry.completed ? 0 : (entry.position || 0)
          );
        } else if (typeof EmbedPlayer !== "undefined") {
          await EmbedPlayer.open(entry.item, entry.episode || null);
        } else {
          UI.openModal(entry.item);
        }
      } catch (err) {
        console.error("resumeEntry error:", err);
        UI.openModal(entry.item);
      }
    }
  
    function renderContinueWatching() {
      if (!continueSection || !continueRow) return;
      const entries = (typeof PROGRESS !== "undefined") ? PROGRESS.all() : [];
      continueSection.classList.toggle("hidden", entries.length === 0);
      continueRow.innerHTML = "";
  
      for (const entry of entries) {
        const subLabel = entry.completed
          ? "تمت المشاهدة"
          : entry.episode
          ? `الموسم ${entry.episode.season} · الحلقة ${entry.episode.episode}`
          : null;
        const progress = entry.completed
          ? 1
          : entry.duration > 0
            ? Math.min(1, Math.max(0, entry.position / entry.duration))
            : 0;
        const card = UI.createCard(entry.item, {
          progress,
          completed: !!entry.completed,
          subLabel,
          onClick: () => resumeEntry(entry),
          onRemove: (item) => PROGRESS.remove(item),
        });
        if (card) continueRow.appendChild(card);
      }
    }
  
    document.addEventListener("watch-progress-changed", renderContinueWatching);

    /* ---------- قائمتي / تمت المشاهدة / السجل ---------- */
    const LIBRARY_CONFIG = {
      "my-list": {
        title: "قائمتي",
        eyebrow: "اختياراتك",
        description: "الأعمال التي حفظتها لتعود إليها لاحقاً.",
      },
      watched: {
        title: "تمت المشاهدة",
        eyebrow: "إنجازات المشاهدة",
        description: "الأفلام والمسلسلات والحلقات التي أنهيتها أو حددتها يدوياً.",
      },
      history: {
        title: "سجل المشاهدة",
        eyebrow: "آخر النشاطات",
        description: "آخر مرات التشغيل والاستئناف والإكمال لهذا الملف فقط.",
      },
    };

    function episodeLabel(episode) {
      if (!episode) return "";
      return `الموسم ${episode.season ?? "—"} · الحلقة ${episode.episode ?? "—"}`;
    }

    function historyLabel(entry) {
      const eventLabel = {
        play: "بدأ المشاهدة",
        resume: "استأنف المشاهدة",
        complete: "أكمل المشاهدة",
      }[entry.event] || "شاهد";
      const date = new Intl.DateTimeFormat("ar-SA", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(entry.createdAt || Date.now()));
      return `${eventLabel}${entry.episode ? ` · ${episodeLabel(entry.episode)}` : ""} · ${date}`;
    }

    function renderLibrary() {
      if (!activeLibraryView || !libraryGrid) return;
      const config = LIBRARY_CONFIG[activeLibraryView];
      if (!config) return;

      if (libraryTitle) libraryTitle.textContent = config.title;
      if (libraryEyebrow) {
        const profileName = PROFILES.getActive()?.name || "الملف الحالي";
        libraryEyebrow.textContent = `${config.eyebrow} · ${profileName}`;
      }

      let entries = [];
      if (activeLibraryView === "my-list") entries = MY_LIST.all();
      if (activeLibraryView === "watched") entries = WATCHED.all();
      if (activeLibraryView === "history") entries = HISTORY.all();

      if (libraryDescription) {
        libraryDescription.textContent = `${config.description} · ${entries.length} عنصر`;
      }
      libraryGrid.replaceChildren();
      libraryGrid.classList.toggle(
        "history-grid",
        activeLibraryView === "history"
      );

      if (!entries.length) {
        UI.showError(
          libraryGrid,
          activeLibraryView === "my-list"
            ? "قائمتك فارغة. أضف عملاً من نافذة التفاصيل."
            : activeLibraryView === "watched"
              ? "لم تُسجّل أعمالاً مكتملة بعد."
              : "لا يوجد نشاط مشاهدة لهذا الملف بعد."
        );
        return;
      }

      for (const entry of entries) {
        if (!entry?.item) continue;
        let options = {};

        if (activeLibraryView === "my-list") {
          options = {
            onRemove: (item) => MY_LIST.remove(item),
            removeLabel: "إزالة من قائمتي",
          };
        } else if (activeLibraryView === "watched") {
          options = {
            progress: 1,
            completed: true,
            episode: entry.episode || null,
            subLabel: entry.episode
              ? `تمت · ${episodeLabel(entry.episode)}`
              : "تمت المشاهدة",
            onRemove: (item) => WATCHED.unmark(item, entry.episode || null),
            removeLabel: "إزالة من تمت المشاهدة",
          };
        } else {
          options = {
            episode: entry.episode || null,
            subLabel: historyLabel(entry),
            onClick: (item) => {
              const saved = PROGRESS.get(item);
              if (saved) resumeEntry(saved);
              else UI.openModal(item);
            },
          };
        }

        libraryGrid.appendChild(UI.createCard(entry.item, options));
      }
    }

    function openLibrary(view) {
      if (!LIBRARY_CONFIG[view]) return;
      activeLibraryView = view;
      clearTimeout(debounceTimer);
      lastQueryId += 1;
      if (searchInput) searchInput.value = "";
      showActiveView();
      renderLibrary();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function closeLibrary() {
      activeLibraryView = null;
      showActiveView();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    document.addEventListener("profile-library-requested", (event) => {
      openLibrary(event.detail?.view);
    });
    document.getElementById("library-close")?.addEventListener("click", closeLibrary);
    document.addEventListener("my-list-changed", () => {
      if (activeLibraryView === "my-list") renderLibrary();
    });
    document.addEventListener("watched-changed", () => {
      if (activeLibraryView === "watched") renderLibrary();
    });
    document.addEventListener("history-changed", () => {
      if (activeLibraryView === "history") renderLibrary();
    });
    document.addEventListener("profile-changed", () => {
      renderContinueWatching();
      if (activeLibraryView) renderLibrary();
    });
  
    /* ---------- صفوف الرئيسية ---------- */
    const rows = [
      { el: document.getElementById("row-library"),    fetcher: (typeof SOURCES !== "undefined" && SOURCES.getLibraryItems) ? SOURCES.getLibraryItems : null, hero: false },
      { el: document.getElementById("row-trending"),   fetcher: (typeof API !== "undefined" && API.getTrendingToday) ? API.getTrendingToday : null, hero: true },
      { el: document.getElementById("row-top-movies"), fetcher: (typeof API !== "undefined" && API.getTopRatedMovies) ? API.getTopRatedMovies : null, hero: false },
      { el: document.getElementById("row-anime"),      fetcher: (typeof API !== "undefined" && API.getPopularAnime) ? API.getPopularAnime : null, hero: false },
    ];
  
    async function loadHome() {
      if (CONFIG.TMDB_API_KEY === "YOUR_TMDB_API_KEY_HERE") {
        if (heroEl) heroEl.classList.add("hidden");
        const tr = document.getElementById("row-trending");
        if (tr) UI.showError(tr, "لم يتم ضبط مفتاح TMDB — افتح public/js/config.js وضع مفتاحك.");
      }
  
      renderContinueWatching();
  
      await Promise.allSettled(
        rows.map(async (row) => {
          if (!row.el || !row.fetcher) {
            if (row.el) UI.showError(row.el, "غير متاح");
            return;
          }
          UI.showSkeletons(row.el);
          try {
            const items = await row.fetcher();
            UI.renderItems(row.el, items || []);
            if (row.hero) setupHero(items || []);
          } catch (err) {
            console.error("row load error:", err);
            UI.showError(row.el, "تعذّر تحميل هذا القسم. تحقق من الاتصال أو مفتاح API.");
            if (row.hero && heroEl) heroEl.classList.add("hidden");
          }
        })
      );
    }
  
    /* ---------- البحث ---------- */
    let debounceTimer = null;
    let lastQueryId = 0;
  
    function setupSearch() {
      if (!searchInput) return;
      searchInput.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        const query = searchInput.value.trim();
  
        if (!query) {
          lastQueryId += 1;
          if (searchTitle) searchTitle.textContent = "نتائج البحث";
          showActiveView();
          return;
        }
  
        debounceTimer = setTimeout(async () => {
          const queryId = ++lastQueryId;
          if (viewHome) viewHome.classList.add("hidden");
          if (viewCategory) viewCategory.classList.add("hidden");
          if (profileLibraryView) profileLibraryView.classList.add("hidden");
          if (searchSection) searchSection.classList.remove("hidden");
          if (searchGrid) UI.showSkeletons(searchGrid, 12);
  
          try {
            const result = typeof API.searchSmart === "function"
              ? await API.searchSmart(query, activeTab)
              : { items: await API.searchAll(query), title: `نتائج البحث عن «${query}»` };
  
            if (queryId !== lastQueryId) return;
            if (searchTitle) searchTitle.textContent = result.title || "نتائج البحث";
            if (searchGrid) UI.renderItems(searchGrid, result.items || []);
          } catch (err) {
            console.error("search error:", err);
            if (queryId === lastQueryId && searchGrid) {
              UI.showError(searchGrid, "حدث خطأ أثناء البحث. حاول مرة أخرى.");
            }
          }
        }, 450);
      });
    }
  
    /* ---------- الهيدر ---------- */
    function setupScroll() {
      window.addEventListener("scroll", () => {
        if (topbar) topbar.classList.toggle("scrolled", window.scrollY > 30);
      }, { passive: true });
    }
  
    async function init() {
      try {
        if (typeof PROFILE_STORE !== "undefined") {
          await PROFILE_STORE.init();
        }
        if (typeof PROFILE_UI !== "undefined") {
          await PROFILE_UI.init();
        }
        if (typeof ACCESS_GATE !== "undefined") {
          await ACCESS_GATE.init();
        }
      } catch (error) {
        console.error("profile system init failed:", error);
      }
      setupNav();
      setupLoadMore();
      setupHeroButtons();
      setupSearch();
      setupScroll();
      await loadHome();
    }
  
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  
  })();
  