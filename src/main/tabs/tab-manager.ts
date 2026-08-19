// Owns every open tab's WebContentsView (Electron's current API for
// embedding a webContents inside a window — the modern replacement for the
// older, now-legacy BrowserView). Each tab is a fully independent,
// fully-sandboxed view of the live platform app, exactly like the single
// window content used to be pre-tabs — just N of them now, stacked/swapped
// under the shell chrome instead of one filling the whole window.
//
// The shell UI (src/shell/) never touches WebContentsView directly — it
// only ever sees TabInfo snapshots pushed over IPC and calls the handful of
// methods below. All the Electron-specific machinery stays in here.

import { BrowserWindow, WebContentsView, shell } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ALLOWED_ORIGINS, applyNavigationGuards, isAllowedOrigin } from "../security";
import type { TabInfo } from "../../shared/types";

const NEW_TAB_DEFAULT_PATH = "/dashboard";

/** Height in px reserved at the top of the window for the tab strip +
 * toolbar (the shell chrome) — every tab's WebContentsView is positioned
 * to start just below this, never under it. Kept as one constant so the
 * shell's CSS and the main-process bounds math can't drift apart.
 * 40 (tab strip) + 44 (toolbar, bumped from 36 for bigger icons) = 84. */
export const CHROME_HEIGHT = 84;

interface Tab {
  id: string;
  view: WebContentsView;
  title: string;
  path: string;
  isLoading: boolean;
}

export class TabManager {
  private win: BrowserWindow;
  private tabs: Tab[] = [];
  private activeId: string | null = null;
  private onChange: (tabs: TabInfo[]) => void;

  constructor(win: BrowserWindow, onChange: (tabs: TabInfo[]) => void) {
    this.win = win;
    this.onChange = onChange;

    this.win.on("resize", () => this.layoutActiveView());
  }

  /** For cross-cutting main-process code (e.g. the notifications-report IPC
   * handler) that needs to reach the shell's OWN webContents directly —
   * distinct from any tab's webContents. */
  getWindow(): BrowserWindow {
    return this.win;
  }

  private snapshot(): TabInfo[] {
    return this.tabs.map((t) => ({
      id: t.id,
      title: t.title || "New Tab",
      path: t.path,
      isActive: t.id === this.activeId,
      isLoading: t.isLoading,
      canGoBack: t.view.webContents.navigationHistory.canGoBack(),
      canGoForward: t.view.webContents.navigationHistory.canGoForward(),
    }));
  }

  private notify(): void {
    this.onChange(this.snapshot());
  }

  private layoutActiveView(): void {
    const active = this.tabs.find((t) => t.id === this.activeId);
    if (!active) return;
    const bounds = this.win.getContentBounds();
    active.view.setBounds({ x: 0, y: CHROME_HEIGHT, width: bounds.width, height: Math.max(0, bounds.height - CHROME_HEIGHT) });
  }

