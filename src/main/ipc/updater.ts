import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/types";
import { relaunchToUpdate } from "../services/updater";

const NoArgs = z.undefined();

export function registerUpdaterIpc(): void {
  ipcMain.handle(IPC_CHANNELS.updaterRelaunch, async (_event, payload) => {
    NoArgs.parse(payload);
    relaunchToUpdate();
  });
}
