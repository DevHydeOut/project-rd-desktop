// Shell chrome renderer — the tab strip + toolbar UI. Talks only to
// window.shellApi (exposed by src/preload/shell.ts); never touches
// Electron APIs directly, same discipline as the tab-content preload.

import type { ShellApi, TabInfo, UserProfileInfo, PopupAnchor, HistoryEntry, SuggestionEntry } from "../shared/types";

declare global {
  interface Window {
    shellApi: ShellApi;
  }
}

const tabstripEl = document.getElementById("tabstrip")!;
const newTabBtn = document.getElementById("new-tab-btn")!;
const backBtn = document.getElementById("back-btn") as HTMLButtonElement;
const forwardBtn = document.getElementById("forward-btn") as HTMLButtonElement;
const reloadBtn = document.getElementById("reload-btn")!;
const historyBtn = document.getElementById("history-btn")!;
const addressBar = document.getElementById("address-bar") as HTMLInputElement;
const profileBtn = document.getElementById("profile-btn")!;
const profileAvatar = document.getElementById("profile-avatar") as HTMLSpanElement;
const bellBadge = document.getElementById("bell-badge") as HTMLSpanElement;
const addressWrap = document.getElementById("address-wrap")!;

// Static route index for the address bar's "quickly go there" dropdown.
// The shell can't scrape the tab's DOM for the real nav (separate process/
// renderer — see the earlier note on why UniversalSearch couldn't just be
// ported as-is), so this mirrors apps/platform's sidebar.tsx nav by hand.
// Keep in sync if that file's routes change.
interface RouteEntry {
  label: string;
  /** Owner-level routes are absolute ("/dashboard/sites"). Site-level ones
   * use {siteId}, filled in from the CURRENTLY ACTIVE tab's path — see
   * currentSiteId() below. Omitted from results if no siteId is known. */
  path: string;
  siteScoped?: boolean;
}

const OWNER_ROUTES: RouteEntry[] = [
  { label: "Dashboard", path: "/dashboard" },
  { label: "Sites", path: "/dashboard/sites" },
  { label: "Staff", path: "/dashboard/staff" },
  { label: "Roles", path: "/dashboard/roles" },
  { label: "Items & Inventory", path: "/dashboard/items" },
  { label: "Stock transfers", path: "/dashboard/transfers" },
  { label: "Modules", path: "/dashboard/modules" },
  { label: "Features", path: "/dashboard/features" },
  { label: "Audit log", path: "/dashboard/audit" },
  { label: "Miscellaneous", path: "/dashboard/misc" },
  { label: "Click-to-call", path: "/dashboard/telephony" },
  { label: "WhatsApp", path: "/dashboard/whatsapp" },
  { label: "Feature requests", path: "/dashboard/feature-requests" },
  { label: "Plan & billing", path: "/dashboard/plan" },
  { label: "Export data", path: "/dashboard/exports" },
  { label: "Settings", path: "/dashboard/settings" },
  { label: "Help", path: "/help" },
];

const SITE_ROUTES: RouteEntry[] = [
  { label: "Site dashboard", path: "/{siteId}/dashboard", siteScoped: true },
  { label: "Invoice", path: "/{siteId}/invoice", siteScoped: true },
  { label: "Inventory", path: "/{siteId}/inventory", siteScoped: true },
  { label: "Stock transfer", path: "/{siteId}/transfers", siteScoped: true },
  { label: "Providers", path: "/{siteId}/providers", siteScoped: true },
  { label: "Consultation", path: "/{siteId}/clinic/consultations", siteScoped: true },
  { label: "Queue", path: "/{siteId}/clinic/queue", siteScoped: true },
  { label: "Patients", path: "/{siteId}/clinic/patients", siteScoped: true },
  { label: "Diseases", path: "/{siteId}/clinic/diseases", siteScoped: true },
  { label: "Loyalty", path: "/{siteId}/retail/loyalty", siteScoped: true },
  { label: "Contacts", path: "/{siteId}/retail/contacts", siteScoped: true },
  { label: "Expenses", path: "/{siteId}/expenses", siteScoped: true },
  { label: "Reports", path: "/{siteId}/reports", siteScoped: true },
  { label: "Site settings", path: "/{siteId}/settings", siteScoped: true },
];

/** Best-effort: the active tab's current path's first segment, if it looks
 * like a site id rather than a known owner-level top segment. Site routes
 * in the dropdown are simply omitted when this can't be determined (e.g.
 * currently on an owner-level page) — better than guessing wrong. */
function currentSiteId(tabs: TabInfo[]): string | undefined {
  const active = tabs.find((t) => t.isActive);
  const first = active?.path.split("/").filter(Boolean)[0];
  if (!first) return undefined;
  const ownerTopSegments = new Set(["dashboard", "help", "login", "signup", "staff-login", "logout", "support", "privacy", "terms", "contact", "pricing"]);
  return ownerTopSegments.has(first) ? undefined : first;
}

