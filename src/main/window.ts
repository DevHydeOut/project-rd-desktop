// Creates the app's single top-level window — now a Chrome-style shell:
// the window itself renders a LOCAL page (src/shell/, bundled to
// dist/shell/) containing the tab strip + toolbar, and each open tab is a
// separate, fully-sandboxed WebContentsView showing the live platform app
// (see tabs/tab-manager.ts). This replaced the earlier design where the
// window's own content WAS the live app directly — that was simpler, but
// couldn't support more than one page open at a time.
//
// Security posture is unchanged in spirit, just relocated: the shell page
// itself is fully trusted (our own static HTML/CSS/JS, contextIsolation +
// sandbox + its own narrow preload — see preload/shell.ts), and every TAB
// gets the same locked-down webPreferences + CSP + origin allowlist +
// navigation guards the old single window used to have (see security.ts,
// applied per-tab in tab-manager.ts).

import { BrowserWindow } from "electron";
import path from "node:path";
import { getInitialBounds, attachTracking } from "./services/window-state";
import { ensureCspRegistered } from "./security";
import { TabManager, CHROME_HEIGHT } from "./tabs/tab-manager";
import { setActiveTabManager } from "./ipc/shell";
import { SHELL_IPC_CHANNELS } from "../shared/types";

// Desktop never shows the public marketing landing page ("/") — no one to
// market to inside an already-installed app — so every new tab (including
// the first one restored from a previous session) falls back to /login
// instead of "/". If a real session exists, the web app's own proxy.ts
// immediately redirects /login to /dashboard, so this is always right
// either way.
const DESKTOP_DEFAULT_PATH = "/login";

export async function createMainWindow(): Promise<BrowserWindow> {
  ensureCspRegistered();

  const initial = await getInitialBounds();

  const win = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    x: initial.x,
    y: initial.y,
    show: false, // shown once ready-to-show fires, avoids a white flash
    minWidth: 760,
    minHeight: 480,
    backgroundColor: "#ffffff",
    // Frameless + titleBarOverlay: Windows still draws its own native
    // minimize/maximize/close buttons (hover states, snap-to-side, the
    // works) in the top-right corner, but everything else in that top
    // strip is OUR content — this is what makes a real Chrome-style tab
    // strip possible at all, rather than living below a separate native
    // title bar. CHROME_HEIGHT is shared with tab-manager.ts so the
    // reserved strip and the tab content's bounds can never drift apart.
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#dee1e6",
      symbolColor: "#5f6368",
      height: 40,
    },
    webPreferences: {
      // This is the SHELL's own preload (tab strip/toolbar chrome), not
      // the one tab content gets — see preload/shell.ts vs preload/index.ts.
      preload: path.join(__dirname, "../preload/shell.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.once("ready-to-show", () => {
    if (initial.isMaximized) win.maximize();
    win.show();
  });

  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    // eslint-disable-next-line no-console
    console.log(`[shell:${level}] ${message} (${sourceId}:${line})`);
  });

  const savedTabs = initial.tabs && initial.tabs.length > 0 ? initial.tabs : [DESKTOP_DEFAULT_PATH];
  const savedActiveIndex = Math.min(Math.max(initial.activeTabIndex ?? 0, 0), savedTabs.length - 1);

  const tabManager = new TabManager(win, (tabs) => {
    win.webContents.send(SHELL_IPC_CHANNELS.tabsChanged, tabs);
  });
  setActiveTabManager(tabManager);
  win.on("closed", () => setActiveTabManager(null));

  for (const tabPath of savedTabs) {
    tabManager.createTab(tabPath);
  }
  const restoredTabs = tabManager.getTabs();
  if (restoredTabs[savedActiveIndex]) {
    tabManager.activateTab(restoredTabs[savedActiveIndex].id);
  }

  attachTracking(win, () => {
    const state = tabManager.getPersistableState();
    return { tabs: state.paths, activeTabIndex: state.activeIndex };
  });

  await win.loadFile(path.join(__dirname, "../shell/index.html"));

  return win;
}

export { CHROME_HEIGHT };
