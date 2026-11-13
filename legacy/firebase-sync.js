import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  connectFirestoreEmulator,
  doc,
  getFirestore,
  getDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-functions.js";

const APP_SCRIPT = "assets/index-CzAOxx0j.js?v=20261027-sand-1";
const MAX_SNAPSHOT_BYTES = 900_000;
const FIREBASE_CONFIG_KEY = "muwci-race-firebase-config-v1";
const PENDING_SYNC_KEY = "muwci-race-pending-sync-v1";

const defaultRace = {
  status: "idle",
  startTime: null,
  timeRemainingAtPause: 86400,
  totalDurationSeconds: 86400,
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const stablePayload = (value) => JSON.stringify({
  teams: value.teams || [],
  race: value.race || defaultRace,
  announcements: value.announcements || [],
});

const loadStoredJson = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
};

const loadFirebaseConfig = async () => {
  if (window.__FIREBASE_CONFIG__) return window.__FIREBASE_CONFIG__;
  try {
    const response = await fetch("/__/firebase/init.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Firebase configuration is unavailable.");
    const config = await response.json();
    localStorage.setItem(FIREBASE_CONFIG_KEY, JSON.stringify(config));
    return config;
  } catch (error) {
    const stored = loadStoredJson(FIREBASE_CONFIG_KEY);
    if (stored) return stored;
    throw error;
  }
};

