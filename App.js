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

// 1. The Background Task (Runs even if the app is closed)
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error(error);
    return;
  }
  if (data) {
    const { locations } = data;
    const loc = locations[0]; // Grab the newest coordinate

    // Package the data exactly how Traccar did (Form Data)
    const formData = new FormData();
    formData.append("id", String(DEVICE_ID));
    formData.append("lat", String(loc.coords.latitude));
    formData.append("lon", String(loc.coords.longitude));
    formData.append("timestamp", String(Math.floor(loc.timestamp / 1000)));

    // Fire the HTTP POST request to your FastAPI server
    try {
      // Pull the URL from the phone's storage
      const savedUrl = await AsyncStorage.getItem("server_url");
      if (!savedUrl) {
        console.log("No server URL configured.");
        return;
      }

      await fetch(savedUrl, {
        method: "POST",
        body: formData,
        headers: { "Content-Type": "multipart/form-data" },
      });
      console.log(
        "Ping sent:",
        loc.coords.latitude,
        loc.coords.longitude,
        DEVICE_ID,
      );
    } catch (err) {
      console.error("Server offline or unreachable");
    }
  }
});

// 2. The User Interface
export default function App() {
  const [isTracking, setIsTracking] = useState(false);
  const [statusText, setStatusText] = useState("Waiting for permissions...");
  const [serverUrl, setServerUrl] = useState("");

  useEffect(() => {
    (async () => {
      // Load the saved URL when the app opens
      const saved = await AsyncStorage.getItem("server_url");
      if (saved) setServerUrl(saved);

      // Ask for foreground and background permissions
      const fg = await Location.requestForegroundPermissionsAsync();
      const bg = await Location.requestBackgroundPermissionsAsync();

      if (fg.status !== "granted" || bg.status !== "granted") {
        setStatusText("Permission denied. Cannot track.");
        return;
      }
      setStatusText("Ready to track.");
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
        accuracy: Location.Accuracy.High,
        timeInterval: 5000,
        distanceInterval: 0,
        showsBackgroundLocationIndicator: true,
      });
      setIsTracking(true);
      setStatusText("Tracking live...");
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>GPS Tracker</Text>

      {/* --- NEW: Device ID Card --- */}
      <View style={styles.card}>
        <Text style={styles.label}>Device ID</Text>
        <Text style={styles.deviceId} selectable={true}>
          {DEVICE_ID}
        </Text>
      </View>

      {/* --- NEW: URL Input Field --- */}
      <View style={styles.inputContainer}>
        <Text style={styles.label}>Server URL</Text>
        <TextInput
          style={styles.input}
          value={serverUrl}
          onChangeText={async (text) => {
            setServerUrl(text);
            await AsyncStorage.setItem("server_url", text);
          }}
          placeholder="https://...ngrok-free.app"
          placeholderTextColor="#555"
          autoCapitalize="none"
          keyboardType="url"
        />
      </View>

      {/* --- NEW: Red/Green Status Dot --- */}
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
  // Add these inside your existing styles object
  card: {
    backgroundColor: "#1e1e1e",
    padding: 20,
    borderRadius: 10,
    width: "80%",
    alignItems: "center",
    marginBottom: 30,
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
    marginBottom: 40,
  },
  statusDot: { width: 12, height: 12, borderRadius: 6, marginRight: 8 },
  statusText: { color: "#aaaaaa", fontSize: 16 },
  inputContainer: { width: "80%", marginBottom: 30 },
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
