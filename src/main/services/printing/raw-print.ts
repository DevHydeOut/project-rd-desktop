// Shared low-level transport for both the receipt (ESC/POS) and label (ZPL)
// pipelines: sends a Buffer of raw bytes straight to a named Windows
// printer, no GDI rendering, no dialog — exactly what thermal/label
// printers expect (they interpret the byte stream as commands, not a page).
//
// Delegates the actual Win32 spooler calls to resources/raw-print.ps1 (a
// PowerShell script using P/Invoke into winspool.drv) rather than a native
// Node addon — avoids requiring node-gyp/Visual Studio build tools on every
// machine this app is installed on, which would be a real reliability risk
// for a years-long ERP deployment across many customer PCs.
//
// STATUS (2026-08-06): implemented, NOT yet verified against real hardware
// — no physical ESC/POS or ZPL-capable printer has been available to test
// against in this environment. The transport mechanism (this file) is
// generic and printer-agnostic; escpos-print.ts / zpl-print.ts only differ
// in what bytes they hand it. Once a real printer is connected, testing
// should start here (send a trivial payload, confirm it prints) before
// trusting the higher-level ESC/POS/ZPL command builders.

import { app } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function scriptPath(): string {
  // Packaged builds ship resources/ alongside the app via electron-builder's
  // extraResources (see electron-builder.yml); dev runs read straight from
  // the source tree.
  return app.isPackaged ? path.join(process.resourcesPath, "raw-print.ps1") : path.join(__dirname, "../../../../resources/raw-print.ps1");
}

export async function sendRawBytes(printerName: string, data: Buffer): Promise<void> {
  const dir = path.join(app.getPath("temp"), "projectrd-desktop-print");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${randomUUID()}.raw`);

  try {
    await writeFile(filePath, data);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath(), "-PrinterName", printerName, "-FilePath", filePath],
        { windowsHide: true }
      );

      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Raw print to "${printerName}" failed (exit ${code}): ${stderr.trim() || "no error output"}`));
        }
      });
    });
  } finally {
    await rm(filePath, { force: true });
  }
}
