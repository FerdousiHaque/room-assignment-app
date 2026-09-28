/**
 * Firestore sync for the app's editable data.
 * ------------------------------------------------------------------
 * The app's state shape is a handful of small arrays (providers, rooms,
 * and each day's uploaded desk rows) that every existing component
 * already treats as "one full array in, one full array out" (see
 * ProviderManager/RoomManager's onChange(nextArray) contract). Rather
 * than rewrite those components into per-document CRUD, each array is
 * stored as ONE Firestore document with a `list` field. That's plenty
 * for a single department's provider/room counts, keeps every existing
 * component untouched, and makes multi-desk live sync a couple of
 * onSnapshot calls.
 *
 * Collection: `appState`
 *   appState/providers        { list: Provider[] }
 *   appState/rooms             { list: Room[] }
 *   appState/day-<YYYY-MM-DD>  { rowsByDesk: { [deskId]: Row[] } }  -- one per day, so old days don't linger
 * ------------------------------------------------------------------
 */
import { doc, onSnapshot, setDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase.js';

/**
 * Recursively drops any object key whose value is `undefined` (arrays are
 * walked but not otherwise altered). Firestore's setDoc() rejects a document
 * containing an `undefined` value anywhere in it ("Unsupported field value:
 * undefined") and fails the WHOLE write — including everything else in the
 * same document — rather than just skipping that one field. Parsed schedule
 * rows are the main source of these (an optional column that a given icon/
 * value doesn't apply to), so every write in this file runs through this
 * first as a safety net, on top of not producing `undefined` in the first
 * place at the source (see pdfOcrParser.js).
 */
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

/**
 * Subscribes to a `{ list: [...] }` doc, seeding it with `seedValue` the
 * first time it doesn't exist yet. Calls back with the live list on every
 * change (including the local write that just happened, since Firestore
 * echoes writes back through the same listener).
 * Returns an unsubscribe function.
 */
function subscribeList(docId, seedValue, callback) {
  const ref = doc(db, 'appState', docId);
  let seeded = false;

  const unsubscribe = onSnapshot(
    ref,
    (snap) => {
      if (snap.exists()) {
        callback(snap.data().list || []);
      } else if (!seeded) {
        // First run ever for this project: seed Firestore from the
        // bundled sample data so there's something to look at and sync
        // from. Only attempted once per subscription to avoid a retry
        // loop if the write itself fails (e.g. rules reject it).
        seeded = true;
        setDoc(ref, { list: seedValue }).catch((err) => {
          console.error(`Failed to seed appState/${docId}:`, err);
          callback(seedValue); // still show something locally
        });
      }
    },
    (err) => {
      console.error(`Firestore subscription failed for appState/${docId}:`, err);
    }
  );

  return unsubscribe;
}

export function subscribeProviders(seedProviders, callback) {
  return subscribeList('providers', seedProviders, callback);
}

export function subscribeRooms(seedRooms, callback) {
  return subscribeList('rooms', seedRooms, callback);
}

export async function saveProviders(nextProviders) {
  await setDoc(doc(db, 'appState', 'providers'), { list: stripUndefined(nextProviders) });
}

export async function saveRooms(nextRooms) {
  await setDoc(doc(db, 'appState', 'rooms'), { list: stripUndefined(nextRooms) });
}

// ---- Per-day uploaded schedule rows (so all desks/users see the same
// live upload state instead of it living only in one browser tab) ------

function dayDocId(date) {
  return `day-${date}`;
}

export function subscribeDayRows(date, callback) {
  const ref = doc(db, 'appState', dayDocId(date));
  return onSnapshot(
    ref,
    (snap) => callback(snap.exists() ? snap.data().rowsByDesk || {} : {}),
    (err) => console.error(`Firestore subscription failed for appState/${dayDocId(date)}:`, err)
  );
}

export async function saveDayRows(date, rowsByDesk) {
  await setDoc(doc(db, 'appState', dayDocId(date)), { rowsByDesk: stripUndefined(rowsByDesk) });
}

/** One-off read, used only if a caller needs the current value without subscribing. */
export async function getDayRows(date) {
  const snap = await getDoc(doc(db, 'appState', dayDocId(date)));
  return snap.exists() ? snap.data().rowsByDesk || {} : {};
}

/**
 * Deletes a single day's uploaded-rows doc outright. Each day already lives
 * under its own doc id (day-YYYY-MM-DD), so a new day never reads a prior
 * day's data by construction — this goes a step further and actively wipes
 * yesterday's doc once a new day starts (see App.jsx), so an imported
 * schedule is never left sitting in the database past the day it was for.
 * Safe to call on a doc that doesn't exist (no-op).
 */
export async function deleteDayRows(date) {
  await deleteDoc(doc(db, 'appState', dayDocId(date)));
}
