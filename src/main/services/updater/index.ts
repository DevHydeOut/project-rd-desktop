// Auto-update service: checks GitHub Releases in the background, downloads
// silently, and notifies the renderer once a new version is ready so the
// frontend can render the "Relaunch to update" toast — no blocking dialog,
// matching the agreed UX (a small corner notification, per the Figma
// reference the user provided: leaf icon + "Relaunch to update" + version).
//
// The actual toast UI lives in apps/platform's desktop-mode code (not built
// yet, tracked separately) — this module only owns the native mechanics:
// checking, silent downloading, and exposing "ready to relaunch" + the
// relaunch action itself over IPC.

import { app, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { IPC_CHANNELS } from "../../../shared/types";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly — updates are not urgent, no reason to poll harder

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) {
    // electron-updater has nothing real to check against in an unpackaged
    // dev run (no installed app, no GitHub release matching this build) —
    // skip entirely rather than let it log noisy errors on every launch.
    return;
  }

  // Silent background download — never interrupts the user, matches the
  // locked UX decision ("download quietly is the best thing").
  autoUpdater.autoDownload = true;
  // If the user never clicks "Relaunch to update," the update still applies
  // automatically the next time the app quits normally — matches "applies
  // on next natural restart or relaunch."
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", (info) => {
    getWindow()?.webContents.send(IPC_CHANNELS.updaterUpdateReady, { version: info.version });
  });

  autoUpdater.on("error", (err) => {
    // Never surface this to the user — a failed background update check
    // (e.g. offline) is not something the app should interrupt anyone
    // over. Logged for our own diagnostics only.
    console.error("[updater] error:", err.message);
  });

  void autoUpdater.checkForUpdates();
  setInterval(() => {
    void autoUpdater.checkForUpdates();
  }, CHECK_INTERVAL_MS);
}

export function relaunchToUpdate(): void {
  autoUpdater.quitAndInstall();
}
