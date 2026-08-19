import { ipcMain, app } from "electron";
import { z } from "zod";
import { IPC_CHANNELS, SHELL_IPC_CHANNELS } from "../../shared/types";
import { getActiveTabManager } from "./shell";

// No-argument channel, but we still validate the payload shape (must be
// undefined) rather than trusting the caller — same discipline as every
// other handler, even the trivial ones. Prevents this handler from silently
// starting to accept args later without a deliberate schema change.
const NoArgs = z.undefined();

export function registerSystemIpc(): void {
  ipcMain.handle(IPC_CHANNELS.systemGetVersion, async (_event, payload) => {
    NoArgs.parse(payload);
    return app.getVersion();
  });

  // Any tab can call this (whichever one is actively rendering the
  // sidebar/alerts) — forwarded straight to the shell's own webContents so
  // its toolbar bell icon can show a real badge count. Last call wins; no
  // per-tab bookkeeping needed since only the active tab's data is ever
  // meaningful to show in a single, shared shell chrome.
  ipcMain.handle(IPC_CHANNELS.systemReportNotifications, async (_event, payload) => {
    const count = z.number().int().min(0).max(9999).parse(payload);
    getActiveTabManager()?.getWindow().webContents.send(SHELL_IPC_CHANNELS.notificationsChanged, count);
  });

  // Same pattern as reportNotifications — forwarded to the shell so its
  // profile button can show a real avatar/initials instead of a generic
  // person icon (the shell has no access to session data on its own).
  ipcMain.handle(IPC_CHANNELS.systemReportUserProfile, async (_event, payload) => {
    const profile = z.object({ name: z.string().min(1).max(200), image: z.string().url().max(2000).optional(), email: z.string().max(320).optional() }).parse(payload);
    getActiveTabManager()?.getWindow().webContents.send(SHELL_IPC_CHANNELS.userProfileChanged, profile);
  });
}
