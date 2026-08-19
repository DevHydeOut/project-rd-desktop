// Security config shared by every tab's WebContentsView. Originally lived
// inline in window.ts (back when there was exactly one webContents per
// window) — extracted here once tabs meant "N webContentses per window,"
// so the CSP/origin-allowlist/navigation-guard logic has exactly one
// implementation instead of being copy-pasted per tab.

import { WebContents, session, shell } from "electron";

export const APP_URL = process.env.PLATFORM_APP_URL ?? "http://127.0.0.1:3000";

// Only these origins may ever be loaded or navigated to inside this app.
// Everything else (a phishing link in an email, a malicious redirect, a
// compromised ad on some page the user somehow lands on) is blocked instead
// of silently rendering inside a window with our app's icon and title —
// that's the whole point of an allowlist here.
export const ALLOWED_ORIGINS = [new URL(APP_URL).origin];

export function isAllowedOrigin(targetUrl: string): boolean {
  try {
    return ALLOWED_ORIGINS.includes(new URL(targetUrl).origin);
  } catch {
    return false;
  }
}

const isDev = new URL(APP_URL).hostname === "127.0.0.1" || new URL(APP_URL).hostname === "localhost";

// Vercel Web Analytics is only used on the public marketing landing page —
// which no longer even loads inside this app (desktop always opens to
// /login, see window.ts), but kept narrow/conditional anyway in case that
// ever changes, rather than widening the default policy for everyone.
const ANALYTICS_ORIGINS = ["https://va.vercel-scripts.com", "https://vitals.vercel-insights.com"];

function buildCsp(isLandingPage: boolean): string {
  const analyticsScript = isLandingPage ? ` ${ANALYTICS_ORIGINS.join(" ")}` : "";
  const analyticsConnect = isLandingPage ? ` ${ANALYTICS_ORIGINS.join(" ")}` : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} ${ALLOWED_ORIGINS.join(" ")}${analyticsScript}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${ALLOWED_ORIGINS.join(" ")} ws://127.0.0.1:* ws://localhost:*${analyticsConnect}`,
  ].join("; ");
}

// Registered ONCE on the default session (all tabs share it) rather than
// per-webContents — CSP is a session/webRequest-level concern, and
// registering N times (once per tab) would just mean N redundant listeners
// doing the same header rewrite.
let cspRegistered = false;
export function ensureCspRegistered(): void {
  if (cspRegistered) return;
  cspRegistered = true;

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Only tab content (the live platform app, an ALLOWED_ORIGINS document)
    // gets this CSP — NOT the shell chrome's own local file:// page, which
    // ships its own <meta> CSP tag in shell/index.html. Both are 'self'-
    // scoped and would likely coexist fine either way (multiple CSPs on one
    // document combine restrictively, per the lesson learned building the
    // single-window CSP originally), but there's no reason to layer a
    // second, http-origin-shaped policy onto an unrelated local file.
    if (details.resourceType !== "mainFrame" || !isAllowedOrigin(details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const pathname = new URL(details.url).pathname;
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [buildCsp(pathname === "/")],
      },
    });
  });
}

/** Per-tab guards: navigation allowlisting + external-link handling +
 * console forwarding. Call once per tab's webContents, right after
 * creation. (contextIsolation/sandbox/nodeIntegration are constructor-time
 * webPreferences, set where each WebContentsView is created — see
 * tabs/tab-manager.ts — not here, since they can't be applied after the
 * fact.) */
export function applyNavigationGuards(webContents: WebContents): void {
  webContents.on("console-message", (_event, level, message, line, sourceId) => {
    // eslint-disable-next-line no-console
    console.log(`[tab:${level}] ${message} (${sourceId}:${line})`);
  });

  webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedOrigin(targetUrl)) {
      event.preventDefault();
      void shell.openExternal(targetUrl);
    }
  });

  webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedOrigin(url)) {
      // Same-app content wanting a new window/tab. Open it as a new TAB
      // instead of an unconfigured popup window — see tab-manager.ts,
      // which calls createTab() from this same handler via the manager
      // reference passed in at construction time.
      return { action: "deny" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });
}
