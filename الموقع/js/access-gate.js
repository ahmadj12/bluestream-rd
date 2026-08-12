/* =====================================================
   BlueStream — بوابة إلزامية للحساب واختيار الملف
   ===================================================== */

const ACCESS_GATE = (() => {
  const byId = (id) => document.getElementById(id);
  const gate = byId("access-gate");
  const states = [
    "gate-loading",
    "gate-auth",
    "gate-profiles",
    "gate-renewal",
    "gate-suspended",
    "gate-offline",
  ];

  let initialized = false;
  let grantedUserId = null;
  let accessPromise = null;
  let resolveAccess = null;
  let busy = false;

  function showState(id) {
    for (const stateId of states) {
      byId(stateId)?.classList.toggle("hidden", stateId !== id);
    }
  }

  function lock() {
    document.body.classList.add("app-locked");
    gate?.classList.remove("hidden");
  }

  function unlock(userId) {
    grantedUserId = userId;
    gate?.classList.add("hidden");
    document.body.classList.remove("app-locked");
    resolveAccess?.(PROFILES.getActive());
    resolveAccess = null;
    document.dispatchEvent(
      new CustomEvent("access-granted", {
        detail: { userId, profile: PROFILES.getActive() },
      })
    );
  }

  function revokeAccess() {
    grantedUserId = null;
    lock();
    try {
      if (typeof EmbedPlayer !== "undefined") EmbedPlayer.close();
      if (typeof Player !== "undefined") Player.close();
    } catch {
      // البوابة تبقى أولوية حتى لو تعذّر إغلاق مشغل قديم.
    }
  }

  function renderProfiles() {
    const list = byId("gate-profile-list");
    if (!list) return;
    list.replaceChildren();
    const active = PROFILES.getActive();

    for (const profile of PROFILES.getAll()) {
      const card = document.createElement("div");
      card.className = "gate-profile-card";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "gate-profile-select";
      button.classList.toggle("active", profile.id === active?.id);
      button.setAttribute("aria-label", `الدخول بملف ${profile.name}`);

      const avatar = document.createElement("span");
      avatar.className = "profile-avatar";
      PROFILE_UI.setAvatar(avatar, profile);
      const name = document.createElement("strong");
      name.textContent = profile.name;
      const hint = document.createElement("span");
      hint.textContent =
        profile.id === active?.id ? "آخر ملف مستخدم" : "اختيار الملف";
      button.append(avatar, name, hint);

      button.addEventListener("click", async () => {
        if (busy) return;
        busy = true;
        button.disabled = true;
        try {
          await PROFILES.activate(profile.id);
          unlock(AUTH.getState().user?.id);
          PROFILE_SYNC.schedule(profile.id, 100);
        } catch (error) {
          PROFILE_UI.showToast(
            error.message || "تعذّر اختيار الملف.",
            "error"
          );
          button.disabled = false;
        } finally {
          busy = false;
        }
      });

      card.appendChild(button);
      list.appendChild(card);
    }
  }

  function render(authState = AUTH.getState()) {
    const entitlement =
      authState.user?.entitlement?.status ||
      (authState.status === "authenticated" ? "active" : null);
    if (
      grantedUserId &&
      authState.user?.id === grantedUserId &&
      entitlement === "active"
    ) {
      return;
    }
    lock();

    if (authState.status === "loading") {
      showState("gate-loading");
      return;
    }

    if (
      authState.status === "suspended" ||
      authState.user?.status === "suspended" ||
      entitlement === "suspended"
    ) {
      const email = byId("gate-suspended-email");
      if (email) email.textContent = authState.user?.email || "";
      showState("gate-suspended");
      return;
    }

    if (
      authState.status === "authenticated" &&
      authState.user &&
      entitlement === "expired"
    ) {
      const email = byId("gate-renewal-email");
      if (email) email.textContent = authState.user.email || "";
      showState("gate-renewal");
      return;
    }

    if (
      authState.status === "authenticated" &&
      authState.user &&
      entitlement === "active"
    ) {
      const email = byId("gate-account-email");
      if (email) email.textContent = authState.user.email || "";
      renderProfiles();
      showState("gate-profiles");
      return;
    }

    if (authState.user || authState.status === "offline") {
      const message = byId("gate-offline-message");
      if (message) {
        message.textContent = navigator.onLine
          ? "خدمة الحسابات غير متاحة حالياً. تحقق من تشغيل Caddy وCloudflare Tunnel ومن صحة مسار /api ثم أعد المحاولة."
          : "الجهاز غير متصل بالإنترنت.";
      }
      showState("gate-offline");
      return;
    }

    showState("gate-auth");
  }

  async function logout() {
    if (busy) return;
    busy = true;
    try {
      await AUTH.logout();
      await PROFILES.refreshFromAuth();
      revokeAccess();
      render(AUTH.getState());
    } catch (error) {
      PROFILE_UI.showToast(error.message || "تعذّر تسجيل الخروج.", "error");
    } finally {
      busy = false;
    }
  }

  async function redeem(event) {
    event.preventDefault();
    if (busy) return;
    const code = byId("gate-renewal-code")?.value || "";
    const submit = byId("gate-renewal-submit");
    const errorElement = byId("gate-renewal-error");
    busy = true;
    if (submit) submit.disabled = true;
    if (errorElement) {
      errorElement.textContent = "";
      errorElement.classList.add("hidden");
    }
    try {
      const state = await AUTH.redeem(code);
      await PROFILES.refreshFromAuth();
      const input = byId("gate-renewal-code");
      if (input) input.value = "";
      PROFILE_UI.showToast("تم تجديد الاشتراك بنجاح.");
      render(state);
    } catch (error) {
      if (errorElement) {
        errorElement.textContent =
          error.message || "تعذّر استخدام رمز التفعيل.";
        errorElement.classList.remove("hidden");
      }
    } finally {
      if (submit) submit.disabled = false;
      busy = false;
    }
  }

  function bindEvents() {
    byId("gate-login")?.addEventListener("click", () =>
      PROFILE_UI.openAuthModal("login")
    );
    byId("gate-register")?.addEventListener("click", () =>
      PROFILE_UI.openAuthModal("register")
    );
    byId("gate-manage-profiles")?.addEventListener(
      "click",
      PROFILE_UI.openProfilesModal
    );
    byId("gate-logout")?.addEventListener("click", logout);
    byId("gate-renewal-form")?.addEventListener("submit", redeem);
    byId("gate-renewal-logout")?.addEventListener("click", logout);
    byId("gate-suspended-logout")?.addEventListener("click", logout);
    byId("gate-offline-logout")?.addEventListener("click", logout);
    byId("gate-retry")?.addEventListener("click", async (event) => {
      if (busy) return;
      busy = true;
      event.currentTarget.disabled = true;
      showState("gate-loading");
      try {
        const state = await AUTH.refreshSession();
        await PROFILES.refreshFromAuth();
        render(state);
      } finally {
        event.currentTarget.disabled = false;
        busy = false;
      }
    });

    document.addEventListener("auth-changed", (event) => {
      const state = event.detail || AUTH.getState();
      if (
        grantedUserId &&
        (state.status !== "authenticated" ||
          state.user?.id !== grantedUserId ||
          state.user?.entitlement?.status === "expired" ||
          state.user?.entitlement?.status === "suspended")
      ) {
        revokeAccess();
      }
      render(state);
    });
    document.addEventListener("profiles-changed", () => {
      if (
        !gate?.classList.contains("hidden") &&
        AUTH.getState().status === "authenticated"
      ) {
        renderProfiles();
      }
    });
  }

  async function init() {
    if (initialized) return accessPromise;
    initialized = true;
    bindEvents();
    accessPromise = new Promise((resolve) => {
      resolveAccess = resolve;
    });
    render(AUTH.getState());
    return accessPromise;
  }

  return { init, isGranted: () => Boolean(grantedUserId) };
})();
