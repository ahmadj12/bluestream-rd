/* =====================================================
   BlueStream — بيانات الملف الشخصي المعزولة
   تقدّم + قائمتي + تمت المشاهدة + السجل
   ===================================================== */

const PROFILE_STORE = (() => {
  const DATA_PREFIX = "bluestream:data:v2";
  const LEGACY_PROGRESS_KEY = "bluestream:progress";
  const MIN_SECONDS = 5;
  const DONE_RATIO = 0.95;
  const COLLECTION_EVENTS = {
    progress: "watch-progress-changed",
    myList: "my-list-changed",
    watched: "watched-changed",
    history: "history-changed",
  };

  let initialized = false;
  let listenersBound = false;
  const recentHistory = new Map();

  function activeProfileId() {
    return (
      (typeof PROFILES !== "undefined" && PROFILES.getActive()?.id) ||
      "default"
    );
  }

  function activeScope() {
    return (
      (typeof PROFILES !== "undefined" && PROFILES.getScopeKey()) ||
      "guest"
    );
  }

  function storageKey(collection, profileId = activeProfileId()) {
    return `${DATA_PREFIX}:${encodeURIComponent(
      activeScope()
    )}:${encodeURIComponent(profileId)}:${collection}`;
  }

  function safeParse(raw, fallback) {
    try {
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function loadMap(collection, profileId = activeProfileId()) {
    try {
      const parsed = safeParse(
        localStorage.getItem(storageKey(collection, profileId)) || "{}",
        {}
      );
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  function loadHistory(profileId = activeProfileId()) {
    try {
      const parsed = safeParse(
        localStorage.getItem(storageKey("history", profileId)) || "[]",
        []
      );
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function notify(collection, profileId = activeProfileId()) {
    const detail = { collection, profileId, scope: activeScope() };
    document.dispatchEvent(
      new CustomEvent("profile-data-changed", { detail })
    );
    const eventName = COLLECTION_EVENTS[collection];
    if (eventName) {
      document.dispatchEvent(new CustomEvent(eventName, { detail }));
    }
  }

  function persistMap(
    collection,
    map,
    profileId = activeProfileId(),
    shouldNotify = true
  ) {
    try {
      localStorage.setItem(
        storageKey(collection, profileId),
        JSON.stringify(map)
      );
    } catch (error) {
      console.warn(`PROFILE_STORE: تعذّر حفظ ${collection}:`, error);
    }
    if (shouldNotify) notify(collection, profileId);
  }

  function persistHistory(
    entries,
    profileId = activeProfileId(),
    shouldNotify = true
  ) {
    try {
      localStorage.setItem(
        storageKey("history", profileId),
        JSON.stringify(entries.slice(-500))
      );
    } catch (error) {
      console.warn("PROFILE_STORE: تعذّر حفظ السجل:", error);
    }
    if (shouldNotify) notify("history", profileId);
  }

  function safePart(value, fallback) {
    const normalized = String(value ?? fallback);
    return normalized.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80);
  }

  function keyOf(item) {
    return `${safePart(item?.source, "unknown")}:${safePart(item?.id, "0")}`;
  }

  function watchedKey(item, episode = null) {
    const base = keyOf(item);
    if (!episode) return base;
    return `${base}:s${safePart(episode.season, 0)}:e${safePart(
      episode.episode,
      0
    )}`;
  }

  function itemSnapshot(item) {
    return {
      id: item.id,
      type: item.type,
      mediaType: item.mediaType,
      source: item.source,
      title: item.title,
      originalTitle: item.originalTitle,
      poster: item.poster,
      backdrop: item.backdrop,
      rating: item.rating,
      year: item.year,
      overview: item.overview,
      genres: item.genres,
      genreIds: item.genreIds,
      totalEpisodes: item.totalEpisodes,
      runtime: item.runtime,
      externalIds: item.externalIds,
    };
  }

  function sameEpisode(left, right) {
    if (!left && !right) return true;
    return Boolean(
      left &&
        right &&
        Number(left.season) === Number(right.season) &&
        Number(left.episode) === Number(right.episode)
    );
  }

  function queueMutation(collection, operation, key, value, profileId) {
    if (
      typeof AUTH !== "undefined" &&
      AUTH.hasAccount() &&
      typeof PROFILE_SYNC !== "undefined"
    ) {
      PROFILE_SYNC.enqueue(collection, operation, key, value, profileId);
    }
  }

  function migrateLegacyProgress() {
    let legacy;
    try {
      legacy = safeParse(
        localStorage.getItem(LEGACY_PROGRESS_KEY) || "{}",
        {}
      );
    } catch {
      return;
    }
    if (!legacy || typeof legacy !== "object" || !Object.keys(legacy).length) {
      return;
    }

    const accountBacked =
      typeof AUTH !== "undefined" && AUTH.hasAccount();
    const marker = accountBacked
      ? "bluestream:legacy-progress-migrated:cloud:v1"
      : "bluestream:legacy-progress-migrated:guest:v1";
    try {
      if (localStorage.getItem(marker)) return;
    } catch {
      return;
    }

    const profileId = activeProfileId();
    const current = loadMap("progress", profileId);
    for (const [legacyKey, entry] of Object.entries(legacy)) {
      if (!entry?.item) continue;
      const key = keyOf(entry.item) || legacyKey;
      if (!current[key]) {
        current[key] = {
          ...entry,
          item: itemSnapshot(entry.item),
          updatedAt: Number(entry.updatedAt || Date.now()),
        };
        queueMutation("progress", "upsert", key, current[key], profileId);
      }
    }
    persistMap("progress", current, profileId);
    try {
      localStorage.setItem(marker, String(Date.now()));
    } catch {
      // ignore
    }
  }

  function applyCollectionChanges(collection, changes, profileId) {
    if (!Array.isArray(changes) || !changes.length) return;
    const map = loadMap(collection, profileId);
    let changed = false;

    for (const change of changes) {
      if (
        typeof PROFILE_SYNC !== "undefined" &&
        PROFILE_SYNC.hasPending(collection, change.key, profileId)
      ) {
        continue;
      }
      if (change.deleted) {
        if (Object.hasOwn(map, change.key)) {
          delete map[change.key];
          changed = true;
        }
      } else if (change.value) {
        map[change.key] = {
          ...change.value,
          updatedAt: Number(change.updatedAt || change.value.updatedAt),
        };
        changed = true;
      }
    }
    if (changed) persistMap(collection, map, profileId);
  }

  function applyRemoteChanges(profileId, changes) {
    applyCollectionChanges("progress", changes.progress, profileId);
    applyCollectionChanges("myList", changes.myList, profileId);
    applyCollectionChanges("watched", changes.watched, profileId);

    if (Array.isArray(changes.history) && changes.history.length) {
      const current = loadHistory(profileId);
      const byId = new Map(current.map((entry) => [entry.id, entry]));
      for (const entry of changes.history) byId.set(entry.id, entry);
      const merged = Array.from(byId.values())
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(-500);
      persistHistory(merged, profileId);
    }
  }

  function notifyAll(profileId = activeProfileId()) {
    for (const collection of Object.keys(COLLECTION_EVENTS)) {
      notify(collection, profileId);
    }
  }

  function discardProfile(profileId) {
    if (!profileId) return;
    for (const collection of Object.keys(COLLECTION_EVENTS)) {
      try {
        localStorage.removeItem(storageKey(collection, profileId));
      } catch {
        // ignore
      }
    }
    for (const key of Array.from(recentHistory.keys())) {
      if (key.startsWith(`${profileId}:`)) recentHistory.delete(key);
    }
  }

  async function init() {
    if (initialized) return;
    await PROFILES.init();
    if (typeof PROFILE_SYNC !== "undefined") {
      PROFILE_SYNC.setApplier(applyRemoteChanges);
    }
    migrateLegacyProgress();

    if (!listenersBound) {
      listenersBound = true;
      document.addEventListener("profile-changed", (event) => {
        migrateLegacyProgress();
        notifyAll(event.detail?.profile?.id || activeProfileId());
      });
      document.addEventListener("auth-changed", () => {
        queueMicrotask(migrateLegacyProgress);
      });
    }

    initialized = true;
    notifyAll();
    if (typeof PROFILE_SYNC !== "undefined") {
      PROFILE_SYNC.schedule(activeProfileId(), 100);
    }
  }

  return {
    init,
    keyOf,
    watchedKey,
    itemSnapshot,
    sameEpisode,
    loadMap,
    loadHistory,
    persistMap,
    persistHistory,
    queueMutation,
    applyRemoteChanges,
    discardProfile,
    activeProfileId,
    activeScope,
    MIN_SECONDS,
    DONE_RATIO,
    recentHistory,
  };
})();

const HISTORY = (() => {
  function add(
    item,
    episode = null,
    event = "play",
    position = 0,
    duration = 0
  ) {
    if (!item) return null;
    const profileId = PROFILE_STORE.activeProfileId();
    const guardKey = `${profileId}:${PROFILE_STORE.watchedKey(
      item,
      episode
    )}:${event}`;
    const now = Date.now();
    if (
      event !== "complete" &&
      now - Number(PROFILE_STORE.recentHistory.get(guardKey) || 0) < 30_000
    ) {
      return null;
    }
    PROFILE_STORE.recentHistory.set(guardKey, now);

    const entry = {
      id: crypto.randomUUID(),
      key: PROFILE_STORE.keyOf(item),
      item: PROFILE_STORE.itemSnapshot(item),
      episode: episode || null,
      event: ["play", "resume", "complete"].includes(event) ? event : "play",
      position: Math.max(0, Math.floor(position || 0)),
      duration: Math.max(0, Math.floor(duration || 0)),
      createdAt: now,
    };
    const entries = PROFILE_STORE.loadHistory(profileId);
    entries.push(entry);
    PROFILE_STORE.persistHistory(entries.slice(-500), profileId);
    if (typeof AUTH !== "undefined" && AUTH.hasAccount()) {
      PROFILE_SYNC.enqueueHistory(entry, profileId);
    }
    return entry;
  }

  function all() {
    return PROFILE_STORE.loadHistory()
      .filter((entry) => entry?.item)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  return { add, all };
})();

const WATCHED = (() => {
  function mark(item, episode = null, options = {}) {
    if (!item) return null;
    const profileId = PROFILE_STORE.activeProfileId();
    const key = PROFILE_STORE.watchedKey(item, episode);
    const now = Date.now();
    const entry = {
      item: PROFILE_STORE.itemSnapshot(item),
      episode: episode || null,
      manual: Boolean(options.manual),
      watchedAt: Number(options.watchedAt || now),
      updatedAt: now,
    };
    const map = PROFILE_STORE.loadMap("watched", profileId);
    map[key] = entry;
    PROFILE_STORE.persistMap("watched", map, profileId);
    PROFILE_STORE.queueMutation("watched", "upsert", key, entry, profileId);
    return entry;
  }

  function unmark(item, episode = null) {
    if (!item) return;
    const profileId = PROFILE_STORE.activeProfileId();
    const key = PROFILE_STORE.watchedKey(item, episode);
    const map = PROFILE_STORE.loadMap("watched", profileId);
    if (!Object.hasOwn(map, key)) return;
    delete map[key];
    PROFILE_STORE.persistMap("watched", map, profileId);
    PROFILE_STORE.queueMutation("watched", "delete", key, null, profileId);
  }

  function get(item, episode = null) {
    if (!item) return null;
    return (
      PROFILE_STORE.loadMap("watched")[
        PROFILE_STORE.watchedKey(item, episode)
      ] || null
    );
  }

  function has(item, episode = null) {
    return Boolean(get(item, episode));
  }

  function toggle(item, episode = null) {
    if (has(item, episode)) {
      unmark(item, episode);
      return false;
    }
    mark(item, episode, { manual: true });
    return true;
  }

  function all() {
    return Object.values(PROFILE_STORE.loadMap("watched"))
      .filter((entry) => entry?.item)
      .sort(
        (left, right) =>
          Number(right.watchedAt || right.updatedAt) -
          Number(left.watchedAt || left.updatedAt)
      );
  }

  return { mark, unmark, get, has, toggle, all };
})();

const MY_LIST = (() => {
  function add(item) {
    if (!item) return null;
    const profileId = PROFILE_STORE.activeProfileId();
    const key = PROFILE_STORE.keyOf(item);
    const now = Date.now();
    const entry = {
      item: PROFILE_STORE.itemSnapshot(item),
      createdAt: now,
      updatedAt: now,
    };
    const map = PROFILE_STORE.loadMap("myList", profileId);
    map[key] = entry;
    PROFILE_STORE.persistMap("myList", map, profileId);
    PROFILE_STORE.queueMutation("myList", "upsert", key, entry, profileId);
    return entry;
  }

  function remove(item) {
    if (!item) return;
    const profileId = PROFILE_STORE.activeProfileId();
    const key = PROFILE_STORE.keyOf(item);
    const map = PROFILE_STORE.loadMap("myList", profileId);
    if (!Object.hasOwn(map, key)) return;
    delete map[key];
    PROFILE_STORE.persistMap("myList", map, profileId);
    PROFILE_STORE.queueMutation("myList", "delete", key, null, profileId);
  }

  function has(item) {
    return Boolean(
      item &&
        PROFILE_STORE.loadMap("myList")[PROFILE_STORE.keyOf(item)]
    );
  }

  function toggle(item) {
    if (has(item)) {
      remove(item);
      return false;
    }
    add(item);
    return true;
  }

  function all() {
    return Object.values(PROFILE_STORE.loadMap("myList"))
      .filter((entry) => entry?.item)
      .sort(
        (left, right) =>
          Number(right.createdAt || right.updatedAt) -
          Number(left.createdAt || left.updatedAt)
      );
  }

  return { add, remove, has, toggle, all };
})();

const PROGRESS = (() => {
  function save(item, position, duration, episode = null) {
    const current = Number(position);
    const total = Number(duration);
    if (
      !item ||
      !Number.isFinite(current) ||
      !Number.isFinite(total) ||
      total <= 0 ||
      current < PROFILE_STORE.MIN_SECONDS
    ) {
      return;
    }

    const profileId = PROFILE_STORE.activeProfileId();
    const key = PROFILE_STORE.keyOf(item);
    const map = PROFILE_STORE.loadMap("progress", profileId);
    const previous = map[key];
    const completed = current / total >= PROFILE_STORE.DONE_RATIO;
    const finalPosition = completed ? total : Math.min(current, total);
    const entry = makeEntry(
      item,
      finalPosition,
      total,
      episode,
      completed
    );
    map[key] = entry;
    PROFILE_STORE.persistMap("progress", map, profileId);
    PROFILE_STORE.queueMutation("progress", "upsert", key, entry, profileId);

    const newlyCompleted =
      completed &&
      !(
        previous?.completed &&
        PROFILE_STORE.sameEpisode(previous.episode, episode)
      );
    if (newlyCompleted) {
      WATCHED.mark(item, episode, { manual: false, watchedAt: Date.now() });
      HISTORY.add(item, episode, "complete", total, total);
    }
  }

  function makeEntry(item, position, duration, episode, completed) {
    return {
      item: PROFILE_STORE.itemSnapshot(item),
      episode: episode || null,
      position: Math.max(0, Math.floor(position || 0)),
      duration: Math.max(0, Math.floor(duration || 0)),
      completed: Boolean(completed),
      updatedAt: Date.now(),
    };
  }

  function start(item, episode = null, durationHint = 0) {
    if (!item) return;
    const profileId = PROFILE_STORE.activeProfileId();
    const key = PROFILE_STORE.keyOf(item);
    const map = PROFILE_STORE.loadMap("progress", profileId);
    const existing = map[key];
    let event = "play";

    if (
      existing &&
      !existing.completed &&
      PROFILE_STORE.sameEpisode(existing.episode, episode)
    ) {
      event = existing.position > PROFILE_STORE.MIN_SECONDS ? "resume" : "play";
      map[key] = {
        ...existing,
        item: PROFILE_STORE.itemSnapshot(item),
        updatedAt: Date.now(),
      };
    } else {
      map[key] = makeEntry(item, 0, durationHint, episode, false);
    }
    PROFILE_STORE.persistMap("progress", map, profileId);
    PROFILE_STORE.queueMutation(
      "progress",
      "upsert",
      key,
      map[key],
      profileId
    );
    HISTORY.add(
      item,
      episode,
      event,
      existing?.position || 0,
      existing?.duration || durationHint || 0
    );
  }

  function advance(item, episode = null, durationHint = 0) {
    if (!item) return;
    const profileId = PROFILE_STORE.activeProfileId();
    const key = PROFILE_STORE.keyOf(item);
    const map = PROFILE_STORE.loadMap("progress", profileId);
    map[key] = makeEntry(item, 0, durationHint, episode, false);
    PROFILE_STORE.persistMap("progress", map, profileId);
    PROFILE_STORE.queueMutation(
      "progress",
      "upsert",
      key,
      map[key],
      profileId
    );
  }

  function remove(item) {
    if (!item) return;
    const profileId = PROFILE_STORE.activeProfileId();
    const key = PROFILE_STORE.keyOf(item);
    const map = PROFILE_STORE.loadMap("progress", profileId);
    delete map[key];
    PROFILE_STORE.persistMap("progress", map, profileId);
    PROFILE_STORE.queueMutation("progress", "delete", key, null, profileId);
  }

  function get(item) {
    if (!item) return null;
    return (
      PROFILE_STORE.loadMap("progress")[PROFILE_STORE.keyOf(item)] || null
    );
  }

  function all() {
    return Object.values(PROFILE_STORE.loadMap("progress"))
      .filter((entry) => entry?.item)
      .sort(
        (left, right) =>
          Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
      );
  }

  return {
    save,
    start,
    advance,
    remove,
    get,
    all,
    keyOf: PROFILE_STORE.keyOf,
  };
})();
