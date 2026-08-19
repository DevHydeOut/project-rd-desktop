// Per-machine local settings store (NOT per logged-in user — printer
// assignments, window state, etc. belong to the physical computer, since a
// staff member may log into the same account from different PCs, each with
// different printers attached — see the printer-assignment decision in
// HANDOVER.md §2).
//
// A single flat JSON file under Electron's per-machine userData directory.
// Deliberately NOT electron-store (a fine library, just an extra dependency
// for something this small) — plain fs + a write queue is ~40 lines and
// keeps the dependency count low, matching the "maintainability over many
// years" priority from the original requirements doc.
//
// Never holds credentials/tokens — those belong in OS-backed secure storage
// (Electron's safeStorage), wired separately whenever auth-token caching is
// actually needed.

import { app } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type PrintPurpose = "invoice" | "receipt" | "label";

interface StoreShape {
  windowState?: {
    width: number;
    height: number;
    x?: number;
    y?: number;
    isMaximized: boolean;
    /** Every open tab's path+query (e.g. "/dashboard/invoices/245"),
     * same-origin only — restored on next launch, Brave-style, now that a
     * window can have multiple tabs. Replaces the old single `lastPath`
     * field (pre-tabs) — an old settings.json without `tabs` just falls
     * back to the default single tab, nothing to migrate. */
    tabs?: string[];
    activeTabIndex?: number;
  };
  /** Windows printer name assigned to each print purpose, ON THIS MACHINE
   * (locked decision — per-computer, not per-login: a staff member may use
   * different PCs with different printers attached). No settings UI exists
   * yet to edit this — the backend is ready for whenever that's built. */
  printerAssignments?: Partial<Record<PrintPurpose, string>>;
}

function storeFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

async function readStoreFile(): Promise<StoreShape> {
  try {
    const raw = await readFile(storeFilePath(), "utf-8");
    return JSON.parse(raw) as StoreShape;
  } catch {
    // First run (file doesn't exist yet) or corrupt JSON — start fresh
    // rather than crashing the app over a settings file.
    return {};
  }
}

// Writes are serialized through this promise chain so two rapid saves
// (e.g. a resize event firing right after a navigation event) can't
// interleave and corrupt the file — the single-instance lock in main/index.ts
// rules out cross-PROCESS races, this rules out same-process ones.
let writeQueue: Promise<void> = Promise.resolve();

async function writeStoreFile(data: StoreShape): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    await mkdir(path.dirname(storeFilePath()), { recursive: true });
    await writeFile(storeFilePath(), JSON.stringify(data, null, 2), "utf-8");
  });
  return writeQueue;
}

export async function getWindowState(): Promise<StoreShape["windowState"] | undefined> {
  const store = await readStoreFile();
  return store.windowState;
}

export async function setWindowState(state: StoreShape["windowState"]): Promise<void> {
  const store = await readStoreFile();
  store.windowState = state;
  await writeStoreFile(store);
}

export async function getPrinterAssignments(): Promise<Partial<Record<PrintPurpose, string>>> {
  const store = await readStoreFile();
  return store.printerAssignments ?? {};
}

export async function setPrinterAssignment(purpose: PrintPurpose, printerName: string | undefined): Promise<void> {
  const store = await readStoreFile();
  const assignments = { ...(store.printerAssignments ?? {}) };
  if (printerName) {
    assignments[purpose] = printerName;
  } else {
    delete assignments[purpose];
  }
  store.printerAssignments = assignments;
  await writeStoreFile(store);
}
