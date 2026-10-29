import React, { useState, useEffect } from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Platform,
  TextInput,
  ActivityIndicator,
} from "react-native";
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
    // nginx only lets a tracker token POST to exactly "/app3/" (trailing slash)
    const res = await fetch(`${base}/app3/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ id: String(DEVICE_ID), points: batch }),
    });

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
    // offline: points stay queued
  } finally {
    flushing = false;
  }
}

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error || !data) return;

  // Logged out or token invalid: stop tracking and save battery.
  const token = await getToken();
  if (!token) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => {});
    return;
  }

  const points = data.locations
    .filter((l) => l.coords.accuracy != null && l.coords.accuracy <= 25)
    .map((l) => ({
      lat: l.coords.latitude,
      lon: l.coords.longitude,
      acc: l.coords.accuracy,
      ts: Math.floor(l.timestamp / 1000),
    }));

  if (points.length) await enqueue(points);
  await flushQueue();
});

// ---------- UI ----------
export default function App() {
  const [ready, setReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [isTracking, setIsTracking] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);

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
      await clearToken();
      await AsyncStorage.removeItem(QUEUE_KEY); // don't send old points under a new login
      setIsTracking(false);
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
      const isRunning =
        await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
      if (isRunning) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME).catch(
          () => {},
        );
      }
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 3000,
        distanceInterval: 0, // backend filters jitter; keeps "online" alive when standing still
        foregroundService: {
          notificationTitle: "Tracking active",
          notificationBody: "Your location is being shared.",
        },
      });
      setIsTracking(true);
      setStatusText("Tracking live...");
    }
  };

  if (!ready) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  // ----- login screen -----
  if (!loggedIn) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>GPS Tracker</Text>
        <Text style={styles.subtitle}>Log in to start tracking</Text>

        <View style={styles.inputContainer}>
          <Text style={styles.label}>Server</Text>
          <TextInput
            style={styles.input}
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="https://cs317.duckdns.org"
            placeholderTextColor="#555"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>

        <View style={styles.inputContainer}>
          <Text style={styles.label}>Username</Text>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            placeholder="Tracker username"
            placeholderTextColor="#555"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View style={styles.inputContainer}>
          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor="#555"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            onSubmitEditing={login}
          />
        </View>

        {!!loginError && <Text style={styles.error}>{loginError}</Text>}

        <TouchableOpacity
          style={[styles.button, styles.buttonStart, busy && styles.disabled]}
          onPress={login}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>LOG IN</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  }

  // ----- tracking screen -----
  return (
    <View style={styles.container}>
      <Text style={styles.title}>GPS Tracker</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Signed in as</Text>
        <Text style={styles.deviceId}>{username}</Text>
        <Text style={[styles.label, { marginTop: 12 }]}>Device ID</Text>
        <Text style={styles.deviceIdSmall} selectable={true}>
          {DEVICE_ID}
        </Text>
      </View>

      <View style={styles.statusContainer}>
        <View
          style={[
            styles.statusDot,
            { backgroundColor: isTracking ? "#28a745" : "#dc3545" },
          ]}
        />
        <Text style={styles.statusText}>
          {isTracking ? "Online & Tracking" : "Offline"}
        </Text>
      </View>
      {!!statusText && <Text style={styles.hint}>{statusText}</Text>}

      <TouchableOpacity
        style={[
          styles.button,
          isTracking ? styles.buttonStop : styles.buttonStart,
        ]}
        onPress={toggleTracking}
      >
        <Text style={styles.buttonText}>
          {isTracking ? "STOP TRACKING" : "START TRACKING"}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.linkButton, busy && styles.disabled]}
        onPress={logout}
        disabled={busy}
      >
        <Text style={styles.linkText}>Log out</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#121212",
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#ffffff",
    marginBottom: 10,
  },
  subtitle: { fontSize: 15, color: "#aaaaaa", marginBottom: 24 },
  button: {
    paddingVertical: 15,
    paddingHorizontal: 40,
    borderRadius: 8,
    minWidth: 200,
    alignItems: "center",
  },
  buttonStart: { backgroundColor: "#28a745" },
  buttonStop: { backgroundColor: "#dc3545" },
  buttonText: { color: "#ffffff", fontWeight: "bold", fontSize: 18 },
  disabled: { opacity: 0.5 },
  linkButton: { marginTop: 24, padding: 10 },
  linkText: { color: "#888888", fontSize: 16, textDecorationLine: "underline" },
  card: {
    backgroundColor: "#1e1e1e",
    padding: 20,
    borderRadius: 10,
    width: "80%",
    alignItems: "center",
    marginBottom: 20,
  },
  label: { color: "#888888", fontSize: 14, marginBottom: 5 },
  deviceId: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "bold",
    letterSpacing: 1,
  },
  deviceIdSmall: { color: "#cccccc", fontSize: 14 },
  statusContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  statusDot: { width: 12, height: 12, borderRadius: 6, marginRight: 8 },
  statusText: { color: "#aaaaaa", fontSize: 16 },
  hint: { color: "#777777", fontSize: 13, marginBottom: 24 },
  error: { color: "#ff6b6b", fontSize: 14, marginBottom: 14, width: "80%" },
  inputContainer: { width: "80%", marginBottom: 16 },
  input: {
    backgroundColor: "#1e1e1e",
    color: "#ffffff",
    padding: 15,
    borderRadius: 8,
    fontSize: 16,
    borderWidth: 1,
    borderColor: "#333",
  },
});