let lastTabs: TabInfo[] = [];
let suggestionResults: SuggestionEntry[] = [];
let activeSuggestion = 0;
// Whether the suggestions POPUP (a separate window, not in-page DOM — see
// main/popup.ts for why) is currently open, so keystrokes know whether to
// open fresh or push an update into the existing one.
let suggestionsPopupOpen = false;

function suggestionAnchor(): PopupAnchor {
  const r = addressWrap.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.bottom + 4), width: Math.round(r.width) };
}

function updateSuggestions(query: string): void {
  const q = query.trim().toLowerCase();
  if (!q) {
    closeSuggestions();
    return;
  }

  const siteId = currentSiteId(lastTabs);
  const owner = OWNER_ROUTES.filter((r) => r.label.toLowerCase().includes(q)).map((r) => ({ label: r.label, path: r.path }));
  const site = siteId
    ? SITE_ROUTES.filter((r) => r.label.toLowerCase().includes(q)).map((r) => ({ label: r.label, path: r.path.replace("{siteId}", siteId) }))
    : [];
  suggestionResults = [...owner, ...site].slice(0, 8);
  activeSuggestion = 0;

  if (suggestionResults.length === 0) {
    closeSuggestions();
    return;
  }
  pushSuggestions();
}

/** Opens the popup on the first result, or pushes fresh content into the
 * ALREADY-OPEN one — this is what avoids reopening (and thus flashing) it
 * on every keystroke while the popup, deliberately, never takes keyboard
 * focus away from this <input>. */
function pushSuggestions(): void {
  const content = { kind: "suggestions" as const, suggestions: suggestionResults, activeIndex: activeSuggestion };
  if (suggestionsPopupOpen) {
    void window.shellApi.updatePopupContent(content);
  } else {
    void window.shellApi.openPopup("suggestions", suggestionAnchor(), content);
    suggestionsPopupOpen = true;
  }
}

function closeSuggestions(): void {
  if (!suggestionsPopupOpen) return;
  suggestionsPopupOpen = false;
  void window.shellApi.closePopup();
}

function goToSuggestion(r: SuggestionEntry): void {
  void window.shellApi.navigate(r.path);
  addressBar.value = "";
  closeSuggestions();
  addressBar.blur();
}

// Fed by whichever tab currently reports its alert count via
// window.erpNative.system.reportNotifications() (apps/platform's sidebar).
window.shellApi.onNotificationsChanged((count) => {
  if (count > 0) {
    bellBadge.textContent = count > 99 ? "99+" : String(count);
    bellBadge.hidden = false;
  } else {
    bellBadge.hidden = true;
  }
});

// --- Profile avatar + theme menu ------------------------------------------
// Fed by whichever tab currently reports its session via
// window.erpNative.system.reportUserProfile() (apps/platform's sidebar,
// gated by useIsDesktop()). The shell can't read the tab's own session —
// separate process — so it just renders whatever gets pushed to it.
let currentProfile: UserProfileInfo | undefined;

window.shellApi.onUserProfileChanged((profile: UserProfileInfo) => {
  currentProfile = profile;
  profileAvatar.classList.remove("avatar-fallback");
  if (profile.image) {
    profileAvatar.innerHTML = `<img src="${profile.image}" alt="" />`;
  } else {
    const initials = profile.name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
    profileAvatar.textContent = initials;
    profileAvatar.classList.add("avatar-fallback");
  }
});

// --- Today's history --------------------------------------------------------
// Tracked here in the shell (not persisted, not sent anywhere) purely from
// the tabsChanged snapshots we already receive — every distinct path seen
// on any tab today, most recent first. "Today only" per the request, so
// this resets naturally on relaunch/date change; no need for real storage.
const historyToday: HistoryEntry[] = [];
const seenPaths = new Set<string>();

/** Every page sets the same <title> ("ProjectRD"), so tab.title is useless
 * as a history label — derive a real one from the route table instead,
 * falling back to the path itself for anything unlisted. */
function labelForPath(path: string): string {
  const clean = path.split("?")[0];
  const owner = OWNER_ROUTES.find((r) => r.path === clean);
  if (owner) return owner.label;
  const segments = clean.split("/").filter(Boolean);
  if (segments.length > 1) {
    const site = SITE_ROUTES.find((r) => r.path.replace("{siteId}", segments[0]) === clean);
    if (site) return site.label;
  }
  return clean || "/";
}

function recordHistory(tab: TabInfo): void {
  const key = `${tab.id}:${tab.path}`;
  if (seenPaths.has(key)) return;
  seenPaths.add(key);
  historyToday.unshift({ label: labelForPath(tab.path), path: tab.path, time: Date.now() });
  if (historyToday.length > 200) historyToday.length = 200;
}

// --- Menus ------------------------------------------------------------------
// Both menus open as real popup WINDOWS rather than in-page dropdowns: the
// active tab's WebContentsView is a native layer covering everything below
// the chrome strip, so an in-page dropdown renders underneath it and is
// invisible even though it exists and works. See main/popup.ts.

/** Anchor a popup to a toolbar button, in shell-content coordinates. */
function anchorFor(btn: HTMLElement): PopupAnchor {
  const r = btn.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.bottom + 4), width: Math.round(r.width) };
}

profileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  closeSuggestions();
  void window.shellApi.openPopup("profile", anchorFor(profileBtn), {
    kind: "profile",
    profile: currentProfile,
  });
});

historyBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  closeSuggestions();
  void window.shellApi.openPopup("history", anchorFor(historyBtn), {
    kind: "history",
    history: historyToday,
  });
});

// A popup can close for reasons the SHELL never initiated — e.g. the main
// process dismisses it the instant the window moves/resizes/minimizes,
// since the popup's screen position is fixed at open time and would
// otherwise be left floating in the wrong place (a real reported bug: the
// suggestions dropdown stayed on screen, detached from the address bar,
// after the window was moved/minimized). Without this, suggestionsPopupOpen
// could stay stuck `true` after such a close, and further keystrokes would
// silently no-op (push into a window that no longer exists) instead of
// opening a fresh one.
window.shellApi.onPopupClosed(() => {
  suggestionsPopupOpen = false;
});

function render(tabs: TabInfo[]): void {
  lastTabs = tabs;
  for (const tab of tabs) {
    if (!tab.isLoading) recordHistory(tab);
  }
  tabstripEl.innerHTML = "";
  for (const tab of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.isActive ? " active" : "") + (tab.isLoading ? " loading" : "");
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(tab.isActive));

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title;
    el.appendChild(title);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.setAttribute("aria-label", `Close ${tab.title}`);
    close.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void window.shellApi.closeTab(tab.id);
    });
    el.appendChild(close);

    el.addEventListener("click", () => void window.shellApi.activateTab(tab.id));
    tabstripEl.appendChild(el);
  }

  const active = tabs.find((t) => t.isActive);
  if (active) {
    backBtn.disabled = !active.canGoBack;
    forwardBtn.disabled = !active.canGoForward;
    // Deliberately NOT synced from active.path — the address bar shows a
    // "search or jump to a page" placeholder only, never the raw internal
    // route, per the "make it universal search, I don't want them to show
    // path" request. It's a type-to-go input, not a literal location bar.
  }
}

window.shellApi.onTabsChanged(render);
void window.shellApi.getTabs().then(render);

newTabBtn.addEventListener("click", () => void window.shellApi.createTab());
backBtn.addEventListener("click", () => void window.shellApi.goBack());
forwardBtn.addEventListener("click", () => void window.shellApi.goForward());
reloadBtn.addEventListener("click", () => void window.shellApi.reload());

addressBar.addEventListener("input", () => updateSuggestions(addressBar.value));
addressBar.addEventListener("focus", () => updateSuggestions(addressBar.value));
// The popup can never take focus (by design — see main/popup.ts), so
// closing it on blur has to be driven from here; the popup itself can't
// detect "the address bar lost focus".
addressBar.addEventListener("blur", () => closeSuggestions());

addressBar.addEventListener("keydown", (e) => {
  const hasSuggestions = suggestionsPopupOpen && suggestionResults.length > 0;

  if (e.key === "ArrowDown" && hasSuggestions) {
    e.preventDefault();
    activeSuggestion = Math.min(activeSuggestion + 1, suggestionResults.length - 1);
    pushSuggestions();
  } else if (e.key === "ArrowUp" && hasSuggestions) {
    e.preventDefault();
    activeSuggestion = Math.max(activeSuggestion - 1, 0);
    pushSuggestions();
  } else if (e.key === "Enter") {
    // A dropdown match wins over treating the raw text as a literal path —
    // that's the "quickly go there" part: Enter picks the highlighted
    // suggestion whenever one exists, not just an exact-typed route.
    if (hasSuggestions) {
      goToSuggestion(suggestionResults[activeSuggestion]);
    } else if (addressBar.value.trim()) {
      void window.shellApi.navigate(addressBar.value.trim());
      addressBar.value = "";
      addressBar.blur();
    }
  } else if (e.key === "Escape") {
    addressBar.value = "";
    closeSuggestions();
    addressBar.blur();
  }
});

// Toolbar action icons (help/feature-requests/audit-log/plan/settings) —
// each just navigates the active tab to a fixed path. These moved here
// from the web app's own sidebar by request; they act like real
// browser-chrome controls now (Chrome's own profile/extensions icons
// aren't part of the loaded website either), not page content.
document.querySelectorAll<HTMLElement>("[data-nav]").forEach((el) => {
  el.addEventListener("click", () => {
    const path = el.dataset.nav;
    if (path) void window.shellApi.navigate(path);
  });
});

// Sign-out lives in the profile POPUP now (popup.ts), not here — it still
// goes through the main process (clearing cookies at the Electron session
// level) rather than navigating to the web app's /logout page, so it keeps
// working when the app itself is broken.

// Ctrl+T / Ctrl+W here too (not just the app menu) — a plain click focus
// inside the shell (e.g. the address bar) can otherwise swallow the menu
// accelerator in some focus states; belt-and-suspenders.
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    void window.shellApi.createTab();
  }
  if (e.ctrlKey && e.key.toLowerCase() === "l") {
    e.preventDefault();
    addressBar.focus();
    addressBar.select();
  }
});
