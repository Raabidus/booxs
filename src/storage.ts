import { openDB } from "idb";
import type { Snapshot } from "../shared/books";

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
    await db.clear("library");
  } finally {
    db.close();
  }
}
