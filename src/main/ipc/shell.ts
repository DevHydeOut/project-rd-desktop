import { ipcMain, session } from "electron";
import { z } from "zod";
import { SHELL_IPC_CHANNELS, IPC_CHANNELS, type PopupContent } from "../../shared/types";
import { ALLOWED_ORIGINS } from "../security";
import { openPopup, closePopup, getPopupContentFor, updatePopupContent } from "../popup";
import type { TabManager } from "../tabs/tab-manager";

const NoArgs = z.undefined();
const IdPayload = z.string().min(1).max(100);
const PathPayload = z.string().max(2000).optional();

// Single-window app (see main/index.ts) — one active TabManager at a time
// is all that's ever needed. If multi-window support is added later
// (mentioned as a "future update" in the original requirements doc), this
// becomes a lookup by the invoking webContents' owning window instead.
let activeManager: TabManager | null = null;

export function setActiveTabManager(manager: TabManager | null): void {
  activeManager = manager;
}

/** For same-process callers (menu.ts's accelerators) that need to act on
 * the active window's tabs directly, without a round-trip through IPC —
 * those only make sense for the renderer side of the boundary. */
export function getActiveTabManager(): TabManager | null {
  return activeManager;
}

export function registerShellIpc(): void {
  ipcMain.handle(SHELL_IPC_CHANNELS.getTabs, async (_event, payload) => {
    NoArgs.parse(payload);
    return activeManager?.getTabs() ?? [];
  });

  ipcMain.handle(SHELL_IPC_CHANNELS.createTab, async (_event, payload) => {
    const initialPath = PathPayload.parse(payload);
    activeManager?.createTab(initialPath);
  });

  ipcMain.handle(SHELL_IPC_CHANNELS.closeTab, async (_event, payload) => {
    const id = IdPayload.parse(payload);
    activeManager?.closeTab(id);
  });

  ipcMain.handle(SHELL_IPC_CHANNELS.activateTab, async (_event, payload) => {
    const id = IdPayload.parse(payload);
    activeManager?.activateTab(id);
  });

  ipcMain.handle(SHELL_IPC_CHANNELS.navigate, async (_event, payload) => {
    const target = z.string().min(1).max(2000).parse(payload);
    activeManager?.navigateActive(target);
  });

  // Hard sign-out — clears session cookies directly in Electron rather than
  // asking the web app to do it. See the ShellApi.signOut docs: a
  // navigation-based logout is useless precisely when the user is stuck
  // (app 404ing/500ing/unreachable), which is when they most need out.
  ipcMain.handle(SHELL_IPC_CHANNELS.signOut, async (_event, payload) => {
    NoArgs.parse(payload);
    const origin = ALLOWED_ORIGINS[0];
    const cookies = await session.defaultSession.cookies.get({ url: origin });
    await Promise.all(cookies.map((c) => session.defaultSession.cookies.remove(origin, c.name)));
    activeManager?.navigateActive("/login");
  });

  ipcMain.handle(SHELL_IPC_CHANNELS.goBack, async (_event, payload) => {
    NoArgs.parse(payload);
    activeManager?.goBack();
  });

  ipcMain.handle(SHELL_IPC_CHANNELS.goForward, async (_event, payload) => {
    NoArgs.parse(payload);
    activeManager?.goForward();
  });

  ipcMain.handle(SHELL_IPC_CHANNELS.reload, async (_event, payload) => {
    NoArgs.parse(payload);
    activeManager?.reloadActive();
  });

  // The shell has no theme of its own — this just signals the ACTIVE TAB
  // (which owns next-themes) to change theirs. See
  // ErpNativeApi.system.onThemeChangeRequested for the tab-side listener.
  ipcMain.handle(SHELL_IPC_CHANNELS.setTheme, async (_event, payload) => {
    const theme = z.enum(["light", "dark", "system"]).parse(payload);
    activeManager?.getActiveTabWebContents()?.send(IPC_CHANNELS.systemThemeChangeRequested, theme);
  });

  // Shell menus open as real windows, not in-page DOM — see main/popup.ts
  // for the (non-obvious) reason.
  const PopupKindSchema = z.enum(["profile", "history", "suggestions"]);
  const PopupContentSchema = z.object({
    kind: PopupKindSchema,
    profile: z.object({ name: z.string().min(1).max(200), image: z.string().url().max(2000).optional(), email: z.string().max(320).optional() }).optional(),
    history: z
      .array(z.object({ label: z.string().max(300), path: z.string().max(2000), time: z.number() }))
      .max(200)
      .optional(),
    suggestions: z.array(z.object({ label: z.string().max(300), path: z.string().max(2000) })).max(20).optional(),
    activeIndex: z.number().int().min(0).optional(),
  });
  const AnchorSchema = z.object({ x: z.number(), y: z.number(), width: z.number() });

  ipcMain.handle(SHELL_IPC_CHANNELS.openPopup, async (_event, payload) => {
    const { kind, anchor, content } = z.object({ kind: PopupKindSchema, anchor: AnchorSchema, content: PopupContentSchema }).parse(payload);
    const win = activeManager?.getWindow();
    if (win) openPopup(win, kind, anchor, content as PopupContent);
  });

  ipcMain.handle(SHELL_IPC_CHANNELS.closePopup, async (_event, payload) => {
    NoArgs.parse(payload);
    closePopup();
  });

  // Resolved from the CALLING window, so each popup gets its own content
  // even if popups are opened back to back.
  ipcMain.handle(SHELL_IPC_CHANNELS.getPopupContent, async (event, payload) => {
    NoArgs.parse(payload);
    return getPopupContentFor(event.sender);
  });

  // Address-bar suggestions push fresh content into the ALREADY-OPEN popup
  // on every keystroke, rather than reopening it — reopening would flash
  // and (for a focusable:false window) is unnecessary anyway.
  ipcMain.handle(SHELL_IPC_CHANNELS.updatePopupContent, async (_event, payload) => {
    const content = PopupContentSchema.parse(payload);
    updatePopupContent(content as PopupContent);
  });
}
