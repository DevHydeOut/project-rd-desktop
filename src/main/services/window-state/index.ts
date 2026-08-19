// Persists and restores window bounds, maximized state, and the open tab
// set — the Brave-style "reopens exactly where you left off" behavior
// (locked decision, see HANDOVER.md §2: quits on close, restores full
// state on reopen).
//
// Two halves:
//   - getInitialBounds() — read before the BrowserWindow is constructed, so
//     it opens at the right size/position/maximized state from the first
//     frame (no visible resize-after-open jump).
//   - attachTracking(win) — wires resize/move/maximize listeners that keep
//     the saved bounds up to date. Debounced so a drag-resize doesn't write
//     to disk on every pixel. Tab-state saving is separate (see
//     scheduleTabsSave below) since it's driven by tab events, not window
//     events.

import { BrowserWindow, screen } from "electron";
import { getWindowState, setWindowState } from "../settings/store";

const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;
const SAVE_DEBOUNCE_MS = 500;

export interface InitialWindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
  tabs?: string[];
  activeTabIndex?: number;
}

/** Is this saved position actually still on screen? Handles the case where
 * the window was last closed on a second monitor that's since been
 * unplugged — without this check the window could open off-screen and
 * appear to "not launch" at all. */
function isOnScreen(x: number, y: number, width: number, height: number): boolean {
  const displays = screen.getAllDisplays();
  return displays.some((d) => {
    const { x: dx, y: dy, width: dw, height: dh } = d.workArea;
    // Require at least the top-left corner plus a reasonable slice of the
    // window to be within some display's work area — not just any overlap,
    // since a 1px sliver "on screen" is effectively still unusable.
    return x + width * 0.5 >= dx && x + width * 0.5 <= dx + dw && y + height * 0.5 >= dy && y + height * 0.5 <= dy + dh;
  });
}

export async function getInitialBounds(): Promise<InitialWindowBounds> {
  const saved = await getWindowState();

  if (!saved) {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, isMaximized: false };
  }

  const hasValidPosition = typeof saved.x === "number" && typeof saved.y === "number" && isOnScreen(saved.x, saved.y, saved.width, saved.height);

  return {
    width: saved.width || DEFAULT_WIDTH,
    height: saved.height || DEFAULT_HEIGHT,
    x: hasValidPosition ? saved.x : undefined,
    y: hasValidPosition ? saved.y : undefined,
    isMaximized: saved.isMaximized,
    tabs: saved.tabs,
    activeTabIndex: saved.activeTabIndex,
  };
}

/** Bounds-only save — bundles the last-known tab state back in (via
 * getTabsState) so a resize event doesn't accidentally wipe out the saved
 * tab list, since both live in the same settings.json windowState object. */
function currentTabsState(getTabsState: () => { tabs: string[]; activeTabIndex: number }) {
  const { tabs, activeTabIndex } = getTabsState();
  return { tabs, activeTabIndex };
}

export function attachTracking(win: BrowserWindow, getTabsState: () => { tabs: string[]; activeTabIndex: number }): void {
  let saveTimer: NodeJS.Timeout | undefined;

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // Bounds while maximized reflect the maximized size, not the
      // "restored" size the user would expect back on un-maximize — pull
      // the pre-maximize bounds via getNormalBounds() so un-maximizing next
      // launch looks right, matching how Chrome/Brave/VS Code behave.
      const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
      void setWindowState({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        isMaximized: win.isMaximized(),
        ...currentTabsState(getTabsState),
      });
    }, SAVE_DEBOUNCE_MS);
  }

  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);
  win.on("maximize", scheduleSave);
  win.on("unmaximize", scheduleSave);

  // Flush immediately on close, and — critically — actually WAIT for the
  // write to land before the window is allowed to finish closing.
  //
  // Found via live testing (not a hypothetical): the previous version
  // fired the save with `void setWindowState(...)` and let 'close'
  // proceed immediately. That happened to look reliable in single-tab
  // testing (a tiny JSON write is fast enough to usually beat the
  // process-teardown race), but was never actually guaranteed — and with
  // multiple WebContentsViews now needing their own teardown as part of
  // window close, the timing shifted enough to lose the race for real: the
  // close handler read the correct up-to-date tab list, called
  // setWindowState with it, and the window still finished closing (and the
  // process exited) before that write reached disk, silently persisting a
  // stale earlier state instead. `event.preventDefault()` + `win.destroy()`
  // once the write settles closes this race entirely — destroy() skips the
  // 'close' event (no infinite loop) and goes straight to actual teardown.
  win.on("close", (event) => {
    if (saveTimer) clearTimeout(saveTimer);
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    const state = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: win.isMaximized(),
      ...currentTabsState(getTabsState),
    };
    event.preventDefault();
    void setWindowState(state).finally(() => win.destroy());
  });
}
