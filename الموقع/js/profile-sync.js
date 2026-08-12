/* =====================================================
   BlueStream — مزامنة بيانات الملف مع D1
   ===================================================== */

const PROFILE_SYNC = (() => {
  const QUEUE_PREFIX = "bluestream:sync-queue:v1:";
  const CURSOR_PREFIX = "bluestream:sync-cursor:v1:";
  const locks = new Map();
  const timers = new Map();
  let applyRemote = null;

  function scopeFor(profileId) {
    const account =
      typeof PROFILES !== "undefined" ? PROFILES.getScopeKey() : "guest";
    return `${account}:${profileId}`;
  }

  function queueKey(profileId, syncScope = scopeFor(profileId)) {
    return `${QUEUE_PREFIX}${syncScope}`;
  }

  function cursorKey(profileId, syncScope = scopeFor(profileId)) {
    return `${CURSOR_PREFIX}${syncScope}`;
  }

  function emptyQueue() {
    return { mutations: [], history: [] };
  }

  function loadQueue(profileId, syncScope = scopeFor(profileId)) {
    try {
      const queue = JSON.parse(
        localStorage.getItem(queueKey(profileId, syncScope)) || "{}"
      );
      return {
        mutations: Array.isArray(queue.mutations) ? queue.mutations : [],
        history: Array.isArray(queue.history) ? queue.history : [],
      };
    } catch {
      return emptyQueue();
    }
  }

  function saveQueue(profileId, queue, syncScope = scopeFor(profileId)) {
    try {
      if (!queue.mutations.length && !queue.history.length) {
        localStorage.removeItem(queueKey(profileId, syncScope));
      } else {
        localStorage.setItem(
          queueKey(profileId, syncScope),
          JSON.stringify(queue)
        );
      }
    } catch (error) {
      console.warn("PROFILE_SYNC: تعذّر حفظ طابور المزامنة:", error);
    }
    dispatchStatus(profileId, queue);
  }

  function readCursor(profileId, syncScope = scopeFor(profileId)) {
    try {
      return (
        Number(localStorage.getItem(cursorKey(profileId, syncScope)) || 0) || 0
      );
    } catch {
      return 0;
    }
  }

  function writeCursor(
    profileId,
    value,
    syncScope = scopeFor(profileId)
  ) {
    try {
      localStorage.setItem(
        cursorKey(profileId, syncScope),
        String(Math.max(0, value))
      );
    } catch {
      // ignore
    }
  }

  function dispatchStatus(profileId, queue = loadQueue(profileId), status) {
    document.dispatchEvent(
      new CustomEvent("profile-sync-status", {
        detail: {
          profileId,
          pending: queue.mutations.length + queue.history.length,
          status:
            status ||
            (queue.mutations.length || queue.history.length
              ? "pending"
              : "synced"),
        },
      })
    );
  }

  function mutationId() {
    return crypto.randomUUID();
  }

  function activeProfileId() {
    return PROFILES.getActive()?.id || null;
  }

  function enqueue(collection, operation, key, value, profileId) {
    const targetProfileId = profileId || activeProfileId();
    if (!targetProfileId) return;
    const queue = loadQueue(targetProfileId);
    queue.mutations = queue.mutations.filter(
      (entry) => !(entry.collection === collection && entry.key === key)
    );
    queue.mutations.push({
      id: mutationId(),
      collection,
      operation,
      key,
      value: operation === "delete" ? null : value,
      queuedAt: Date.now(),
    });
    if (queue.mutations.length > 1000) {
      queue.mutations = queue.mutations.slice(-1000);
    }
    saveQueue(targetProfileId, queue);
    schedule(targetProfileId);
  }

  function enqueueHistory(entry, profileId) {
    const targetProfileId = profileId || activeProfileId();
    if (!targetProfileId) return;
    const queue = loadQueue(targetProfileId);
    if (!queue.history.some((existing) => existing.id === entry.id)) {
      queue.history.push(entry);
    }
    if (queue.history.length > 500) {
      queue.history = queue.history.slice(-500);
    }
    saveQueue(targetProfileId, queue);
    schedule(targetProfileId);
  }

  function hasPending(collection, key, profileId) {
    const targetProfileId = profileId || activeProfileId();
    if (!targetProfileId) return false;
    return loadQueue(targetProfileId).mutations.some(
      (entry) => entry.collection === collection && entry.key === key
    );
  }

  async function flush(profileId, syncScope) {
    const queue = loadQueue(profileId, syncScope);
    if (!queue.mutations.length && !queue.history.length) return null;

    const sentMutationIds = new Set(
      queue.mutations.slice(0, 250).map((entry) => entry.id)
    );
    const sentHistoryIds = new Set(
      queue.history.slice(0, 100).map((entry) => entry.id)
    );
    const response = await AUTH.request(
      `/api/sync/${encodeURIComponent(profileId)}`,
      {
        method: "POST",
        body: JSON.stringify({
          mutations: queue.mutations.slice(0, 250),
          history: queue.history.slice(0, 100),
        }),
      }
    );

    const latest = loadQueue(profileId, syncScope);
    latest.mutations = latest.mutations.filter(
      (entry) => !sentMutationIds.has(entry.id)
    );
    latest.history = latest.history.filter(
      (entry) => !sentHistoryIds.has(entry.id)
    );
    saveQueue(profileId, latest, syncScope);
    return response;
  }

  async function pull(profileId, syncScope) {
    const since = Math.max(0, readCursor(profileId, syncScope) - 1000);
    const response = await AUTH.request(
      `/api/sync/${encodeURIComponent(profileId)}?since=${since}`,
      { method: "GET" }
    );
    if (
      scopeFor(profileId) === syncScope &&
      typeof applyRemote === "function"
    ) {
      applyRemote(profileId, response.changes || {});
      writeCursor(
        profileId,
        Number(response.serverTime || Date.now()),
        syncScope
      );
    }
    return response;
  }

  async function performSync(profileId) {
    const syncScope = scopeFor(profileId);
    if (!AUTH.isAuthenticated() || !navigator.onLine) {
      dispatchStatus(
        profileId,
        loadQueue(profileId, syncScope),
        "offline"
      );
      return;
    }

    dispatchStatus(profileId, loadQueue(profileId, syncScope), "syncing");
    try {
      let rounds = 0;
      while (rounds < 5) {
        const queue = loadQueue(profileId, syncScope);
        if (!queue.mutations.length && !queue.history.length) break;
        await flush(profileId, syncScope);
        rounds += 1;
      }
      await pull(profileId, syncScope);
      if (scopeFor(profileId) === syncScope) {
        dispatchStatus(
          profileId,
          loadQueue(profileId, syncScope),
          "synced"
        );
      }
    } catch (error) {
      if (error.status === 401) AUTH.expireSession();
      console.warn("PROFILE_SYNC: المزامنة مؤجلة:", error);
      if (scopeFor(profileId) === syncScope) {
        dispatchStatus(
          profileId,
          loadQueue(profileId, syncScope),
          "error"
        );
      }
    }
  }

  function syncNow(profileId = activeProfileId()) {
    if (!profileId) return Promise.resolve();
    const lockKey = scopeFor(profileId);
    if (locks.has(lockKey)) return locks.get(lockKey);
    const promise = performSync(profileId).finally(() => {
      locks.delete(lockKey);
    });
    locks.set(lockKey, promise);
    return promise;
  }

  function schedule(profileId = activeProfileId(), delay = 900) {
    if (!profileId) return;
    const timerKey = scopeFor(profileId);
    clearTimeout(timers.get(timerKey));
    timers.set(
      timerKey,
      setTimeout(() => {
        timers.delete(timerKey);
        if (scopeFor(profileId) === timerKey) syncNow(profileId);
      }, delay)
    );
  }

  function discardProfile(profileId) {
    const syncScope = scopeFor(profileId);
    clearTimeout(timers.get(syncScope));
    timers.delete(syncScope);
    try {
      localStorage.removeItem(queueKey(profileId, syncScope));
      localStorage.removeItem(cursorKey(profileId, syncScope));
    } catch {
      // ignore
    }
  }

  function setApplier(callback) {
    applyRemote = callback;
  }

  window.addEventListener("online", () => schedule(activeProfileId(), 100));
  document.addEventListener("profile-changed", (event) => {
    schedule(event.detail?.profile?.id, 100);
  });
  document.addEventListener("auth-changed", (event) => {
    if (event.detail?.status === "authenticated") {
      queueMicrotask(() => schedule(activeProfileId(), 100));
    }
  });

  return {
    enqueue,
    enqueueHistory,
    hasPending,
    syncNow,
    schedule,
    discardProfile,
    setApplier,
    pendingCount(profileId = activeProfileId()) {
      if (!profileId) return 0;
      const queue = loadQueue(profileId);
      return queue.mutations.length + queue.history.length;
    },
  };
})();
