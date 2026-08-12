/* =====================================================
   ahmad says hi — لوحة الإدارة (إعادة كتابة كاملة)
   يبني الواجهة داخل #admin-modal ولا يعتمد على .modal/.btn-info
   ===================================================== */

const ADMIN_UI = (() => {
  const byId = (id) => document.getElementById(id);
  const root = byId("admin-modal");
  const state = {
    initialized: false,
    mounted: false,
    open: false,
    tab: "users",
    usersPage: 1,
    codesPage: 1,
    auditPage: 1,
    createdCodes: [],
    busy: false,
    refs: {},
  };

  const dateFormatter = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = text;
    return node;
  }

  function btn(text, onClick, className = "ash-btn") {
    const node = el("button", className, text);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function field(labelText, control, forId = "") {
    const wrap = el("div", "ash-field");
    const label = el("label", "", labelText);
    if (forId) label.htmlFor = forId;
    wrap.append(label, control);
    return wrap;
  }

  function formatDate(value) {
    const timestamp = Number(value || 0);
    return timestamp ? dateFormatter.format(new Date(timestamp)) : "—";
  }

  function formatPlan(entitlement) {
    if (!entitlement) return "—";
    if (entitlement.isLifetime) return "مدى الحياة";
    const labels = {
      "1_month": "شهر",
      "3_months": "3 أشهر",
      "6_months": "6 أشهر",
      "12_months": "12 شهراً",
    };
    return labels[entitlement.plan] || entitlement.plan || "—";
  }

  function statusLabel(status) {
    return (
      {
        active: "نشط",
        expired: "منتهي",
        suspended: "موقوف",
        available: "متاح",
        used: "مستخدم",
        revoked: "ملغي",
      }[status] || status
    );
  }

  function statusTone(status) {
    if (["active", "available"].includes(status)) return "ok";
    if (["expired", "used"].includes(status)) return "warn";
    if (["suspended", "revoked"].includes(status)) return "bad";
    return "";
  }

  function setError(message = "") {
    const error = state.refs.error;
    if (!error) return;
    error.textContent = message;
    error.classList.toggle("is-visible", Boolean(message));
  }

  function setEmpty(container, message) {
    if (!container) return;
    container.replaceChildren(el("div", "ash-empty", message));
  }

  function setLoading(container, message = "جارِ التحميل...") {
    if (!container) return;
    container.replaceChildren(el("div", "ash-empty", message));
  }

  function renderEntryVisibility(authState = AUTH.getState()) {
    const entry = byId("open-admin");
    const visible =
      authState.status === "authenticated" && authState.user?.role === "admin";
    entry?.classList.toggle("hidden", !visible);
    if (!visible && state.open) close();
  }

  async function api(path, options = {}) {
    try {
      return await AUTH.request(path, options);
    } catch (error) {
      if ([401, 403].includes(error.status) && error.code === "admin_required") {
        close();
      }
      throw error;
    }
  }

  function mountShell() {
    if (!root || state.mounted) return;
    root.replaceChildren();
    root.className = "ash-root";
    root.setAttribute("aria-hidden", "true");

    const layout = el("div", "ash-layout");

    const top = el("header", "ash-top");
    const topText = el("div");
    topText.append(
      el("span", "ash-kicker", "إدارة آمنة"),
      el("h1", "", "لوحة إدارة ahmad says hi"),
      el("p", "", "الحسابات والاشتراكات ورموز التفعيل.")
    );
    const topActions = el("div", "ash-top-actions");
    const refreshBtn = btn("تحديث", () => refresh());
    refreshBtn.id = "admin-refresh";
    const closeBtn = btn("إغلاق", () => close());
    closeBtn.setAttribute("data-admin-close", "");
    topActions.append(refreshBtn, closeBtn);
    top.append(topText, topActions);

    const error = el("p", "ash-error");
    error.id = "admin-error";
    error.setAttribute("role", "alert");

    const summary = el("div", "ash-metrics");
    summary.id = "admin-summary";
    summary.setAttribute("aria-live", "polite");

    const tabs = el("nav", "ash-tabs");
    tabs.setAttribute("aria-label", "أقسام الإدارة");
    for (const [name, label] of [
      ["users", "المستخدمون"],
      ["codes", "رموز التفعيل"],
      ["audit", "سجل الإدارة"],
    ]) {
      const tab = btn(label, () => setTab(name), "ash-tab");
      tab.dataset.adminTab = name;
      if (name === "users") tab.classList.add("is-active");
      tabs.appendChild(tab);
    }

    const usersPane = el("section", "ash-pane is-active");
    usersPane.id = "admin-pane-users";
    const userToolbar = el("div", "ash-toolbar");
    const userSearch = el("input", "ash-input");
    userSearch.id = "admin-user-search";
    userSearch.type = "search";
    userSearch.placeholder = "بحث بالبريد الإلكتروني";
    const userStatus = el("select", "ash-select");
    userStatus.id = "admin-user-status";
    for (const [value, label] of [
      ["all", "كل الحالات"],
      ["active", "نشط"],
      ["expired", "منتهي"],
      ["suspended", "موقوف"],
    ]) {
      const option = el("option", "", label);
      option.value = value;
      userStatus.appendChild(option);
    }
    const userRole = el("select", "ash-select");
    userRole.id = "admin-user-role";
    for (const [value, label] of [
      ["all", "كل الصلاحيات"],
      ["user", "مستخدم"],
      ["admin", "مدير"],
    ]) {
      const option = el("option", "", label);
      option.value = value;
      userRole.appendChild(option);
    }
    const userFilter = btn("تطبيق", () => {
      state.usersPage = 1;
      loadUsers();
    });
    userFilter.id = "admin-user-filter";
    userToolbar.append(userSearch, userStatus, userRole, userFilter);
    const usersList = el("div", "ash-list");
    usersList.id = "admin-users-list";
    const usersPager = el("div", "ash-pager");
    usersPager.id = "admin-users-pagination";
    usersPane.append(userToolbar, usersList, usersPager);

    const codesPane = el("section", "ash-pane");
    codesPane.id = "admin-pane-codes";
    const codeForm = el("form", "ash-form");
    codeForm.id = "admin-code-form";
    const duration = el("select", "ash-select");
    duration.id = "admin-code-duration";
    for (const [value, label] of [
      ["1", "شهر واحد"],
      ["3", "3 أشهر"],
      ["6", "6 أشهر"],
      ["12", "12 شهراً"],
      ["lifetime", "مدى الحياة"],
    ]) {
      const option = el("option", "", label);
      option.value = value;
      duration.appendChild(option);
    }
    const count = el("input", "ash-input");
    count.id = "admin-code-count";
    count.type = "number";
    count.min = "1";
    count.max = "20";
    count.value = "1";
    count.required = true;
    const labelInput = el("input", "ash-input");
    labelInput.id = "admin-code-label";
    labelInput.maxLength = 80;
    labelInput.placeholder = "مثال: عميل يوليو";
    const submit = el("button", "ash-btn ash-btn-primary", "إنشاء الرموز");
    submit.type = "submit";
    codeForm.append(
      field("مدة الرمز", duration, "admin-code-duration"),
      field("العدد", count, "admin-code-count"),
      field("وصف اختياري", labelInput, "admin-code-label"),
      submit
    );

    const codeResult = el("div", "ash-codes-box");
    codeResult.id = "admin-code-result";
    const codeResultHead = el("div");
    codeResultHead.appendChild(
      el("strong", "", "انسخ الرموز الآن — لن تظهر كاملة مرة أخرى")
    );
    const codeResultActions = el("div", "ash-actions");
    const copyBtn = btn("نسخ الكل", () => copyCodes());
    copyBtn.id = "admin-copy-codes";
    const downloadBtn = btn("تنزيل TXT", () => downloadCodes());
    downloadBtn.id = "admin-download-codes";
    codeResultActions.append(copyBtn, downloadBtn);
    codeResultHead.appendChild(codeResultActions);
    const createdCodes = el("textarea", "ash-textarea");
    createdCodes.id = "admin-created-codes";
    createdCodes.rows = 5;
    createdCodes.readOnly = true;
    codeResult.append(codeResultHead, createdCodes);

    const codeFilterBar = el("div", "ash-toolbar");
    codeFilterBar.style.gridTemplateColumns = "minmax(180px, 260px) auto";
    const codeStatus = el("select", "ash-select");
    codeStatus.id = "admin-code-status";
    for (const [value, label] of [
      ["all", "كل الرموز"],
      ["available", "متاح"],
      ["used", "مستخدم"],
      ["revoked", "ملغي"],
    ]) {
      const option = el("option", "", label);
      option.value = value;
      codeStatus.appendChild(option);
    }
    const codeFilter = btn("تطبيق", () => {
      state.codesPage = 1;
      loadCodes();
    });
    codeFilter.id = "admin-code-filter";
    codeFilterBar.append(codeStatus, codeFilter);
    const codesList = el("div", "ash-list");
    codesList.id = "admin-codes-list";
    const codesPager = el("div", "ash-pager");
    codesPager.id = "admin-codes-pagination";
    codesPane.append(
      codeForm,
      codeResult,
      codeFilterBar,
      codesList,
      codesPager
    );

    const auditPane = el("section", "ash-pane");
    auditPane.id = "admin-pane-audit";
    const auditList = el("div", "ash-list");
    auditList.id = "admin-audit-list";
    const auditPager = el("div", "ash-pager");
    auditPager.id = "admin-audit-pagination";
    auditPane.append(auditList, auditPager);

    layout.append(top, error, summary, tabs, usersPane, codesPane, auditPane);
    root.appendChild(layout);

    const drawer = el("div", "ash-drawer");
    drawer.id = "admin-user-panel";
    drawer.setAttribute("aria-live", "polite");
    const drawerPanel = el("div", "ash-drawer-panel");
    drawerPanel.id = "admin-user-panel-body";
    drawer.appendChild(drawerPanel);
    root.appendChild(drawer);

    state.refs = {
      error,
      summary,
      usersList,
      usersPager,
      codesList,
      codesPager,
      auditList,
      auditPager,
      codeResult,
      createdCodes,
      drawer,
      drawerPanel,
      userSearch,
      userStatus,
      userRole,
      codeStatus,
      duration,
      count,
      labelInput,
    };

    userSearch.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      state.usersPage = 1;
      loadUsers();
    });
    codeForm.addEventListener("submit", generateCodes);

    state.mounted = true;
  }

  function renderSummary(summary) {
    const container = state.refs.summary;
    if (!container) return;
    const cards = [
      ["المستخدمون", summary.users.total],
      ["الاشتراكات المنتهية", summary.users.expired],
      ["الحسابات الموقوفة", summary.users.suspended],
      ["الرموز المتاحة", summary.codes.available],
      ["الملفات", summary.profiles],
      ["الجلسات النشطة", summary.sessions],
    ];
    container.replaceChildren(
      ...cards.map(([label, value]) => {
        const card = el("div", "ash-metric");
        card.append(el("span", "", label), el("strong", "", String(value)));
        return card;
      })
    );
  }

  async function loadSummary() {
    const payload = await api("/api/admin/summary");
    renderSummary(payload.summary);
  }

  function renderPagination(container, pagination, onPage) {
    if (!container) return;
    container.replaceChildren();
    if (!pagination || pagination.pages <= 1) return;
    const previous = btn("السابق", () => onPage(pagination.page - 1));
    const next = btn("التالي", () => onPage(pagination.page + 1));
    previous.disabled = pagination.page <= 1;
    next.disabled = pagination.page >= pagination.pages;
    container.append(
      previous,
      el("span", "", `${pagination.page} / ${pagination.pages} · ${pagination.total}`),
      next
    );
  }

  function statusTag(value) {
    return el(
      "span",
      `ash-tag ${statusTone(value)}`.trim(),
      statusLabel(value)
    );
  }

  function renderUsers(users, pagination) {
    const container = state.refs.usersList;
    if (!container) return;
    container.replaceChildren();
    if (!users.length) {
      setEmpty(container, "لا توجد حسابات تطابق الفلتر.");
    }
    for (const user of users) {
      const card = el("article", "ash-card");
      const main = el("div");
      const email = el("strong", "", user.email);
      email.dir = "ltr";
      const meta = el(
        "small",
        "",
        `${user.profileCount} ملفات · ${user.sessionCount} جلسات · أُنشئ ${formatDate(user.createdAt)}`
      );
      const tags = el("div", "ash-tags");
      tags.append(
        statusTag(user.entitlement.status),
        el("span", "ash-tag", user.role === "admin" ? "مدير" : "مستخدم"),
        el("span", "ash-tag", formatPlan(user.entitlement))
      );
      if (user.protected) tags.append(el("span", "ash-tag", "محمي"));
      main.append(email, meta, tags);
      const actions = el("div", "ash-actions");
      actions.append(btn("التفاصيل والإدارة", () => openUserPanel(user.id)));
      card.append(main, actions);
      container.appendChild(card);
    }
    renderPagination(state.refs.usersPager, pagination, (page) => {
      state.usersPage = page;
      loadUsers();
    });
  }

  async function loadUsers() {
    setLoading(state.refs.usersList);
    setError("");
    const params = new URLSearchParams({
      page: String(state.usersPage),
      pageSize: "20",
      q: state.refs.userSearch?.value || "",
      status: state.refs.userStatus?.value || "all",
      role: state.refs.userRole?.value || "all",
    });
    try {
      const payload = await api(`/api/admin/users?${params}`);
      renderUsers(payload.users, payload.pagination);
    } catch (error) {
      setEmpty(state.refs.usersList, error.message || "تعذّر تحميل المستخدمين.");
      setError(error.message);
    }
  }

  function selectInput(options, value = "") {
    const select = el("select", "ash-select");
    for (const [optionValue, label] of options) {
      const option = el("option", "", label);
      option.value = optionValue;
      option.selected = String(optionValue) === String(value);
      select.appendChild(option);
    }
    return select;
  }

  async function updateUser(userId, body, successMessage) {
    if (state.busy) return null;
    state.busy = true;
    setError("");
    try {
      const payload = await api(
        `/api/admin/users/${encodeURIComponent(userId)}`,
        { method: "PATCH", body: JSON.stringify(body) }
      );
      PROFILE_UI.showToast(successMessage);
      await Promise.all([loadSummary(), loadUsers()]);
      return payload.user;
    } catch (error) {
      setError(error.message);
      PROFILE_UI.showToast(error.message || "تعذّر تنفيذ الإجراء.", "error");
      return null;
    } finally {
      state.busy = false;
    }
  }

  function panelStat(label, value) {
    const stat = el("div", "ash-stat");
    stat.append(el("span", "", label), el("strong", "", value));
    return stat;
  }

  function actionBlock(title) {
    const block = el("section", "ash-block");
    block.appendChild(el("h3", "", title));
    return block;
  }

  function closeDrawer() {
    state.refs.drawer?.classList.remove("is-open");
  }

  function renderUserPanel(payload) {
    const panel = state.refs.drawerPanel;
    const drawer = state.refs.drawer;
    if (!panel || !drawer) return;
    const { user, audit = [], redemptions = [] } = payload;
    panel.replaceChildren();
    drawer.classList.add("is-open");

    const header = el("div", "ash-drawer-head");
    const heading = el("div");
    const email = el("h2", "", user.email);
    email.dir = "ltr";
    heading.append(email, el("small", "", user.id));
    header.append(heading, btn("إغلاق", () => closeDrawer()));

    const grid = el("div", "ash-stats");
    grid.append(
      panelStat("الحالة", statusLabel(user.entitlement.status)),
      panelStat("الصلاحية", user.role === "admin" ? "مدير" : "مستخدم"),
      panelStat("الاشتراك", formatPlan(user.entitlement)),
      panelStat("ينتهي", formatDate(user.entitlement.expiresAt)),
      panelStat("الملفات", String(user.profileCount)),
      panelStat("الجلسات", String(user.sessionCount)),
      panelStat("آخر دخول", formatDate(user.lastLoginAt)),
      panelStat("تاريخ الإنشاء", formatDate(user.createdAt))
    );
    panel.append(header, grid);

    const statusBlock = actionBlock("حالة الحساب");
    const statusActions = el("div", "ash-actions");
    if (user.status === "suspended") {
      statusActions.append(
        btn("إعادة تفعيل الحساب", async () => {
          const updated = await updateUser(
            user.id,
            { action: "reactivate" },
            "تمت إعادة تفعيل الحساب."
          );
          if (updated) openUserPanel(user.id);
        })
      );
    } else {
      const suspend = btn(
        "إيقاف الحساب",
        async () => {
          if (!window.confirm(`إيقاف حساب ${user.email} وإلغاء جلساته؟`)) return;
          const updated = await updateUser(
            user.id,
            { action: "suspend" },
            "تم إيقاف الحساب."
          );
          if (updated) openUserPanel(user.id);
        },
        "ash-btn ash-btn-danger"
      );
      suspend.disabled = user.protected || user.id === AUTH.getState().user?.id;
      statusActions.append(suspend);
    }
    statusBlock.appendChild(statusActions);

    const roleBlock = actionBlock("الصلاحية");
    const roleRow = el("div", "ash-row");
    const roleSelect = selectInput(
      [
        ["user", "مستخدم"],
        ["admin", "مدير"],
      ],
      user.role
    );
    roleSelect.disabled = user.protected;
    const saveRole = btn("حفظ الصلاحية", async () => {
      const updated = await updateUser(
        user.id,
        { action: "set_role", role: roleSelect.value },
        "تم تحديث الصلاحية."
      );
      if (updated) openUserPanel(user.id);
    });
    saveRole.disabled = user.protected;
    roleRow.append(roleSelect, saveRole);
    roleBlock.appendChild(roleRow);

    const subscriptionBlock = actionBlock("تعديل الاشتراك");
    const subscriptionRow = el("div", "ash-row");
    const duration = selectInput([
      ["1", "شهر واحد"],
      ["3", "3 أشهر"],
      ["6", "6 أشهر"],
      ["12", "12 شهراً"],
      ["lifetime", "مدى الحياة"],
    ]);
    const mode = selectInput([
      ["replace", "من الآن"],
      ["extend", "تمديد المدة الحالية"],
    ]);
    subscriptionRow.append(
      duration,
      mode,
      btn("تطبيق الاشتراك", async () => {
        const updated = await updateUser(
          user.id,
          {
            action: "set_subscription",
            durationMonths:
              duration.value === "lifetime" ? null : Number(duration.value),
            mode: mode.value,
          },
          "تم تحديث الاشتراك."
        );
        if (updated) openUserPanel(user.id);
      })
    );
    subscriptionBlock.appendChild(subscriptionRow);

    const sessionBlock = actionBlock("الجلسات والحذف");
    const destructive = el("div", "ash-actions");
    destructive.append(
      btn("إلغاء كل الجلسات", async () => {
        if (!window.confirm("إلغاء جميع جلسات هذا الحساب؟")) return;
        try {
          await api(`/api/admin/users/${encodeURIComponent(user.id)}/sessions`, {
            method: "DELETE",
            body: "{}",
          });
          PROFILE_UI.showToast("تم إلغاء جلسات الحساب.");
          await Promise.all([loadSummary(), loadUsers()]);
          closeDrawer();
        } catch (error) {
          setError(error.message);
        }
      })
    );
    const deleteButton = btn(
      "حذف الحساب نهائياً",
      async () => {
        const confirmation = window.prompt(
          `اكتب البريد التالي لتأكيد الحذف النهائي:\n${user.email}`
        );
        if (confirmation === null) return;
        try {
          await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
            method: "DELETE",
            body: JSON.stringify({ confirmation }),
          });
          closeDrawer();
          PROFILE_UI.showToast("تم حذف الحساب نهائياً.");
          await Promise.all([loadSummary(), loadUsers()]);
        } catch (error) {
          setError(error.message);
          PROFILE_UI.showToast(error.message, "error");
        }
      },
      "ash-btn ash-btn-danger"
    );
    deleteButton.disabled =
      user.protected || user.id === AUTH.getState().user?.id;
    destructive.append(deleteButton);
    sessionBlock.appendChild(destructive);
    panel.append(statusBlock, roleBlock, subscriptionBlock, sessionBlock);

    const historyBlock = actionBlock("آخر عمليات الاشتراك والإدارة");
    const history = el("div", "ash-list");
    const entries = [
      ...redemptions.map((entry) => ({
        title: `استخدام رمز ••••-${entry.hint}`,
        detail: `${entry.durationMonths === null ? "مدى الحياة" : `${entry.durationMonths} شهر`} · ${formatDate(entry.redeemedAt)}`,
      })),
      ...audit.map((entry) => ({
        title: entry.action,
        detail: `${entry.adminEmail || "مدير محذوف"} · ${formatDate(entry.createdAt)}`,
      })),
    ].slice(0, 20);
    if (!entries.length) {
      history.appendChild(el("div", "ash-empty", "لا توجد عمليات بعد."));
    } else {
      for (const entry of entries) {
        const card = el("div", "ash-card");
        const main = el("div");
        main.append(el("strong", "", entry.title), el("small", "", entry.detail));
        card.appendChild(main);
        history.appendChild(card);
      }
    }
    historyBlock.appendChild(history);
    panel.appendChild(historyBlock);
  }

  async function openUserPanel(userId) {
    const panel = state.refs.drawerPanel;
    const drawer = state.refs.drawer;
    if (!panel || !drawer) return;
    drawer.classList.add("is-open");
    panel.replaceChildren(el("div", "ash-empty", "جارِ تحميل الحساب..."));
    try {
      renderUserPanel(
        await api(`/api/admin/users/${encodeURIComponent(userId)}`)
      );
    } catch (error) {
      panel.replaceChildren(
        el("div", "ash-empty", error.message || "تعذّر تحميل الحساب.")
      );
    }
  }

  function renderCodes(codes, pagination) {
    const container = state.refs.codesList;
    if (!container) return;
    container.replaceChildren();
    if (!codes.length) setEmpty(container, "لا توجد رموز في هذا القسم.");
    for (const code of codes) {
      const card = el("article", "ash-card");
      const main = el("div");
      const title = el(
        "strong",
        "",
        `••••-${code.hint} · ${code.durationMonths === null ? "مدى الحياة" : `${code.durationMonths} شهر`}`
      );
      title.dir = "ltr";
      const meta = el(
        "small",
        "",
        `${code.label || "بدون وصف"} · ${formatDate(code.createdAt)}${code.usedByEmail ? ` · ${code.usedByEmail}` : ""}`
      );
      const tags = el("div", "ash-tags");
      tags.append(statusTag(code.state));
      main.append(title, meta, tags);
      const actions = el("div", "ash-actions");
      if (code.state === "available") {
        actions.append(
          btn(
            "إلغاء الرمز",
            async () => {
              if (!window.confirm(`إلغاء الرمز المنتهي بـ ${code.hint}؟`)) return;
              try {
                await api(`/api/admin/codes/${encodeURIComponent(code.id)}`, {
                  method: "DELETE",
                  body: "{}",
                });
                PROFILE_UI.showToast("تم إلغاء الرمز.");
                await Promise.all([loadCodes(), loadSummary()]);
              } catch (error) {
                setError(error.message);
              }
            },
            "ash-btn ash-btn-danger"
          )
        );
      }
      card.append(main, actions);
      container.appendChild(card);
    }
    renderPagination(state.refs.codesPager, pagination, (page) => {
      state.codesPage = page;
      loadCodes();
    });
  }

  async function loadCodes() {
    setLoading(state.refs.codesList);
    const params = new URLSearchParams({
      page: String(state.codesPage),
      pageSize: "20",
      status: state.refs.codeStatus?.value || "all",
    });
    try {
      const payload = await api(`/api/admin/codes?${params}`);
      renderCodes(payload.codes, payload.pagination);
    } catch (error) {
      setEmpty(state.refs.codesList, error.message || "تعذّر تحميل الرموز.");
      setError(error.message);
    }
  }

  async function generateCodes(event) {
    event.preventDefault();
    if (state.busy) return;
    state.busy = true;
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    setError("");
    try {
      const duration = state.refs.duration?.value || "1";
      const payload = await api("/api/admin/codes", {
        method: "POST",
        body: JSON.stringify({
          durationMonths: duration === "lifetime" ? null : Number(duration),
          count: Number(state.refs.count?.value || 1),
          label: state.refs.labelInput?.value || null,
        }),
      });
      state.createdCodes = payload.codes.map((entry) => entry.code);
      if (state.refs.createdCodes) {
        state.refs.createdCodes.value = state.createdCodes.join("\n");
      }
      state.refs.codeResult?.classList.add("is-visible");
      PROFILE_UI.showToast("تم إنشاء الرموز. انسخها الآن.");
      await Promise.all([loadCodes(), loadSummary()]);
    } catch (error) {
      setError(error.message);
      PROFILE_UI.showToast(error.message || "تعذّر إنشاء الرموز.", "error");
    } finally {
      state.busy = false;
      if (submit) submit.disabled = false;
    }
  }

  async function copyCodes() {
    if (!state.createdCodes.length) return;
    const text = state.createdCodes.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      state.refs.createdCodes?.select();
      document.execCommand("copy");
    }
    PROFILE_UI.showToast("تم نسخ الرموز.");
  }

  function downloadCodes() {
    if (!state.createdCodes.length) return;
    const blob = new Blob([`${state.createdCodes.join("\r\n")}\r\n`], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ahmad-says-hi-codes-${Date.now()}.txt`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderAudit(entries, pagination) {
    const container = state.refs.auditList;
    if (!container) return;
    container.replaceChildren();
    if (!entries.length) setEmpty(container, "لا توجد عمليات إدارية.");
    for (const entry of entries) {
      const card = el("article", "ash-card");
      const main = el("div");
      const title = el("strong", "", entry.action);
      title.dir = "ltr";
      const target =
        entry.targetUserEmail ||
        entry.targetUserId ||
        entry.targetCodeId ||
        "إجراء عام";
      main.append(
        title,
        el(
          "small",
          "",
          `${entry.adminEmail || "مدير محذوف"} ← ${target} · ${formatDate(entry.createdAt)}`
        )
      );
      card.appendChild(main);
      container.appendChild(card);
    }
    renderPagination(state.refs.auditPager, pagination, (page) => {
      state.auditPage = page;
      loadAudit();
    });
  }

  async function loadAudit() {
    setLoading(state.refs.auditList);
    try {
      const payload = await api(
        `/api/admin/audit?page=${state.auditPage}&pageSize=30`
      );
      renderAudit(payload.audit, payload.pagination);
    } catch (error) {
      setEmpty(state.refs.auditList, error.message || "تعذّر تحميل السجل.");
      setError(error.message);
    }
  }

  async function setTab(tab) {
    state.tab = ["users", "codes", "audit"].includes(tab) ? tab : "users";
    root?.querySelectorAll(".ash-tab").forEach((tabButton) => {
      tabButton.classList.toggle(
        "is-active",
        tabButton.dataset.adminTab === state.tab
      );
    });
    for (const name of ["users", "codes", "audit"]) {
      byId(`admin-pane-${name}`)?.classList.toggle(
        "is-active",
        name === state.tab
      );
    }
    if (state.tab === "users") await loadUsers();
    if (state.tab === "codes") await loadCodes();
    if (state.tab === "audit") await loadAudit();
  }

  async function refresh() {
    if (!state.open) return;
    setError("");
    try {
      await Promise.all([loadSummary(), setTab(state.tab)]);
    } catch (error) {
      setError(error.message || "تعذّر تحديث لوحة الإدارة.");
    }
  }

  async function open() {
    const authState = AUTH.getState();
    if (
      authState.status !== "authenticated" ||
      authState.user?.role !== "admin"
    ) {
      PROFILE_UI.showToast("لا تملك صلاحية لوحة الإدارة.", "error");
      return;
    }
    mountShell();
    PROFILE_UI.closeDropdown();
    state.open = true;
    root?.classList.add("is-open");
    root?.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    setLoading(state.refs.usersList);
    try {
      await Promise.all([loadSummary(), setTab(state.tab)]);
    } catch (error) {
      setError(error.message || "تعذّر فتح لوحة الإدارة.");
    }
  }

  function close() {
    state.open = false;
    closeDrawer();
    root?.classList.remove("is-open");
    root?.setAttribute("aria-hidden", "true");
    setError("");
    document.body.style.overflow = "";
  }

  function bindEvents() {
    byId("open-admin")?.addEventListener("click", open);
    root?.addEventListener("click", (event) => {
      if (event.target === state.refs.drawer) closeDrawer();
      if (event.target.hasAttribute?.("data-admin-close")) close();
    });
    document.addEventListener("auth-changed", (event) =>
      renderEntryVisibility(event.detail)
    );
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !state.open) return;
      if (state.refs.drawer?.classList.contains("is-open")) closeDrawer();
      else close();
    });
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    if (root) {
      root.className = "ash-root";
      root.setAttribute("aria-hidden", "true");
      root.replaceChildren();
    }
    bindEvents();
    renderEntryVisibility();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { init, open, close };
})();
