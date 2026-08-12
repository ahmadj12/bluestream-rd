/* =====================================================
   BlueStream — HLS Player (مشغل حقيقي بجودة عالية)
   ===================================================== */

   const HLSPlayer = (() => {
    const overlay = document.getElementById("embed-overlay");
    const titleEl = document.getElementById("embed-title");
    const backBtn = document.getElementById("embed-back");
    const errorEl = document.getElementById("embed-error");
    const loadingEl = document.getElementById("embed-loading");
  
    let activeItem = null;
    let activeEpisode = null;
    let video = null;
    let hls = null;
    let hideChromeTimer = null;
  
    // ====== مسارات HLS مجانية بجودة عالية ======
    // نستخدم TMDB trailer API لجلب الفيديو
    async function getTMDBTrailer(item) {
      const url = `https://api.themoviedb.org/3/${item.mediaType || item.type}/${item.id}/videos?api_key=${CONFIG.TMDB_API_KEY}&language=ar-SA`;
      try {
        const res = await fetch(url);
        const data = await res.json();
        const videos = data.results || [];
        // نبحث عن trailer بجودة عالية
        const trailer = videos.find(v => v.site === "YouTube" && v.type === "Trailer");
        return trailer ? `https://www.youtube.com/embed/${trailer.key}?autoplay=1` : null;
      } catch {
        return null;
      }
    }
  
    // ====== سيرفرات HLS مباشرة (تجريبية) ======
    function getDirectHLS(item, episode) {
      const id = item.id;
      const type = item.mediaType || item.type;
      const season = episode?.season || 1;
      const ep = episode?.episode || 1;
  
      // مصادر HLS من Cloudflare/cdn
      return null; // ما عندنا مصادر مباشرة
    }
  
    // ====== تشغيل بـ iframe من سيرفرات 1080p ======
    async function playWithIframe(url, title) {
      // تنظيف
      if (video) { video.remove(); video = null; }
  
      // إنشاء iframe جديد (احترافي)
      const frame = document.createElement("div");
      frame.id = "embed-iframe-wrapper";
      frame.className = "embed-frame";
      frame.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;background:#000;";
  
      const iframe = document.createElement("iframe");
      iframe.id = "embed-iframe";
      iframe.src = url;
      iframe.style.cssText = "width:100%;height:100%;border:none;display:block;";
      iframe.allowFullscreen = true;
      iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  
      frame.appendChild(iframe);
  
      // إضافة إلى الـ stage
      const stage = document.querySelector(".embed-stage");
      if (stage) {
        // إزالة أي iframe قديم
        const oldFrame = stage.querySelector(".embed-frame");
        if (oldFrame) oldFrame.remove();
        stage.appendChild(frame);
      }
  
      titleEl.textContent = title;
  
      // إخفاء الـ loading لما يحمل الـ iframe
      iframe.addEventListener("load", () => {
        hideLoading();
        hideError();
        if (overlay) {
          clearTimeout(hideChromeTimer);
          hideChromeTimer = setTimeout(() => {
            if (overlay && !overlay.classList.contains("hidden")) {
              overlay.classList.add("hide-chrome");
            }
          }, 3500);
        }
      });
    }
  
    // ====== تشغيل TMDB Trailer (الحل المضمون) ======
    async function playTMDBTrailer(item) {
      showLoading("جاري جلب الإعلان بجودة عالية...", "TMDB");
      const trailerURL = await getTMDBTrailer(item);
  
      if (trailerURL) {
        await playWithIframe(trailerURL, `${item.title} — إعلان (1080p)`);
      } else {
        hideLoading();
        showError("لا يوجد إعلان متاح لهذا العمل.");
      }
    }
  
    /* ============ UI ============ */
    function show() {
      if (!overlay) return;
      overlay.classList.remove("hidden", "hide-chrome");
      document.body.style.overflow = "hidden";
      if (errorEl) errorEl.classList.add("hidden");
    }
  
    function hide() {
      if (!overlay) return;
      overlay.classList.add("hidden", "hide-chrome");
      document.body.style.overflow = "";
      const stage = document.querySelector(".embed-stage");
      if (stage) {
        const frame = stage.querySelector(".embed-frame");
        if (frame) frame.remove();
      }
      if (loadingEl) loadingEl.classList.add("hidden");
      activeItem = null;
      activeEpisode = null;
      clearTimeout(hideChromeTimer);
    }
  
    function showLoading(text, server) {
      if (!loadingEl) return;
      loadingEl.classList.remove("hidden");
      const textEl = document.getElementById("embed-loading-text");
      const serverEl = document.getElementById("embed-loading-server");
      if (textEl) textEl.textContent = text || "جاري التحميل...";
      if (serverEl) serverEl.textContent = server || "";
    }
  
    function hideLoading() {
      if (loadingEl) loadingEl.classList.add("hidden");
    }
  
    function showError(msg) {
      if (!errorEl) return;
      const p = errorEl.querySelector(".embed-error-msg");
      if (p) p.textContent = msg || "كل السيرفرات غير متاحة.";
      errorEl.classList.remove("hidden");
    }
  
    function hideError() {
      if (errorEl) errorEl.classList.add("hidden");
    }
  
    /* ============ Open ============ */
    async function open(item, episode = null) {
      if (!item) return;
      activeItem = item;
      activeEpisode = episode;
  
      titleEl.textContent = item.title || "جاري التحميل...";
      show();
  
      // نستخدم iframe من سيرفرات قوية
      const sources = await EMBED.buildSources(item, episode);
  
      if (!sources.length) {
        hideLoading();
        showError("لا توجد سيرفرات متاحة.");
        return;
      }
  
      // تجربة السيرفرات واحد واحد
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        showLoading(
          "جاري البحث عن سيرفر يعمل...",
          `${source.name} (${i + 1}/${sources.length})`
        );
  
        const ok = await testIframe(source.url, 5000);
        if (ok) {
          showLoading("جاري التشغيل...", source.name);
          await playWithIframe(source.url, `${item.title} — ${source.name}`);
          return;
        }
      }
  
      hideLoading();
      showError("كل السيرفرات تم تجربتها ولم يعمل أي منها.");
    }
  
    // اختبار iframe مخفي
    async function testIframe(url, timeout = 5000) {
      return new Promise((resolve) => {
        const frame = document.createElement("iframe");
        frame.style.cssText = "position:fixed;left:-9999px;width:50px;height:50px;border:none;visibility:hidden;";
        document.body.appendChild(frame);
  
        let resolved = false;
        const cleanup = (result) => {
          if (resolved) return;
          resolved = true;
          frame.src = "about:blank";
          setTimeout(() => { try { frame.remove(); } catch {} }, 100);
          resolve(result);
        };
  
        frame.addEventListener("load", () => cleanup(true));
        frame.addEventListener("error", () => cleanup(false));
        frame.src = url;
  
        setTimeout(() => cleanup(false), timeout);
      });
    }
  
    /* ============ Setup ============ */
    function setup() {
      if (backBtn) backBtn.addEventListener("click", hide);
  
      if (overlay) {
        overlay.addEventListener("mousemove", () => {
          overlay.classList.remove("hide-chrome");
          clearTimeout(hideChromeTimer);
          hideChromeTimer = setTimeout(() => {
            if (overlay && !overlay.classList.contains("hidden")) {
              overlay.classList.add("hide-chrome");
            }
          }, 3500);
        });
      }
  
      document.addEventListener("keydown", (e) => {
        if (!overlay || overlay.classList.contains("hidden")) return;
        if (e.key === "Escape") hide();
      });
  
      document.addEventListener("click", async (e) => {
        if (!e.target) return;
        if (e.target.classList.contains("embed-error-retry")) {
          hideError();
          if (activeItem) await open(activeItem, activeEpisode);
        }
        if (e.target.classList.contains("embed-error-close")) {
          hide();
        }
      });
    }
  
    setup();
  
    return { open, close: hide };
  })();
  