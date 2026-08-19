// Renderer for shell menu popups (profile, history). Runs inside its own
// frameless always-on-top window — see main/popup.ts for why menus can't
// just be DOM in the shell page.
//
// Gets the SAME preload as the shell chrome, so acting on a menu item is a
// direct shellApi call; each action closes the popup afterwards, the way a
// native menu dismisses on selection.

import type { ShellApi, PopupContent, HistoryEntry, SuggestionEntry, ThemePreference } from "../shared/types";

declare global {
  interface Window {
    shellApi: ShellApi;
  }
}

const card = document.getElementById("card")!;

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

/** Every menu action ends the same way: do the thing, then dismiss. */
function act(run: () => void): void {
  run();
  void window.shellApi.closePopup();
}

// Every menu row gets a leading icon, the way Chrome's own profile/context
// menus do (key/G/pencil/sync icons) — a bare text list is what made these
// look like a barebones internal tool rather than app chrome.
const ICON = {
  settings: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v1.7M8 12.7v1.7M14.4 8h-1.7M3.3 8H1.6M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8L3.6 3.6" stroke-linecap="round"/></svg>`,
  signOut: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14H3.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1H6"/><path d="M10.5 11.5 14 8l-3.5-3.5"/><path d="M14 8H6"/></svg>`,
  page: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.8h5.2L12.5 5v8.7a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2.3a.5.5 0 0 1 .5-.5Z"/><path d="M9 1.8V5h3.2"/></svg>`,
  clock: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.4 1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const THEME_ICONS: Record<ThemePreference, string> = {
  light: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.4 3.6l-1 1M4.6 11.4l-1 1M12.4 12.4l-1-1M4.6 4.6l-1-1"/></svg>`,
  dark: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7Z"/></svg>`,
  system: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="1.5" y="3" width="13" height="8" rx="1"/><path d="M6 13.5h4M8 11v2.5"/></svg>`,
};

/** A menu row with a leading icon + label — every profile-menu item uses
 * this, matching Chrome's own account-menu rows (key/G/pencil icons). */
function iconButton(icon: string, label: string, className?: string): HTMLButtonElement {
  const btn = document.createElement("button");
  if (className) btn.className = className;
  btn.innerHTML = `<span class="row-icon">${icon}</span><span>${label}</span>`;
  return btn;
}

function renderProfile(content: PopupContent): void {
  const name = content.profile?.name ?? "Signed in";

  // Centered account card — Chrome's profile popup leads with a large
  // centered avatar + name + email in a softly-tinted panel, not a small
  // left-aligned row. This is the single biggest visual gap from the
  // original flat design.
  const head = el("div", "profile-head");
  const avatar = el("div", "profile-avatar");
  if (content.profile?.image) {
    const img = document.createElement("img");
    img.src = content.profile.image;
    img.alt = "";
    avatar.appendChild(img);
  } else {
    avatar.textContent = initialsOf(name);
  }
  head.appendChild(avatar);
  head.appendChild(el("div", "profile-name", name));
  if (content.profile?.email) head.appendChild(el("div", "profile-email", content.profile.email));
  card.appendChild(head);

  const body = el("div", "menu-body");

  const settings = iconButton(ICON.settings, "Settings");
  settings.addEventListener("click", () => act(() => void window.shellApi.navigate("/dashboard/settings")));
  body.appendChild(settings);

  body.appendChild(el("div", "section-label", "Theme"));
  const themeRow = el("div");
  themeRow.id = "theme-row";
  (["light", "dark", "system"] as ThemePreference[]).forEach((theme) => {
    const btn = document.createElement("button");
    btn.innerHTML = `${THEME_ICONS[theme]}<span>${theme[0].toUpperCase()}${theme.slice(1)}</span>`;
    btn.addEventListener("click", () => act(() => void window.shellApi.setTheme(theme)));
    themeRow.appendChild(btn);
  });
  body.appendChild(themeRow);

  body.appendChild(el("div", "divider"));

  const signOut = iconButton(ICON.signOut, "Sign out", "danger");
  signOut.addEventListener("click", () => act(() => void window.shellApi.signOut()));
  body.appendChild(signOut);

  card.appendChild(body);
}

function renderHistory(content: PopupContent): void {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const entries = (content.history ?? []).filter((h: HistoryEntry) => h.time >= startOfToday);

  card.appendChild(el("div", "section-label", "Opened today"));

  if (entries.length === 0) {
    card.appendChild(el("div", "empty", "No pages opened today yet"));
    return;
  }

  const list = el("div");
  list.id = "history-list";
  for (const entry of entries) {
    const row = el("button", "history-item");
    row.innerHTML = `<span class="row-icon">${ICON.clock}</span>`;
    const text = el("span", "history-text");
    text.appendChild(el("span", "history-title", entry.label));
    const time = new Date(entry.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    text.appendChild(el("span", "history-meta", `${time} · ${entry.path}`));
    row.appendChild(text);
    row.addEventListener("click", () => act(() => void window.shellApi.navigate(entry.path)));
    list.appendChild(row);
  }
  card.appendChild(list);
}

function renderSuggestions(content: PopupContent): void {
  const entries = content.suggestions ?? [];
  if (entries.length === 0) {
    card.appendChild(el("div", "empty", "No matches"));
    return;
  }
  const list = el("div");
  list.id = "suggestion-list";
  entries.forEach((entry: SuggestionEntry, i: number) => {
    const row = el("button", "suggestion-item" + (i === content.activeIndex ? " active" : ""));
    row.innerHTML = `<span class="row-icon">${ICON.page}</span>`;
    row.appendChild(el("span", "suggestion-title", entry.label));
    row.appendChild(el("span", "suggestion-path", entry.path));
    // Clicking navigates directly — this popup never has keyboard focus
    // (see main/popup.ts), so mouse is its only input; act() closes it
    // afterwards the same as every other menu item.
    row.addEventListener("click", () => act(() => void window.shellApi.navigate(entry.path)));
    list.appendChild(row);
  });
  card.appendChild(list);
}

function render(content: PopupContent): void {
  card.innerHTML = "";
  if (content.kind === "profile") renderProfile(content);
  else if (content.kind === "history") renderHistory(content);
  else renderSuggestions(content);
}

// Escape closes, matching native menu behavior. For "profile"/"history",
// blur-to-close is handled in the main process (the only place that sees
// window focus); "suggestions" never takes focus at all (see main/popup.ts)
// so its Escape/blur closing is driven from the shell's address bar instead
// — this listener only covers profile/history, whose window CAN be focused.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") void window.shellApi.closePopup();
});

// "suggestions" content changes on every keystroke while this same window
// stays open — everything else is fetched once, up front.
window.shellApi.onPopupContentChanged((content) => render(content));

void window.shellApi.getPopupContent().then((content) => {
  if (content) render(content);
});
