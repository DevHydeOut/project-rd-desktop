// Types shared between the main process, preload, and (eventually) the web
// app's "desktop mode" code — kept here so the IPC contract has one source
// of truth instead of drifting between preload's exposed API and the web
// app's `window.erpNative` type declarations.

export type PrintPurpose = "invoice" | "receipt" | "label";

export interface DetectedPrinter {
  name: string;
  paperSizes: string[];
  isDefault: boolean;
}

export interface PrintPdfRequest {
  /** Base64-encoded PDF bytes. The renderer never gets filesystem access,
   * so it can't hand over a path — it hands over the document itself, and
   * the main process is responsible for writing/cleaning up a temp file. */
  pdfBase64: string;
  printerName?: string;
  copies?: number;
  paperSize?: string;
}

export interface ReceiptLineRequest {
  text: string;
  bold?: boolean;
  align?: "left" | "center" | "right";
  doubleHeight?: boolean;
}

export interface PrintReceiptRequest {
  lines: ReceiptLineRequest[];
  printerName?: string;
}

export interface PrintLabelRequest {
  /** Raw ZPL string — see services/printing/zpl-print.ts's
   * buildSimpleTextLabel() for a helper that builds one from plain fields,
   * or hand over hand-crafted ZPL directly. */
  zpl: string;
  printerName?: string;
}

export interface UpdateReadyInfo {
  version: string;
}

export interface UserProfileInfo {
  name: string;
  /** Avatar image URL, if the user has one set. Undefined -> shell falls
   * back to rendering initials, matching the web app's own Avatar/
   * AvatarFallback pattern. */
  image?: string;
  /** Shown under the name in the profile popup's account card, the way
   * Chrome's own profile popup shows name + email. */
  email?: string;
}

export type ThemePreference = "light" | "dark" | "system";

// ── Shell popups ─────────────────────────────────────────────────────────
//
// Dropdown menus in the shell chrome CANNOT be plain DOM inside the shell's
// own page. Each tab is a WebContentsView — a NATIVE layer stacked on top of
// the shell's webContents from y=CHROME_HEIGHT downwards — so anything the
// shell renders below that strip is painted underneath the tab and is
// invisible, even though it's in the DOM, has correct layout, and receives
// clicks. That was a real, long-lived bug: the profile menu opened every
// time and simply could not be seen.
//
// So shell menus are separate always-on-top popup windows — which is what
// real browsers do, for exactly this reason.

// "suggestions" (the address-bar dropdown) is a different animal from the
// other two: it must stay open and update on every keystroke WITHOUT ever
// taking focus away from the address bar's <input>, which lives in the
// shell window, not the popup. See openPopup/updatePopupContent below.
export type PopupKind = "profile" | "history" | "suggestions";

/** Where to put the popup, in coordinates relative to the shell window's
 * content area; the main process converts these to screen coordinates. */
export interface PopupAnchor {
  x: number;
  y: number;
  /** Anchor width, so the popup can be right-aligned under its button. */
  width: number;
}

export interface HistoryEntry {
  label: string;
  path: string;
  /** Epoch ms — the popup filters to "today" and formats the time. */
  time: number;
}

export interface SuggestionEntry {
  label: string;
  path: string;
}

/** Everything a popup needs to render itself. For "profile"/"history" this
 * is fetched once when the popup opens. For "suggestions" it's pushed again
 * on every keystroke/arrow-key via updatePopupContent — see ShellApi. */
export interface PopupContent {
  kind: PopupKind;
  profile?: UserProfileInfo;
  history?: HistoryEntry[];
  suggestions?: SuggestionEntry[];
  /** Keyboard-highlighted row, for "suggestions" — keyboard focus stays in
   * the shell's address bar, so the popup can't track this itself. */
  activeIndex?: number;
}

// ── Tab / shell chrome (the "full multi-tab Chrome" UI) ─────────────────
//
// Two SEPARATE preload/API surfaces exist in this app, deliberately not
// merged into one:
//   - ErpNativeApi (below)  -> exposed to EACH TAB'S content (the live
//     platform app, loaded via WebContentsView). This is what apps/platform
//     calls for printing/updates/etc.
//   - ShellApi (this section) -> exposed ONLY to the shell chrome itself
//     (the local tab-strip/toolbar UI in src/shell/) — the tab content
//     never sees this, and the shell chrome never sees ErpNativeApi. Two
//     different renderers, two different preloads, two different trust
//     boundaries: the shell is OUR code (fully trusted), a tab's content is
//     the live web app (trusted, but still sandboxed like any renderer).

