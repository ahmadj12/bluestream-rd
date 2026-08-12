/* =====================================================
   BlueStream — واجهة الحساب والملفات الشخصية
   ===================================================== */

const PROFILE_UI = (() => {
  const byId = (id) => document.getElementById(id);
  const trigger = byId("profile-trigger");
  const dropdown = byId("profile-dropdown");
  const switcher = byId("profile-switcher");
  const profilesModal = byId("profiles-modal");
  const managerGrid = byId("profiles-manager-grid");
  const editor = byId("profile-editor");
  const authModal = byId("auth-modal");

  let initialized = false;
  let editingId = null;
  let selectedPreset = "blue";
  let selectedFile = null;
  let previewUrl = null;
  let authMode = "login";

  function setHidden(element, hidden) {
    if (element) element.classList.toggle("hidden", hidden);
  }

  function setAvatar(element, profile, overrideUrl = null) {
    if (!element) return;
    for (const preset of PROFILES.PRESETS) {
      element.classList.remove(`avatar-${preset}`);
    }
    element.replaceChildren();
    const avatar = profile?.avatar || { type: "preset", value: "blue" };
    const url = overrideUrl || avatar.url;

    if (avatar.type === "upload" && url) {
      const image = document.createElement("img");
      image.src = url;
      image.alt = "";
      image.addEventListener("error", () => {
        element.replaceChildren();
        element.classList.remove("avatar-upload");
        element.classList.add("avatar-blue");
        element.textContent =
          String(profile?.name || "م").trim().charAt(0) || "م";
      });
      element.appendChild(image);
      element.classList.add("avatar-upload");
      return;
    }

    element.classList.remove("avatar-upload");
    const preset = PROFILES.PRESETS.includes(avatar.value)
      ? avatar.value
      : "blue";
    element.classList.add(`avatar-${preset}`);
    element.textContent = String(profile?.name || "م").trim().charAt(0) || "م";
  }

  function closeDropdown() {
    setHidden(dropdown, true);
    trigger?.setAttribute("aria-expanded", "false");
  }

  function toggleDropdown() {
    const willOpen = dropdown?.classList.contains("hidden");
    setHidden(dropdown, !willOpen);
    trigger?.setAttribute("aria-expanded", String(Boolean(willOpen)));
  }

  function authStatusLabel() {
    const state = AUTH.getState();
    if (state.user?.entitlement?.status === "expired") return "الاشتراك منتهي";
    if (state.status === "suspended") return "الحساب موقوف";
    if (state.status === "authenticated") return state.user?.email || "متزامن";
    if (state.user) return "غير متصل · التغييرات محفوظة محلياً";
    return "محفوظ على هذا الجهاز";
  }

  function renderSwitcher() {
    if (!switcher) return;
    switcher.replaceChildren();
    const active = PROFILES.getActive();

    for (const profile of PROFILES.getAll()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "profile-switch-item";
      button.classList.toggle("active", profile.id === active?.id);
      button.setAttribute("role", "menuitem");

      const avatar = document.createElement("span");
      avatar.className = "profile-avatar profile-avatar-md";
      setAvatar(avatar, profile);
      const name = document.createElement("span");
      name.className = "profile-switch-name";
      name.textContent = profile.name;
      const check = document.createElement("span");
      check.className = "profile-switch-check";
      check.textContent = profile.id === active?.id ? "✓" : "";
      button.append(avatar, name, check);

      button.addEventListener("click", async () => {
        closeDropdown();
        try {
          await PROFILES.activate(profile.id);
          showToast(`تم التبديل إلى ${profile.name}`);
        } catch (error) {
          showToast(error.message || "تعذّر تبديل الملف.", "error");
        }
      });
      switcher.appendChild(button);
    }
  }

  function renderHeader() {
    const active = PROFILES.getActive();
    const avatar = byId("header-profile-avatar");
    const name = byId("header-profile-name");
    if (active) {
      setAvatar(avatar, active);
      if (name) name.textContent = active.name;
    }

    const accountLabel = byId("profile-account-label");
    if (accountLabel) accountLabel.textContent = authStatusLabel();

    const authAction = byId("profile-auth-action");
    if (authAction) {
      authAction.textContent = AUTH.hasAccount()
        ? AUTH.isAuthenticated()
          ? "تسجيل الخروج"
          : "الخروج من الحساب المحلي"
        : "تسجيل الدخول والمزامنة";
    }
    renderSwitcher();
  }

  function renderManager() {
    if (!managerGrid) return;
    managerGrid.replaceChildren();
    const active = PROFILES.getActive();

    for (const profile of PROFILES.getAll()) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "profile-manager-card";
      card.classList.toggle("active", profile.id === active?.id);

      const avatar = document.createElement("span");
      avatar.className = "profile-avatar profile-avatar-lg";
      setAvatar(avatar, profile);
      const name = document.createElement("strong");
      name.textContent = profile.name;
      const status = document.createElement("span");
      status.textContent =
        profile.id === active?.id ? "الملف النشط" : "تعديل الملف";
      card.append(avatar, name, status);
      card.addEventListener("click", () => openEditor(profile.id));
      managerGrid.appendChild(card);
    }

    const addButton = byId("add-profile");
    const atLimit = PROFILES.getAll().length >= PROFILES.MAX_PROFILES;
    if (addButton) {
      addButton.disabled = atLimit;
      addButton.innerHTML = atLimit
        ? "<span>✓</span> وصلت إلى 10 ملفات"
        : "<span>＋</span> إضافة ملف جديد";
    }
  }

  function clearPreviewUrl() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }

  function renderPresetButtons() {
    const container = byId("avatar-presets");
    if (!container) return;
    container.replaceChildren();
    for (const preset of PROFILES.PRESETS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "avatar-preset-button";
      button.classList.toggle("selected", selectedPreset === preset);
      button.dataset.preset = preset;
      button.setAttribute("aria-label", `اختيار الصورة ${preset}`);
      const avatar = document.createElement("span");
      avatar.className = "profile-avatar profile-avatar-md";
      setAvatar(avatar, {
        name: "م",
        avatar: { type: "preset", value: preset },
      });
      button.appendChild(avatar);
      button.addEventListener("click", () => {
        selectedPreset = preset;
        selectedFile = null;
        clearPreviewUrl();
        renderPresetButtons();
        updateEditorPreview();
      });
      container.appendChild(button);
    }
  }

  function updateEditorPreview() {
    const preview = byId("profile-editor-avatar");
    const current = PROFILES.getAll().find((profile) => profile.id === editingId);
    const name = byId("profile-name-input")?.value || current?.name || "ملف";

    if (previewUrl) {
      setAvatar(
        preview,
        { name, avatar: { type: "upload", url: previewUrl } },
        previewUrl
      );
    } else if (selectedPreset) {
      setAvatar(preview, {
        name,
        avatar: { type: "preset", value: selectedPreset },
      });
    } else {
      setAvatar(preview, current || {
        name,
        avatar: { type: "preset", value: "blue" },
      });
    }
  }

  function showEditorError(message = "") {
    const error = byId("profile-editor-error");
    if (!error) return;
    error.textContent = message;
    setHidden(error, !message);
  }

  function openEditor(profileId = null) {
    editingId = profileId;
    selectedFile = null;
    clearPreviewUrl();
    showEditorError("");
    const profile = PROFILES.getAll().find((entry) => entry.id === profileId);
    selectedPreset =
      profile?.avatar?.type === "preset"
        ? profile.avatar.value || "blue"
        : profile
          ? null
          : "blue";

    const title = byId("profile-editor-title");
    if (title) title.textContent = profile ? "تعديل الملف" : "ملف جديد";
    const nameInput = byId("profile-name-input");
    if (nameInput) {
      nameInput.value = profile?.name || "";
      queueMicrotask(() => nameInput.focus());
    }
    setHidden(byId("delete-profile"), !profile);
    setHidden(editor, false);
    renderPresetButtons();
    updateEditorPreview();
    editor?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closeEditor() {
    editingId = null;
    selectedFile = null;
    selectedPreset = "blue";
    clearPreviewUrl();
    showEditorError("");
    setHidden(editor, true);
  }

  function openProfilesModal() {
    closeDropdown();
    closeEditor();
    renderManager();
    setHidden(profilesModal, false);
    profilesModal?.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeProfilesModal() {
    closeEditor();
    setHidden(profilesModal, true);
    profilesModal?.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  function setAuthMode(mode) {
    authMode = mode === "register" ? "register" : "login";
    document.querySelectorAll(".auth-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.authMode === authMode);
    });
    setHidden(byId("register-name-field"), authMode !== "register");
    setHidden(byId("register-activation-field"), authMode !== "register");
    const activationCode = byId("auth-activation-code");
    if (activationCode) activationCode.required = authMode === "register";
    const password = byId("auth-password");
    if (password) {
      password.autocomplete =
        authMode === "register" ? "new-password" : "current-password";
    }
    const title = byId("auth-title");
    if (title) {
      title.textContent =
        authMode === "register" ? "أنشئ حسابك" : "مزامنة ملفاتك";
    }
    const submit = byId("auth-submit");
    if (submit) {
      submit.textContent =
        authMode === "register" ? "إنشاء الحساب" : "تسجيل الدخول";
    }
    showAuthError("");
  }

  function showAuthError(message = "") {
    const error = byId("auth-error");
    if (!error) return;
    error.textContent = message;
    setHidden(error, !message);
  }

  function openAuthModal(mode = "login") {
    closeDropdown();
    setAuthMode(mode);
    setHidden(authModal, false);
    authModal?.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    queueMicrotask(() => byId("auth-email")?.focus());
  }

  function closeAuthModal() {
    setHidden(authModal, true);
    authModal?.setAttribute("aria-hidden", "true");
    showAuthError("");
    document.body.style.overflow = "";
  }

  function showToast(message, type = "success") {
    const region = byId("toast-region");
    if (!region || !message) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    region.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  }

  async function handleProfileSubmit(event) {
    event.preventDefault();
    const name = byId("profile-name-input")?.value || "";
    const saveButton = byId("save-profile");
    if (saveButton) saveButton.disabled = true;
    showEditorError("");

    try {
      let profile;
      if (editingId) {
        const changes = { name };
        if (selectedPreset) changes.avatar = selectedPreset;
        profile = await PROFILES.update(editingId, changes);
      } else {
        profile = await PROFILES.create(name, selectedPreset || "blue");
      }

      if (selectedFile) {
        profile = await PROFILES.uploadAvatar(profile.id, selectedFile);
      }
      renderHeader();
      renderManager();
      closeEditor();
      showToast(`تم حفظ ملف ${profile.name}`);
    } catch (error) {
      showEditorError(error.message || "تعذّر حفظ الملف.");
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  }

  async function handleDeleteProfile() {
    if (!editingId) return;
    const profile = PROFILES.getAll().find((entry) => entry.id === editingId);
    if (
      !profile ||
      !window.confirm(`هل تريد حذف ملف «${profile.name}» وبياناته؟`)
    ) {
      return;
    }
    const button = byId("delete-profile");
    if (button) button.disabled = true;
    try {
      await PROFILES.remove(editingId);
      renderHeader();
      renderManager();
      closeEditor();
      showToast("تم حذف الملف.");
    } catch (error) {
      showEditorError(error.message || "تعذّر حذف الملف.");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    const email = byId("auth-email")?.value || "";
    const password = byId("auth-password")?.value || "";
    const profileName = byId("auth-profile-name")?.value || "الملف الرئيسي";
    const activationCode = byId("auth-activation-code")?.value || "";
    const submit = byId("auth-submit");
    if (submit) submit.disabled = true;
    showAuthError("");

    try {
      if (authMode === "register") {
        await AUTH.register(email, password, profileName, activationCode);
      } else {
        await AUTH.login(email, password);
      }
      await PROFILES.refreshFromAuth();
      closeAuthModal();
      renderHeader();
      const entitlement = AUTH.getState().user?.entitlement?.status;
      if (entitlement === "active") {
        PROFILE_SYNC.schedule(PROFILES.getActive()?.id, 100);
      }
      showToast(
        entitlement === "expired"
          ? "انتهى الاشتراك. أدخل رمز تفعيل جديداً للمتابعة."
          : authMode === "register"
          ? "تم إنشاء الحساب وبدء المزامنة."
          : "تم تسجيل الدخول واستعادة ملفاتك."
      );
    } catch (error) {
      if (error.code === "account_suspended") {
        closeAuthModal();
        showToast(error.message, "error");
      } else {
        showAuthError(error.message || "تعذّر تسجيل الدخول.");
      }
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function handleAuthAction() {
    closeDropdown();
    if (!AUTH.hasAccount()) {
      openAuthModal();
      return;
    }

    try {
      if (AUTH.isAuthenticated()) {
        await PROFILE_SYNC.syncNow();
      }
      await AUTH.logout();
      await PROFILES.refreshFromAuth();
      renderHeader();
      showToast("تم تسجيل الخروج.");
    } catch (error) {
      showToast(error.message || "تعذّر تسجيل الخروج.", "error");
    }
  }

  function updateSyncState(detail) {
    const dot = byId("profile-sync-dot");
    if (!dot) return;
    dot.className = `sync-dot sync-${detail?.status || "idle"}`;
    const labels = {
      syncing: "جارِ المزامنة",
      synced: "تمت المزامنة",
      pending: "تغييرات بانتظار المزامنة",
      offline: "غير متصل",
      error: "ستُعاد المحاولة تلقائياً",
    };
    dot.title = labels[detail?.status] || "محفوظ محلياً";
  }

  function bindEvents() {
    trigger?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleDropdown();
    });
    dropdown?.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", closeDropdown);

    byId("manage-profiles")?.addEventListener("click", openProfilesModal);
    byId("add-profile")?.addEventListener("click", () => openEditor());
    byId("cancel-profile-edit")?.addEventListener("click", closeEditor);
    byId("delete-profile")?.addEventListener("click", handleDeleteProfile);
    editor?.addEventListener("submit", handleProfileSubmit);
    byId("profile-name-input")?.addEventListener("input", updateEditorPreview);
    byId("choose-profile-avatar")?.addEventListener("click", () =>
      byId("profile-avatar-file")?.click()
    );
    byId("profile-avatar-file")?.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      selectedFile = file;
      selectedPreset = null;
      clearPreviewUrl();
      previewUrl = URL.createObjectURL(file);
      renderPresetButtons();
      updateEditorPreview();
    });

    profilesModal?.addEventListener("click", (event) => {
      if (event.target.hasAttribute?.("data-profiles-close")) {
        closeProfilesModal();
      }
    });
    authModal?.addEventListener("click", (event) => {
      if (event.target.hasAttribute?.("data-auth-close")) closeAuthModal();
    });

    document.querySelectorAll(".auth-tab").forEach((tab) => {
      tab.addEventListener("click", () => setAuthMode(tab.dataset.authMode));
    });
    byId("auth-form")?.addEventListener("submit", handleAuthSubmit);
    byId("profile-auth-action")?.addEventListener("click", handleAuthAction);

    dropdown?.querySelectorAll("[data-library-view]").forEach((button) => {
      button.addEventListener("click", () => {
        closeDropdown();
        document.dispatchEvent(
          new CustomEvent("profile-library-requested", {
            detail: { view: button.dataset.libraryView },
          })
        );
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      closeDropdown();
      if (!profilesModal?.classList.contains("hidden")) closeProfilesModal();
      if (!authModal?.classList.contains("hidden")) closeAuthModal();
    });

    document.addEventListener("profiles-changed", () => {
      renderHeader();
      if (!profilesModal?.classList.contains("hidden")) renderManager();
    });
    document.addEventListener("auth-changed", renderHeader);
    document.addEventListener("profile-sync-status", (event) =>
      updateSyncState(event.detail)
    );
  }

  async function init() {
    if (initialized) return;
    initialized = true;
    renderHeader();
    renderManager();
    bindEvents();
    updateSyncState({
      status: AUTH.isAuthenticated()
        ? PROFILE_SYNC.pendingCount()
          ? "pending"
          : "synced"
        : "offline",
    });
  }

  return {
    init,
    renderHeader,
    setAvatar,
    showToast,
    openProfilesModal,
    openAuthModal,
    closeAuthModal,
    closeDropdown,
  };
})();
