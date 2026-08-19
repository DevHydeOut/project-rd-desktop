// Lists printers installed on the OS (Windows print spool) so the frontend's
// printer-assignment settings page can offer them as options.
//
// Uses pdf-to-printer's getPrinters()/getDefaultPrinter() (backed by a
// PowerShell Get-Printer call under the hood) rather than hand-rolling our
// own PowerShell/WMI call here — it's the same library the A4 pipeline
// (pdf-print.ts) already depends on for silent printing, so this avoids a
// second, redundant way of talking to the Windows print spooler.

import { getPrinters as pdfToPrinterGetPrinters, getDefaultPrinter } from "pdf-to-printer";

export interface DetectedPrinter {
  name: string;
  paperSizes: string[];
  isDefault: boolean;
}

export async function listPrinters(): Promise<DetectedPrinter[]> {
  const [printers, defaultPrinter] = await Promise.all([pdfToPrinterGetPrinters(), getDefaultPrinter()]);

  return printers.map((p) => ({
    name: p.name,
    paperSizes: p.paperSizes,
    isDefault: defaultPrinter?.name === p.name,
  }));
}