export interface TabInfo {
  id: string;
  title: string;
  /** Path + query only (e.g. "/dashboard/invoices"), not a full URL — tabs
   * are always same-origin, so there's nothing else meaningful to show. */
  path: string;
  isActive: boolean;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface ShellApi {
  getTabs(): Promise<TabInfo[]>;
  createTab(path?: string): Promise<void>;
  closeTab(id: string): Promise<void>;
  activateTab(id: string): Promise<void>;
  /** Address-bar navigation: a bare path ("/dashboard") navigates the
   * active tab; anything that isn't same-origin gets opened in the real OS
   * browser instead (same policy as in-page navigation). */
  navigate(pathOrUrl: string): Promise<void>;
  /** Hard sign-out: clears the session cookie at the ELECTRON session
   * level, then sends the active tab to /login. Deliberately does NOT rely
   * on navigating to the web app's own /logout page — that only works if
   * the web app is actually rendering. This path still works when the app
   * is 404ing/500ing/unreachable, which is exactly when a stuck user most
   * needs a way out. */
  signOut(): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  /** Fires whenever the tab list or any tab's state changes (new/closed/
   * activated/title changed/loading changed/history changed). The shell
   * re-renders its tab strip + toolbar from this — one event, full
   * snapshot, no incremental-diffing bugs to worry about. */
  onTabsChanged(callback: (tabs: TabInfo[]) => void): () => void;
  /** Fires whenever a tab reports a new unread-alert count via
   * window.erpNative.system.reportNotifications() — drives the toolbar's
   * bell icon badge. */
  onNotificationsChanged(callback: (count: number) => void): () => void;
  /** Fires whenever a tab reports the logged-in user's name/avatar via
   * window.erpNative.system.reportUserProfile() — drives the toolbar's
   * profile button (real avatar/initials instead of a generic icon). */
  onUserProfileChanged(callback: (profile: UserProfileInfo) => void): () => void;
  /** Signals the active tab to switch theme — the shell has no theme of its
   * own to change; this just asks the web app (which owns next-themes) to
   * do it. See ErpNativeApi.system.onThemeChangeRequested. */
  setTheme(theme: ThemePreference): Promise<void>;
  /** Opens a shell menu as a real popup window anchored under `anchor`.
   * Menus can't be in-page DOM — see the PopupKind docs for why. The shell
   * passes the content it already holds (profile, today's history) rather
   * than main keeping a second copy of the same state. */
  openPopup(kind: PopupKind, anchor: PopupAnchor, content: PopupContent): Promise<void>;
  /** Dismisses the open popup. Called by the popup itself after an action,
   * and by the shell when a click should close it. */
  closePopup(): Promise<void>;
  /** Called by the POPUP renderer on load to fetch what it should show. */
  getPopupContent(): Promise<PopupContent | undefined>;
  /** Pushes fresh content (and resizes) into an ALREADY-OPEN popup without
   * moving it or touching focus — the address-bar suggestions dropdown
   * updates on every keystroke this way; keyboard focus never leaves the
   * shell's <input>. No-ops if no popup of the right kind is open. */
  updatePopupContent(content: PopupContent): Promise<void>;
  /** The suggestions popup itself has no keyboard focus, so it can't
   * subscribe to key events — this is how it learns content changed. */
  onPopupContentChanged(callback: (content: PopupContent) => void): () => void;
  /** Fires whenever a popup closes for ANY reason — including ones the
   * SHELL didn't initiate, like the main process dismissing it because the
   * window moved/resized/minimized (see main/popup.ts). Without this the
   * shell's own "is a popup open" bookkeeping (used to decide whether
   * further keystrokes should open a new suggestions popup or push into an
   * existing one) can drift out of sync with what's actually on screen. */
  onPopupClosed(callback: () => void): () => void;
}

/**
 * The full shape of what's exposed to the renderer via contextBridge.
 * This is the whitelist — if it's not on this interface, the web app cannot
 * reach it, no matter what runs inside the renderer (including a compromised
 * or malicious script, e.g. via a supply-chain issue in a dependency loaded
 * by the live web app). Keep this list as small as the app actually needs.
 */
export interface ErpNativeApi {
  system: {
    /** Always true — lets apps/platform detect "I'm in the desktop shell"
     * and switch into desktop-mode layouts. */
    isDesktop: true;
    getVersion(): Promise<string>;
    /** Pushes the tab's current unread-alert count to the shell's toolbar
     * bell icon — the shell has no way to compute this itself (separate
     * process/renderer from tab content, no access to site data). */
    reportNotifications(count: number): Promise<void>;
    /** Pushes the logged-in user's name/avatar to the shell's toolbar
     * profile button — same reasoning as reportNotifications. */
    reportUserProfile(profile: UserProfileInfo): Promise<void>;
    /** Fires when the user picks a theme from the SHELL's profile menu.
     * The web app (which owns next-themes, not the shell) subscribes to
     * this and calls its own setTheme() — the shell only signals intent,
     * it has no theme state of its own. Returns an unsubscribe function. */
    onThemeChangeRequested(callback: (theme: ThemePreference) => void): () => void;
  };
  printer: {
    getPrinters(): Promise<DetectedPrinter[]>;
    /** A4/report/invoice pipeline. Silent, no dialog. Verified against a
     * real print queue. */
    printPdf(request: PrintPdfRequest): Promise<void>;
    /** Receipt/thermal pipeline (raw ESC/POS). Implemented, NOT yet
     * verified against real hardware — see services/printing/index.ts. */
    printReceipt(request: PrintReceiptRequest): Promise<void>;
    /** Label pipeline (raw ZPL). Implemented, NOT yet verified against real
     * hardware — see services/printing/index.ts. */
    printLabel(request: PrintLabelRequest): Promise<void>;
    /** This machine's saved printer-purpose assignments (invoice/receipt/
     * label -> a specific Windows printer name). No settings UI to edit
     * these exists yet — this is the backend, ready for one. */
    getAssignments(): Promise<Partial<Record<PrintPurpose, string>>>;
    setAssignment(purpose: PrintPurpose, printerName: string | undefined): Promise<void>;
  };
  updater: {
    /** Fires once a downloaded update is ready to install. The actual toast
     * UI lives in apps/platform's desktop-mode code — this just delivers
     * the event. Returns an unsubscribe function. */
    onUpdateReady(callback: (info: UpdateReadyInfo) => void): () => void;
    /** Quits and installs the downloaded update immediately (the "Relaunch
     * to update" action). If never called, the update still applies on the
     * next natural app restart (autoInstallOnAppQuit). */
    relaunchToUpdate(): Promise<void>;
  };
}

/** Every IPC channel name the preload script is allowed to invoke. Adding a
 * channel here is a deliberate, reviewable act — nothing is exposed by
 * accident. */
export const IPC_CHANNELS = {
  systemGetVersion: "system:get-version",
  systemReportNotifications: "system:report-notifications",
  systemReportUserProfile: "system:report-user-profile",
  /** Main -> renderer(TAB) push — see ErpNativeApi.system.onThemeChangeRequested. */
  systemThemeChangeRequested: "system:theme-change-requested",
  printerGetPrinters: "printer:get-printers",
  printerPrintPdf: "printer:print-pdf",
  printerPrintReceipt: "printer:print-receipt",
  printerPrintLabel: "printer:print-label",
  printerGetAssignments: "printer:get-assignments",
  printerSetAssignment: "printer:set-assignment",
  /** Main -> renderer push (not an invoke/handle channel) — fired by
   * services/updater when a downloaded update is ready. */
  updaterUpdateReady: "updater:update-ready",
  updaterRelaunch: "updater:relaunch",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** Separate channel namespace for the SHELL preload (src/preload/shell.ts)
 * — kept apart from IPC_CHANNELS above so it's never possible to
 * accidentally wire a tab-content handler to a shell channel or vice versa;
 * the two preloads import from two different constants entirely. */
export const SHELL_IPC_CHANNELS = {
  getTabs: "shell:get-tabs",
  createTab: "shell:create-tab",
  closeTab: "shell:close-tab",
  activateTab: "shell:activate-tab",
  navigate: "shell:navigate",
  signOut: "shell:sign-out",
  goBack: "shell:go-back",
  goForward: "shell:go-forward",
  reload: "shell:reload",
  setTheme: "shell:set-theme",
  /** Main -> renderer push, fired by the tab manager on any tab-state change. */
  tabsChanged: "shell:tabs-changed",
  /** Main -> renderer push, forwarded from whichever tab last called
   * system.reportNotifications(). */
  notificationsChanged: "shell:notifications-changed",
  /** Main -> renderer push, forwarded from whichever tab last called
   * system.reportUserProfile(). */
  userProfileChanged: "shell:user-profile-changed",
  /** Shell chrome -> main: open a menu as a real popup window. */
  openPopup: "shell:open-popup",
  /** Popup (or shell) -> main: dismiss the current popup window. */
  closePopup: "shell:close-popup",
  /** Popup -> main: fetch what it should render, once, on open. */
  getPopupContent: "shell:get-popup-content",
  /** Shell -> main: push fresh content into the already-open popup. */
  updatePopupContent: "shell:update-popup-content",
  /** Main -> popup: content changed after the popup already loaded — only
   * "suggestions" popups stay open long enough to need this. */
  popupContentChanged: "shell:popup-content-changed",
  /** Main -> shell chrome (not the popup itself): a popup just closed, for
   * any reason — lets the shell's own open/closed bookkeeping stay correct
   * even when main initiated the close (window moved/resized/minimized). */
  popupClosed: "shell:popup-closed",
} as const;

export type ShellIpcChannel = (typeof SHELL_IPC_CHANNELS)[keyof typeof SHELL_IPC_CHANNELS];
