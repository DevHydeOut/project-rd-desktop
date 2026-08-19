// Shell menus as real popup windows.
//
// WHY THIS EXISTS: the shell chrome (tab strip + toolbar) is the shell
// window's own webContents, but every tab is a WebContentsView — a separate
// NATIVE layer stacked on top of it, covering everything from
// y=CHROME_HEIGHT down. Any menu the shell renders as ordinary DOM opens
// *underneath* the tab and is invisible: the element exists, has layout,
// and even receives clicks, so it looks fine to DevTools while showing
// nothing on screen. Chrome solves this the same way — native popups.
//
// One reusable window is created lazily and re-pointed for each menu, rather
// than one window per menu type: cheaper, and it makes "only one menu open
// at a time" fall out for free.
//
// "suggestions" (the address-bar dropdown) is the odd one out: it has to
// stay open and update on every keystroke/arrow-key WITHOUT ever taking
// focus away from the address bar's <input>, which lives in the shell
// window. That's `focusable: false` + `showInactive()` instead of `show()`,
// and a separate updatePopupContent() path that resizes + re-sends content
// into the SAME window rather than reopening it (reopening would flash).

import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { SHELL_IPC_CHANNELS, type PopupAnchor, type PopupContent, type PopupKind } from "../shared/types";

const ROW_HEIGHT = 44; // matches popup.css's .history-item / .suggestion-item sizing

function computeSize(kind: PopupKind, anchor: PopupAnchor, content: PopupContent): { width: number; height: number } {
  // Taller/wider than before: the redesigned profile card has a centered
  // avatar+name+email header (with a tinted background panel) above the
  // menu rows, not a compact single-line header — see popup.css.
  if (kind === "profile") return { width: 264, height: content.profile?.email ? 336 : 316 };
  if (kind === "history") return { width: 340, height: 380 };
  // suggestions: full-width under the address bar, height follows row count
  // (capped, same idea as the old in-page dropdown's max-height + scroll).
  const rows = content.suggestions?.length ?? 0;
  return { width: anchor.width, height: Math.min(340, 30 + Math.max(rows, 1) * ROW_HEIGHT) };
}

let popupWin: BrowserWindow | null = null;
let popupKind: PopupKind | null = null;
// The shell's OWN webContents (distinct from popupWin, which is the menu
// window) — closePopup() notifies it via popupClosed so its "is a popup
// currently open" bookkeeping can't drift out of sync with reality; see the
// ShellApi.onPopupClosed docs for the scenario this fixes.
let ownerWindow: BrowserWindow | null = null;
// The popup's x/y is computed ONCE, in screen coordinates, when it opens —
// it does NOT track the parent window afterwards. If the user then moves,
// resizes, or minimizes/restores the shell window, the popup would just sit
// at its stale screen position, detached from the button that opened it
// (a real bug: reported as "why does this still show after I minimize the
// window"). Rather than re-deriving its position live on every parent
// move/resize event (fiddly, and every real browser doesn't bother either —
// Chrome just closes its own dropdowns the instant the window moves), this
// just dismisses the popup on any of those parent-window events.
let detachParentGuards: (() => void) | null = null;

// BrowserWindow#on is a big overloaded method — looping over a union of
// event-name strings doesn't type-check against it (TS can't match a widened
// union to "whichever overload applies"), so this is six explicit calls
// rather than a loop over an array.
function attachParentGuards(win: BrowserWindow, parent: BrowserWindow): () => void {
  const dismiss = () => {
    if (popupWin === win) closePopup();
  };
  parent.on("move", dismiss);
  parent.on("resize", dismiss);
  parent.on("minimize", dismiss);
  parent.on("restore", dismiss);
  parent.on("maximize", dismiss);
  parent.on("unmaximize", dismiss);
  return () => {
    parent.off("move", dismiss);
    parent.off("resize", dismiss);
    parent.off("minimize", dismiss);
    parent.off("restore", dismiss);
    parent.off("maximize", dismiss);
    parent.off("unmaximize", dismiss);
  };
}

// Content is bound to ITS OWN window, not a module-level "pending" value.
// A shared value is racy: closing the previous popup fires 'closed'/'blur'
// asynchronously, so the old window's teardown would wipe the content the
// NEW popup had already stored, and the new popup would render empty. That
// happened — the window appeared with a blank card.
const contentByWindow = new WeakMap<BrowserWindow, PopupContent>();

