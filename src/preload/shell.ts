// Preload for the SHELL window's own chrome (tab strip + toolbar) — a
// separate, narrower surface from src/preload/index.ts, which is what gets
// injected into each TAB's content (the live platform app). The shell is
// our own trusted code, but still goes through contextBridge rather than
// getting raw ipcRenderer, for the same reason every other preload in this
// app does: one deliberate, auditable API surface, not "can invoke
// anything."

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  SHELL_IPC_CHANNELS,
  type ShellApi,
  type TabInfo,
  type UserProfileInfo,
  type ThemePreference,
  type PopupKind,
  type PopupAnchor,
  type PopupContent,
} from "../shared/types";

const shellApi: ShellApi = {
  getTabs: () => ipcRenderer.invoke(SHELL_IPC_CHANNELS.getTabs),
  createTab: (path?: string) => ipcRenderer.invoke(SHELL_IPC_CHANNELS.createTab, path),
  closeTab: (id: string) => ipcRenderer.invoke(SHELL_IPC_CHANNELS.closeTab, id),
  activateTab: (id: string) => ipcRenderer.invoke(SHELL_IPC_CHANNELS.activateTab, id),
  navigate: (pathOrUrl: string) => ipcRenderer.invoke(SHELL_IPC_CHANNELS.navigate, pathOrUrl),
  signOut: () => ipcRenderer.invoke(SHELL_IPC_CHANNELS.signOut),
  goBack: () => ipcRenderer.invoke(SHELL_IPC_CHANNELS.goBack),
  goForward: () => ipcRenderer.invoke(SHELL_IPC_CHANNELS.goForward),
  reload: () => ipcRenderer.invoke(SHELL_IPC_CHANNELS.reload),
  setTheme: (theme: ThemePreference) => ipcRenderer.invoke(SHELL_IPC_CHANNELS.setTheme, theme),
  // Popup windows get this SAME preload (they're shell chrome too), so a
  // menu item can call navigate/setTheme/signOut directly.
  openPopup: (kind: PopupKind, anchor: PopupAnchor, content: PopupContent) =>
    ipcRenderer.invoke(SHELL_IPC_CHANNELS.openPopup, { kind, anchor, content }),
  closePopup: () => ipcRenderer.invoke(SHELL_IPC_CHANNELS.closePopup),
  getPopupContent: () => ipcRenderer.invoke(SHELL_IPC_CHANNELS.getPopupContent),
  updatePopupContent: (content: PopupContent) => ipcRenderer.invoke(SHELL_IPC_CHANNELS.updatePopupContent, content),
  onPopupContentChanged: (callback: (content: PopupContent) => void) => {
    const listener = (_event: IpcRendererEvent, content: PopupContent) => callback(content);
    ipcRenderer.on(SHELL_IPC_CHANNELS.popupContentChanged, listener);
    return () => ipcRenderer.removeListener(SHELL_IPC_CHANNELS.popupContentChanged, listener);
  },
  onPopupClosed: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(SHELL_IPC_CHANNELS.popupClosed, listener);
    return () => ipcRenderer.removeListener(SHELL_IPC_CHANNELS.popupClosed, listener);
  },
  onTabsChanged: (callback: (tabs: TabInfo[]) => void) => {
    const listener = (_event: IpcRendererEvent, tabs: TabInfo[]) => callback(tabs);
    ipcRenderer.on(SHELL_IPC_CHANNELS.tabsChanged, listener);
    return () => ipcRenderer.removeListener(SHELL_IPC_CHANNELS.tabsChanged, listener);
  },
  onNotificationsChanged: (callback: (count: number) => void) => {
    const listener = (_event: IpcRendererEvent, count: number) => callback(count);
    ipcRenderer.on(SHELL_IPC_CHANNELS.notificationsChanged, listener);
    return () => ipcRenderer.removeListener(SHELL_IPC_CHANNELS.notificationsChanged, listener);
  },
  onUserProfileChanged: (callback: (profile: UserProfileInfo) => void) => {
    const listener = (_event: IpcRendererEvent, profile: UserProfileInfo) => callback(profile);
    ipcRenderer.on(SHELL_IPC_CHANNELS.userProfileChanged, listener);
    return () => ipcRenderer.removeListener(SHELL_IPC_CHANNELS.userProfileChanged, listener);
  },
};

contextBridge.exposeInMainWorld("shellApi", shellApi);
