// Receipt pipeline: builds raw ESC/POS command bytes and sends them via
// raw-print.ts straight to the assigned receipt/thermal printer — no HTML
// rendering, no dialog. Standard command set understood by the vast
// majority of ESC/POS-compatible printers (Epson and its many clones).
//
// STATUS: implemented, NOT yet verified against real hardware — see
// raw-print.ts's status note. The command bytes below follow the
// well-documented, stable ESC/POS spec (unchanged across decades of
// hardware), so the risk here is lower than with the transport mechanism
// itself, but "should work per the spec" is not the same as "verified on a
// real printer." Test with a trivial payload first once hardware exists.

import { sendRawBytes } from "./raw-print";

const ESC = 0x1b;
const GS = 0x1d;

const CMD = {
  init: Buffer.from([ESC, 0x40]), // ESC @  — reset printer to defaults
  boldOn: Buffer.from([ESC, 0x45, 0x01]), // ESC E 1
  boldOff: Buffer.from([ESC, 0x45, 0x00]), // ESC E 0
  alignLeft: Buffer.from([ESC, 0x61, 0x00]), // ESC a 0
  alignCenter: Buffer.from([ESC, 0x61, 0x01]), // ESC a 1
  alignRight: Buffer.from([ESC, 0x61, 0x02]), // ESC a 2
  doubleHeightOn: Buffer.from([GS, 0x21, 0x01]), // GS ! 1  (double height, normal width)
  doubleHeightOff: Buffer.from([GS, 0x21, 0x00]), // GS ! 0
  lineFeed: Buffer.from([0x0a]),
  // GS V 66 3 — partial cut, feeding a few lines first. The most widely
  // supported "cut" variant across Epson-compatible hardware.
  feedAndCut: Buffer.from([0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x03]),
};

export interface ReceiptLine {
  text: string;
  bold?: boolean;
  align?: "left" | "center" | "right";
  doubleHeight?: boolean;
}

export function buildEscPosReceipt(lines: ReceiptLine[]): Buffer {
  const parts: Buffer[] = [CMD.init];

  for (const line of lines) {
    parts.push(
      line.align === "center" ? CMD.alignCenter : line.align === "right" ? CMD.alignRight : CMD.alignLeft,
      line.bold ? CMD.boldOn : CMD.boldOff,
      line.doubleHeight ? CMD.doubleHeightOn : CMD.doubleHeightOff,
      // ESC/POS printers are single-byte/code-page text, not UTF-8 — plain
      // ASCII (the overwhelming case for receipt content: names, numbers,
      // currency amounts) round-trips correctly. Non-ASCII characters will
      // render as whatever the printer's active code page maps them to,
      // which is a real limitation worth knowing about once real content
      // (e.g. non-English names) is tested against real hardware.
      Buffer.from(line.text, "ascii"),
      CMD.lineFeed
    );
  }

  parts.push(CMD.feedAndCut);
  return Buffer.concat(parts);
}

export async function printReceipt(printerName: string, lines: ReceiptLine[]): Promise<void> {
  await sendRawBytes(printerName, buildEscPosReceipt(lines));
}

/** Escape hatch for callers that want to construct their own ESC/POS byte
 * sequence directly (e.g. a cash-drawer kick pulse, or a command this
 * builder doesn't cover) rather than going through buildEscPosReceipt. */
export async function printReceiptRaw(printerName: string, bytes: Buffer): Promise<void> {
  await sendRawBytes(printerName, bytes);
}
