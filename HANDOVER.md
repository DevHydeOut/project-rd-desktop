# ProjectRD Desktop — Handover & Status

> **Purpose:** single source of truth for this desktop app's decisions, current status, and
> history. Read this before touching `apps/desktop`. **Update it after every meaningful
> change** — same discipline as the main project's `HANDOVER.md` one level up.

_Last updated: 2026-08-15 (rev 11)_

---

## 1. What this is

A native Windows desktop shell for ProjectRD's `apps/platform` web app. It does **not** carry
its own copy of the frontend — it loads the real, live platform app inside an Electron window
(no address bar, own icon/menu) and adds native capabilities the browser can't: silent printing
(A4/receipt/label, any printer brand), window-state restore, system tray/menu, background
auto-updates.

Full requirements + the Electron-vs-Tauri evaluation that led here are captured in this
session's history (not yet copied into a file — see "Open documentation debt" below).

## 2. Locked decisions (don't relitigate without a reason)

| Area | Decision | Why |
|---|---|---|
| Framework | **Electron**, not Tauri | Printing (silent, raw ESC/POS + ZPL + PDF, any brand) is the top-priority requirement and has a far more mature story in Node/Electron |
| Frontend | **Live-loaded**, not bundled | Changes to `apps/platform` reach the desktop app with no separate desktop release. Trade-off: "desktop mode" look-and-feel work happens in `apps/platform` itself, not here |
| Look & feel | Desktop-only layout mode (in `apps/platform`, detects `window.erpNative`), to be merged into one UI later once the whole app is redesigned with desktop in mind | User wants to see what's possible on desktop first, then redesign holistically |
| Offline | None — needs internet, same as the web app | Simplicity; revisit only if asked |
| Auth | Identical to web (same login, same inactivity logout) | No special desktop session handling needed for now |
| Platforms | Windows only | The printer hardware in scope (Zebra/TSC/Epson/ESC-POS-class) is a Windows-business-PC world; Mac/Linux not worth the effort right now |
| Window close | Quits the app; reopens restoring exact previous state (tabs, page, window bounds) — Brave-style | Requested behavior without the extra complexity of a tray-resident background process |
| Auto-update | Silent background download → small corner toast ("Relaunch to update"), never a blocking modal | Matches a Figma reference the user provided |
| Update hosting | GitHub Releases | Free, sufficient for now |
| Code signing | Skipped for now (unsigned installer; users click through the one-time Windows warning) | No budget for an Authenticode cert yet; add once there's revenue |
| Printer scope | Any brand/type — not limited to the doc's Zebra/TSC/Epson examples | User's explicit correction |
| Printer assignment | **Per-machine**, not per-login | A staff member may use different PCs, each with different printers attached |
| Distribution | One simple download link/page | No installer store, no auto-provisioning, for now |
| Vercel Web Analytics | Allowed in CSP **only** when loading the landing page (`/`) | It's only used there; keeping the allowlist as narrow as possible everywhere else |

## 3. Architecture

```
apps/platform (live, real URL)  <-- loaded directly, not bundled
        |  window.erpNative.* only (contextBridge)
Preload (contextIsolation boundary, esbuild-bundled — see rev 2 below for why)
        |  ipcRenderer.invoke(channel, validatedPayload)
Electron Main Process
        ├── ipc/            the ONLY files calling ipcMain.handle — auditable whitelist
        └── services/       framework-agnostic native logic (printing, settings, updater, window-state)
```

See `apps/desktop/README.md` for the folder layout in file-tree form.

## 4. Status — what's DONE and verified

### Folder scaffold (rev 1)
- ✅ `apps/desktop` created as a pnpm workspace member (picked up automatically by the
  existing `apps/*` glob in `pnpm-workspace.yaml`).
- ✅ Full stub tree: main process, IPC layer, native service-layer folders (printing/settings/
  updater/window-state), preload, shared types. Every stub file documents what belongs there
  and why, so implementation phases don't need to rediscover the plan.

### Security hardening (rev 2 — this session)
- ✅ **Locked-down `BrowserWindow`**: `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`, `webSecurity: true`.
- ✅ **Origin allowlist** (`src/main/window.ts`) — only the configured platform app origin can
  be loaded or navigated to; `will-navigate` blocks anything else, `setWindowOpenHandler` sends
  external links to the OS browser instead of opening an unconfigured Electron window
  (a common Electron foot-gun), and a global `web-contents-created` handler denies any stray
  `webContents` creation as a last-resort net.
- ✅ **CSP enforced at the Electron level**, independent of whatever headers the web app sends.
  Scoped narrowly: Vercel Analytics origins only added in when the loaded document's pathname
  is `/`; `unsafe-eval` only added in dev (Turbopack HMR needs it, never shipped pointed at a
  real deployed URL).
- ✅ **Preload exposes exactly one narrow API** (`window.erpNative.system.*` today) via
  `contextBridge.exposeInMainWorld` — no raw `ipcRenderer`, no filesystem/shell/OS access
  reachable from the page. `src/shared/types.ts` `IPC_CHANNELS` is the single whitelist of what
  the renderer can ever invoke.
- ✅ **Every IPC handler validates its input with Zod** before doing anything
  (`src/main/ipc/system.ts` as the reference pattern) — same discipline as the platform app's
  server actions, applied at the IPC boundary instead of the HTTP boundary.
- ✅ **Single-instance lock** — prevents two copies racing over the same future local settings
  file.
- ✅ **Verified live**, twice, against the real `apps/platform` dev server (not just typechecked):
  - First pass caught two real bugs: (1) the preload script silently failed to load entirely —
    Electron's sandboxed preload can't `require()` separate local files, needed a real bundle
    (added `esbuild`, bundles `src/preload/index.ts` to a single `dist/preload/index.js`);
    (2) the CSP was built as multiple separate header array entries, which Electron sends as
    *independent* CSP policies (all must be satisfied) — the strict `default-src`-only entry was
    silently overriding the more permissive `script-src`/`style-src` entries meant to allow
    legitimate Next.js behavior (inline hydration scripts, injected styles). Fixed by combining
    into one joined policy string.
  - Second pass (after fixes) confirmed end-to-end: preload → IPC → main process round-trip
    working (`window.erpNative.system.getVersion()` returned the real app version), zero
    console errors on either the landing page or the general app.
  - Third pass confirmed the landing-page-only analytics scoping: Vercel Analytics loads and
    fires its pageview on `/`, with the CSP switching correctly based on `details.resourceType
    === "mainFrame"` + pathname.

