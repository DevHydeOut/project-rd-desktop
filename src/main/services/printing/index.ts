// PrinterService — the single entry point the IPC layer calls into.
// Framework-agnostic on purpose: plain TypeScript, not Electron-specific, so
// the printing logic isn't tangled into IPC wiring.
//
// Status (2026-08-06):
//   - listPrinters / printPdf (A4 pipeline)      -> verified live against a
//     real Windows print queue (see HANDOVER.md printing-spike section).
//   - printReceipt (ESC/POS) / printLabel (ZPL)  -> implemented, NOT yet
//     verified against real hardware — no thermal/label printer has been
//     available to test against. Transport (raw-print.ts) and command
//     builders (escpos-print.ts, zpl-print.ts) are ready; the moment real
//     hardware is connected, start by sending a trivial payload through
//     printReceipt/printLabel and confirming it actually prints before
//     trusting more complex content.
//   - Printer-purpose assignment (invoice/receipt/label -> a specific
//     printer name, per-machine) is implemented and used automatically by
//     all three pipelines when the caller doesn't specify a printer
//     explicitly. No settings UI to EDIT assignments exists yet (that's a
//     desktop-mode UI concern, in apps/platform, not started).

import { getPrinterAssignments, setPrinterAssignment, type PrintPurpose } from "../settings/store";
import { listPrinters, type DetectedPrinter } from "./printer-registry";
import { printPdf as printPdfPipeline, type PrintPdfOptions } from "./pdf-print";
import { printReceipt as printReceiptPipeline, type ReceiptLine } from "./escpos-print";
import { printLabel as printLabelPipeline } from "./zpl-print";

export { type DetectedPrinter, type PrintPdfOptions, type ReceiptLine, type PrintPurpose };

/** Explicit printer name wins; otherwise falls back to this machine's saved
 * assignment for the purpose; otherwise undefined (the pipeline's own
 * default, e.g. the OS default printer for the A4/PDF pipeline). */
async function resolvePrinterName(purpose: PrintPurpose, explicit: string | undefined): Promise<string | undefined> {
  if (explicit) return explicit;
  const assignments = await getPrinterAssignments();
  return assignments[purpose];
}

export async function getPrinters(): Promise<DetectedPrinter[]> {
  return listPrinters();
}

export async function getPrinterAssignmentsForRenderer(): Promise<Partial<Record<PrintPurpose, string>>> {
  return getPrinterAssignments();
}

export async function assignPrinter(purpose: PrintPurpose, printerName: string | undefined): Promise<void> {
  await setPrinterAssignment(purpose, printerName);
}

export async function printInvoicePdf(options: Omit<PrintPdfOptions, "printerName"> & { printerName?: string }): Promise<void> {
  const printerName = await resolvePrinterName("invoice", options.printerName);
  await printPdfPipeline({ ...options, printerName });
}

export async function printReceiptLines(lines: ReceiptLine[], printerName?: string): Promise<void> {
  const resolved = await resolvePrinterName("receipt", printerName);
  if (!resolved) {
    throw new Error('No printer specified and no "receipt" printer assigned on this machine.');
  }
  await printReceiptPipeline(resolved, lines);
}

export async function printLabelZpl(zpl: string, printerName?: string): Promise<void> {
  const resolved = await resolvePrinterName("label", printerName);
  if (!resolved) {
    throw new Error('No printer specified and no "label" printer assigned on this machine.');
  }
  await printLabelPipeline(resolved, zpl);
}
