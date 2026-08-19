// Preload script — the ONLY bridge between the live-loaded web app (renderer,
// running with nodeIntegration: false + contextIsolation: true + sandbox: true)
// and the Electron main process.
//
// This file itself has Node access (preload scripts always do), but nothing
// it imports here is reachable from the page's own JavaScript — only what we
// explicitly hand across via contextBridge.exposeInMainWorld. The renderer
// never gets `ipcRenderer` directly (that would let any script in the loaded
// page — including a compromised third-party dependency of the web app —
// invoke ANY channel, not just the ones we intend). Every function exposed
// here is a thin wrapper around one specific, named IPC channel.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC_CHANNELS,
  type ErpNativeApi,
  type PrintPdfRequest,
  type PrintReceiptRequest,
  type PrintLabelRequest,
  type PrintPurpose,
  type UpdateReadyInfo,
  type UserProfileInfo,
  type ThemePreference,
} from "../shared/types";

const erpNative: ErpNativeApi = {
  system: {
    isDesktop: true,
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.systemGetVersion),
    reportNotifications: (count: number) => ipcRenderer.invoke(IPC_CHANNELS.systemReportNotifications, count),
    reportUserProfile: (profile: UserProfileInfo) => ipcRenderer.invoke(IPC_CHANNELS.systemReportUserProfile, profile),
    onThemeChangeRequested: (callback: (theme: ThemePreference) => void) => {
      const listener = (_event: IpcRendererEvent, theme: ThemePreference) => callback(theme);
      ipcRenderer.on(IPC_CHANNELS.systemThemeChangeRequested, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.systemThemeChangeRequested, listener);
    },
  },
  printer: {
    getPrinters: () => ipcRenderer.invoke(IPC_CHANNELS.printerGetPrinters),
    printPdf: (request: PrintPdfRequest) => ipcRenderer.invoke(IPC_CHANNELS.printerPrintPdf, request),
    printReceipt: (request: PrintReceiptRequest) => ipcRenderer.invoke(IPC_CHANNELS.printerPrintReceipt, request),
    printLabel: (request: PrintLabelRequest) => ipcRenderer.invoke(IPC_CHANNELS.printerPrintLabel, request),
    getAssignments: () => ipcRenderer.invoke(IPC_CHANNELS.printerGetAssignments),
    setAssignment: (purpose: PrintPurpose, printerName: string | undefined) =>
      ipcRenderer.invoke(IPC_CHANNELS.printerSetAssignment, { purpose, printerName }),
  },
  updater: {
    onUpdateReady: (callback: (info: UpdateReadyInfo) => void) => {
      const listener = (_event: IpcRendererEvent, info: UpdateReadyInfo) => callback(info);
      ipcRenderer.on(IPC_CHANNELS.updaterUpdateReady, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.updaterUpdateReady, listener);
    },
    relaunchToUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.updaterRelaunch),
  },
};

contextBridge.exposeInMainWorld("erpNative", erpNative);

// Mark the document as "running inside the desktop shell" as early as
// possible — preload runs at document_start, BEFORE the page's HTML is
// parsed or painted.
//
// This exists because a React hook cannot fix the logo/header flicker. The
// platform app is server-rendered: the server has no `window`, so its HTML
// is always the WEB layout, and the browser paints that before React
// hydrates. No effect (layout or otherwise) runs early enough to prevent
// that first paint — the user genuinely sees the sidebar logo and bottom
// section appear, then vanish when hydration flips the branch.
//
// A class on <html> is available to CSS on the very first style resolution,
// so the desktop/web difference can be expressed in CSS and is correct in
// the first painted frame. See `html.erp-desktop` rules in the platform's
// globals.css.
function markDesktop(): void {
  document.documentElement?.classList.add("erp-desktop");
}
markDesktop();
// documentElement can be missing at the very first tick in some load paths;
// re-apply once the document exists so we can't lose the race.
document.addEventListener("readystatechange", markDesktop);
