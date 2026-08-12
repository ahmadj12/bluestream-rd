/* =====================================================
   BlueStream — جلسة الحساب وعميل Pages Functions
   ===================================================== */

const AUTH = (() => {
  const CACHE_KEY = "bluestream:account-cache:v1";
  const CLIENT_HEADER = "X-BlueStream-Client";
  let initPromise = null;
  let refreshPromise = null;
  let state = {
    status: "loading",
    user: null,
    profiles: [],
    activeProfileId: null,
  };

  class AuthError extends Error {
    constructor(message, status = 0, code = "request_failed", details = null) {
      super(message);
      this.name = "AuthError";
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  function cloneState() {
    return {
      status: state.status,
      user: state.user ? { ...state.user } : null,
      profiles: state.profiles.map((profile) => ({
        ...profile,
        avatar: profile.avatar ? { ...profile.avatar } : null,
      })),
      activeProfileId: state.activeProfileId,
    };
  }

  function dispatch() {
    document.dispatchEvent(
      new CustomEvent("auth-changed", { detail: cloneState() })
    );
  }

  function readCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      return cached && cached.user && Array.isArray(cached.profiles)
        ? cached
        : null;
    } catch {
      return null;
    }
  }

  function writeCache(account) {
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({
          user: account.user,
          profiles: account.profiles || [],
          activeProfileId: account.activeProfileId || null,
        })
      );
    } catch {
      // يبقى الحساب عاملاً في الذاكرة إذا كان localStorage غير متاح.
    }
  }

  function clearCache() {
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      // ignore
    }
  }

  function applyAccount(account, status = "authenticated") {
    state = {
      status,
      user: account?.user || null,
      profiles: Array.isArray(account?.profiles) ? account.profiles : [],
      activeProfileId: account?.activeProfileId || null,
    };
    if (state.user) writeCache(state);
    dispatch();
    return cloneState();
  }

  function becomeAnonymous() {
    clearCache();
    state = {
      status: "anonymous",
      user: null,
      profiles: [],
      activeProfileId: null,
    };
    dispatch();
    return cloneState();
  }

  function becomeRestricted(status, details = {}) {
    clearCache();
    state = {
      status,
      user: {
        id: details.userId || null,
        email: details.email || "",
        role: "user",
        status: "suspended",
        entitlement: { status: "suspended" },
      },
      profiles: [],
      activeProfileId: null,
    };
    dispatch();
    return cloneState();
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set(CLIENT_HEADER, "web");
    if (
      options.body !== undefined &&
      !(options.body instanceof FormData) &&
      !headers.has("Content-Type")
    ) {
      headers.set("Content-Type", "application/json");
    }

    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers,
        credentials: "same-origin",
      });
    } catch (error) {
      throw new AuthError(
        "تعذّر الاتصال بخدمة الحسابات. تحقق من الإنترنت أو من تشغيل Caddy وCloudflare Tunnel ثم أعد المحاولة.",
        0,
        "network_error",
        error?.message
      );
    }

    const contentType = response.headers.get("content-type") || "";
    let payload = null;
    if (contentType.includes("application/json")) {
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
    }

    if (!payload) {
      throw new AuthError(
        response.status >= 500
          ? "خدمة الحسابات غير متاحة مؤقتاً. تحقق من Caddy وCloudflare Tunnel ثم أعد المحاولة."
          : "وصل رد غير صالح من خدمة الحسابات. تأكد أن مسار /api موجّه إلى Cloudflare Pages Functions.",
        response.status,
        "backend_unavailable"
      );
    }

    if (!response.ok || payload.ok === false) {
      const error = payload.error || {};
      throw new AuthError(
        error.message || "تعذّر تنفيذ الطلب.",
        response.status,
        error.code || "request_failed",
        error.details || null
      );
    }

    return payload;
  }

  async function init() {
    if (state.status !== "loading") return cloneState();
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const account = await request("/api/auth/session", { method: "GET" });
        return applyAccount(account, "authenticated");
      } catch (error) {
        if (error.status === 401) return becomeAnonymous();
        if (error.code === "account_suspended") {
          return becomeRestricted("suspended", error.details);
        }

        const cached = readCache();
        if (cached) return applyAccount(cached, "offline");
        state.status = "anonymous";
        dispatch();
        return cloneState();
      }
    })();
    return initPromise;
  }

  async function login(email, password) {
    try {
      const account = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      return applyAccount(account, "authenticated");
    } catch (error) {
      if (error.code === "account_suspended") {
        becomeRestricted("suspended", {
          ...(error.details || {}),
          email,
        });
      }
      throw error;
    }
  }

  async function register(email, password, profileName, activationCode) {
    const account = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, profileName, activationCode }),
    });
    return applyAccount(account, "authenticated");
  }

  async function redeem(activationCode) {
    const account = await request("/api/subscription/redeem", {
      method: "POST",
      body: JSON.stringify({ activationCode }),
    });
    return applyAccount(account, "authenticated");
  }

  async function logout() {
    try {
      if (state.status === "authenticated") {
        await request("/api/auth/logout", {
          method: "POST",
          body: "{}",
        });
      }
    } finally {
      becomeAnonymous();
    }
  }

  async function refreshSession() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const account = await request("/api/auth/session", { method: "GET" });
        return applyAccount(account, "authenticated");
      } catch (error) {
        if (error.status === 401) return becomeAnonymous();
        if (error.code === "account_suspended") {
          return becomeRestricted("suspended", error.details);
        }
        if (state.user) {
          state.status = "offline";
          dispatch();
        }
        return cloneState();
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  function updateAccount(account) {
    return applyAccount(
      {
        user: account.user || state.user,
        profiles: account.profiles || state.profiles,
        activeProfileId:
          account.activeProfileId === undefined
            ? state.activeProfileId
            : account.activeProfileId,
      },
      state.status
    );
  }

  function expireSession() {
    becomeAnonymous();
  }

  window.addEventListener("online", () => {
    if (state.status === "offline" && state.user) {
      refreshSession();
    }
  });

  return {
    AuthError,
    init,
    login,
    register,
    redeem,
    logout,
    refreshSession,
    request,
    updateAccount,
    expireSession,
    getState: cloneState,
    isAuthenticated: () => state.status === "authenticated",
    hasAccount: () => !!state.user,
  };
})();
