# ProjectRD Desktop

Native Windows shell for the ProjectRD platform app. Loads the live
`apps/platform` web app inside an Electron window (not a bundled copy — so
web-app changes reach the desktop app without a separate desktop release)
and adds native OS capabilities the browser can't: silent printing (A4/
receipt/label, any brand), window-state restore, system tray/menu, and
background auto-updates.

See the project's `HANDOVER.md` §7 for how this connects to the platform
app's known printing gap, and the desktop-app architecture discussion
(kept in this session's history) for the full rationale behind each choice
below.

## Status

Scaffolding only — no implementation yet. Next step: the printing spike
(prove silent PDF + raw ESC/POS + raw ZPL printing against real hardware
before building anything else on top of it).

## Structure

```
src/
  main/                    Electron main process
    index.ts                 App entry / boot sequence
    menu.ts                  Native application menu
    ipc/                      IPC handlers (the ONLY whitelisted surface
                              the renderer can call — see preload/index.ts)
      index.ts
      printer.ts
      system.ts
    services/                Framework-agnostic native service layer —
                              plain TypeScript, not Electron-specific
      printing/                A4 (pdf-print), receipt (escpos-print),
                                label (zpl-print), printer-registry
      settings/                Per-machine local settings (printer
                                assignments, window state) — NOT per login
      updater/                 electron-updater wiring (GitHub releases)
      window-state/            Persist/restore bounds + last route (Brave-
                                style "reopen where you left off")
  preload/                  contextBridge — exposes window.erpNative.*
                              to the renderer, nothing else
  shared/                   Types shared across main/preload/web-app
build/icons/               App icon (drop icon.ico here)
resources/                 Installer assets
electron-builder.yml       Packaging/publish config
```

## Key architectural decisions (recap)

- **Electron, not Tauri** — printing (silent, raw ESC/POS + ZPL + PDF,
  any printer brand) is the highest-priority requirement and has a far more
  mature story in Node/Electron than in Tauri's webview-first model.
- **Live-loaded frontend, not bundled** — the desktop app points at the real
  platform app URL. A "desktop mode" layout toggle lives in `apps/platform`
  itself (not here) so the UI can look better on desktop without forking the
  codebase; it gets removed once the whole app is redesigned with desktop in
  mind.
- **No offline support** — same as the web app, requires internet.
- **Printer assignment is per-machine**, not per-login (a staff member may
  use different PCs with different printers attached).
- **Security**: `nodeIntegration: false`, `contextIsolation: true`, sandboxed
  where possible, CSP enabled, every IPC payload validated (Zod), no direct
  filesystem/shell/OS-API access from the renderer — only the narrow
  `window.erpNative.*` surface.
