/* =====================================================

   محرك التشغيل الاحترافي — Video.js

   -----------------------------------------------------

   - قوائم تشغيل (حلقات) مع "التالية/السابقة" وتشغيل تلقائي

   - اختصارات كيبورد مضمونة (Capture) مع مؤشرات على الشاشة

   - فرض أعلى جودة + حفظ التقدم والصوت واستئناف

   ===================================================== */


   const Player = (() => {

    // عناصر DOM
  
    const overlay = document.getElementById("player-overlay");
  
    const titleEl = document.getElementById("player-title");
  
    const VOLUME_KEY = "bluestream:volume";
  
  
    const fbSeekBack = document.getElementById("fb-seek-back");
  
    const fbSeekFwd = document.getElementById("fb-seek-fwd");
  
    const fbVolume = document.getElementById("fb-volume");
  
    const fbPlay = document.getElementById("fb-play");
  
  
    const errorEl = document.getElementById("player-error");
  
    const errorMsg = document.getElementById("player-error-msg");
  
  
    // حالة
  
    let player = null;
  
    let activeItem = null;
  
    let activeEpisode = null;
  
    let playlist = null;
  
    let prevBtn = null;
  
    let nextBtn = null;
  
    let subBtn = null;
  
    let lastSaveTime = 0;
  
    let loadTimeout = null;
  
  
    /* ---------- مؤشرات بصرية (Feedback) ---------- */
  
    function flash(el) {
  
      if (!el) return;
  
      el.classList.remove("show");
  
      void el.offsetWidth; // إعادة تشغيل الأنيميشن
  
      el.classList.add("show");
  
    }
  
  
    function seekBy(delta) {
  
      if (!player) return;
  
      const target = player.currentTime() + delta;
  
      player.currentTime(Math.max(0, Math.min(target, player.duration() || Infinity)));
  
      flash(delta > 0 ? fbSeekFwd : fbSeekBack);
  
    }
  
  
    function volumeBy(delta) {
  
      if (!player) return;
  
      player.muted(false);
  
      player.volume(Math.min(1, Math.max(0, player.volume() + delta)));
  
      fbVolume.textContent = `🔊 ${Math.round(player.volume() * 100)}%`;
  
      flash(fbVolume);
  
    }
  
  
    function togglePlay() {
  
      if (!player) return;
  
      if (player.paused()) {
  
        player.play().catch(() => {});
  
        fbPlay.textContent = "▶";
  
      } else {
  
        player.pause();
  
        fbPlay.textContent = "⏸";
  
      }
  
      flash(fbPlay);
  
    }
  
  
    /* ---------- أزرار مخصصة في شريط التحكم ---------- */
  
    function registerComponents() {
  
      if (!window.videojs) {
  
        console.error("Video.js غير محمّل");
  
        return;
  
      }
  
      const VjsButton = videojs.getComponent("Button");
  
  
      class SkipButton extends VjsButton {
  
        constructor(p, options) {
  
          super(p, options);
  
          this.controlText(options.seconds > 0 ? "تقديم 10 ثوانٍ" : "إرجاع 10 ثوانٍ");
  
        }
  
        buildCSSClass() {
  
          const dir = this.options_.seconds > 0 ? "vjs-skip-forward" : "vjs-skip-back";
  
          return `vjs-skip-btn ${dir} ${super.buildCSSClass()}`;
  
        }
  
        handleClick() { seekBy(this.options_.seconds); }
  
      }
  
  
      class EpisodeButton extends VjsButton {
  
        constructor(p, options) {
  
          super(p, options);
  
          this.controlText(options.next ? "الحلقة التالية" : "الحلقة السابقة");
  
        }
  
        buildCSSClass() {
  
          const dir = this.options_.next ? "vjs-ep-next" : "vjs-ep-prev";
  
          return `vjs-ep-btn ${dir} ${super.buildCSSClass()}`;
  
        }
  
        handleClick() { playRelative(this.options_.next ? 1 : -1); }
  
      }
  
  
      class SubtitleButton extends VjsButton {
  
        constructor(p, options) {
  
          super(p, options);
  
          this.controlText("الترجمة");
  
          this.labelEl = videojs.dom.createEl("span", { className: "vjs-sub-label" });
  
          this.el().appendChild(this.labelEl);
  
        }
  
        buildCSSClass() { return `vjs-subtitle-toggle ${super.buildCSSClass()}`; }
  
        handleClick() { cycleSubtitles(); }
  
        setLabel(text) { if (this.labelEl) this.labelEl.textContent = text; }
  
      }
  
  
      videojs.registerComponent("SkipButton", SkipButton);
  
      videojs.registerComponent("EpisodeButton", EpisodeButton);
  
      videojs.registerComponent("SubtitleButton", SubtitleButton);
  
    }
  
  
    /* ---------- الترجمة: التدوير والتسمية ---------- */
  
    function subtitleTracks() {
  
      if (!player) return [];
  
      const tracks = player.remoteTextTracks();
  
      const list = [];
  
      for (let i = 0; i < tracks.length; i++) {
  
        if (tracks[i].kind === "subtitles" || tracks[i].kind === "captions") {
  
          list.push(tracks[i]);
  
        }
  
      }
  
      return list;
  
    }
  
  
    function labelForLang(track) {
  
      if (!track) return "ترجمة";
  
      if (track.language === "ar") return "عربي";
  
      if (track.language === "en") return "إنجليزي";
  
      return track.label || "ترجمة";
  
    }
  
  
    function refreshSubtitleLabel() {
  
      if (!subBtn) return;
  
      const tracks = subtitleTracks();
  
      if (!tracks.length) { subBtn.hide(); return; }
  
      subBtn.show();
  
      const showing = tracks.find((t) => t.mode === "showing");
  
      subBtn.setLabel(showing ? labelForLang(showing) : "إيقاف");
  
    }
  
  
    function cycleSubtitles() {
  
      const tracks = subtitleTracks();
  
      if (!tracks.length) return;
  
      const states = [...tracks, null];
  
      const currentIndex = tracks.findIndex((t) => t.mode === "showing");
  
      const nextIndex = (currentIndex + 1) % states.length;
  
      const next = states[nextIndex];
  
      tracks.forEach((t) => (t.mode = "disabled"));
  
      if (next) next.mode = "showing";
  
      refreshSubtitleLabel();
  
      fbVolume.textContent = next ? `الترجمة: ${labelForLang(next)}` : "الترجمة: إيقاف";
  
      flash(fbVolume);
  
    }
  
  
    /* ---------- فرض أعلى دقة متاحة ---------- */
  
    function preferHighestQuality(p) {
  
      if (!p || typeof p.qualityLevels !== "function") return;
  
      const levels = p.qualityLevels();
  
      p.one("loadedmetadata", () => {
  
        let maxHeight = 0;
  
        for (let i = 0; i < levels.length; i++) {
  
          maxHeight = Math.max(maxHeight, levels[i].height || 0);
  
        }
  
        if (!maxHeight) return;
  
        for (let i = 0; i < levels.length; i++) {
  
          levels[i].enabled = (levels[i].height === maxHeight);
  
        }
  
      });
  
    }
  
  
    /* ---------- حفظ تقدم المشاهدة ---------- */
  
    function saveProgress() {
  
      if (!player || !activeItem) return;
  
      try {
  
        PROGRESS.save(activeItem, player.currentTime(), player.duration(), activeEpisode);
  
      } catch (err) {
  
        console.warn("saveProgress failed:", err);
  
      }
  
    }
  
  
    /* ---------- اختصارات الكيبورد (Capture) ---------- */
  
    function bindHotkeys() {
  
      document.addEventListener(
  
        "keydown",
  
        (e) => {
  
          if (!player || overlay.classList.contains("hidden")) return;
  
          if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  
          const handled = () => { e.preventDefault(); e.stopPropagation(); };
  
          switch (e.key) {
  
            case " ":          handled(); togglePlay(); break;
  
            case "ArrowRight": handled(); seekBy(10); break;
  
            case "ArrowLeft":  handled(); seekBy(-10); break;
  
            case "ArrowUp":    handled(); volumeBy(0.1); break;
  
            case "ArrowDown":  handled(); volumeBy(-0.1); break;
  
            case "f": case "F":
  
              handled();
  
              player.isFullscreen() ? player.exitFullscreen() : player.requestFullscreen();
  
              break;
  
            case "m": case "M": handled(); player.muted(!player.muted()); break;
  
            case "n": case "N": handled(); playRelative(1); break;
  
          }
  
        },
  
        true
  
      );
  
    }
  
  
    /* ---------- إنشاء المشغل ---------- */
  
    function ensurePlayer() {
  
      if (player) return player;
  
      if (!window.videojs) {
  
        console.error("Video.js غير محمّل — تأكد من تحميل السكربت قبل player.js");
  
        return null;
  
      }
  
      registerComponents();
  
  
      try {
  
        player = videojs("main-player", {
  
          controls: true,
  
          fill: true,
  
          playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
  
          language: "ar",
  
          userActions: { doubleClick: true, hotkeys: false },
  
          html5: {
  
            vhs: {
  
              overrideNative: true,
  
              enableLowInitialPlaylist: false,
  
              limitRenditionByPlayerDimensions: false,
  
              useDevicePixelRatio: true,
  
              bandwidth: 100000000,
  
            },
  
            nativeTextTracks: false,
  
            nativeAudioTracks: false,
  
          },
  
        });
  
      } catch (err) {
  
        console.error("Video.js init failed:", err);
  
        return null;
  
      }
  
  
      const controlBar = player.getChild("controlBar");
  
      prevBtn = controlBar.addChild("EpisodeButton", { next: false }, 1);
  
      controlBar.addChild("SkipButton", { seconds: -10 }, 2);
  
      controlBar.addChild("SkipButton", { seconds: 10 }, 3);
  
      nextBtn = controlBar.addChild("EpisodeButton", { next: true }, 4);
  
      subBtn = controlBar.addChild("SubtitleButton", {}, controlBar.children().length - 1);
  
  
      if (typeof player.hlsQualitySelector === "function") {
  
        player.hlsQualitySelector({ displayCurrentQuality: true });
  
      }
  
      preferHighestQuality(player);
  
  
      // استرجاع الصوت المحفوظ
  
      try {
  
        const savedVolume = parseFloat(localStorage.getItem(VOLUME_KEY));
  
        if (!isNaN(savedVolume)) player.volume(savedVolume);
  
        player.on("volumechange", () => {
  
          if (!player.muted()) localStorage.setItem(VOLUME_KEY, player.volume());
  
        });
  
      } catch (e) { /* localStorage قد يكون معطلاً */ }
  
  
      // حفظ التقدم كل 5 ثوانٍ
  
      player.on("timeupdate", () => {
  
        const now = Date.now();
  
        if (now - lastSaveTime > 5000) {
  
          lastSaveTime = now;
  
          saveProgress();
  
        }
  
      });
  
  
      // نهاية الحلقة/الفيلم
  
      player.on("ended", () => {
  
        saveProgress();
  
        if (playlist && playlist.index < playlist.entries.length - 1) {
  
          playRelative(1, false);
  
        } else {
  
          close();
  
        }
  
      });
  
  
      // إخفاء الـtopbar أثناء التشغيل
  
      player.on("userinactive", () => {
  
        if (!player.paused()) overlay.classList.add("hide-chrome");
  
      });
  
      player.on("useractive", () => overlay.classList.remove("hide-chrome"));
  
      player.on("pause", () => overlay.classList.remove("hide-chrome"));
  
  
      // تحديث زر الترجمة
  
      player.on("loadeddata", refreshSubtitleLabel);
  
      if (player.textTracks()) {
  
        player.textTracks().on("addtrack", refreshSubtitleLabel);
  
        player.textTracks().on("removetrack", refreshSubtitleLabel);
  
      }
  
  
      // خطأ البث
  
      player.on("error", () => {
  
        console.error("Player error:", player.error());
  
        showError();
  
      });
  
  
      bindHotkeys();
  
      return player;
  
    }
  
  
    /* ---------- رسالة الخطأ داخل المشغل ---------- */
  
    function showError(message) {
  
      errorMsg.textContent =
  
        message || "عذراً، المحتوى غير متوفر حالياً، يرجى المحاولة لاحقاً.";
  
      errorEl.classList.remove("hidden");
  
      if (player) player.pause();
  
    }
  
  
    function hideError() {
  
      errorEl.classList.add("hidden");
  
    }
  
  
    function setupErrorHandlers() {
  
      document.getElementById("player-error-retry").addEventListener("click", () => {
  
        hideError();
  
        if (playlist) playEntry(playlist.index, 0);
  
      });
  
      document.getElementById("player-error-close").addEventListener("click", close);
  
    }
  
  
    function clearTextTracks(p) {
  
      if (!p || typeof p.removeRemoteTextTrack !== "function") return;
  
      const tracks = p.remoteTextTracks();
  
      for (let i = tracks.length - 1; i >= 0; i--) {
  
        p.removeRemoteTextTrack(tracks[i]);
  
      }
  
    }
  
  
    function updateEpisodeButtons() {
  
      if (!prevBtn || !nextBtn) return;
  
      const multi = playlist && playlist.entries.length > 1;
  
      if (!multi) { prevBtn.hide(); nextBtn.hide(); return; }
  
      prevBtn.show(); nextBtn.show();
  
      playlist.index > 0 ? prevBtn.enable() : prevBtn.disable();
  
      playlist.index < playlist.entries.length - 1 ? nextBtn.enable() : nextBtn.disable();
  
    }
  
  
    /* ---------- تشغيل إدخال من قائمة التشغيل ---------- */
  
    function playEntry(index, startAt = 0) {
  
      const p = ensurePlayer();
  
      if (!p) {
  
        showError("تعذّر تهيئة المشغل. تأكد من تحميل Video.js.");
  
        return;
  
      }
  
      if (!playlist || !playlist.entries || !playlist.entries[index]) {
  
        showError("إدخال غير صالح في قائمة التشغيل.");
  
        return;
  
      }
  
      const entry = playlist.entries[index];
  
      playlist.index = index;
  
      activeEpisode = entry.episode;
  
  
      titleEl.textContent = entry.info?.title || "";
  
      overlay.classList.remove("hidden", "hide-chrome");
  
      document.body.style.overflow = "hidden";
  
      hideError();
  
  
      clearTextTracks(p);
  
  
      if (!entry.info.stream || !entry.info.stream.src) {
  
        showError();
  
        return;
  
      }
  
  
      // حماية: timeout للـloading — لو ما بدأ التحميل خلال 15 ثانية، نعرض خطأ
  
      clearTimeout(loadTimeout);
  
      loadTimeout = setTimeout(() => {
  
        if (player && player.paused() && player.readyState() < 2) {
  
          console.warn("Player: timeout waiting for loadeddata");
  
          showError("استغرق تحميل الفيديو وقتاً طويلاً. تحقق من الاتصال.");
  
        }
  
      }, 15000);
  
  
      try {
  
        p.src({ src: entry.info.stream.src, type: entry.info.stream.type || "application/x-mpegURL" });
  
      } catch (err) {
  
        console.error("p.src failed:", err);
  
        showError("صيغة الفيديو غير مدعومة.");
  
        return;
  
      }
  
  
      // إضافة الترجمات
  
      for (const sub of entry.info.subtitles || []) {
  
        try {
  
          p.addRemoteTextTrack(
  
            { kind: "subtitles", src: sub.src, srclang: sub.srclang, label: sub.label, default: !!sub.default },
  
            false
  
          );
  
        } catch (err) {
  
          console.warn("addRemoteTextTrack failed:", err);
  
        }
  
      }
  
  
      if (startAt > 0) {
  
        p.one("loadedmetadata", () => {
  
          clearTimeout(loadTimeout);
  
          try {
  
            if (startAt < (p.duration() || Infinity) * 0.95) p.currentTime(startAt);
  
          } catch (e) { /* ignore */ }
  
        });
  
      } else {
  
        p.one("loadedmetadata", () => clearTimeout(loadTimeout));
  
      }
  
  
      updateEpisodeButtons();
  
      p.play().catch((err) => {
  
        clearTimeout(loadTimeout);
  
        console.warn("play() rejected:", err?.message || err);
  
        // قد يكون Autoplay policy — المستخدم يضغط تشغيل يدوياً
  
      });
  
    }
  
  
    function playRelative(delta, saveCurrent = true) {
  
      if (!playlist) return;
  
      const target = playlist.index + delta;
  
      if (target < 0 || target >= playlist.entries.length) return;
  
      if (saveCurrent) saveProgress();

      const targetEntry = playlist.entries[target];
      if (activeItem && typeof PROGRESS !== "undefined" && PROGRESS.start) {
        const durationHint = Number(targetEntry.episode?.runtime || 0) * 60;
        PROGRESS.start(activeItem, targetEntry.episode || null, durationHint);
      }
  
      playEntry(target, 0);
  
    }
  
  
    function openPlaylist(item, playback, startAt = 0) {
  
      if (!item || !playback || !Array.isArray(playback.entries) || playback.entries.length === 0) {
  
        console.warn("Player.openPlaylist: invalid args", { item, playback });
  
        return;
  
      }
  
      activeItem = item;
  
      playlist = playback;

      const initialEntry = playback.entries[playback.index || 0];
      if (typeof PROGRESS !== "undefined" && PROGRESS.start) {
        const durationHint = Number(initialEntry.episode?.runtime || item.runtime || 0) * 60;
        PROGRESS.start(item, initialEntry.episode || null, durationHint);
      }
  
      playEntry(playback.index || 0, startAt);
  
    }
  
  
    function close() {
  
      if (player) {
  
        try {
  
          saveProgress();
  
          player.pause();
  
          if (player.isFullscreen()) player.exitFullscreen();
  
        } catch (e) { /* ignore */ }
  
      }
  
      clearTimeout(loadTimeout);
  
      activeItem = null;
  
      activeEpisode = null;
  
      playlist = null;
  
      overlay.classList.add("hidden");
  
      document.body.style.overflow = "";
  
    }
  
  
    function setupGlobalHandlers() {
  
      const backBtn = document.getElementById("player-back");
  
      if (backBtn) backBtn.addEventListener("click", close);
  
      document.addEventListener("keydown", (e) => {
  
        if (e.key === "Escape" && !overlay.classList.contains("hidden")) close();
  
      });
  
    }
  
  
    // تهيئة المعالجات عند تحميل الملف
  
    setupErrorHandlers();
  
    setupGlobalHandlers();
  
  
    return { openPlaylist, close };
  
  })();
  
  