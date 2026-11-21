import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';
import {Platform} from 'react-native';
import {subscribePhotos} from './photo-queue';

const CHANNEL_ID = 'photo-status-silent';
const STATUS_ID = 'northpoint-photo-status';
const APP_NAME = Application.applicationName || 'tracker-app';
let initialized = false;
let channelReady = false;
let lastKey = '';

// Quiet tray-only behavior: show in notification shade without popping down as a heads-up banner.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: false,
    shouldShowList: true,
  }),
});

async function ensureChannel() {
  if (channelReady || Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Photo Upload Status',
      importance: Notifications.AndroidImportance.LOW,
      sound: null,
      enableVibrate: false,
      showBadge: false,
    });
    channelReady = true;
  } catch { /* Never block tracking or photo delivery if channel setup fails. */ }
}

export async function ensureNotificationPermission() {
  try {
    await ensureChannel();
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    const requested = await Notifications.requestPermissionsAsync();
    return !!requested.granted;
  } catch {
    return false;
  }
}

function buildBody(event) {
  switch (event?.type) {
    case 'sending':
      return 'Sending photo…';
    case 'sent':
      return 'Photo sent — HR can now see your work photo.';
    case 'title-sent':
      return 'Photo title updated — HR can now see your correction.';
    case 'saved':
    case 'waiting':
      return 'Photo waiting to send — Saved on this phone. Will upload automatically when connected.';
    case 'paused':
      return `Photo upload paused — ${event.message || 'Saved photos will retry automatically when connected.'}`;
    case 'blocked':
      return `Photo needs attention — Open ${APP_NAME} to check your photo outbox and retry.`;
    default:
      return '';
  }
}

async function postStatusNotification(event) {
  const body = buildBody(event);
  if (!body) return;
  const key = `${event.type}:${event.id || ''}:${body}`;
  if (key === lastKey) return;
  lastKey = key;
  try {
    const perms = await Notifications.getPermissionsAsync();
    if (!perms.granted) return;
    await ensureChannel();
    await Notifications.scheduleNotificationAsync({
      identifier: STATUS_ID,
      content: {
        title: APP_NAME,
        body,
        color: '#285587',
        data: {type: event.type},
      },
      trigger: Platform.OS === 'android' ? {channelId: CHANNEL_ID} : null,
    });
  } catch { /* Notifications are best-effort and must never affect upload retries. */ }
}

export function startPhotoNotifications() {
  if (initialized) return;
  initialized = true;
  subscribePhotos(event => {
    void postStatusNotification(event);
  });
}
