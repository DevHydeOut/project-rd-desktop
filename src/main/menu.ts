// Native application menu (File/Edit/View/Window/Help) + the keyboard
// accelerators that ride along with it. Windows-only per the project scope,
// so no macOS-specific app-name menu handling — but still uses Electron's
// cross-platform "CmdOrCtrl" accelerator alias and built-in menu "role"s,
// since those are the standard idiom and cost nothing extra.
//
// Deliberately does NOT include a generic "Print" menu item — this app's
// whole point is purpose-specific silent printing (invoice/receipt/label)
// driven from the actual page UI, not a generic browser-style print command
// that would just reopen the exact dialog-based flow we're replacing.
//
// DevTools is only offered in dev (`!app.isPackaged`) — a shipped ERP build
// shouldn't casually expose Chromium devtools to end users. Worth
// confirming this default is what's wanted; easy to change if not.
//
// IMPORTANT (tabs): "Reload"/"Close" here must NOT use Electron's built-in
// `role: "reload"` / `role: "close"` — those act on the FOCUSED webContents,
// which since the tabs rewrite is the SHELL window's own chrome page, not
// whatever tab is active. Reloading via role would reload the tab strip
// itself, not the page you're looking at; closing would always close the
// whole window instead of just the active tab. Both are now explicit
// `click` handlers that go through the active TabManager instead.

import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { getActiveTabManager } from "./ipc/shell";

const HELP_URL = "https://github.com"; // TODO: swap for the real docs/support URL once one exists.

function buildTemplate(): Electron.MenuItemConstructorOptions[] {
  const isDev = !app.isPackaged;

  const fileMenu: Electron.MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      {
        label: "New Tab",
        accelerator: "CmdOrCtrl+T",
        click: () => getActiveTabManager()?.createTab(),
      },
      {
        label: "Close Tab",
        accelerator: "CmdOrCtrl+W",
        click: () => getActiveTabManager()?.closeActiveTab(),
      },
      { type: "separator" },
      { role: "quit", accelerator: "CmdOrCtrl+Q" },
    ],
  };

  const editMenu: Electron.MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const viewMenu: Electron.MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      {
        label: "Reload",
        accelerator: "CmdOrCtrl+R",
        click: () => getActiveTabManager()?.reloadActive(),
      },
      { type: "separator" },
      { role: "resetZoom", accelerator: "CmdOrCtrl+0" },
      { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
      { role: "zoomOut", accelerator: "CmdOrCtrl+-" },
      { type: "separator" },
      { role: "togglefullscreen", accelerator: "F11" },
      ...(isDev ? [{ role: "toggleDevTools" as const, accelerator: "CmdOrCtrl+Shift+I" }] : []),
    ],
  };

  const windowMenu: Electron.MenuItemConstructorOptions = {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { type: "separator" },
      {
        label: "Next Tab",
        accelerator: "Ctrl+Tab",
        click: () => getActiveTabManager()?.cycleTab(1),
      },
      {
        label: "Previous Tab",
        accelerator: "Ctrl+Shift+Tab",
        click: () => getActiveTabManager()?.cycleTab(-1),
      },
    ],
  };

  const helpMenu: Electron.MenuItemConstructorOptions = {
    label: "Help",
    submenu: [
      {
        label: "Learn More",
        click: () => {
          void shell.openExternal(HELP_URL);
        },
      },
      {
        label: "About ProjectRD",
        click: () => {
          const win = BrowserWindow.getFocusedWindow();
          const options: Electron.MessageBoxOptions = {
            type: "info",
            title: "About ProjectRD",
            message: "ProjectRD Desktop",
            detail: `Version ${app.getVersion()}`,
          };
          void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
        },
      },
    ],
  };

  return [fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}

export function setApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate()));
}
