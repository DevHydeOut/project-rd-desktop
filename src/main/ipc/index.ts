// Registers every IPC handler exposed to the renderer. This is the ONLY file
// that should be imported to wire up ipcMain.handle calls — keeps the
// whitelist of what the frontend can reach centralized and auditable in one
// place, matching the security requirement (no generic "invoke anything"
// passthrough, no handler registered without a matching entry in
// shared/types.ts IPC_CHANNELS).
//
// Every handler MUST validate its input (Zod) before touching a native
// service — same discipline as projectrd's server actions, just at the IPC
// boundary instead of the HTTP boundary.

import { registerSystemIpc } from "./system";
import { registerPrinterIpc } from "./printer";
import { registerUpdaterIpc } from "./updater";
import { registerShellIpc } from "./shell";

export function registerIpcHandlers(): void {
  registerSystemIpc();
  registerPrinterIpc();
  registerUpdaterIpc();
  registerShellIpc();
}
