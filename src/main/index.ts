import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { registerIpcHandlers } from "./ipc";
import { setApplicationMenu } from "./menu";
import { initAutoUpdater } from "./services/updater";

// Single-instance lock: prevents a second copy of the app from starting
// (e.g. double-clicking the installed shortcut twice) with two windows
// racing against the same local settings store / print queue. Standard for
// any desktop app, but especially relevant here since window-state and
// (eventually) printer assignment live in a per-machine JSON file
// (services/settings/store.ts) that two processes writing at once could
// corrupt.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIpcHandlers();
    setApplicationMenu();
    await createMainWindow();

    // getWindow() re-resolves at call time rather than capturing a single
    // reference, so the update-ready push still reaches the right window
    // even if the original one was closed and a new one created via
    // "activate" in the meantime.
    initAutoUpdater(() => BrowserWindow.getAllWindows()[0] ?? null);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    // Windows/Linux: quit when the last window closes (macOS is excluded by
    // convention, but this app is Windows-only per the project scope — kept
    // as an explicit platform check anyway rather than relying on omission).
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // Global safety net: refuse to create ANY webContents (including from a
  // renderer trying to spawn one) that doesn't use this app's own secure
  // defaults. Covers cases createMainWindow()'s per-window config can't —
  // e.g. a <webview> tag or devtools popouts that don't go through
  // createMainWindow at all.
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
}