  createTab(initialPath: string = NEW_TAB_DEFAULT_PATH): string {
    const id = randomUUID();

    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "../../preload/index.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
      },
    });

    const tab: Tab = { id, view, title: "New Tab", path: initialPath, isLoading: true };
    this.tabs.push(tab);

    applyNavigationGuards(view.webContents);

    // Same-app window.open()/target=_blank requests (blocked as a popup by
    // applyNavigationGuards' setWindowOpenHandler) become a new TAB here,
    // rather than doing nothing — matches how a real browser treats
    // "open in new tab" links.
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedOrigin(url)) {
        this.createTab(new URL(url).pathname + new URL(url).search);
      }
      return { action: "deny" };
    });

    view.webContents.on("page-title-updated", (_e, title) => {
      tab.title = title;
      this.notify();
    });
    view.webContents.on("did-start-loading", () => {
      tab.isLoading = true;
      this.notify();
    });
    view.webContents.on("did-stop-loading", () => {
      tab.isLoading = false;
      this.notify();
    });
    const updatePath = (url: string) => {
      try {
        if (isAllowedOrigin(url)) {
          const u = new URL(url);
          tab.path = u.pathname + u.search;
          this.notify();
        }
      } catch {
        // ignore malformed URLs from the navigation event
      }
    };
    view.webContents.on("did-navigate", (_e, url) => updatePath(url));
    view.webContents.on("did-navigate-in-page", (_e, url) => updatePath(url));

    this.win.contentView.addChildView(view);
    void view.webContents.loadURL(new URL(initialPath, ALLOWED_ORIGINS[0]).toString());

    this.activateTab(id);
    return id;
  }

  activateTab(id: string): void {
    const target = this.tabs.find((t) => t.id === id);
    if (!target) return;

    // Hide every other tab's view by removing it from the window's content
    // view tree (cheap to re-add; WebContentsView keeps its webContents —
    // and thus its state, scroll position, in-flight requests — alive
    // while detached, it just isn't rendered or receiving input).
    for (const t of this.tabs) {
      if (t.id !== id) this.win.contentView.removeChildView(t.view);
    }
    if (!this.win.contentView.children.includes(target.view)) {
      this.win.contentView.addChildView(target.view);
    }

    this.activeId = id;
    this.layoutActiveView();
    this.notify();
  }

  closeTab(id: string): void {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index === -1) return;

    const [closed] = this.tabs.splice(index, 1);
    this.win.contentView.removeChildView(closed.view);
    closed.view.webContents.close();

    if (this.tabs.length === 0) {
      // Closing the last tab closes the window — matches the locked
      // "window close quits the app" decision; there's no "empty browser"
      // state to fall back to.
      this.win.close();
      return;
    }

    if (this.activeId === id) {
      // Activate the tab that was to the right, or the new last tab if the
      // closed one was rightmost — the same convention Chrome uses.
      const next = this.tabs[index] ?? this.tabs[this.tabs.length - 1];
      this.activateTab(next.id);
    } else {
      this.notify();
    }
  }

  private get activeTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  /** For cross-cutting main-process code that needs to push something INTO
   * the active tab's own page (e.g. the theme-change signal) — distinct
   * from getWindow(), which is the shell's own webContents. */
  getActiveTabWebContents(): Electron.WebContents | undefined {
    return this.activeTab?.view.webContents;
  }

  navigateActive(pathOrUrl: string): void {
    const active = this.activeTab;
    if (!active) return;

    let target: URL;
    try {
      target = new URL(pathOrUrl, ALLOWED_ORIGINS[0]);
    } catch {
      return; // not a parseable path/URL — ignore rather than crash on bad input
    }

    if (!isAllowedOrigin(target.toString())) {
      // Typed a full external URL into the address bar — same policy as
      // any other off-origin navigation: hand it to the real OS browser,
      // never load third-party content inside this app's chrome.
      void shell.openExternal(target.toString());
      return;
    }

    void active.view.webContents.loadURL(target.toString());
  }

  goBack(): void {
    const wc = this.activeTab?.view.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  goForward(): void {
    const wc = this.activeTab?.view.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  reloadActive(): void {
    this.activeTab?.view.webContents.reload();
  }

  getTabs(): TabInfo[] {
    return this.snapshot();
  }

  /** Ctrl+Tab / Ctrl+Shift+Tab — cycle to the next/previous tab, wrapping
   * around at either end (standard browser behavior). */
  cycleTab(direction: 1 | -1): void {
    if (this.tabs.length < 2) return;
    const currentIndex = this.tabs.findIndex((t) => t.id === this.activeId);
    const nextIndex = (currentIndex + direction + this.tabs.length) % this.tabs.length;
    this.activateTab(this.tabs[nextIndex].id);
  }

  closeActiveTab(): void {
    if (this.activeId) this.closeTab(this.activeId);
  }

  /** For window-state persistence: every open tab's path + which one was
   * active, so relaunching restores the same set of tabs, Brave-style —
   * the multi-tab equivalent of the single lastPath this used to save. */
  getPersistableState(): { paths: string[]; activeIndex: number } {
    return {
      paths: this.tabs.map((t) => t.path),
      activeIndex: Math.max(0, this.tabs.findIndex((t) => t.id === this.activeId)),
    };
  }
}
