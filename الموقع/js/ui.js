/* =====================================================
   BlueStream — طبقة واجهة المستخدم
   بطاقة + نافذة تفاصيل + زر تشغيل واحد
   ===================================================== */

const UI = (() => {

  const typeLabels = { movie: "فيلم", tv: "مسلسل", anime: "أنمي" };

  /* ---------- بطاقة عمل ---------- */
  function createCard(item, opts = {}) {
    if (!item) return document.createDocumentFragment();
    const card = document.createElement("article");
    card.className = "card";
    card._blueStreamItem = item;
    card._blueStreamEpisode = opts.episode || null;
    card.dataset.itemKey = `${item.source || "unknown"}:${item.id}`;
    const inMyList = typeof MY_LIST !== "undefined" && MY_LIST.has(item);
    const markedWatched = typeof WATCHED !== "undefined" && WATCHED.has(item, opts.episode || null);
    card.classList.toggle("available", canStream(item));
    card.classList.toggle("watching", typeof opts.progress === "number");
    card.classList.toggle("completed", !!opts.completed);
    card.classList.toggle("in-my-list", inMyList);
    card.classList.toggle("is-watched", markedWatched || !!opts.completed);

    card.innerHTML = `
      <div class="card-poster">
        <img loading="lazy" alt="">
        <span class="card-rating">★ ${item.rating || "—"}</span>
        <span class="card-status" aria-hidden="true"></span>
        <div class="card-flags" aria-hidden="true">
          ${inMyList ? '<span class="card-flag card-flag-list" title="في قائمتي">＋</span>' : ""}
          ${markedWatched || opts.completed ? '<span class="card-flag card-flag-watched" title="تمت المشاهدة">✓</span>' : ""}
        </div>
        <div class="card-overlay">
          <div class="card-title"></div>
          <div class="card-sub"></div>
        </div>
      </div>
    `;

    const img = card.querySelector("img");
    if (item.poster) img.src = item.poster;
    img.alt = item.title || "";
    card.querySelector(".card-title").textContent = item.title || "";
    card.querySelector(".card-sub").textContent =
      opts.subLabel || `${typeLabels[item.type] || ""} ${item.year ? "· " + item.year : ""}`;

    if (typeof opts.progress === "number" && isFinite(opts.progress)) {
      const bar = document.createElement("div");
      bar.className = "card-progress";
      const percent = Math.round(Math.min(1, Math.max(0, opts.progress)) * 100);
      bar.innerHTML = `<span style="width:${percent}%"></span>`;
      card.querySelector(".card-poster").appendChild(bar);
    }

    if (opts.onRemove) {
      const btn = document.createElement("button");
      btn.className = "card-remove";
      btn.textContent = "✕";
      btn.title = opts.removeLabel || "إزالة من متابعة المشاهدة";
      btn.addEventListener("click", (e) => { e.stopPropagation(); opts.onRemove(item); });
      card.querySelector(".card-poster").appendChild(btn);
    }

    card.addEventListener("click", () => (opts.onClick || openModal)(item));
    return card;
  }

  function refreshCardStates() {
    document.querySelectorAll(".card").forEach((card) => {
      const item = card._blueStreamItem;
      if (!item) return;
      const inMyList = typeof MY_LIST !== "undefined" && MY_LIST.has(item);
      const markedWatched = typeof WATCHED !== "undefined" && WATCHED.has(item, card._blueStreamEpisode || null);
      card.classList.toggle("in-my-list", inMyList);
      card.classList.toggle("is-watched", markedWatched || card.classList.contains("completed"));
      const flags = card.querySelector(".card-flags");
      if (!flags) return;
      flags.replaceChildren();
      if (inMyList) {
        const flag = document.createElement("span");
        flag.className = "card-flag card-flag-list";
        flag.title = "في قائمتي";
        flag.textContent = "＋";
        flags.appendChild(flag);
      }
      if (markedWatched || card.classList.contains("completed")) {
        const flag = document.createElement("span");
        flag.className = "card-flag card-flag-watched";
        flag.title = "تمت المشاهدة";
        flag.textContent = "✓";
        flags.appendChild(flag);
      }
    });
  }

  /* ---------- تعبئة صف/شبكة ---------- */
  function renderItems(container, items, opts = {}) {
    if (!container) return;
    if (!opts.append) container.innerHTML = "";
    if (!items || !items.length) {
      if (!opts.append) container.innerHTML = `<div class="row-error">لا توجد نتائج.</div>`;
      return;
    }
    const existing = new Set(
      Array.from(container.querySelectorAll(".card[data-item-key]")).map((c) => c.dataset.itemKey)
    );
    for (const item of items) {
      const key = `${item.source || "unknown"}:${item.id}`;
      if (existing.has(key)) continue;
      const card = createCard(item);
      if (card) { container.appendChild(card); existing.add(key); }
    }
  }

  function showSkeletons(container, count = 8) {
    if (!container) return;
    container.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const sk = document.createElement("div");
      sk.className = "skeleton";
      container.appendChild(sk);
    }
  }

  function showError(container, message) {
    if (!container) return;
    container.innerHTML = `<div class="row-error">⚠ ${message || "حدث خطأ"}</div>`;
  }

  function formatTime(sec) {
    if (!sec || !isFinite(sec)) return "0د";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h ? `${h}س ${m}د` : `${m}د`;
  }

  /* =====================================================
     نافذة التفاصيل — زر تشغيل واحد فقط
     ===================================================== */

  const modal = document.getElementById("details-modal");
  const playBtn = document.getElementById("modal-play");
  const noticeEl = document.getElementById("modal-notice");
  const watchOptionsEl = document.getElementById("watch-options");
  const myListBtn = document.getElementById("modal-my-list");
  const watchedBtn = document.getElementById("modal-watched");
  const episodesBlock = document.getElementById("episodes-block");
  const episodesList = document.getElementById("episodes-list");
  const seasonSelect = document.getElementById("season-select");

  let currentItem = null;
  let modalToken = 0;

  function canStream(item) {
    return !!(item && typeof SOURCES !== "undefined" && typeof SOURCES.isPlayable === "function" && SOURCES.isPlayable(item));
  }

  // زر التشغيل دائماً "تشغيل" — لا استئناف، لا اختيار مشغّل
  function playLabel(item) { return "▶&nbsp;&nbsp;تشغيل"; }

  function updateCollectionButtons(item) {
    if (!item) return;
    const inMyList = typeof MY_LIST !== "undefined" && MY_LIST.has(item);
    const isWatched = typeof WATCHED !== "undefined" && WATCHED.has(item);
    if (myListBtn) {
      myListBtn.classList.toggle("active", inMyList);
      myListBtn.textContent = inMyList ? "✓ في قائمتي" : "＋ قائمتي";
      myListBtn.setAttribute("aria-pressed", String(inMyList));
    }
    if (watchedBtn) {
      watchedBtn.classList.toggle("active", isWatched);
      watchedBtn.textContent = isWatched ? "✓ تمت المشاهدة" : "○ تحديد كمُشاهد";
      watchedBtn.setAttribute("aria-pressed", String(isWatched));
    }
  }

  function openModal(item) {
    if (!item) return;
    currentItem = item;
    const token = ++modalToken;

    const backdropEl = document.getElementById("modal-backdrop");
    if (backdropEl) backdropEl.src = item.backdrop || item.poster || "";
    const titleEl = document.getElementById("modal-title");
    if (titleEl) titleEl.textContent = item.title || "";
    const ratingEl = document.getElementById("modal-rating");
    if (ratingEl) ratingEl.textContent = `★ ${item.rating || "—"}`;
    const yearEl = document.getElementById("modal-year");
    if (yearEl) yearEl.textContent = item.year || "غير معروف";
    const typeEl = document.getElementById("modal-type");
    if (typeEl) typeEl.textContent = typeLabels[item.type] || "";
    const overviewEl = document.getElementById("modal-overview");
    if (overviewEl) overviewEl.textContent = item.overview || "";

    if (noticeEl) noticeEl.classList.add("hidden");
    if (playBtn) {
      playBtn.innerHTML = playLabel(item);
      playBtn.disabled = false;
      playBtn.style.display = "";
    }
    updateCollectionButtons(item);

    // شيل أي زر إضافي (clean-play أو embed-play) لو موجود
    document.getElementById("modal-clean-play")?.remove();
    document.getElementById("modal-embed-play")?.remove();

    if (watchOptionsEl) {
      watchOptionsEl.classList.add("hidden");
      watchOptionsEl.replaceChildren();
    }

    if (episodesBlock) episodesBlock.classList.add("hidden");
    if (episodesList) episodesList.innerHTML = "";
    if (seasonSelect) seasonSelect.innerHTML = "";

    const hasTMDBSeasons = item.source === "tmdb" &&
      (item.type === "tv" || (item.type === "anime" && item.mediaType === "tv"));
    if (item.type === "tv" || hasTMDBSeasons) loadEpisodesUI(item, token);

    if (modal) {
      modal.classList.remove("hidden");
      modal.setAttribute("aria-hidden", "false");
    }
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    if (modal) {
      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "";
    currentItem = null;
    modalToken++;
  }

  /* ---------- المواسم والحلقات ---------- */
  async function loadEpisodesUI(item, token) {
    if (!episodesBlock || !episodesList) return;
    episodesBlock.classList.remove("hidden");
    episodesList.innerHTML = `<div class="row-error">جارِ تحميل الحلقات...</div>`;

    try {
      let seasons;
      if (SOURCES?.isLibrarySeries?.(item)) {
        const data = await SOURCES.getSeriesData();
        seasons = data.seasons || [];
      } else if (item.source === "tvmaze" && typeof API !== "undefined") {
        seasons = await API.getTVMazeSeasons(item.id);
      } else if (item.source === "tmdb" && typeof API !== "undefined") {
        const details = await API.getTVDetails(item.id);
        seasons = details.seasons || [];
      } else {
        seasons = [];
      }

      if (token !== modalToken) return;
      if (!seasons.length) {
        episodesList.innerHTML = `<div class="row-error">لا توجد بيانات حلقات لهذا المسلسل.</div>`;
        return;
      }

      if (seasonSelect) {
        seasonSelect.innerHTML = "";
        for (const s of seasons) {
          const opt = document.createElement("option");
          opt.value = s.season;
          opt.textContent = `${s.name || "موسم " + s.season} (${s.episodeCount || 0} حلقة)`;
          seasonSelect.appendChild(opt);
        }
        seasonSelect.value = seasons[0].season;
        seasonSelect.onchange = () => loadSeason(item, parseInt(seasonSelect.value, 10), token);
      }

      await loadSeason(item, seasonSelect ? parseInt(seasonSelect.value, 10) : seasons[0].season, token);
    } catch (err) {
      console.error("loadEpisodesUI error:", err);
      if (token === modalToken && episodesList) {
        episodesList.innerHTML = `<div class="row-error">تعذّر تحميل الحلقات.</div>`;
      }
    }
  }

  async function loadSeason(item, seasonNumber, token) {
    if (!episodesList) return;
    episodesList.innerHTML = `<div class="row-error">جارِ تحميل الحلقات...</div>`;

    let episodes = [];
    try {
      if (SOURCES?.isLibrarySeries?.(item)) {
        const data = await SOURCES.getSeriesData();
        episodes = (data.episodes || []).filter((e) => e.season === seasonNumber);
      } else if (item.source === "tvmaze" && typeof API !== "undefined") {
        const allEpisodes = await API.getTVMazeEpisodes(item.id);
        episodes = allEpisodes.filter((episode) => episode.season === seasonNumber);
      } else if (item.source === "tmdb" && typeof API !== "undefined") {
        episodes = await API.getSeasonEpisodes(item.id, seasonNumber);
      }
    } catch (err) {
      console.error("loadSeason error:", err);
      if (token === modalToken) episodesList.innerHTML = `<div class="row-error">تعذّر تحميل الحلقات.</div>`;
      return;
    }

    if (token !== modalToken) return;
    episodesList.innerHTML = "";

    for (const ep of episodes) {
      const isWatched = typeof WATCHED !== "undefined" && WATCHED.has(item, { season: ep.season, episode: ep.episode });
      const row = document.createElement("div");
      row.className = "episode-row" + (isWatched ? " watched" : "");
      row.innerHTML = `
        <div class="episode-num">${ep.episode ?? ""}</div>
        <div class="episode-thumb">
          <img loading="lazy" alt="">
          <span class="episode-play">▶</span>
        </div>
        <div class="episode-info">
          <div class="episode-title">
            <span class="episode-name"></span>
            ${ep.runtime ? `<span class="episode-runtime">${ep.runtime} د</span>` : ""}
          </div>
          <p class="episode-desc"></p>
          <div class="episode-badges">
            ${isWatched ? `<span class="episode-badge episode-watched-badge">تمت المشاهدة</span>` : ""}
          </div>
        </div>
      `;
      const img = row.querySelector("img");
      img.src = ep.still || item.backdrop || item.poster || "";
      img.alt = ep.title || "";
      row.querySelector(".episode-name").textContent = ep.title || `الحلقة ${ep.episode}`;
      row.querySelector(".episode-desc").textContent = ep.overview || "لا يوجد وصف لهذه الحلقة.";
      row.addEventListener("click", () => playEpisode(item, ep));
      episodesList.appendChild(row);
    }
  }

  /* ---------- التشغيل: player.html (مشغّل واحد، نفس هوية الموقع) ---------- */
  async function startPlayback(item, episode) {
    if (!item) return;
    if (noticeEl) noticeEl.classList.add("hidden");
    if (playBtn) playBtn.disabled = true;

    try {
      const params = new URLSearchParams({
        id: item.id,
        type: item.type === 'anime' ? 'anime' : (item.mediaType || 'movie'),
        season: episode?.season || 1,
        episode: episode?.episode || 1,
        title: encodeURIComponent(item.title || "مشاهدة"),
        poster: encodeURIComponent(item.poster || ""),
        backdrop: encodeURIComponent(item.backdrop || ""),
      });

      if (typeof PROGRESS !== "undefined" && PROGRESS.start) {
        PROGRESS.start(item, episode);
      }

      window.location.href = `player.html?${params.toString()}`;
    } catch (err) {
      console.error("startPlayback error:", err);
      if (noticeEl) {
        noticeEl.textContent = "حدث خطأ. حاول مرة أخرى.";
        noticeEl.classList.remove("hidden");
      }
    } finally {
      if (playBtn) playBtn.disabled = !currentItem;
      if (currentItem && playBtn) playBtn.innerHTML = playLabel(currentItem);
    }
  }

  function playEpisode(item, ep) {
    startPlayback(item, {
      season: ep.season, episode: ep.episode,
      title: ep.title, runtime: ep.runtime,
    });
  }

  function setupModalHandlers() {
    if (playBtn) {
      playBtn.addEventListener("click", () => {
        if (!currentItem) return;
        startPlayback(currentItem, null);
      });
    }
    if (myListBtn) {
      myListBtn.addEventListener("click", () => {
        if (!currentItem || typeof MY_LIST === "undefined") return;
        const added = MY_LIST.toggle(currentItem);
        updateCollectionButtons(currentItem);
        if (typeof PROFILE_UI !== "undefined") PROFILE_UI.showToast(added ? "تمت الإضافة إلى قائمتي." : "تمت الإزالة من قائمتي.");
      });
    }
    if (watchedBtn) {
      watchedBtn.addEventListener("click", () => {
        if (!currentItem || typeof WATCHED === "undefined") return;
        const marked = WATCHED.toggle(currentItem);
        updateCollectionButtons(currentItem);
        if (typeof PROFILE_UI !== "undefined") PROFILE_UI.showToast(marked ? "تم تحديد العمل كمُشاهد." : "تمت إزالته.");
      });
    }
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target?.hasAttribute?.("data-close")) closeModal();
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal && !modal.classList.contains("hidden")) closeModal();
    });
  }

  setupModalHandlers();

  document.addEventListener("my-list-changed", () => {
    if (currentItem) updateCollectionButtons(currentItem);
    refreshCardStates();
  });
  document.addEventListener("watched-changed", () => {
    if (currentItem) updateCollectionButtons(currentItem);
    refreshCardStates();
  });

  return {
    createCard, renderItems, showSkeletons, showError,
    openModal, closeModal, updateCollectionButtons, refreshCardStates,
  };
})();
