import { app, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/types";
import { getPrinters, printInvoicePdf, printReceiptLines, printLabelZpl, getPrinterAssignmentsForRenderer, assignPrinter } from "../services/printing";

const NoArgs = z.undefined();

const PRINT_PURPOSES = ["invoice", "receipt", "label"] as const;

const PrintPdfPayload = z.object({
  // Base64 has a fairly tight charset; also cap size (~25MB of base64,
  // comfortably above any real invoice/report PDF) so a malformed or
  // malicious payload can't be used to exhaust disk/memory via this channel.
  pdfBase64: z
    .string()
    .min(1)
    .max(25_000_000)
    .regex(/^[A-Za-z0-9+/]+=*$/, "not valid base64"),
  printerName: z.string().min(1).max(200).optional(),
  copies: z.number().int().positive().max(50).optional(),
  paperSize: z.string().min(1).max(50).optional(),
});

const ReceiptLinePayload = z.object({
  text: z.string().max(500), // one receipt line — generous but bounded
  bold: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  doubleHeight: z.boolean().optional(),
});

const PrintReceiptPayload = z.object({
  lines: z.array(ReceiptLinePayload).min(1).max(200), // 200 lines is already a very long receipt
  printerName: z.string().min(1).max(200).optional(),
});

const PrintLabelPayload = z.object({
  zpl: z.string().min(1).max(20_000), // ZPL is compact text; 20KB covers even an elaborate label
  printerName: z.string().min(1).max(200).optional(),
});

const SetAssignmentPayload = z.object({
  purpose: z.enum(PRINT_PURPOSES),
  printerName: z.string().min(1).max(200).optional(),
});

export function registerPrinterIpc(): void {
  ipcMain.handle(IPC_CHANNELS.printerGetPrinters, async (_event, payload) => {
    NoArgs.parse(payload);
    return getPrinters();
  });

  ipcMain.handle(IPC_CHANNELS.printerPrintPdf, async (_event, payload) => {
    const { pdfBase64, printerName, copies, paperSize } = PrintPdfPayload.parse(payload);

    // Renderer hands over document bytes, not a path (it has no filesystem
    // access) — write to a per-job temp file, print, then always clean up,
    // even on failure.
    const dir = path.join(app.getPath("temp"), "projectrd-desktop-print");
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${randomUUID()}.pdf`);

    try {
      await writeFile(filePath, Buffer.from(pdfBase64, "base64"));
      await printInvoicePdf({ filePath, printerName, copies, paperSize });
    } finally {
      await rm(filePath, { force: true });
    }
  });

  ipcMain.handle(IPC_CHANNELS.printerPrintReceipt, async (_event, payload) => {
    const { lines, printerName } = PrintReceiptPayload.parse(payload);
    await printReceiptLines(lines, printerName);
  });

  ipcMain.handle(IPC_CHANNELS.printerPrintLabel, async (_event, payload) => {
    const { zpl, printerName } = PrintLabelPayload.parse(payload);
    await printLabelZpl(zpl, printerName);
  });

  ipcMain.handle(IPC_CHANNELS.printerGetAssignments, async (_event, payload) => {
    NoArgs.parse(payload);
    return getPrinterAssignmentsForRenderer();
  });

  ipcMain.handle(IPC_CHANNELS.printerSetAssignment, async (_event, payload) => {
    const { purpose, printerName } = SetAssignmentPayload.parse(payload);
    await assignPrinter(purpose, printerName);
  });
}
