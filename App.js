import {filterGpsFixes} from './frontend/ui/gps-quality';
import {startPhotoSync} from './frontend/ui/photo-queue';
import {ensureNotificationPermission, startPhotoNotifications} from './frontend/ui/photo-notifications';
import PhotoUpload from './frontend/ui/PhotoUpload';
import React, { useState, useEffect } from "react";
import { Platform } from "react-native";
import {
  TrackerLoading,
  TrackerLogin,
  TrackingScreen,
} from "./frontend/ui/TrackerScreens";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import * as Application from "expo-application";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

const LOCATION_TASK_NAME = "background-location-task";
const DEVICE_ID =
  Platform.OS === "android"
    ? typeof Application.getAndroidId === "function"
      ? Application.getAndroidId()
      : Application.androidId
    : "unknown-device";

const QUEUE_KEY = "point_queue";
const TOKEN_KEY = "device_token"; // kept in SecureStore
const USER_KEY = "tracker_username";
const URL_KEY = "server_url";
const MAX_QUEUE = 5000;
let flushing = false;
let gpsWrites = Promise.resolve();
const GPS_ANCHOR_KEY = 'northpoint_gps_anchor_v1';

// ---------- helpers ----------

// The user types the site address only, e.g. https://cs317.duckdns.org
// (an old saved "…/app3/" value is cleaned up automatically)
function normalizeBase(url) {
  return (url || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/app3$/, "")
    .replace(/\/+$/, "");
}

const getToken = () => SecureStore.getItemAsync(TOKEN_KEY);
const setToken = (t) => SecureStore.setItemAsync(TOKEN_KEY, t);
const clearToken = () => SecureStore.deleteItemAsync(TOKEN_KEY);

async function enqueue(points) {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  const queue = raw ? JSON.parse(raw) : [];
  const next = [...queue, ...points].slice(-MAX_QUEUE); // keep newest
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(next));
}

