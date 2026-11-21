import {Directory, File, Paths} from 'expo-file-system';
import {fetch} from 'expo/fetch';
import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as Network from 'expo-network';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppState} from 'react-native';
import {sameEmployee, retryDelay, deliverPhoto, photoSyncError} from './photo-queue-core';

const TASK = 'northpoint-photo-outbox-v1';
const CACHE = 'northpoint_photo_identity_v1';
const folder = () => new Directory(Paths.document, 'northpoint-photo-outbox');
const photoFile = row => new File(folder(), row.filename);
const listeners = new Set();
let database, flight, rerun = false;
export const normalizePhotoBase = value => (value || '').trim().replace(/\/+$/, '').replace(/\/app3$/, '').replace(/\/+$/, '');
const notify = event => { for (const fn of listeners) { try { fn(event); } catch { /* UI must not affect delivery. */ } } };
export function subscribePhotos(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }

export const PHOTO_SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS photo_outbox (
 id TEXT PRIMARY KEY, base TEXT NOT NULL, tracker_id INTEGER NOT NULL,
 employee_id INTEGER NOT NULL, employee_code TEXT NOT NULL, filename TEXT NOT NULL,
 metadata TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 next_try INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
 lease_key TEXT, message TEXT NOT NULL DEFAULT 'Saved on this phone. Waiting to send.',
 server_id INTEGER, sent_at INTEGER
);
CREATE TABLE IF NOT EXISTS photo_title_edits (
 photo_id TEXT PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL,
 dirty INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,
 next_try INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
 lease_key TEXT, message TEXT NOT NULL DEFAULT 'Title saved on this phone. Waiting to sync.'
);
CREATE INDEX IF NOT EXISTS photo_outbox_scope ON photo_outbox(base,tracker_id,employee_id,state);
`;
async function db() {
  if (!database) database = (async () => {
    const result = await SQLite.openDatabaseAsync('northpoint-photo-outbox-v1.db');
    await result.execAsync(PHOTO_SCHEMA);
    return result;
  })().catch(error => { database = null; throw error; });
  return database;
}
async function session() {
  return {base: normalizePhotoBase(await AsyncStorage.getItem('server_url')),
    token: await SecureStore.getItemAsync('device_token')};
}
async function request(url, options, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {...options, signal: controller.signal});
    let body; try { body = await response.json(); } catch { /* HTML error from gateway, for example. */ }
    if (!response.ok) throw Object.assign(Error(typeof body?.detail === 'string' ? body.detail : `Server returned ${response.status}.`), {status: response.status});
    if (!body) throw Error('The server reply could not be read.');
    return body;
  } finally { clearTimeout(timer); }
}
async function fingerprint(base, token) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, base + '\n' + token);
}
export async function photoIdentity(base, token, allowCached = true) {
  base = normalizePhotoBase(base);
  if (!token) throw Error('Please sign in again.');
  const key = await fingerprint(base, token);
  try {
    const state = await Network.getNetworkStateAsync();
    if (state.isConnected === false || state.isInternetReachable === false) throw Error('Offline');
    const info = await request(`${base}/auth/device-me`, {headers: {Authorization: `Bearer ${token}`}});
    if (!info.full_name || !info.employee_id || !info.tracker_id || !info.employee_code)
      throw Object.assign(Error('Ask HR to link your account using Mobile App Access.'), {status: 403});
    // Cache only the verified identity, scoped to this token and server. Never a password/token.
    // Cache failure must not turn a successful online verification into a network error.
    try { await SecureStore.setItemAsync(CACHE, JSON.stringify({key, info})); } catch { /* Online delivery remains available. */ }
    return info;
  } catch (error) {
    if ([401, 403].includes(error.status)) {
      try { await SecureStore.deleteItemAsync(CACHE); } catch { /* Still refuse rejected credentials. */ }
      throw Error('Please sign in again, or ask HR to check your mobile access.');
    }
    if (allowCached) {
      try {
        const cached = JSON.parse(await SecureStore.getItemAsync(CACHE) || 'null');
        if (cached?.key === key) return cached.info;
      } catch { /* A missing or unreadable cache is not a verified identity. */ }
    }
    if (!allowCached) {
      const reason = error.status ? `Server returned ${error.status}.` :
        error.message === 'The server reply could not be read.' ? 'The server returned an unreadable reply.' :
        'The HR server could not be reached.';
      throw Error(`${reason} Saved photos are safe. We will retry automatically. Check that the computer, backend and server link are online.`);
    }
    throw Error('Connect to the HR server once to verify this account before saving offline photos.');
  }
}
export async function listPhotos(base, identity) {
  const connection = await db();
  return connection.getAllAsync(`SELECT photo_outbox.*, e.title AS edit_title, e.dirty AS title_pending, e.message AS title_message, e.lease_until AS title_lease_until
    FROM photo_outbox LEFT JOIN photo_title_edits e ON e.photo_id=photo_outbox.id
    WHERE base=? AND tracker_id=? AND employee_id=? AND employee_code=?
    ORDER BY (state='sent') ASC, created DESC LIMIT 103`, base, identity.tracker_id, identity.employee_id, identity.employee_code);
}
export async function editPhotoTitle(id, title, base, identity) {
  title = title.trim();
  if (!title || title.length > 120) throw Error('Please enter a photo title (up to 120 characters).');
  const current = await session();
  if (!current.token || current.base !== base) throw Error('Your session changed. Sign in with the same account before saving.');
  const checked = await photoIdentity(base, current.token);
  if (!sameEmployee(checked, identity)) throw Error('Sign in with the employee account that uploaded this photo.');
  const connection = await db();
  let changed = false;
  await connection.withExclusiveTransactionAsync(async tx => {
    const row = await tx.getFirstAsync('SELECT * FROM photo_outbox WHERE id=? AND base=? AND tracker_id=? AND employee_id=? AND employee_code=?',
      id, base, identity.tracker_id, identity.employee_id, identity.employee_code);
    if (!row) throw Error('This photo is no longer in this account’s outbox.');
    const metadata = JSON.parse(row.metadata);
    const edit = await tx.getFirstAsync('SELECT * FROM photo_title_edits WHERE photo_id=?', id);
    if ((edit?.title || metadata.title) === title && !edit?.dirty) return;
    await tx.runAsync(`INSERT INTO photo_title_edits(photo_id,title,revision) VALUES(?,?,1)
      ON CONFLICT(photo_id) DO UPDATE SET title=excluded.title,revision=photo_title_edits.revision+1,
      dirty=1,attempts=0,next_try=0,message='Title saved on this phone. Waiting to sync.'`, id, title);
    changed = true;
    // Never mutate the payload of an upload that could already have reached the server.
    // The separate durable edit will apply after its original receipt is recovered.
    if (row.state !== 'sent' && row.attempts === 0 && !row.lease_key) {
      await tx.runAsync('UPDATE photo_outbox SET metadata=? WHERE id=?', JSON.stringify({...metadata, title}), id);
    }
  });
  if (!changed) return;
  notify({type: 'title-saved', id});
  void ensurePhotoBackgroundTask();
  void syncPhotos();
}

async function flushTitleEdits(connection, current, identity, deadline) {
  for (let count=0; count<5 && Date.now()+10000<=deadline; count++) {
    const row = await connection.getFirstAsync(`SELECT o.*,e.title AS edit_title,e.revision,e.attempts AS edit_attempts
      FROM photo_outbox o JOIN photo_title_edits e ON e.photo_id=o.id
      WHERE o.base=? AND o.tracker_id=? AND o.employee_id=? AND o.employee_code=? AND o.state='sent'
      AND e.dirty=1 AND e.next_try<=? AND e.lease_until<=? ORDER BY o.created LIMIT 1`,
      current.base, identity.tracker_id, identity.employee_id, identity.employee_code, Date.now(), Date.now());
    if (!row) return;
    const lease = Crypto.randomUUID();
    const claimed = await connection.runAsync('UPDATE photo_title_edits SET lease_key=?,lease_until=? WHERE photo_id=? AND revision=? AND dirty=1 AND lease_until<=?',
      lease, Date.now()+60000, row.id, row.revision, Date.now());
    if (!claimed.changes) continue;
    try {
      const fresh = await session();
      if (fresh.token !== current.token || fresh.base !== current.base) throw Error('Session changed.');
      const receipt = await request(`${row.base}/app2/mobile-photos/${row.server_id}/title`, {
        method: 'PATCH', headers: {Authorization: `Bearer ${current.token}`, 'Content-Type':'application/json'},
        body: JSON.stringify({upload_id:row.id,revision:row.revision,title:row.edit_title,
          expected_tracker_id:row.tracker_id,expected_employee_id:row.employee_id,expected_employee_code:row.employee_code})
      });
      if (receipt.id !== row.server_id || receipt.upload_id !== row.id || receipt.revision !== row.revision ||
          receipt.title !== row.edit_title || !sameEmployee(receipt, row))
        throw Error('The title reply did not match this edit. Your correction is still saved on this phone.');
      const updated = await connection.runAsync("UPDATE photo_title_edits SET dirty=0,message='Title updated. HR can see the correction.' WHERE photo_id=? AND revision=? AND lease_key=?", row.id, row.revision, lease);
      if (updated.changes) notify({type:'title-sent',id:row.id});
    } catch (error) {
      const message = photoSyncError(error, 'Title correction');
      await connection.runAsync('UPDATE photo_title_edits SET attempts=attempts+1,next_try=?,message=? WHERE photo_id=? AND revision=? AND lease_key=?',
        Date.now()+retryDelay(row.edit_attempts), message, row.id, row.revision, lease);
      notify({type:'title-waiting',id:row.id});
      // Continue to other due items; one failed correction must not block them.
    } finally {
      // A newer edit keeps its own revision and retry state while this lease is released.
      await connection.runAsync('UPDATE photo_title_edits SET lease_key=NULL,lease_until=0 WHERE photo_id=? AND lease_key=?', row.id, lease);
    }
  }
}

export async function savePhoto(draft, base, identity) {
  if(typeof draft.metadata.title!=='string'||!draft.metadata.title.trim()||draft.metadata.title.trim().length>120)throw Error('Please enter a photo title (up to 120 characters) before sending.');
  const current = await session();
  if (!current.token || current.base !== base) throw Error('Your session changed. Sign in with the same account before saving.');
  const checked = await photoIdentity(base, current.token);
  if (!sameEmployee(checked, identity)) throw Error('Your employee account changed. Select the photo again.');
  const connection = await db();
  const existing = await connection.getFirstAsync('SELECT id FROM photo_outbox WHERE id=?', draft.metadata.upload_id);
  if (existing) return draft.metadata.upload_id;
  const directory = folder(); directory.create({idempotent: true, intermediates: true});
  const filename = draft.metadata.upload_id + '.jpg';
  const target = new File(directory, filename);
  // SDK 57 copy() is asynchronous. Await completion before checking or recording the file.
  try {
    if (target.exists) target.delete(); // Uncommitted copy from a previous interrupted save.
    await new File(draft.uri).copy(target);
    if (!target.exists || !target.size) throw Error('Could not save the photo. Free some phone storage and try again.');
    await connection.withExclusiveTransactionAsync(async tx => {
      const totals = await tx.getFirstAsync("SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM photo_outbox WHERE state!='sent'");
      if (totals.count >= 100 || totals.bytes + target.size > 200 * 1024 * 1024)
        throw Error('Your photo outbox is full. Connect to send your saved photos before adding more.');
      const exifTakenAt = typeof draft.metadata.exif_taken_at === 'string' && !Number.isNaN(Date.parse(draft.metadata.exif_taken_at))
        ? draft.metadata.exif_taken_at.trim() : null;
      const metadata = {...draft.metadata,
        ...('exif_taken_at' in draft.metadata ? {exif_taken_at: exifTakenAt} : {}),
        expected_tracker_id: identity.tracker_id,
        expected_employee_id: identity.employee_id, expected_employee_code: identity.employee_code};
      await tx.runAsync(`INSERT INTO photo_outbox(id,base,tracker_id,employee_id,employee_code,filename,metadata,bytes,created)
        VALUES(?,?,?,?,?,?,?,?,?)`, draft.metadata.upload_id, base, identity.tracker_id, identity.employee_id,
        identity.employee_code, filename, JSON.stringify(metadata), target.size, Date.now());
    });
  } catch (error) {
    // If a competing save already committed, never remove its referenced file.
    if (!await connection.getFirstAsync('SELECT id FROM photo_outbox WHERE id=?', draft.metadata.upload_id)) {
      try { if (target.exists) target.delete(); } catch { /* Leave unreferenced file for recovery. */ }
    }
    throw error;
  }
  notify({type: 'saved', id: draft.metadata.upload_id});
  void ensurePhotoBackgroundTask();
  void syncPhotos();
  return draft.metadata.upload_id;
}
async function cleanConfirmed(connection) {
  const sent = await connection.getAllAsync("SELECT * FROM photo_outbox WHERE state='sent' AND NOT EXISTS (SELECT 1 FROM photo_title_edits e WHERE e.photo_id=photo_outbox.id AND e.dirty=1)");
  for (const row of sent) {
    try {
      const file = photoFile(row); if (file.exists) file.delete();
      // Keep a small receipt history, and retry file cleanup next time if deletion failed.
      if (row.sent_at < Date.now() - 7 * 86400000) await connection.runAsync("DELETE FROM photo_outbox WHERE id=? AND state='sent' AND NOT EXISTS (SELECT 1 FROM photo_title_edits e WHERE e.photo_id=photo_outbox.id AND e.dirty=1)", row.id);
    } catch { /* Cleanup is never an upload failure. */ }
  }
}
async function flush() {
  const deadline = Date.now() + 22000;
  const connection = await db();
  await cleanConfirmed(connection);
  const current = await session();
  if (!current.base || !current.token) return;
  const network = await Network.getNetworkStateAsync();
  if (network.isConnected === false || network.isInternetReachable === false) return;
  const any = await connection.getFirstAsync(`SELECT id FROM photo_outbox o WHERE base=? AND
    ((state='pending' AND next_try<=? AND lease_until<=?) OR
    (state='sent' AND EXISTS (SELECT 1 FROM photo_title_edits e WHERE e.photo_id=o.id AND e.dirty=1 AND e.next_try<=? AND e.lease_until<=?)))`,
    current.base, Date.now(), Date.now(), Date.now(), Date.now());
  if (!any) return;
  const identity = await photoIdentity(current.base, current.token, false);
  notify({type: 'verified'});
  await flushTitleEdits(connection, current, identity, deadline);
  // Small bounded batches: leave time for a complete request before claiming another file.
  for (let count = 0; count < 5 && Date.now() + 10000 <= deadline; count++) {
  const row = await connection.getFirstAsync(`SELECT * FROM photo_outbox WHERE base=? AND tracker_id=? AND employee_id=?
    AND employee_code=? AND state='pending' AND next_try<=? AND lease_until<=? ORDER BY created LIMIT 1`,
    current.base, identity.tracker_id, identity.employee_id, identity.employee_code, Date.now(), Date.now());
  if (!row) break;
  const lease = Crypto.randomUUID();
  const claimed = await connection.runAsync("UPDATE photo_outbox SET lease_key=?,lease_until=? WHERE id=? AND state='pending' AND lease_until<=?", lease, Date.now()+60000, row.id, Date.now());
  if (!claimed.changes) break;
  row.metadata = (await connection.getFirstAsync('SELECT metadata FROM photo_outbox WHERE id=?', row.id)).metadata;
  notify({type: 'sending', id: row.id});
  const outcome = await deliverPhoto(row, {
    send: async () => {
      const fresh = await session();
      if (fresh.token !== current.token || fresh.base !== current.base) throw Error('Session changed.');
      const file = photoFile(row);
      if (!file.exists) throw Object.assign(Error('The saved photo file is missing. Contact HR; this item cannot be sent.'), {status: 422});
      const form = new FormData(); form.append('file', file); form.append('metadata', row.metadata); form.append('title', JSON.parse(row.metadata).title || 'Untitled Photo');
      return request(`${row.base}/app2/mobile-upload`, {method: 'POST', headers: {Authorization: `Bearer ${current.token}`}, body: form}, 30000);
    },
    confirm: async (_, saved) => {
      const updated = await connection.runAsync("UPDATE photo_outbox SET state='sent',server_id=?,sent_at=?,lease_until=0,lease_key=NULL,message='Photo sent successfully. HR can now see it.' WHERE id=? AND lease_key=?", saved.id, Date.now(), row.id, lease);
      if (updated.changes) {
        notify({type: 'sent', id: row.id});
        await cleanConfirmed(connection);
      }
    },
    retain: async (_, blocked, message) => {
      await connection.runAsync('UPDATE photo_outbox SET state=?,attempts=attempts+1,next_try=?,lease_until=0,lease_key=NULL,message=? WHERE id=? AND lease_key=?',
        blocked ? 'blocked' : 'pending', Date.now()+retryDelay(row.attempts), message, row.id, lease);
      notify({type: blocked ? 'blocked' : 'waiting', id: row.id});
    }
  });
  if (outcome !== 'sent') continue;
  }
  await flushTitleEdits(connection, current, identity, deadline);
}
export async function syncPhotos() {
  if (flight) { rerun = true; return flight; }
  flight = (async () => {
    // A save during an active flush requests another pass, instead of losing its wake-up.
    for (let pass=0; pass<3; pass++) {
      rerun = false;
      try { await flush(); }
      catch (error) { notify({type:'paused',message:error.message || 'Saved items are waiting for the HR server.'}); }
      if (!rerun) break;
    }
  })().finally(() => { flight = null; });
  return flight;
}
export async function syncPhotosNow(base, identity) {
  // Let an active request finish before bypassing retry delays. Never break a live lease.
  if (flight) await flight;
  const current = await session();
  if (!current.token || current.base !== base) throw Error('Sign in with the account that saved these photos.');
  const checked = await photoIdentity(base, current.token);
  if (!sameEmployee(checked, identity)) throw Error('Sign in with the account that saved these photos.');
  const connection = await db();
  await connection.runAsync("UPDATE photo_outbox SET state='pending',next_try=0 WHERE base=? AND tracker_id=? AND employee_id=? AND employee_code=? AND state!='sent' AND lease_until<=?",
    base, identity.tracker_id, identity.employee_id, identity.employee_code, Date.now());
  await connection.runAsync(`UPDATE photo_title_edits SET next_try=0 WHERE dirty=1 AND photo_id IN
    (SELECT id FROM photo_outbox WHERE base=? AND tracker_id=? AND employee_id=? AND employee_code=?)`,
    base, identity.tracker_id, identity.employee_id, identity.employee_code);
  await syncPhotos();
  const network = await Network.getNetworkStateAsync();
  if (network.isConnected === false || network.isInternetReachable === false)
    notify({type:'paused',message:'You are offline. Your photos and title corrections are saved on this phone.'});
}
export async function ensurePhotoBackgroundTask() {
  try {
    if (await BackgroundTask.getStatusAsync() !== BackgroundTask.BackgroundTaskStatus.Available) return false;
    if (!await TaskManager.isTaskRegisteredAsync(TASK)) await BackgroundTask.registerTaskAsync(TASK, {minimumInterval: 15});
    return true;
  } catch { return false; }
}
// Defined at module scope: available when Android starts a headless JS task.
TaskManager.defineTask(TASK, async () => {
  await syncPhotos();
  return BackgroundTask.BackgroundTaskResult.Success;
});
export async function retrySavedPhoto(id, base, identity) {
  const connection = await db();
  await connection.runAsync("UPDATE photo_outbox SET state='pending',next_try=0,message='Saved on this phone. Waiting to send.' WHERE id=? AND base=? AND tracker_id=? AND employee_id=? AND employee_code=? AND state='blocked'",
    id, base, identity.tracker_id, identity.employee_id, identity.employee_code);
  notify({type: 'saved', id});
  void syncPhotos();
}
async function wake() {
  try {
    const current = await session();
    if (!current.token || !current.base) return;
    const connection = await db();
    await connection.runAsync("UPDATE photo_outbox SET next_try=0 WHERE base=? AND state='pending'", current.base);
    await connection.runAsync("UPDATE photo_title_edits SET next_try=0 WHERE dirty=1 AND photo_id IN (SELECT id FROM photo_outbox WHERE base=?)", current.base);
    await syncPhotos();
  } catch { /* Retry on the next foreground tick; never discard the outbox. */ }
}
export function startPhotoSync() {
  const kick = () => { if (AppState.currentState === 'active') void syncPhotos(); };
  const connection = Network.addNetworkStateListener(state => { if (state.isConnected !== false && state.isInternetReachable !== false && AppState.currentState === 'active') void wake(); });
  const app = AppState.addEventListener('change', state => { if (state === 'active') void wake(); });
  const timer = setInterval(kick, 10000);
  void ensurePhotoBackgroundTask(); kick();
  return () => { connection.remove(); app.remove(); clearInterval(timer); };
}
