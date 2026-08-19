// Label pipeline: sends ZPL (Zebra Programming Language — also understood
// by many "Zebra-compatible" label printers, e.g. TSC in emulation mode)
// straight to the assigned label printer via raw-print.ts. ZPL is ASCII
// text, not binary, so there's no separate "byte builder" the way ESC/POS
// needs — a ZPL string IS the command.
//
// STATUS: implemented, NOT yet verified against real hardware — see
// raw-print.ts's status note. buildSimpleTextLabel below mirrors the
// "plain text only, no barcode graphic" label content already used for the
// reference MediSuite POS app's appointment labels (name/ID/date/doctor) —
// a reasonable starting template, not a fixed requirement.

import { sendRawBytes } from "./raw-print";

export interface TextLabelField {
  text: string;
  /** Font point size — ZPL's ^A0N,height,width. 24 is a reasonable default
   * for a small label's body text. */
  size?: number;
}

/** A minimal, plain-text ZPL label: one field per line, top to bottom, no
 * barcode. `widthDots`/`heightDots` should match the label stock actually
 * loaded (e.g. 812x609 for a common 4x3in label at 203dpi) — get this from
 * the real printer's spec once hardware is available; the defaults here
 * are a placeholder guess, not a verified value. */
export function buildSimpleTextLabel(fields: TextLabelField[], widthDots = 812, heightDots = 609): string {
  const lineHeight = 40;
  let y = 20;
  const body = fields
    .map((f) => {
      const size = f.size ?? 24;
      const line = `^FO20,${y}^A0N,${size},${size}^FD${escapeZpl(f.text)}^FS`;
      y += lineHeight;
      return line;
    })
    .join("\n");

  return `^XA\n^PW${widthDots}\n^LL${heightDots}\n${body}\n^XZ`;
}

/** ZPL treats ^ and ~ as control-command prefixes — strip/escape them out
 * of user-supplied field text so a stray caret in, say, a patient name
 * can't accidentally break out into a new ZPL command. */
function escapeZpl(text: string): string {
  return text.replace(/[\^~]/g, "");
}

export async function printLabel(printerName: string, zpl: string): Promise<void> {
  await sendRawBytes(printerName, Buffer.from(zpl, "ascii"));
}