### Printing spike (rev 3 — this session)

Goal: prove silent printing actually works before building any UI around it. Result: **A4/PDF
pipeline proven end-to-end; receipt/label pipelines blocked on hardware, not attempted.**

- ⚠️ **This machine currently has no physical printer installed** — only three virtual/software
  ones: `RustDesk Printer` (implies this session may be running over a remote-desktop
  connection — worth checking whether that's hiding your real local printers), `Microsoft Print
  to PDF`, `Fax`. None list "A4" as a paper size (all US-locale, Letter/Legal/Tabloid only) —
  real A4 behavior is still unverified.
- ✅ **Printer detection implemented and verified** (`services/printing/printer-registry.ts`,
  via `pdf-to-printer`'s `getPrinters()`/`getDefaultPrinter()`) — real call against this
  machine's print spooler returns accurate results.
- ✅ **Silent A4/PDF pipeline implemented and verified end-to-end**
  (`services/printing/pdf-print.ts` + `ipc/printer.ts` + preload + `shared/types.ts`):
  renderer hands over base64 PDF bytes (it has no filesystem access) → IPC handler validates
  with Zod (incl. a size cap and a base64-shape check) → writes a per-job temp file → calls
  `pdf-to-printer`'s `print()` → deletes the temp file in a `finally` regardless of outcome.
  Verified via a temporary probe exercising the REAL path (sandboxed renderer →
  contextBridge → ipcRenderer.invoke → Zod validation → temp file → real Windows print queue):
  `printPdfResult: "success"` against `RustDesk Printer`, zero errors.
- 📝 **Finding: the OS "default printer" changed on its own between two test runs** (from
  `Microsoft Print to PDF` to `RustDesk Printer`) with no explicit action to cause it — not a
  bug in our code, just confirms relying on "whatever the OS calls default" would be fragile.
  Reinforces the already-locked decision to use explicit per-machine printer assignment instead
  of ever trusting the OS default.
- ⛔ **Receipt (ESC/POS) and label (ZPL) pipelines: not implemented, not attempted.** Blocked on
  real hardware — nothing to verify against yet. `pdf-to-printer`'s README explicitly advertises
  label-printer support (Zebra/Rollo) via rendering a PDF at the label's paper size, which is a
  real, simpler alternative worth trying FIRST once hardware is available, before writing raw
  ZPL/ESC-POS byte generation by hand.

### Window-state persistence (rev 4 — this session)

Brave-style "reopens exactly where you left off": window bounds, maximized state, and the last
path/route the user was viewing. **Implemented and rigorously verified — not just typechecked.**

- `services/settings/store.ts` — generic per-machine JSON store (`%APPDATA%/desktop/settings.json`),
  hand-rolled (no `electron-store` dependency) with a write queue to prevent same-process
  concurrent-save corruption.
- `services/window-state/index.ts` — `getInitialBounds()` (read before window construction, with
  an on-screen sanity check so a saved position from a monitor that's since been unplugged
  doesn't open the window off-screen) and `attachTracking()` (debounced save on resize/move/
  maximize/unmaximize, plus an immediate un-debounced flush on close).
- `window.ts` — restores bounds at construction, calls `maximize()` in `ready-to-show` if the
  saved state was maximized, tracks the current path via `did-navigate` +
  `did-navigate-in-page` (Next.js client-side routing fires the latter, not a full navigation),
  and rebuilds the initial `loadURL()` target from the saved path (same-origin only).
- **Verification method**: OS-level window manipulation (Win32 `MoveWindow`/`ShowWindow` via
  PowerShell), not just internal testing — moved/resized/maximized the REAL window the same way
  a user's mouse would, the same way a printer or file dialog would be tested. Confirmed:
  - Seeding `settings.json` with a distinctive value (850×650 at 300,200, maximized, a fake
    path) and relaunching produced a window that was verifiably maximized
    (`IsZoomed=True` via Win32) and loaded the exact restored URL.
  - Resizing the live window to (933,611 at 111,77) and un-maximizing produced an exact
    matching write to `settings.json` after the debounce.
  - **The close-handler's immediate flush was specifically isolated**: moved the window to
    (800×600 at 555,44) and posted `WM_CLOSE` immediately — before the 500ms debounce could
    have fired on its own — and the final saved file still matched exactly, proving the
    close-time flush path (not just the debounced one) works.
  - Bonus finding from the same run: navigation tracking correctly follows redirects too, not
    just direct client-side routes — a restricted test path correctly saved as
    `/login?callbackUrl=...` after the app's own auth redirect fired.
- One environment note: this remote-desktop-flavored session (see the `RustDesk Printer` finding
  in §4) made raw OS-level minimize/restore state behave unreliably for direct manipulation —
  worked around by seeding known state via the settings file directly rather than fighting the
  window manager. Not a concern for a real interactive desktop session.

### Native menu + keyboard shortcuts (rev 5 — this session)

`src/main/menu.ts`: File / Edit / View / Window / Help menu, built with Electron's standard
`role`-based items (undo/redo/cut/copy/paste/selectAll, reload/force-reload, zoom, minimize,
close, quit) plus a custom About dialog and a "Learn More" external link. Deliberately **no
generic "Print" menu item** — this app's whole point is purpose-specific silent printing driven
from the page UI, not reopening the dialog-based flow we're replacing.

**Decision made without asking, flagging it now**: DevTools toggle (`Ctrl+Shift+I`) is only
included in the menu when `!app.isPackaged` (i.e. dev builds only) — a shipped ERP build
shouldn't casually hand end users Chromium devtools. Easy to change if that's not wanted.

**Verification status: code-level only, not visually confirmed.** Typechecks and builds clean,
and `Menu.setApplicationMenu()` runs with no thrown errors in the main-process log. However,
attempting to visually confirm the menu bar rendered (Win32 `GetMenu` on the window handle,
then a full-desktop screenshot as a fallback) both failed to prove it either way in this
session: `GetMenu` returned a null handle despite the window clearly existing (title bar text
confirmed via `MainWindowTitle`), and a screenshot attempt captured the operator's actual live
desktop instead of the Electron window at all — meaning the window isn't rendering into whatever
display surface this automation session's screen capture reads from. Consistent with the
`RustDesk Printer` finding from the printing spike: **this whole session is very likely running
inside a remote-desktop/remote-control layer where GUI-level automation and screen capture don't
reliably reach the actual rendered app window**, even though the process itself runs fine and
its internal logic (proven repeatedly via file-based side effects like `settings.json` in the
window-state work) is verifiable. **Needs a human visual check** — run the app locally and
confirm the File/Edit/View/Window/Help menu bar is visible and a couple of shortcuts
(Ctrl+R reload, Ctrl+0 reset zoom) work.

### Auto-updater (rev 6 — this session)

`services/updater/index.ts` (electron-updater, GitHub provider): silent background download,
pushes an `updater:update-ready` event to the renderer once downloaded, exposes
`relaunchToUpdate()` over IPC for the "Relaunch to update" toast's click action. If the user
never clicks it, `autoInstallOnAppQuit` applies the update on the next natural app quit anyway —
matches the locked UX decision. Skips entirely when `!app.isPackaged` (no noisy errors in dev,
where there's no installed app or real release to check against).

**The toast UI itself is NOT built here** — it lives in `apps/platform`'s desktop-mode code
(not started yet, see §6). This module only owns the native mechanics + the two IPC entry
points (`onUpdateReady` subscription, `relaunchToUpdate()` action) the toast will call into.

**Verification status**: dev-mode guard confirmed via a clean boot (zero updater-related errors
or noise in the log) and the full `window.erpNative.updater.*` API confirmed reachable from the
page via the same IPC-probe technique used for printing/window-state. **Cannot verify the actual
update-download-relaunch cycle** — that requires a packaged installer and a real published
GitHub release to update *from*, neither of which exists yet (same category of blocker as the
printing spike's hardware requirement).

**⚠️ Open decision — needs the user's input, not assumed**: `electron-builder.yml`'s
`publish.owner`/`publish.repo` (which GitHub repo hosts the release artifacts electron-updater
checks against) is left as a commented-out placeholder. Two real options: (a) publish desktop
releases into the same `DevHydeOut/project-rd` repo the web app already uses (simpler, one repo,
but mixes web-app and desktop-app release tags/history), or (b) a dedicated repo just for
desktop distribution (cleaner separation, one more repo to manage). Not blocking further
development — only matters once an actual release pipeline is being set up.

### Icon, distribution repo, and receipt/label printing (rev 7 — this session)

- ✅ **App icon** — `apps/platform/src/app/favicon.ico` (a real 9-size multi-resolution ICO)
  copied to `build/icons/icon.ico`. No more placeholder.
- ✅ **Distribution repo locked in**: `electron-builder.yml` now has real `publish` config —
  GitHub provider, `DevHydeOut/project-rd-desktop`. `dist` script now actually runs
  `electron-builder --win` (was a stub echo before). `electron-builder` added as a devDependency.
- ✅ **Receipt (ESC/POS) and label (ZPL) pipelines: fully implemented and verified as far as
  possible without real hardware — further than "hardware-blocked" now.** What changed since
  rev 3's "not attempted" status:
  - `services/printing/raw-print.ts` — the shared low-level transport both pipelines use:
    sends raw bytes straight to a named Windows printer (RAW datatype, bypasses GDI rendering
    entirely — what ESC/POS and ZPL printers actually expect). Implemented via
    `resources/raw-print.ps1`, a PowerShell script doing P/Invoke into `winspool.drv`
    (`OpenPrinter`/`StartDocPrinter`/`WritePrinter`/etc. — the classic Microsoft
    "RawPrinterHelper" pattern), spawned from Node via `child_process`. Deliberately NOT a
    native Node addon — avoids requiring node-gyp/Visual Studio build tools on every install
    target, a real reliability concern for a years-long multi-PC ERP deployment.
  - **This transport was actually tested against a real Windows print queue, not just written
    to spec**: parse-checked the PowerShell script's syntax, then ran it directly (bypassing
    Node) against `RustDesk Printer` with a trivial payload — real `OpenPrinter` →
    `StartDocPrinter` → `WritePrinter` → `EndDocPrinter` → `ClosePrinter` call sequence
    completed with exit code 0, no dialog, no hang.
  - Then verified the FULL stack through real IPC (same technique as the A4 pipeline's
    verification): renderer → `window.erpNative.printer.printReceipt()` → Zod-validated IPC →
    printer-assignment resolution → ESC/POS byte builder → raw transport → real PowerShell →
    real Win32 spooler call. Result: `"printReceipt: success"`, no exception. Same for
    `printLabel()` → `"printLabel: success"`.
  - `services/printing/escpos-print.ts` — `buildEscPosReceipt(lines)`: init, per-line
    bold/align/double-height, ASCII text, feed+cut. Standard ESC/POS command bytes, unchanged
    across decades of hardware — lower risk than the transport mechanism, but still
    spec-derived, not hardware-confirmed.
  - `services/printing/zpl-print.ts` — `printLabel(printerName, zpl)` (raw ZPL passthrough) +
    `buildSimpleTextLabel(fields)`, a minimal plain-text label builder mirroring the reference
    MediSuite POS app's "no barcode graphic" appointment-label pattern.
  - **What's still genuinely unverified**: whether a REAL thermal/label printer correctly
    interprets these specific command bytes — `RustDesk Printer` accepted the raw bytes as a
    generic passthrough (proving the *software* stack works) but has no ESC/POS or ZPL
    semantics of its own to validate the *content*. That last mile needs real hardware — but
    every layer up to "bytes leave this app and reach the print spooler" is now proven, not
    theoretical.
- ✅ **Printer-purpose assignment (per-machine) implemented** — `services/settings/store.ts`
  gained `getPrinterAssignments()`/`setPrinterAssignment()`; all three print pipelines
  (`printInvoicePdf`/`printReceiptLines`/`printLabelZpl` in `services/printing/index.ts`)
  resolve an explicit printer name first, falling back to this machine's saved assignment for
  that purpose. Completes the backend for the "Invoice→Printer A" model from the original
  requirements doc — no settings UI to EDIT assignments exists yet (desktop-mode UI territory).
- **Bottom line on printing**: per the user's request ("do everything you can so I just have to
  connect a printer and check it"), printing is now as complete as it can be without hardware.
  Remaining work when hardware arrives: connect a real receipt/label printer, run
  `printReceipt`/`printLabel` against it, and confirm the physical output looks right (font
  size, cut behavior, label dimensions/margins) — not "build the pipeline," just "point it at
  something real and look at the paper."

### Temporary print-test page (rev 8 — this session)

Added `apps/platform/src/app/desktop-print-test/page.tsx` — a throwaway, public (no-login)
test tool so printers can be plugged in and tested with real button clicks, without waiting for
the real desktop-mode UI. Lists detected printers, lets each purpose (invoice/receipt/label) be
assigned to one, and has one button per purpose that sends a real test job through the real
pipeline. Whitelisted in `apps/platform/src/proxy.ts` PUBLIC_PATHS. Marked clearly in its own
comments as temporary — safe to delete once real print buttons exist elsewhere in the app.

**Verified live, including a real button click** (not just the underlying functions, which
were already proven in rev 7): loaded the page inside the actual Electron shell, confirmed the
printer list and version populate correctly, then scripted a real click on "Send test receipt
print" and confirmed the success toast ("receipt print job sent") appeared — the full
UI-to-hardware-transport chain, exercised the way a real user would trigger it.

**One real bug found and fixed along the way**: the page's initial `refresh()` had no
error handling, so if it ever failed, the UI just silently stayed empty (blank version, "No
printers detected") with nothing in the console — genuinely hard to debug. Added a
try/catch + toast.error + console.error. (The actual root cause of the one failed run
during testing was Next.js Fast Refresh churn on this route's very first compile in dev —
not a real bug in the print pipeline itself — but the missing error handling was a real gap
regardless and is now fixed.)

**Also confirmed**: `apps/platform`'s own `tsc --noEmit` has pre-existing errors unrelated to
this change (`roundOffEnabled`/`roundOffAmount` fields missing from the Prisma-generated
types — schema drift somewhere in in-progress billing work). Confirmed zero errors trace back
to `desktop-print-test/page.tsx` or `proxy.ts`, but flagging the pre-existing errors since
they were noticed in passing — not something addressed in this session.

### Full multi-tab Chrome-style shell (rev 9 — this session)

Major architecture change, by explicit user request. Previously the window's own content WAS
the live platform app (loaded directly via `loadURL`). Now the window renders a LOCAL shell page
(tab strip + toolbar, `src/shell/`) and every open tab is a separate, fully-sandboxed
`WebContentsView` showing the live app — the multi-tab-browser experience the user asked for by
name ("full multi-tab chrome"), not just a visual restyle.

**New pieces:**
- `src/main/security.ts` — CSP + navigation-guard logic extracted from the old single-window
  `window.ts` into reusable functions, since it now applies per-tab instead of once per window.
  CSP itself is registered ONCE on `session.defaultSession` (a session-level concern), scoped to
  only fire for actual tab content (`isAllowedOrigin` check) — NOT the shell's own local
  `file://` page, which ships its own `<meta>` CSP tag instead.
- `src/main/tabs/tab-manager.ts` — owns every tab's `WebContentsView`: create/close/activate/
  navigate/back/forward/reload/cycle, title+loading+history tracking, pushes a full `TabInfo[]`
  snapshot to the shell on any change (one event, no incremental-diff bugs). Each tab gets the
  same locked-down `webPreferences` (contextIsolation/sandbox/nodeIntegration false) and the same
  `applyNavigationGuards` the single window used to have. `window.open()`/target=_blank from tab
  content now opens as a new TAB (not a blocked no-op).
- `src/shell/` (new renderer) — the actual Chrome-style chrome: `index.html`/`index.css`/
  `index.ts`, vanilla (no framework — kept dependency-light, matching this app's existing
  philosophy). Tab strip with close-per-tab + new-tab button, toolbar with back/forward/reload +
  a same-origin-only address bar (shows/edits the PATH, not a full URL — typing an external URL
  hands it to the OS browser instead of navigating a tab there, same policy as any other
  off-origin navigation in this app).
- `src/preload/shell.ts` — a SEPARATE, narrower preload just for the shell chrome
  (`window.shellApi`), deliberately not merged with `window.erpNative` (tab content's preload) —
  two different renderers, two different trust boundaries.
- `src/main/ipc/shell.ts` — Zod-validated handlers routing shell UI actions to the active
  `TabManager`. Single-window app, so one module-level "active manager" reference is enough (see
  the file's own comment on what multi-window support would need to change here).
- **Window chrome**: `frame: false` + `titleBarStyle: "hidden"` + `titleBarOverlay` — Windows
  still draws native minimize/maximize/close buttons (hover states, snap-to-side, all native),
  everything else in that top strip is our own tab-strip content. This is what makes a real
  Chrome-style tab strip possible at all.
- **`menu.ts` updated**: Electron's built-in `role: "reload"` / `role: "close"` act on the
  FOCUSED webContents, which is now the SHELL's own chrome page, not whatever tab is active —
  using them as-is would have reloaded the tab strip instead of the page you're looking at, and
  closed the whole window instead of just the active tab. Replaced with explicit `click` handlers
  routed through the active `TabManager`. Added Ctrl+T (new tab), Ctrl+W (close active tab),
  Ctrl+Tab / Ctrl+Shift+Tab (cycle tabs).
- **Window-state persistence updated**: `settings.json`'s `windowState.lastPath` (single string)
  replaced with `windowState.tabs` (string array) + `activeTabIndex` — the multi-tab equivalent
  of the old single-path save. `apps/desktop/src/main/services/settings/store.ts` and
  `services/window-state/index.ts` both updated.
- **Build pipeline**: `tsconfig.json` gained the `DOM` lib (the shell is a real browser
  renderer, previously only `ES2022`/Node types existed). New `build:shell` script (esbuild
  bundles `shell/index.ts`, copies `index.html`/`index.css` into `dist/shell/`); `build:preload`
  now also bundles `preload/shell.ts`. `electron-builder.yml`'s `files: dist/**` already covers
  the new `dist/shell/` output, no change needed there.

**Verified live, not just typechecked** — same IPC-probe discipline used throughout this project:
- Confirmed real tab creation, activation-state flips, and per-tab console/CSP isolation via a
  live probe (create a second tab, activate the first again, watch both tabs' `isActive` flip
  correctly) — including a real `/login` → `/login?callbackUrl=...` auth redirect happening
  independently inside a second tab while the first tab stayed untouched.
- **Found and fixed a real, reproducible bug** while verifying tab-list persistence: the
  window's `close` handler correctly READ the up-to-date 2-tab state, but the actual disk write
  was fire-and-forget (`void setWindowState(...)`) with nothing blocking Electron from tearing
  the window down before that write landed — a genuine race that silently persisted a stale
  1-tab state instead. This apparently "worked by luck" in the earlier single-tab window-state
  testing (a tiny JSON write is fast enough to usually win the race), but was never actually
  guaranteed, and adding a second `WebContentsView` needing its own teardown shifted the timing
  enough to lose it for real. Fixed with the standard pattern: `event.preventDefault()` on
  `close`, await the save, then `win.destroy()` (skips `close`, no loop) once it's actually on
  disk. Reproduced the bug live, applied the fix, then reproduced the SAME scenario again and
  confirmed both the save and the subsequent restore-on-relaunch now work correctly.

**Not yet done**: no `<title>`/favicon-per-tab beyond the page's own `<title>` tag (already
working via `page-title-updated`); no drag-to-reorder tabs; no tab overflow/scroll-arrows UI
polish once many tabs are open (the CSS does support horizontal scroll, just unstyled); no
right-click tab context menu (close others, duplicate, etc.) — none of these were asked for,
noting them as natural follow-ups if wanted later, not as gaps in what was requested.

### Chrome-style chrome refinements + desktop-mode UI scoping (rev 10 — this session)

Shell chrome reworked toward the reference Chrome screenshot, and the desktop-mode UI split
made explicit:

- **Address bar is a universal search, not a URL bar** — never displays the raw route. Leading
  app-logo icon (moved out of the sidebar) signals "search from here". Typing filters a route
  index with ↑/↓ + Enter to jump. That index (`OWNER_ROUTES`/`SITE_ROUTES` in
  `src/shell/index.ts`) is **hand-mirrored from `apps/platform`'s sidebar.tsx and must be kept
  in sync by hand** — the shell is a separate renderer and can't scrape the tab's DOM the way
  the web app's own `UniversalSearch` does. Site-scoped routes are only offered when a siteId
  can be inferred from the active tab's path.
- **Toolbar icon row** (moved out of the web sidebar): notifications bell, help, feature
  requests, audit log, plan & billing, settings, profile menu. Icons/hit-targets enlarged
  (buttons 26→32px, glyphs ~19px) after a "too small to see" round; toolbar height 36→44px to
  suit, with `CHROME_HEIGHT` in `tab-manager.ts` updated to match (84 = 40 tab strip + 44
  toolbar) so tab-content bounds don't drift. Tab close (×) enlarged 17→22px.
- **Notification bell shows real data** via a new `system.reportNotifications(count)` bridge —
  `apps/platform`'s sidebar pushes its live alert count to the shell (which has no access to
  site data, being a separate process). New IPC channel both ways; badge renders in the shell.
- **⚠️ Desktop-mode changes MUST be gated** — a first pass at this applied sidebar changes
  (logo removal, bottom icon row removal, width change, universal-search removal) globally,
  silently altering the plain-browser web app too. Corrected: every one now sits behind
  `useIsDesktop()` (`apps/platform/src/lib/desktop/`), with the original web JSX restored
  verbatim. **Any future desktop-only UI work must follow the same pattern** — this is the one
  regression class most likely to recur, since both apps share one codebase.
- Sidebar width deliberately reverted to be **identical to web** (300/72) in both states — a
  desktop-only "thinner" variant caused a layout gap and wasn't wanted.
- Items & Inventory: Figma's fixed `max-w-[1620px]` left dead gutters in the desktop app's
  wider window — removed in desktop mode only, web keeps the Figma spec.
- Main content scrollbar thinned to match the sidebar's (`[data-app-scroll]` in `globals.css`).
  Applied globally, not desktop-only — it improves the browser experience identically.

### Stale-session / "every link is dead" investigation (rev 10 — this session)

Reported as "no link on the 404 page works". **The links were never broken.** Every
destination happened to render the same-looking 404, so clicking felt inert:

| Link | Went to | Result at the time |
|---|---|---|
| Sign in | `/login` | **404** |
| Staff login | `/staff-login` | **404** |
| Owner dashboard | `/dashboard` → `/login` | **404** |
| Help | `/help` → `/login` | **404** |

- **Root cause: stale Turbopack cache** in a long-running dev server — the documented
  "known-good routes suddenly 404" gotcha for this project. A dev-server restart restored
  `/login` and `/staff-login` to 200. **Dev-only; not a code bug and not permanently fixable —
  if known routes 404, restart the dev server before debugging code.**
- **Lesson for future verification**: an earlier probe "confirmed" a link click worked because
  the URL changed — without checking that the *destination* also rendered a 404. Checking the
  status of the landing page, not just that navigation occurred, is the actual test.

**A real production bug surfaced while tracing this — now fixed (see §4a below).**

### 4a. Stale-cookie infinite redirect loop — REAL BUG, fixed (rev 10)

`proxy.ts`'s `getSessionCookie()` checks only that a session cookie **exists**, never that it's
still valid. With a stale cookie (revoked session, DB reset, redeploy) users were trapped:

```
/dashboard → passes middleware (cookie exists)
           → layout finds no real session → redirect /login
           → middleware sees "cookie + auth page" → redirect /dashboard
           → ...forever. No way to ever sign in again.
```

Fixed in **`apps/platform`, so the web app AND the desktop app both get it** (desktop loads the
same code):

1. `proxy.ts` — `/logout` added to `PUBLIC_PATHS` (must be reachable while holding a broken
   cookie; that's the whole point).
2. `(dashboard)/layout.tsx` — invalid session redirects to `/logout`, not `/login`. That branch
   only fires when a cookie EXISTS but is stale (a cookie-less request never gets past
   middleware), so this is exactly the trapped case.
3. `lib/session.ts` `requireSiteAccess` — same fix, twice (no session, and session-valid-but-
   user-row-gone), covering site-scoped pages.
4. `app/logout/page.tsx` — always lands on `/login` even if the sign-out request fails, errors,
   or hangs (3s failsafe timer). Being stranded on a "Signing out…" spinner is the exact failure
   this page exists to prevent.

Verified with a fabricated stale cookie via curl (i.e. the **web** path, no desktop involved):
`/dashboard` → 307 → `/logout` → 200 → `/login` → 200. Loop broken.

**Desktop-only addition**: `shell:sign-out` IPC clears session cookies at the **Electron session
level**, then navigates to `/login` — deliberately NOT a navigation to the web app's `/logout`.
A navigation-based logout is useless precisely when the app is 404ing/500ing/unreachable, which
is when a stuck user most needs it. Wired to the profile menu's "Sign out".

**Known remaining gap (deliberate, needs a product call)**: middleware still doesn't *validate*
the session, only checks cookie presence — validating per-request means a DB hit in middleware,
a real performance tradeoff. The fixes above make the consequences harmless (users escape
instead of being trapped) but a stale cookie still costs one wasted round-trip through
`/logout`. Mitigation, not elimination.

### 4b. Shell menus must be WINDOWS, not DOM — and the SSR flicker (rev 11)

Two root causes found this round. Both had been misdiagnosed repeatedly before being found, so
the reasoning is written out here to stop anyone re-deriving it.

**(1) The chrome strip is the only visible part of the shell page.**

The shell chrome is the shell window's own `webContents`, but every tab is a `WebContentsView` —
a **native layer stacked on top of it**, occupying `y = CHROME_HEIGHT (84)` downwards. So
anything the shell renders below 84px is painted *underneath* the tab and is invisible.

The trap: such an element is completely healthy by every programmatic measure. It's in the DOM,
`hidden === false`, `getBoundingClientRect()` returns a real box, and click handlers fire. DOM
inspection **cannot** see native-layer occlusion. The profile menu opened correctly on every
click for as long as it existed and simply could not be seen. Measured proof:

```
shell viewport height: 900     tab view starts at y=84
profile-menu:      top=84  bottom=254   -> 100% covered
history-dropdown:  top=118              -> 100% covered
address-suggestions: top=83 bottom=126  -> all but 1px covered
```

Fix: menus are real popup windows (`src/main/popup.ts` + `src/shell/popup.{html,css,ts}`) —
frameless, transparent, `alwaysOnTop`, parented to the shell window, dismissed on blur. Exactly
what Chrome does, for exactly this reason. One reusable window is re-pointed per menu, so "only
one menu open at a time" falls out for free. Popups get the *same* preload as the shell chrome
(`preload/shell.js`), so a menu item just calls `shellApi.navigate/setTheme/signOut` directly.

Bug found while building it: content was first held in a module-level `pendingContent`, which
rendered an **empty card**. Closing the previous popup fires `blur`/`closed` *asynchronously*,
so the old window's teardown wiped the content the new popup had already stored. Content is now
bound to its own window via a `WeakMap`, resolved from `event.sender`, with identity guards so a
stale window's late event can't close its replacement.

> **If you add any new shell dropdown, tooltip, or context menu: it must be a popup window.**
> An in-page one will look correct in DevTools and be invisible to the user.

**(2) `useIsDesktop()` cannot fix desktop-vs-web *appearance*.**

`apps/platform` is server-rendered. The server has no `window`, so the first painted frame is
**always** the web layout; a `useIsDesktop()` branch can only correct it after hydration. That is
the reported "sidebar logo appears then disappears", "sidebar bottom section flashes", and "page
header isn't right until I refresh". `useLayoutEffect` does **not** help — the SSR HTML has
already painted before React hydrates at all.

Fix: `src/preload/index.ts` stamps `erp-desktop` on `<html>` at document_start, and the
desktop/web differences are expressed as CSS in `apps/platform/src/app/globals.css`
(`[data-desktop-only]`, `[data-desktop-hide]`, `[data-page-header-row]`, `[data-app-content]`,
`[data-items-container]`). Correct in the first painted frame. The web app is unaffected —
without the class every rule is inert. Coexists with `next-themes` (`... erp-desktop light`).

> **Rule going forward:** desktop-vs-web *appearance* belongs in CSS keyed on `.erp-desktop`.
> Reserve `useIsDesktop()` for genuine *behavior* differences (calling a native API, wiring an
> IPC listener), never for what the first paint looks like.

Also fixed this round: toolbar icons were inside `#toolbar`'s `-webkit-app-region: drag` region
and never opted out (`#toolbar > button` doesn't match them — they're nested in
`#toolbar-actions`), so mouse-down started a window drag and **no click event ever fired**. Note
that synthetic `element.dispatchEvent()` bypasses app-region handling entirely, so scripted
tests pass while a real mouse does nothing — test chrome clicks with CDP
`Input.dispatchMouseEvent`, not `dispatchEvent`. The Settings icon was also a circle with eight
radiating lines, which reads as a sun/brightness control; it's a real cog now.

Verified live via CDP against the running app: real-mouse click opens the profile popup
(`DO / Demo Owner / Settings / THEME / Light Dark System / Sign out`), history popup renders
route-derived labels (`WhatsApp 12:27 AM · /dashboard/whatsapp`) rather than the page `<title>`
(every page is titled "ProjectRD"), and on `/dashboard/items`: `erp-desktop` present, header row
`flex/row`, all `[data-desktop-hide]` elements `display:none`, zero visible sidebar logos.

**Address-bar suggestions — fixed in a follow-up pass, same session.** Same occlusion root cause
as the menus, but needed a different mechanic: it updates on every keystroke and must never steal
focus from the address bar's `<input>` (a different renderer, in the shell window). Solved with a
THIRD popup kind, `"suggestions"`, that differs from profile/history in three ways:

- `focusable: false` + `win.showInactive()` instead of `show()` — the window is visible and
  clickable but never receives OS focus, so the `<input>` keeps typing/caret/keyboard the whole
  time. `win.on("blur", ...)` (used for click-away on the other two) never fires for a
  non-focusable window, so it isn't wired for this kind — closing instead is driven explicitly
  from the shell (`addressBar` blur / Escape / a selection made).
- **Reuses the same window across keystrokes** via a new `updatePopupContent` IPC channel
  (`main/popup.ts`'s `updatePopupContent()`), rather than closing and reopening on every
  character — that would flash. Only the height is recomputed (row count changes); x/y/width
  never move mid-typing. `popupKind` guards against a stale update landing on a different popup
  that opened since.
- Positioned left-aligned under the full width of `#address-wrap`, not right-aligned under a
  button like profile/history.

Verified with REAL keyboard input via CDP (`Input.dispatchKeyEvent`, typing "inv" character by
character): popup opened showing "Items & Inventory / /dashboard/items";
`document.activeElement.id` stayed `"address-bar"` throughout, proving focus never left it;
ArrowDown reused the *same* popup window id and updated the highlighted row in place (not a
close/reopen); Escape closed it cleanly.

**Known-outstanding from this round:**

- Popup *visual* appearance (position, shadow, transparent edges) is unverified — CDP can read a
  popup's DOM but `Page.captureScreenshot` hangs on these windows, so no pixels were seen.
- The `[data-items-container]`, `[data-app-content]`, and nav-item CSS gates are typecheck-clean
  and use the identical, already-verified mechanism, but were not confirmed live: the app had
  returned to the logged-out landing page and logging in was out of scope.

## 5. Open documentation debt

- The full requirements doc (`ERP Desktop Application Requirements & Architecture Evaluation.pdf`)
  and the Electron-vs-Tauri evaluation response only exist in this chat session's history right
  now — worth pasting a condensed version into this file's §1/§2 next time this doc gets a real
  editing pass, so a future contributor doesn't need the original chat transcript.

## 6. Status — NOT started yet

- Printing: all three pipelines (A4/PDF, receipt/ESC-POS, label/ZPL) implemented and verified
  as far as possible without hardware (see §4). **Still needed once hardware is connected**:
  point real receipt/label printers at `printReceipt`/`printLabel` and confirm physical output
  looks right; verify the A4 pipeline against a real "A4" paperSize (only tested against
  virtual Letter/Legal printers so far). Printer-assignment SETTINGS UI (backend done, no UI —
  desktop-mode territory); wiring all three pipelines into real invoice/report/receipt/label
  buttons in `apps/platform`'s desktop-mode code.
- Tray icon (none planned — window-close quits per the locked decision above).
- Auto-updater: native mechanics done (see §4), but the actual corner-toast UI is not built
  (lives in `apps/platform`'s desktop-mode code). GitHub repo to publish to is now decided —
  `DevHydeOut/project-rd-desktop`.
- "Desktop mode" layout work — lives in `apps/platform`, not here. Started: sidebar declutter
  (logo/utility-row/settings-nav moved into the shell toolbar), Items & Inventory width, extra
  content padding — now driven by CSS keyed on `.erp-desktop`, **not** `useIsDesktop()` (see
  §4b for why the hook can't be used for appearance). Most of the original list (master-detail
  views, denser tables, command palette, resizable columns, native context menus) not built yet.
- **Never verified visually by the assistant** — GUI-level automation and screen capture don't
  reach the rendered window in this environment (see the remote-session note in §4). Every UI
  change this project has shipped was confirmed by the user looking at it, or indirectly (IPC
  probes, file side-effects, HTTP status). Plan verification accordingly.
  **As of rev 11 there is a much better indirect method**: launch with
  `npx electron . --remote-debugging-port=9222`, then drive CDP over the WebSocket from
  `http://127.0.0.1:9222/json` (Node 22 has a global `WebSocket`, no deps needed). This reads
  the real running renderers' DOM/computed styles and can send **real** mouse input via
  `Input.dispatchMouseEvent`. Two hard-won caveats: use `Input.dispatchMouseEvent`, never
  `element.dispatchEvent()` (which bypasses `-webkit-app-region` and gives false passes), and
  DOM inspection still cannot detect native-layer occlusion — check element bounds against
  `CHROME_HEIGHT` for anything in the shell. `Page.captureScreenshot` hangs on these windows,
  so actual pixels remain unverifiable.
- Icon — done (`apps/platform`'s real `favicon.ico`, multi-resolution).
- `electron-builder` packaging/distribution config — filled in (publish target
  `DevHydeOut/project-rd-desktop`), not yet actually run to produce a real installer.
- Tab strip polish: drag-to-reorder, overflow scroll-arrows, right-click tab context menu — none
  of these were asked for; noting as natural follow-ups, not gaps (see §4 tabs section).

## 7. Key file map

| Area | File |
|---|---|
| Main process entry / boot sequence | `src/main/index.ts` |
| Window creation (frameless shell + titleBarOverlay) | `src/main/window.ts` |
| Security config (CSP, navigation guards) — shared across all tabs | `src/main/security.ts` |
| Tab management (create/close/activate/navigate/history) | `src/main/tabs/tab-manager.ts` |
| Shell chrome UI (tab strip + toolbar) | `src/shell/index.html`, `index.css`, `index.ts` |
| Shell menus as popup WINDOWS (profile, history, address-bar suggestions) — see §4b for why they can't be DOM | `src/main/popup.ts`, `src/shell/popup.html`, `popup.css`, `popup.ts` |
| Shell preload (separate from tab-content preload) | `src/preload/shell.ts` |
| Shell IPC (Zod-validated, routes to active TabManager) + hard sign-out | `src/main/ipc/shell.ts` |
| **Desktop-mode detection — gate ALL desktop-only UI on this** | `apps/platform/src/lib/desktop/use-is-desktop.ts`, `erp-native.ts` |
| Desktop-only UI branches (sidebar, header, items width) | `apps/platform/src/components/shared/{sidebar,page-header}.tsx`, `components/items/items-client.tsx` |
| Stale-cookie escape hatch (web + desktop) | `apps/platform/src/proxy.ts`, `app/logout/page.tsx`, `app/(dashboard)/layout.tsx`, `lib/session.ts` |
| IPC whitelist registration | `src/main/ipc/index.ts` |
| IPC contract (channels, exposed API shape) | `src/shared/types.ts` |
| Preload for TAB content — window.erpNative (contextBridge boundary) | `src/preload/index.ts` |
| Printer detection + A4/PDF pipeline (done) | `src/main/services/printing/printer-registry.ts`, `pdf-print.ts` |
| Printer IPC (Zod-validated) | `src/main/ipc/printer.ts` |
| Receipt/label pipelines (implemented, needs real hardware to fully confirm) | `src/main/services/printing/escpos-print.ts`, `zpl-print.ts`, `raw-print.ts`, `resources/raw-print.ps1` |
| Printer-purpose assignment, per-machine (done, no settings UI) | `src/main/services/settings/store.ts`, `src/main/services/printing/index.ts` |
| Window-state persistence (done) | `src/main/services/window-state/index.ts`, `src/main/services/settings/store.ts` |
| Native menu + shortcuts (done, needs human visual check) | `src/main/menu.ts` |
| Auto-updater native mechanics (done, toast UI not built) | `src/main/services/updater/index.ts`, `src/main/ipc/updater.ts` |

## 8. How to run locally

```
pnpm --filter platform dev          # start the web app this shell loads (port 3000)
pnpm --filter desktop build         # tsc (main) + esbuild (preload + shell chrome bundles)
pnpm --filter desktop start         # launches the Electron shell against http://127.0.0.1:3000
```

Override the loaded URL with `PLATFORM_APP_URL` (e.g. to point at staging).

---

## 9. Changelog

- **2026-08-15 (rev 11)** — Found the two root causes behind a long run of "nothing changed"
  reports. **Shell menus can't be in-page DOM**: the active tab's `WebContentsView` is a native
  layer covering everything below the 84px chrome strip, so the profile menu was opening
  correctly and was simply invisible — and stayed misdiagnosed because DOM inspection can't see
  native occlusion (element present, `hidden:false`, real bounding box, handlers firing). Menus
  are now real always-on-top popup windows (`main/popup.ts`, `shell/popup.*`), Chrome-style.
  **`useIsDesktop()` can't fix appearance**: SSR paints the web layout before hydration, so the
  logo/header/sidebar-bottom flicker was unfixable in React — desktop-vs-web appearance is now
  CSS keyed on an `.erp-desktop` class stamped on `<html>` by the preload at document_start.
  Also fixed: toolbar icons sat in a window-drag region so real clicks never fired (synthetic
  `dispatchEvent` masked this in testing), the Settings icon was a sun, history entries showed
  the page `<title>` instead of route labels, and a popup-content race that rendered empty
  cards. Removed dead menu CSS + an unused export. **Same-day follow-up: fixed the address-bar
  suggestion dropdown too** — same occlusion bug, but as a third popup kind (`"suggestions"`)
  that's `focusable:false`/`showInactive()` and reuses one window across keystrokes via a new
  `updatePopupContent` push channel, so the address `<input>` never loses keyboard focus.
  Verified with real `Input.dispatchKeyEvent` typing, not synthetic events. See §4b.
- **2026-08-12 (rev 10)** — Chrome-chrome refinements (universal-search address bar with route
  autocomplete, toolbar icon row moved out of the sidebar, real notification badge via a new
  `reportNotifications` bridge, bigger icons/hit-targets, sidebar declutter). **Corrected a
  regression where desktop-only UI changes were applied globally** and leaked into the plain web
  app — all now gated on `useIsDesktop()`. Diagnosed "no link works" as a stale Turbopack cache
  (dev-only) making every link's destination a look-alike 404, and **fixed a real production
  stale-cookie infinite-redirect trap** in `apps/platform` that affected web and desktop alike,
  plus an Electron-level hard sign-out that works even when the web app is unreachable. See §4,
  §4a.
- **2026-08-09 (rev 9)** — Full multi-tab Chrome-style shell, by explicit request ("full
  multi-tab chrome"). Window is now a local shell page (tab strip + toolbar) with each tab a
  separate sandboxed WebContentsView, frameless window + titleBarOverlay for native-feeling
  min/max/close, tab-aware menu shortcuts (Ctrl+T/W/Tab), window-state persistence updated to
  save/restore the full tab list. Found and fixed a real close-time race condition (tab list
  save could lose a race against process teardown — now blocks close until the write lands).
  Verified live via IPC probes: tab creation/activation/console-isolation, and specifically
  reproduced-then-fixed-then-reverified the persistence race. See §4 for full detail.
- **2026-08-06 (rev 8)** — Temporary print-test page in `apps/platform` so real printers can be
  tested with real clicks without waiting for the desktop-mode UI. Verified live including a
  scripted real button click, not just direct API calls. Fixed a silent-failure gap (no error
  handling in the page's data-loading effect). Noted pre-existing unrelated TS errors in
  `apps/platform` for awareness. See §4.
- **2026-08-06 (rev 7)** — Icon (real favicon.ico copied in), distribution repo locked
  (`DevHydeOut/project-rd-desktop`, `electron-builder` wired up for real), and receipt/label
  printing taken as far as possible without hardware: raw Win32 print-spooler transport
  (PowerShell + P/Invoke, no native Node addon), ESC/POS + ZPL command builders, and
  per-machine printer-purpose assignment. Verified via a real (non-simulated) raw print job
  against this machine's print queue, then the full renderer→IPC→transport→spooler chain via
  IPC probes — both `printReceipt` and `printLabel` returned success. See §4 for full detail.
- **2026-08-05 (rev 6)** — Auto-updater native mechanics: electron-updater wired (silent
  background download, `update-ready` IPC push, `relaunchToUpdate()` action,
  `autoInstallOnAppQuit` fallback), dev-mode guard verified via clean boot, full API surface
  confirmed reachable from the page. Toast UI itself not built (belongs in `apps/platform`).
  Open decision flagged: which GitHub repo to publish releases to. See §4.
- **2026-08-05 (rev 5)** — Native menu (File/Edit/View/Window/Help) + keyboard shortcuts
  implemented. Code-level verification only — see §4 for why GUI-level confirmation wasn't
  possible in this session (a discovery about this session's remote-desktop nature, flagged
  clearly rather than claiming visual proof that doesn't exist). Needs a human visual check.
- **2026-08-05 (rev 4)** — Window-state persistence: bounds/maximized/last-path saved to a
  per-machine JSON store, restored on next launch (Brave-style). Verified rigorously via direct
  Win32 window manipulation (not just internal tests) — read side, debounced write side, and the
  close-handler's immediate-flush path all confirmed with exact-match evidence. See §4 for full
  detail.
- **2026-08-05 (rev 3)** — Printing spike: implemented + verified end-to-end silent A4/PDF
  printing (printer detection, IPC round-trip, real print job against this machine's queue).
  Receipt/label pipelines not attempted — no physical hardware available on this machine right
  now (only virtual printers detected; flagged the `RustDesk Printer` finding as a possible clue
  this session is remoted). See §4 for full detail, §6 for what's still open.
- **2026-08-05 (rev 2)** — Security hardening pass on the Electron shell: locked-down
  `BrowserWindow` config, origin allowlist + navigation guards, CSP (landing-page-scoped
  analytics allowance), contextBridge-only preload, Zod-validated IPC. Found and fixed two real
  bugs during live verification against the real dev server (preload needed bundling; CSP
  needed to be one combined string, not split array entries). See §4 for full detail.
- **2026-08-05 (rev 1)** — Initial `apps/desktop` folder scaffold: pnpm workspace member,
  stub tree for main/preload/services/ipc/shared, README, placeholder icon folder,
  `electron-builder.yml` stub.
