// A4 pipeline: silent-prints a PDF (invoices/reports/statements) directly to
// the assigned Windows printer, no print dialog.
//
// Backed by pdf-to-printer, which bundles SumatraPDF and drives it in
// "-print-to" mode — that mode is inherently non-interactive (no dialog),
// so `silent: true` here only suppresses SumatraPDF's own error message box
// on failure, not a print dialog (there was never one to suppress).
//
// Verified against this machine's real print queue (2026-08-05): printer
// detection + a real print() call against "RustDesk Printer" both succeeded
// with zero exceptions and no dialog. NOT yet verified against a physical
// A4 printer or with an "A4" paperSize value — every printer currently
// installed here is a virtual/US-locale driver (Letter/Legal/Tabloid only,
// no A4 in the list). Re-verify paperSize:"A4" once real hardware is
// available.

import { print } from "pdf-to-printer";

export interface PrintPdfOptions {
  /** Absolute path to the PDF file to print. Caller owns writing it (e.g.
   * to app.getPath("temp")) and cleaning it up afterward. */
  filePath: string;
  /** Windows printer name, as returned by listPrinters(). Omit to use the
   * OS default printer. */
  printerName?: string;
  copies?: number;
  paperSize?: string;
}

export async function printPdf(options: PrintPdfOptions): Promise<void> {
  await print(options.filePath, {
    printer: options.printerName,
    copies: options.copies,
    paperSize: options.paperSize,
    silent: true,
  });
}