/** Resolves the content for whichever popup window is asking. */
export function getPopupContentFor(sender: Electron.WebContents): PopupContent | undefined {
  const win = BrowserWindow.fromWebContents(sender);
  return win ? contentByWindow.get(win) : undefined;
}

export function closePopup(): void {
  const win = popupWin;
  const owner = ownerWindow;
  popupWin = null;
  popupKind = null;
  ownerWindow = null;
  detachParentGuards?.();
  detachParentGuards = null;
  if (win && !win.isDestroyed()) {
    // Drop listeners first so this window's own blur/closed handlers can't
    // run against whatever popup replaces it.
    win.removeAllListeners("blur");
    win.removeAllListeners("closed");
    win.close();
  }
  if (owner && !owner.isDestroyed()) {
    owner.webContents.send(SHELL_IPC_CHANNELS.popupClosed);
  }
}

function clampToScreen(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const area = screen.getDisplayMatching({ x, y, width, height }).workArea;
  return {
    x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
  };
}

export function openPopup(parent: BrowserWindow, kind: PopupKind, anchor: PopupAnchor, content: PopupContent): void {
  // Re-opening while one is already up (e.g. clicking profile then history)
  // should replace it, not stack a second window.
  closePopup();

  const size = computeSize(kind, anchor, content);
  // Anchor coords arrive relative to the shell window's CONTENT area; the
  // popup is a screen-positioned window, so convert. Menus (profile/history)
  // right-align to their button, the way a toolbar menu drops down;
  // suggestions left-aligns to the address bar's own left edge and spans
  // its full width instead.
  const contentBounds = parent.getContentBounds();
  const rawX = kind === "suggestions" ? contentBounds.x + anchor.x : contentBounds.x + anchor.x + anchor.width - size.width;
  const rawY = contentBounds.y + anchor.y;
  const { x, y } = clampToScreen(Math.round(rawX), Math.round(rawY), size.width, size.height);

  const isSuggestions = kind === "suggestions";

  popupWin = new BrowserWindow({
    parent,
    width: size.width,
    height: size.height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Menus must float above the tab's WebContentsView — that's the entire
    // point of using a window here.
    alwaysOnTop: true,
    show: false,
    // Suggestions must NEVER take OS focus away from the address-bar
    // <input> (a different renderer, in the shell window) — that's what
    // lets arrow-key/Enter handling stay in the shell while this window is
    // visible and clickable at the same time.
    focusable: !isSuggestions,
    webPreferences: {
      preload: path.join(__dirname, "../preload/shell.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  const win = popupWin;
  popupKind = kind;
  ownerWindow = parent;
  contentByWindow.set(win, content);
  detachParentGuards = attachParentGuards(win, parent);
  win.setMenuBarVisibility(false);
  void win.loadFile(path.join(__dirname, "../shell/popup.html"));

  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    if (isSuggestions) win.showInactive();
    else win.show();
  });

  if (!isSuggestions) {
    // Click-away dismissal, same as any native menu. Only applies to
    // focusable popups — a non-focusable window never receives 'blur'.
    // Suggestions closes are driven explicitly by the shell instead (input
    // blur / Escape / selection), since it can't rely on this.
    win.on("blur", () => {
      if (popupWin === win) closePopup();
    });
  }
  win.on("closed", () => {
    if (popupWin === win) {
      popupWin = null;
      popupKind = null;
    }
  });
}

/** Pushes fresh content into the ALREADY-OPEN popup — resizes (height only;
 * x/y/width never change mid-typing) and re-sends, without moving the
 * window or touching focus. No-ops if nothing of the right kind is open
 * (e.g. the user already dismissed it) — content.kind guards against a
 * stale/late call landing on a DIFFERENT popup that opened since. */
export function updatePopupContent(content: PopupContent): void {
  const win = popupWin;
  if (!win || win.isDestroyed() || popupKind !== content.kind) return;

  contentByWindow.set(win, content);

  const bounds = win.getBounds();
  const size = computeSize(content.kind, { x: 0, y: 0, width: bounds.width }, content);
  if (size.height !== bounds.height) {
    win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: size.height });
  }

  win.webContents.send(SHELL_IPC_CHANNELS.popupContentChanged, content);
}
