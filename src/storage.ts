import { openDB } from "idb";
import type { Snapshot } from "../shared/books";
import { api } from "./api";

const database = () =>
  openDB("booxs-private-library", 1, {
    upgrade(db) {
      db.createObjectStore("library");
    },
  });
export async function loadSnapshot(): Promise<Snapshot | undefined> {
  const db = await database();
  try {
    return await db.get("library", "snapshot");
  } finally {
    db.close();
  }
}
export async function storeSnapshot(snapshot: Snapshot): Promise<void> {
  const db = await database();
  try {
    await db.put("library", snapshot, "snapshot");
  } finally {
    db.close();
  }
}
export async function clearSnapshot(): Promise<void> {
  const db = await database();
  try {
    await db.delete("library", "snapshot");
  } finally {
    db.close();
  }
}

export async function pendingLogout(): Promise<boolean> {
  const db = await database();
  try {
    return !!(await db.get("library", "logoutPending"));
  } finally {
    db.close();
  }
}

export async function setPendingLogout(value: boolean): Promise<void> {
  const db = await database();
  try {
    if (value) await db.put("library", true, "logoutPending");
    else await db.delete("library", "logoutPending");
  } finally {
    db.close();
  }
}

export async function finishPendingLogout(): Promise<boolean> {
  let pending: boolean;
  try {
    pending = await pendingLogout();
  } catch {
    return false;
  } // Online sign-in still works with browser storage disabled.
  if (!pending) return false;
  await api.logout();
  await clearSnapshot();
  await setPendingLogout(false);
  return true;
}
