import React, { useState, useEffect } from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Platform,
  TextInput,
} from "react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import * as Application from "expo-application";
import AsyncStorage from "@react-native-async-storage/async-storage";

const LOCATION_TASK_NAME = "background-location-task";
const DEVICE_ID =
  Platform.OS === "android"
    ? typeof Application.getAndroidId === "function"
      ? Application.getAndroidId()
      : Application.androidId
    : "unknown-device";

const QUEUE_KEY = "point_queue";
const TOKEN_KEY = "device_token"; // NEW
const MAX_QUEUE = 5000; // NEW: a wrong token must not grow the queue forever
let flushing = false;

// NEW: nginx only lets a device token POST to exactly "/app3/" (trailing slash)
function normalizeUrl(url) {
  const u = (url || "").trim();
  if (!u) return "";
  return u.endsWith("/") ? u : u + "/";
}

async function enqueue(points) {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  const queue = raw ? JSON.parse(raw) : [];
  const next = [...queue, ...points].slice(-MAX_QUEUE); // NEW: keep newest
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(next));
}

async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    const url = normalizeUrl(await AsyncStorage.getItem("server_url")); // CHANGED
    if (!url) return;
    const token = ((await AsyncStorage.getItem(TOKEN_KEY)) || "").trim(); // NEW
    const queue = JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) || "[]");
    if (!queue.length) return;

    const batch = queue.slice(0, 100);

    // NEW: attach the bearer token when one is set
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: String(DEVICE_ID), points: batch }),
    });
    // 401 = missing/wrong/revoked token. Points stay queued and retry later.
    if (!res.ok) return;

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

// 2. The User Interface
export default function App() {
  const [isTracking, setIsTracking] = useState(false);
  const [statusText, setStatusText] = useState("Waiting for permissions...");
  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState(""); // NEW

  useEffect(() => {
    (async () => {
      // Load the saved URL and token when the app opens
      const saved = await AsyncStorage.getItem("server_url");
      if (saved) setServerUrl(saved);
      const savedToken = await AsyncStorage.getItem(TOKEN_KEY); // NEW
      if (savedToken) setToken(savedToken);

      // Ask for foreground and background permissions
      const fg = await Location.requestForegroundPermissionsAsync();
      const bg = await Location.requestBackgroundPermissionsAsync();

      if (fg.status !== "granted" || bg.status !== "granted") {
        setStatusText("Permission denied. Cannot track.");
        return;
      }
      setStatusText("Ready to track.");

      const running = await Location.hasStartedLocationUpdatesAsync(
        LOCATION_TASK_NAME,
      ).catch(() => false);
      if (running) {
        setIsTracking(true);
        setStatusText("Tracking live...");
      }
    })();
  }, []);

  const toggleTracking = async () => {
    if (isTracking) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      setIsTracking(false);
      setStatusText("Tracking stopped.");
    } else {
      // SAFETY CHECK: Kill any zombie tasks before starting a new one
      const isRunning =
        await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
      if (isRunning) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }

      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 3000,
        distanceInterval: 0, // backend filters jitter, and this keeps "online" status alive when you stand still
        foregroundService: {
          notificationTitle: "Tracking active",
          notificationBody: "Your location is being shared.",
        },
      });
      setIsTracking(true);
      setStatusText("Tracking live...");
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>GPS Tracker</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Device ID</Text>
        <Text style={styles.deviceId} selectable={true}>
          {DEVICE_ID}
        </Text>
      </View>

      <View style={styles.inputContainer}>
        <Text style={styles.label}>Server URL</Text>
        <TextInput
          style={styles.input}
          value={serverUrl}
          onChangeText={async (text) => {
            setServerUrl(text);
            await AsyncStorage.setItem("server_url", text);
          }}
          placeholder="https://cs317.duckdns.org/app3/"
          placeholderTextColor="#555"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </View>

      {/* NEW: Auth token field */}
      <View style={styles.inputContainer}>
        <Text style={styles.label}>Auth Token</Text>
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={async (text) => {
            setToken(text);
            await AsyncStorage.setItem(TOKEN_KEY, text);
          }}
          placeholder="Paste device token"
          placeholderTextColor="#555"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
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
  status: { fontSize: 16, color: "#aaaaaa", marginBottom: 40 },
  button: { paddingVertical: 15, paddingHorizontal: 40, borderRadius: 8 },
  buttonStart: { backgroundColor: "#28a745" },
  buttonStop: { backgroundColor: "#dc3545" },
  buttonText: { color: "#ffffff", fontWeight: "bold", fontSize: 18 },
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
  statusContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 30,
  },
  statusDot: { width: 12, height: 12, borderRadius: 6, marginRight: 8 },
  statusText: { color: "#aaaaaa", fontSize: 16 },
  inputContainer: { width: "80%", marginBottom: 20 }, // CHANGED: 30 -> 20 to fit the new field
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