const createStore = async () => {
  const config = await loadFirebaseConfig();
  const app = initializeApp(config);
  const db = getFirestore(app);
  const functions = getFunctions(app, "us-central1");
  if (["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  }

  const raceRef = doc(db, "raceSnapshots", "main");
  const raceAdmin = httpsCallable(functions, "raceAdmin");
  const listeners = new Set();
  const statusListeners = new Set();
  let lastRemote = null;
  let lastRemotePayload = "";
  let lastRevision = 0;
  let writeQueue = Promise.resolve();
  let pendingWrites = 0;
  let adminMode = false;
  let adminPin = null;
  let pendingSnapshot = loadStoredJson(PENDING_SYNC_KEY);
  let syncStatus = {
    state: navigator.onLine ? (pendingSnapshot ? "pending" : "synced") : "offline",
    pending: Boolean(pendingSnapshot),
    message: pendingSnapshot ? "Changes waiting to sync" : "All changes saved",
  };

  const notify = (snapshot) => {
    for (const listener of listeners) listener(clone(snapshot));
  };

  const updateStatus = (next) => {
    syncStatus = { ...syncStatus, ...next };
    for (const listener of statusListeners) listener({ ...syncStatus });
  };

  const storePendingSnapshot = (snapshot) => {
    pendingSnapshot = clone(snapshot);
    localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(pendingSnapshot));
    updateStatus({
      state: navigator.onLine ? "pending" : "offline",
      pending: true,
      message: navigator.onLine ? "Saving changes…" : "Offline — changes saved on this device",
    });
  };

  const clearPendingSnapshot = (savedPayload) => {
    if (pendingSnapshot && stablePayload(pendingSnapshot) !== savedPayload) return;
    pendingSnapshot = null;
    localStorage.removeItem(PENDING_SYNC_KEY);
    updateStatus({ state: "synced", pending: false, message: "All changes saved" });
  };

  const isConnectionError = (error) => {
    const code = String(error?.code || "");
    return !navigator.onLine || [
      "functions/unavailable",
      "functions/deadline-exceeded",
      "unavailable",
      "deadline-exceeded",
    ].some((value) => code.includes(value));
  };

  onSnapshot(raceRef, (snapshot) => {
    if (!snapshot.exists()) return;
    const data = snapshot.data();
    try {
      const remoteRevision = data.revision || 0;
      if (remoteRevision < lastRevision) return;
      const parsed = {
        teams: JSON.parse(data.teamsJson || "[]"),
        race: data.race || defaultRace,
        announcements: JSON.parse(data.announcementsJson || "[]"),
      };
      lastRemote = parsed;
      lastRemotePayload = stablePayload(parsed);
      lastRevision = remoteRevision;
      if (!adminMode || (pendingWrites === 0 && !pendingSnapshot)) notify(parsed);
    } catch (error) {
      console.error("Ignoring an invalid race snapshot:", error);
    }
  }, (error) => {
    console.error("Live race connection failed:", error);
    if (!navigator.onLine) updateStatus({ state: "offline", message: "Offline — changes saved on this device" });
  });

  const isAdmin = () => adminMode;

  const loginAdmin = async (pin) => {
    const result = await raceAdmin({ action: "verify", pin });
    if (!result.data?.verified) throw new Error("Admin password could not be verified.");
    adminPin = pin;
    adminMode = true;
    if (pendingSnapshot && navigator.onLine) void flushPendingSnapshot();
    return true;
  };

  const logoutAdmin = async () => {
    adminPin = null;
    adminMode = false;
  };

  const sendSnapshot = (desired) => {
    desired = clone(desired);
    const payload = stablePayload(desired);
    if (payload === lastRemotePayload) {
      clearPendingSnapshot(payload);
      return Promise.resolve({ queued: false, revision: lastRevision });
    }
    if (new TextEncoder().encode(payload).length > MAX_SNAPSHOT_BYTES) {
      return Promise.reject(new Error("The race history is too large to save safely."));
    }

    pendingWrites += 1;
    updateStatus({ state: "pending", pending: true, message: "Saving changes…" });
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      const queuedPayload = stablePayload(desired);
      if (queuedPayload === lastRemotePayload) {
        clearPendingSnapshot(queuedPayload);
        return { queued: false, revision: lastRevision };
      }
      let result;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const baseRevision = lastRevision;
        try {
          result = await raceAdmin({
            action: "save",
            pin: adminPin,
            expectedRevision: baseRevision,
            snapshot: desired,
          });
          if (result.data?.conflict) {
            if (attempt > 0) throw new Error("Race data changed on another device. Reload and repeat the action.");
            const current = await getDoc(raceRef);
            if (!current.exists()) throw new Error("The latest race data could not be loaded.");
            lastRevision = current.data().revision || result.data.revision || 0;
            continue;
          }
          break;
        } catch (error) {
          if (error.code !== "functions/aborted" || attempt > 0) throw error;
          const current = await getDoc(raceRef);
          if (!current.exists()) throw error;
          lastRevision = current.data().revision || 0;
        }
      }
      if (!result?.data?.revision) throw new Error("The race update was not confirmed.");
      lastRevision = result.data.revision;
      lastRemotePayload = queuedPayload;
      lastRemote = desired;
      clearPendingSnapshot(queuedPayload);
      return { queued: false, revision: lastRevision };
    }).catch((error) => {
      if (isConnectionError(error)) {
        updateStatus({ state: "offline", pending: true, message: "Offline — changes saved on this device" });
        return { queued: true };
      }
      throw error;
    }).finally(() => {
      pendingWrites = Math.max(0, pendingWrites - 1);
    });
    return writeQueue;
  };

  function flushPendingSnapshot() {
    if (!pendingSnapshot || !isAdmin() || !navigator.onLine) return Promise.resolve({ queued: Boolean(pendingSnapshot) });
    return sendSnapshot(clone(pendingSnapshot));
  }

  const saveSnapshot = (nextSnapshot) => {
    const desired = clone(nextSnapshot);
    const payload = stablePayload(desired);
    if (payload === lastRemotePayload && !pendingSnapshot) return Promise.resolve({ queued: false });
    if (!isAdmin()) return Promise.reject(new Error("Admin mode is required to save changes."));
    if (new TextEncoder().encode(payload).length > MAX_SNAPSHOT_BYTES) {
      return Promise.reject(new Error("The race history is too large to save safely."));
    }
    storePendingSnapshot(desired);
    if (!navigator.onLine) return Promise.resolve({ queued: true });
    return sendSnapshot(desired);
  };

  window.addEventListener("offline", () => {
    updateStatus({
      state: "offline",
      pending: Boolean(pendingSnapshot),
      message: pendingSnapshot ? "Offline — changes saved on this device" : "Offline",
    });
  });
  window.addEventListener("online", () => {
    updateStatus({
      state: pendingSnapshot ? "pending" : "synced",
      pending: Boolean(pendingSnapshot),
      message: pendingSnapshot ? "Connection restored — synchronizing…" : "Online",
    });
    if (pendingSnapshot && isAdmin()) void flushPendingSnapshot();
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (lastRemote) listener(clone(lastRemote));
      return () => listeners.delete(listener);
    },
    subscribeStatus(listener) {
      statusListeners.add(listener);
      listener({ ...syncStatus });
      return () => statusListeners.delete(listener);
    },
    getSyncStatus() {
      return { ...syncStatus };
    },
    saveSnapshot,
    loginAdmin,
    logoutAdmin,
    isAdmin,
  };
};

const showStartupError = (error) => {
  console.error(error);
  const root = document.getElementById("root");
  root.innerHTML = `<div style="min-height:100vh;background:#ddd4c3;color:#2c2a24;display:grid;place-items:center;font-family:system-ui;padding:24px"><div style="max-width:560px;text-align:center"><h1 style="font-size:24px">Unable to connect to the race</h1><p style="color:#6d6556">Check the internet connection and reload this page.</p></div></div>`;
};

try {
  window.MuwciRaceStore = await createStore();
  const script = document.createElement("script");
  script.type = "module";
  script.src = APP_SCRIPT;
  script.defer = true;
  script.onerror = () => showStartupError(new Error("The application failed to load."));
  document.body.appendChild(script);
} catch (error) {
  showStartupError(error);
}
