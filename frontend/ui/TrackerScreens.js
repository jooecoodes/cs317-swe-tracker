import React from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

const colors = {
  background: "#f5f7fa",
  surface: "#ffffff",
  navy: "#1e3857",
  text: "#22344b",
  muted: "#637186",
  blue: "#285587",
  blueSoft: "#edf3fa",
  border: "#e1e7ef",
  green: "#26745d",
  greenSoft: "#eef7f2",
  red: "#ac4544",
  redSoft: "#fff4f2",
};

// Presentation only. All session, location and upload state stays in App.js.
function Screen({ children, centered = false }) {
  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[
            styles.scrollContent,
            centered && styles.centeredContent,
          ]}
          alwaysBounceVertical={false}
          bounces={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentInsetAdjustmentBehavior="automatic"
        >
          <View style={styles.content}>{children}</View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function Brand() {
  return (
    <View style={styles.brand} accessible accessibilityLabel="Northpoint Manpower Services">
      <Image
        source={require("../../assets/northpoint-logo.png")}
        style={styles.logo}
        resizeMode="contain"
        accessible={false}
      />
      <View style={styles.brandText}>
        <Text style={styles.brandName}>Northpoint</Text>
        <Text style={styles.brandSubtitle}>Manpower Services</Text>
      </View>
    </View>
  );
}

function LocationMark({ active = false }) {
  return (
    <View
      style={[
        styles.locationHalo,
        active && styles.locationHaloActive,
      ]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <View style={styles.locationRing}>
        <View style={[styles.pin, active && styles.pinActive]}>
          <View style={[styles.pinDot, active && styles.pinDotActive]} />
        </View>
      </View>
    </View>
  );
}

export function TrackerLoading() {
  return (
    <Screen centered>
      <Brand />
      <View style={styles.loadingCard} accessibilityLiveRegion="polite">
        <ActivityIndicator color={colors.blue} size="large" />
        <Text style={styles.loadingTitle}>Getting things ready…</Text>
        <Text style={styles.body}>Please wait a moment.</Text>
      </View>
    </Screen>
  );
}

export function TrackerLogin({
  serverUrl,
  setServerUrl,
  username,
  setUsername,
  password,
  setPassword,
  loginError,
  busy,
  login,
}) {
  return (
    <Screen centered>
      <Brand />
      <View style={styles.card}>
        <View style={styles.loginIntro}>
          <Text style={styles.title} accessibilityRole="header">Sign in</Text>
          <Text style={styles.body}>Use your tracker account.</Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label} nativeID="server-label">Server address</Text>
          <TextInput
            style={styles.input}
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="https://cs317.duckdns.org"
            placeholderTextColor={colors.muted}
            selectionColor={colors.blue}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Server address"
            accessibilityLabelledBy="server-label"
            accessibilityHint="Enter the website address provided by your administrator."
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label} nativeID="username-label">Username</Text>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            placeholder="Enter your tracker username"
            placeholderTextColor={colors.muted}
            selectionColor={colors.blue}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Username"
            accessibilityLabelledBy="username-label"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label} nativeID="password-label">Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Enter your password"
            placeholderTextColor={colors.muted}
            selectionColor={colors.blue}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            onSubmitEditing={login}
            accessibilityLabel="Password"
            accessibilityLabelledBy="password-label"
          />
        </View>

        {!!loginError && (
          <View style={styles.errorBox} accessibilityRole="alert" accessibilityLiveRegion="polite">
            <Text style={styles.errorTitle}>Unable to sign in</Text>
            <Text style={styles.errorText}>{loginError}</Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.primaryButton, busy && styles.disabled]}
          onPress={login}
          disabled={busy}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={busy ? "Signing in" : "Sign in"}
          accessibilityState={{ disabled: busy, busy }}
        >
          {busy && <ActivityIndicator color={colors.surface} />}
          <Text style={styles.primaryButtonText}>{busy ? "Signing in…" : "Sign in"}</Text>
        </TouchableOpacity>

        <Text style={styles.signinHelp}>Need access? Ask your administrator.</Text>
      </View>
    </Screen>
  );
}

