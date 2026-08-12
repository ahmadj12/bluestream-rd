/* =====================================================
   BlueStream — الملفات الشخصية (محلي أولاً + سحابي)
   ===================================================== */

const PROFILES = (() => {
  const REGISTRY_PREFIX = "bluestream:profiles:v1:";
  const ACTIVE_PREFIX = "bluestream:active-profile:v1:";
  const MAX_PROFILES = 10;
  const PRESETS = Object.freeze([
    "blue",
    "violet",
    "gold",
    "rose",
    "cyan",
    "lime",
    "orange",
    "slate",
    "indigo",
    "red",
    "teal",
    "amber",
  ]);

  let initialized = false;
  let scope = "guest";
  let profiles = [];
  let activeProfileId = null;
  let authListenerBound = false;

  function safeParse(value, fallback) {
    try {
      const parsed = JSON.parse(value);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function localProfile(name = "الملف الرئيسي", avatar = "blue") {
    const now = Date.now();
    return {
      id: `local-${crypto.randomUUID()}`,
      name,
      avatar: { type: "preset", value: avatar, url: null },
      sortOrder: profiles.length,
      createdAt: now,
      updatedAt: now,
    };
  }

  function registryKey() {
    return `${REGISTRY_PREFIX}${scope}`;
  }

  function activeKey() {
    return `${ACTIVE_PREFIX}${scope}`;
  }

  function cloneProfile(profile) {
    return {
      ...profile,
      avatar: profile.avatar ? { ...profile.avatar } : null,
    };
  }

  function normalizeProfile(profile, index = 0) {
    if (!profile || !profile.id) return null;
    const avatar = profile.avatar || {};
    return {
      id: String(profile.id),
      name: String(profile.name || `ملف ${index + 1}`).slice(0, 30),
      avatar: {
        type: avatar.type === "upload" ? "upload" : "preset",
        value: avatar.type === "upload" ? null : avatar.value || "blue",
        url: avatar.url || null,
      },
      sortOrder: Number(profile.sortOrder ?? index),
      createdAt: Number(profile.createdAt || Date.now()),
      updatedAt: Number(profile.updatedAt || Date.now()),
    };
  }

  function persistLocalRegistry() {
    try {
      localStorage.setItem(registryKey(), JSON.stringify(profiles));
      localStorage.setItem(activeKey(), activeProfileId || "");
    } catch (error) {
      console.warn("PROFILES: تعذّر حفظ الملفات محلياً:", error);
    }
  }

  function dispatchProfileEvents(previousId = null) {
    document.dispatchEvent(
      new CustomEvent("profiles-changed", {
        detail: {
          profiles: getAll(),
          activeProfile: getActive(),
          scope,
        },
      })
    );
    if (previousId !== activeProfileId) {
      document.dispatchEvent(
        new CustomEvent("profile-changed", {
          detail: {
            previousProfileId: previousId,
            profile: getActive(),
            scope,
          },
        })
      );
    }
  }

  function loadGuestRegistry() {
    const stored = safeParse(localStorage.getItem(registryKey()) || "[]", []);
    profiles = Array.isArray(stored)
      ? stored.map(normalizeProfile).filter(Boolean).slice(0, MAX_PROFILES)
      : [];
    if (!profiles.length) profiles = [localProfile()];

    const preferred = localStorage.getItem(activeKey());
    activeProfileId = profiles.some((profile) => profile.id === preferred)
      ? preferred
      : profiles[0].id;
    persistLocalRegistry();
  }

  function applyAuthState(authState, notify = true) {
    const previousId = activeProfileId;
    if (authState?.user && Array.isArray(authState.profiles)) {
      scope = `user:${authState.user.id}`;
      profiles = authState.profiles
        .map(normalizeProfile)
        .filter(Boolean)
        .slice(0, MAX_PROFILES);
      if (!profiles.length) {
        profiles = [localProfile()];
      }
      const serverActiveId = profiles.some(
        (profile) => profile.id === authState.activeProfileId
      )
        ? authState.activeProfileId
        : profiles[0].id;
      let locallyPreferred = null;
      try {
        locallyPreferred = localStorage.getItem(activeKey());
      } catch {
        // ignore
      }
      activeProfileId = profiles.some(
        (profile) => profile.id === locallyPreferred
      )
        ? locallyPreferred
        : serverActiveId;
      persistLocalRegistry();
      if (
        authState.status === "authenticated" &&
        activeProfileId !== serverActiveId
      ) {
        const preferredId = activeProfileId;
        queueMicrotask(() => {
          AUTH.request(
            `/api/profiles/${encodeURIComponent(preferredId)}/activate`,
            { method: "POST", body: "{}" }
          ).catch((error) => {
            if (error.status === 401) AUTH.expireSession();
          });
        });
      }
    } else {
      scope = "guest";
      loadGuestRegistry();
    }
    if (notify) dispatchProfileEvents(previousId);
  }

  async function init() {
    if (initialized) return getActive();
    const authState = await AUTH.init();
    applyAuthState(authState, false);
    initialized = true;

    if (!authListenerBound) {
      authListenerBound = true;
      document.addEventListener("auth-changed", (event) => {
        if (!initialized) return;
        applyAuthState(event.detail);
      });
    }
    dispatchProfileEvents(null);
    return getActive();
  }

  function getAll() {
    return profiles
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map(cloneProfile);
  }

  function getActive() {
    const profile =
      profiles.find((entry) => entry.id === activeProfileId) || profiles[0];
    return profile ? cloneProfile(profile) : null;
  }

  function replaceProfile(updated) {
    const normalized = normalizeProfile(updated);
    const index = profiles.findIndex((profile) => profile.id === normalized.id);
    if (index >= 0) profiles[index] = normalized;
    else profiles.push(normalized);
    persistLocalRegistry();
    dispatchProfileEvents(activeProfileId);
    return cloneProfile(normalized);
  }

  function cleanName(value) {
    const name = String(value || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/gu, " ");
    if (!name || name.length > 30) {
      throw new Error("اسم الملف يجب أن يكون بين 1 و30 حرفاً.");
    }
    return name;
  }

  function cleanPreset(value) {
    const preset = String(value || "blue");
    if (!PRESETS.includes(preset)) {
      throw new Error("صورة الملف المختارة غير صالحة.");
    }
    return preset;
  }

  function requireProfileManagementConnection() {
    if (AUTH.hasAccount() && !AUTH.isAuthenticated()) {
      throw new Error(
        "إدارة الملفات السحابية تحتاج اتصالاً بالإنترنت. يمكنك متابعة المشاهدة والتبديل بين الملفات دون اتصال."
      );
    }
  }

  async function create(name, avatar = "blue") {
    requireProfileManagementConnection();
    if (profiles.length >= MAX_PROFILES) {
      throw new Error("وصلت إلى الحد الأقصى: 10 ملفات شخصية.");
    }
    const clean = cleanName(name);
    const preset = cleanPreset(avatar);

    if (AUTH.isAuthenticated()) {
      const response = await AUTH.request("/api/profiles", {
        method: "POST",
        body: JSON.stringify({ name: clean, avatar: preset }),
      });
      profiles.push(normalizeProfile(response.profile, profiles.length));
      activeProfileId = response.activeProfileId || activeProfileId;
      AUTH.updateAccount({ profiles: getAll(), activeProfileId });
      persistLocalRegistry();
      dispatchProfileEvents(activeProfileId);
      return cloneProfile(response.profile);
    }

    const profile = localProfile(clean, preset);
    profiles.push(profile);
    persistLocalRegistry();
    dispatchProfileEvents(activeProfileId);
    return cloneProfile(profile);
  }

  async function update(profileId, changes) {
    requireProfileManagementConnection();
    const current = profiles.find((profile) => profile.id === profileId);
    if (!current) throw new Error("الملف الشخصي غير موجود.");
    const payload = {};
    if (Object.hasOwn(changes, "name")) payload.name = cleanName(changes.name);
    if (Object.hasOwn(changes, "avatar")) {
      payload.avatar = cleanPreset(changes.avatar);
    }

    if (AUTH.isAuthenticated()) {
      const response = await AUTH.request(
        `/api/profiles/${encodeURIComponent(profileId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(payload),
        }
      );
      const profile = replaceProfile(response.profile);
      AUTH.updateAccount({ profiles: getAll() });
      return profile;
    }

    const updated = {
      ...current,
      ...(payload.name ? { name: payload.name } : {}),
      ...(payload.avatar
        ? {
            avatar: {
              type: "preset",
              value: payload.avatar,
              url: null,
            },
          }
        : {}),
      updatedAt: Date.now(),
    };
    return replaceProfile(updated);
  }

  async function remove(profileId) {
    requireProfileManagementConnection();
    if (profiles.length <= 1) {
      throw new Error("لا يمكن حذف آخر ملف شخصي.");
    }
    const current = profiles.find((profile) => profile.id === profileId);
    if (!current) throw new Error("الملف الشخصي غير موجود.");

    let nextActiveId =
      activeProfileId === profileId
        ? profiles.find((profile) => profile.id !== profileId)?.id
        : activeProfileId;

    if (AUTH.isAuthenticated()) {
      const response = await AUTH.request(
        `/api/profiles/${encodeURIComponent(profileId)}`,
        {
          method: "DELETE",
          body: "{}",
        }
      );
      nextActiveId = response.activeProfileId || nextActiveId;
    }

    const previousId = activeProfileId;
    profiles = profiles
      .filter((profile) => profile.id !== profileId)
      .map((profile, index) => ({ ...profile, sortOrder: index }));
    activeProfileId = nextActiveId || profiles[0].id;
    persistLocalRegistry();
    if (typeof PROFILE_STORE !== "undefined") {
      PROFILE_STORE.discardProfile(profileId);
    }
    if (AUTH.hasAccount()) {
      AUTH.updateAccount({ profiles: getAll(), activeProfileId });
    }
    dispatchProfileEvents(previousId);
    if (typeof PROFILE_SYNC !== "undefined") {
      PROFILE_SYNC.discardProfile(profileId);
    }
  }

  async function activate(profileId) {
    if (profileId === activeProfileId) return getActive();
    const profile = profiles.find((entry) => entry.id === profileId);
    if (!profile) throw new Error("الملف الشخصي غير موجود.");

    const previousId = activeProfileId;
    activeProfileId = profileId;
    persistLocalRegistry();
    if (AUTH.hasAccount()) {
      AUTH.updateAccount({ activeProfileId });
    }
    dispatchProfileEvents(previousId);

    if (AUTH.isAuthenticated()) {
      try {
        await AUTH.request(
          `/api/profiles/${encodeURIComponent(profileId)}/activate`,
          { method: "POST", body: "{}" }
        );
      } catch (error) {
        if (error.status === 401) AUTH.expireSession();
        throw error;
      }
    }
    return getActive();
  }

  async function imageSource(file) {
    if (!(file instanceof File) || !file.type.startsWith("image/")) {
      throw new Error("اختر ملف صورة صالحاً.");
    }
    if (file.size > 8 * 1024 * 1024) {
      throw new Error("حجم الصورة الأصلية يجب ألا يتجاوز 8MB.");
    }

    if (typeof createImageBitmap === "function") {
      return createImageBitmap(file);
    }
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("تعذّر قراءة الصورة."));
      };
      image.src = url;
    });
  }

  async function compressAvatar(file) {
    const image = await imageSource(file);
    const width = image.width || image.naturalWidth;
    const height = image.height || image.naturalHeight;
    const side = Math.min(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#17171C";
    context.fillRect(0, 0, 256, 256);
    context.drawImage(
      image,
      Math.max(0, (width - side) / 2),
      Math.max(0, (height - side) / 2),
      side,
      side,
      0,
      0,
      256,
      256
    );
    if (typeof image.close === "function") image.close();

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.84)
    );
    if (!blob || blob.size > 512 * 1024) {
      throw new Error("تعذّر ضغط الصورة إلى الحجم المطلوب.");
    }
    return new File([blob], "avatar.webp", { type: "image/webp" });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("تعذّر حفظ الصورة محلياً."));
      reader.readAsDataURL(blob);
    });
  }

  async function uploadAvatar(profileId, originalFile) {
    requireProfileManagementConnection();
    const profile = profiles.find((entry) => entry.id === profileId);
    if (!profile) throw new Error("الملف الشخصي غير موجود.");
    const compressed = await compressAvatar(originalFile);

    if (AUTH.isAuthenticated()) {
      const formData = new FormData();
      formData.append("avatar", compressed);
      const response = await AUTH.request(
        `/api/profiles/${encodeURIComponent(profileId)}/avatar`,
        { method: "POST", body: formData }
      );
      const updated = replaceProfile(response.profile);
      AUTH.updateAccount({ profiles: getAll() });
      return updated;
    }

    const updated = {
      ...profile,
      avatar: {
        type: "upload",
        value: null,
        url: await blobToDataUrl(compressed),
      },
      updatedAt: Date.now(),
    };
    return replaceProfile(updated);
  }

  async function refreshFromAuth() {
    applyAuthState(AUTH.getState());
    return getActive();
  }

  return {
    MAX_PROFILES,
    PRESETS,
    init,
    refreshFromAuth,
    getAll,
    getActive,
    getScopeKey: () => scope,
    create,
    update,
    remove,
    activate,
    uploadAvatar,
    replaceProfile,
    isCloudBacked: () => AUTH.isAuthenticated(),
  };
})();