async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    const base = normalizeBase(await AsyncStorage.getItem(URL_KEY));
    const token = await getToken();
    if (!base || !token) return;

    const queue = JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) || "[]");
    if (!queue.length) return;

    const batch = queue.slice(0, 100);

    // abort the request if it hangs (weak mobile data)
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);

    let res;
    try {
      // nginx only lets a tracker token POST to exactly "/app3/" (trailing slash)
      res = await fetch(`${base}/app3/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id: String(DEVICE_ID), points: batch }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      // Token expired, revoked, or account disabled. Keep the queued points
      // and wait for a new login instead of retrying forever.
      await clearToken();
      return;
    }
    if (!res.ok) return; // other errors: retry next time

    // re-read: new points may have been queued while sending
    const latest = JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) || "[]");
    await AsyncStorage.setItem(
      QUEUE_KEY,
      JSON.stringify(latest.slice(batch.length)),
    );
  } catch {
    // offline or timed out: points stay queued
  } finally {
    flushing = false;
  }
}

startPhotoNotifications();

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error || !data) return;

  // Logged out or token invalid: stop tracking and save battery.
  const token = await getToken();
  if (!token) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => {});
    return;
  }

  // Serialize callbacks so the accepted anchor and persisted queue stay ordered.
  const job = gpsWrites.then(async () => {
    if (await getToken() !== token) return;
    const scope = normalizeBase(await AsyncStorage.getItem(URL_KEY)) + ':' + (await AsyncStorage.getItem(USER_KEY));
    const saved = JSON.parse((await AsyncStorage.getItem(GPS_ANCHOR_KEY)) || 'null');
    const result = filterGpsFixes(data.locations || [], saved?.scope === scope ? saved.anchor : null);
    if (result.points.length) {
      await enqueue(result.points);
      await AsyncStorage.setItem(GPS_ANCHOR_KEY, JSON.stringify({scope,anchor:result.anchor}));
    }
  });
  gpsWrites = job.catch(() => {});
  await job;
  await flushQueue();
});

// ---------- UI ----------
export default function App() {
  const [photoBusy, setPhotoBusy] = useState(false);
  const [employeeName, setEmployeeName] = useState("");
  const [ready, setReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [isTracking, setIsTracking] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => startPhotoSync(), []);

  // On open: load saved values, check the session, ask for permissions
  useEffect(() => {
    (async () => {
      const savedUrl = await AsyncStorage.getItem(URL_KEY);
      if (savedUrl) setServerUrl(normalizeBase(savedUrl));
      const savedUser = await AsyncStorage.getItem(USER_KEY);
      if (savedUser) setUsername(savedUser);

      setLoggedIn(!!(await getToken()));

      const fg = await Location.requestForegroundPermissionsAsync();
      const bg = await Location.requestBackgroundPermissionsAsync();
      if (fg.status !== "granted" || bg.status !== "granted") {
        setStatusText("Permission denied. Cannot track.");
      }
      await ensureNotificationPermission();

      const running = await Location.hasStartedLocationUpdatesAsync(
        LOCATION_TASK_NAME,
      ).catch(() => false);
      setIsTracking(running);
      setReady(true);
    })();
  }, []);

  // The background task clears the token on a 401. Notice that here.
  useEffect(() => {
    const id = setInterval(async () => {
      const has = !!(await getToken());
      if (!has && loggedIn) {
        setLoggedIn(false);
        setIsTracking(false);
        setLoginError("Session expired or revoked. Please log in again.");
      }
    }, 5000);
    return () => clearInterval(id);
  }, [loggedIn]);

  // Stop tracking cleanly if the employee turns off phone GPS in device settings.
  useEffect(() => {
    if (!isTracking) return;
    let active = true;
    const checkGps = async () => {
      const enabled = await Location.hasServicesEnabledAsync().catch(() => true);
      if (!active || enabled) return;
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => {});
      if (!active) return;
      setIsTracking(false);
      setStatusText("Phone GPS is off. Tracking stopped.");
    };
    void checkGps();
    const id = setInterval(() => {
      void checkGps();
    }, 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [isTracking]);

  const login = async () => {
    const base = normalizeBase(serverUrl);
    if (!base || !username.trim() || !password) {
      setLoginError("Fill in the server, username and password.");
      return;
    }
    setBusy(true);
    setLoginError("");
    try {
      const res = await fetch(`${base}/auth/device-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          device_id: String(DEVICE_ID),
        }),
      });
      if (res.status === 401) {
        setLoginError("Wrong username or password.");
      } else if (res.status === 503 || res.status === 429) {
        setLoginError("Too many attempts. Wait a minute and try again.");
      } else if (!res.ok) {
        setLoginError(`Login failed (${res.status}).`);
      } else {
        const body = await res.json();
        await setToken(body.token);
        await AsyncStorage.setItem(URL_KEY, base);
        await AsyncStorage.setItem(USER_KEY, username.trim());
        setPassword(""); // never keep the password
        setLoggedIn(true);
        setStatusText("Ready to track.");
      }
    } catch {
      setLoginError(
        "Can't reach the server. Check the address and your connection.",
      );
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      const base = normalizeBase(await AsyncStorage.getItem(URL_KEY));
      const token = await getToken();
      if (base && token) {
        // Best effort. If offline, the token is still deleted locally.
        await fetch(`${base}/auth/device-logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
      if (isTracking) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME).catch(
          () => {},
        );
      }
      await gpsWrites;
      await clearToken();
      await AsyncStorage.removeItem(GPS_ANCHOR_KEY);
      await AsyncStorage.removeItem(QUEUE_KEY); // don't send old points under a new login
      setIsTracking(false);
      setEmployeeName("");
      setPhotoBusy(false);
      setLoggedIn(false);
      setLoginError("");
    } finally {
      setBusy(false);
    }
  };

  const toggleTracking = async () => {
    if (isTracking) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      setIsTracking(false);
      setStatusText("Tracking stopped.");
    } else {
      const gpsEnabled = await Location.hasServicesEnabledAsync().catch(() => true);
      if (!gpsEnabled) {
        setStatusText("Turn on phone GPS to start tracking.");
        return;
      }
      const isRunning =
        await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
      if (isRunning) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME).catch(
          () => {},
        );
      }
      await ensureNotificationPermission();
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 3000,
        distanceInterval: 0, // backend filters jitter; keeps "online" alive when standing still
        foregroundService: {
          notificationTitle: "Tracking active",
          notificationBody: "Your location is being shared.",
          notificationColor: "#285587",
          killServiceOnDestroy: false,
        },
      });
      setIsTracking(true);
      setStatusText("Tracking live...");
    }
  };

  if (!ready) {
    return <TrackerLoading />;
  }

  if (!loggedIn) {
    return (
      <TrackerLogin
        serverUrl={serverUrl}
        setServerUrl={setServerUrl}
        username={username}
        setUsername={setUsername}
        password={password}
        setPassword={setPassword}
        loginError={loginError}
        busy={busy}
        login={login}
      />
    );
  }

  return (
    <TrackingScreen
      username={employeeName || username}
      photoContent={<PhotoUpload baseUrl={normalizeBase(serverUrl)} getToken={getToken} onBusyChange={setPhotoBusy} onIdentity={setEmployeeName} />}
      isTracking={isTracking}
      statusText={statusText}
      busy={busy || photoBusy}
      signingOut={busy}
      toggleTracking={toggleTracking}
      logout={logout}
    />
  );
}