export function TrackingScreen({ username, deviceId, isTracking, statusText, busy, toggleTracking, logout }) {
  return (
    <Screen centered>
      <Brand />
      <View style={[styles.trackingCard, isTracking && styles.trackingCardActive]}>
        <View style={styles.statusOverview}>
          <LocationMark active={isTracking} />
          <View style={styles.statusCopy} accessibilityLiveRegion="polite">
            <Text style={styles.statusTitle} accessibilityRole="header">
              {isTracking ? "Tracking is on" : "Tracking is off"}
            </Text>
            <Text style={styles.statusDescription}>
              {isTracking ? "Location updates are enabled." : "Start to share your location."}
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.primaryButton, styles.trackingButton, isTracking && styles.stopButton]}
          onPress={toggleTracking}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={isTracking ? "Stop tracking" : "Start tracking"}
        >
          <View style={isTracking ? styles.stopIcon : styles.startIcon} accessible={false} />
          <Text style={styles.primaryButtonText}>{isTracking ? "Stop tracking" : "Start tracking"}</Text>
        </TouchableOpacity>
        {!!statusText && <Text style={styles.statusHint} accessibilityLiveRegion="polite">{statusText}</Text>}

        <View style={styles.deviceDetails}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Signed in as</Text>
            <Text style={styles.accountName} selectable>{username}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Device ID</Text>
            <Text style={styles.deviceId} selectable>{deviceId}</Text>
          </View>
        </View>
      </View>

      <Text style={styles.trackingTip}>Keep location access and internet on.</Text>
      <TouchableOpacity
        style={[styles.signoutButton, busy && styles.disabled]}
        onPress={logout}
        disabled={busy}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={busy ? "Signing out" : "Sign out"}
        accessibilityState={{ disabled: busy, busy }}
      >
        {busy && <ActivityIndicator color={colors.red} />}
        <Text style={styles.signoutText}>{busy ? "Signing out…" : "Sign out"}</Text>
      </TouchableOpacity>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingTop: (Platform.OS === "android" ? StatusBar.currentHeight || 24 : Platform.OS === "ios" ? 44 : 0) + 12,
    paddingBottom: 24,
  },
  centeredContent: { justifyContent: "center" },
  content: { width: "100%", maxWidth: 480, alignSelf: "center" },
  brand: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 18 },
  logo: { width: 42, height: 42 },
  brandText: { flexShrink: 1 },
  brandName: { color: colors.navy, fontSize: 26, fontWeight: "700", letterSpacing: -0.8 },
  brandSubtitle: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, padding: 20 },
  loginIntro: { marginBottom: 18 },
  title: { color: colors.navy, fontSize: 30, fontWeight: "700", letterSpacing: -0.8, marginBottom: 8 },
  body: { color: colors.muted, fontSize: 16, lineHeight: 25 },
  field: { marginBottom: 14 },
  label: { color: colors.text, fontSize: 16, lineHeight: 24, fontWeight: "600", marginBottom: 6 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: "#cbd5e2",
    borderRadius: 9,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 17,
  },
  primaryButton: {
    minHeight: 56,
    borderRadius: 10,
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: colors.blue,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
  },
  primaryButtonText: { flexShrink: 1, color: colors.surface, fontSize: 18, lineHeight: 26, fontWeight: "700", textAlign: "center" },
  disabled: { opacity: 0.65 },
  signinHelp: { color: colors.muted, fontSize: 14, lineHeight: 22, textAlign: "center", marginTop: 16 },
  errorBox: { backgroundColor: colors.redSoft, borderWidth: 1, borderColor: "#efd0cb", borderRadius: 9, padding: 14, marginBottom: 20 },
  errorTitle: { color: colors.red, fontSize: 16, fontWeight: "700", lineHeight: 24, marginBottom: 4 },
  errorText: { color: "#8f3935", fontSize: 15, lineHeight: 24 },
  trackingCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 18, padding: 24 },
  trackingCardActive: { borderColor: "#c7dfd2" },
  locationHalo: { width: 64, height: 64, borderRadius: 32, flexShrink: 0, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  locationHaloActive: { backgroundColor: colors.greenSoft },
  locationRing: { width: 50, height: 50, borderRadius: 25, borderWidth: 1, borderColor: "#d6e1ed", alignItems: "center", justifyContent: "center" },
  pin: { width: 31, height: 31, borderWidth: 3, borderColor: colors.blue, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderBottomLeftRadius: 18, borderBottomRightRadius: 4, transform: [{ rotate: "45deg" }], marginTop: -9, alignItems: "center", justifyContent: "center" },
  pinActive: { borderColor: colors.green },
  pinDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.blue },
  pinDotActive: { backgroundColor: colors.green },
  statusOverview: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 20 },
  statusCopy: { flex: 1, minWidth: 0 },
  statusTitle: { color: colors.navy, fontSize: 23, fontWeight: "700", letterSpacing: -0.5, marginBottom: 6 },
  statusDescription: { color: colors.muted, fontSize: 16, lineHeight: 24 },
  trackingButton: { width: "100%" },
  stopButton: { backgroundColor: colors.red },
  startIcon: { width: 0, height: 0, borderTopWidth: 7, borderBottomWidth: 7, borderLeftWidth: 11, borderTopColor: "transparent", borderBottomColor: "transparent", borderLeftColor: colors.surface },
  stopIcon: { width: 13, height: 13, borderRadius: 2, backgroundColor: colors.surface },
  statusHint: { color: colors.muted, fontSize: 14, lineHeight: 22, textAlign: "center", marginTop: 14 },
  detailRow: { gap: 5 },
  detailLabel: { color: colors.muted, fontSize: 14, lineHeight: 22 },
  accountName: { color: colors.text, fontSize: 18, fontWeight: "600", lineHeight: 27 },
  deviceDetails: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 16, marginTop: 18, gap: 12 },
  trackingTip: { color: colors.muted, fontSize: 14, lineHeight: 22, textAlign: "center", marginTop: 16 },
  deviceId: { color: colors.text, fontSize: 15, lineHeight: 24 },
  signoutButton: { minHeight: 52, padding: 12, borderWidth: 1, borderColor: "#e8cfcc", borderRadius: 10, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 14 },
  signoutText: { color: colors.red, fontSize: 17, lineHeight: 25, fontWeight: "600" },
  loadingCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 18, padding: 32, alignItems: "center", gap: 12 },
  loadingTitle: { color: colors.navy, fontSize: 20, fontWeight: "600", textAlign: "center", marginTop: 8 },
});
