import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { format } from 'date-fns';

// Generic tabular exporters for Production reports (the order-shaped exporters in
// export.service.ts don't fit production data). Each takes a title + headers +
// rows and produces a branded PDF / Excel / CSV.

type Cell = string | number;

/**
 * Optional per-column Excel styling, by column index. `date` turns a
 * 'YYYY-MM-DD' string into a real date cell so `numFmt` can show it; any other
 * value (a footnote in that column) is written as it is.
 */
export interface ExcelColumn {
  numFmt?: string;
  date?: boolean;
  /** A fixed width; without one the column is sized to its text (see autoFit). */
  width?: number;
  /** Replaces `numFmt` on the TOTAL rows. */
  totalNumFmt?: string;
}

export interface ExcelSheet {
  title: string;
  headers: string[];
  rows: Cell[][];
  columns?: ExcelColumn[];
  /** Indexes into `rows` that are TOTAL lines: bold, and in each column's `totalNumFmt`. */
  totalRows?: number[];
  /**
   * Lines above the table — a title, the period, a summary — with a blank
   * line between them and the header row. `numFmts` formats a line's cells by
   * position; the columns' own formats start below the header.
   */
  preamble?: { cells: Cell[]; bold?: boolean; size?: number; numFmts?: (string | undefined)[]; highlight?: boolean }[];
  /** Cells shown in bold red (a statement's final balance): `row` indexes into `rows`, `col` from 0. */
  highlight?: { row: number; col: number }[];
  /**
   * Cells written as a formula (the closing stock taken off a Delivered:
   * =45000-17000): `row` indexes into `rows`, `col` from 0. The row's own value
   * is kept as the formula's cached result, so the cell shows it without a
   * recalculation, and PDF/CSV, which ignore this, print that value.
   */
  formulas?: { row: number; col: number; formula: string }[];
  /** Thin borders round the header and the data cells. */
  borders?: boolean;
  /**
   * Notes under the table, after a blank line: each across the table's width,
   * wrapped, its row as tall as its text. A part can be bold.
   */
  notes?: { text: string; bold?: boolean }[][];
}

/** The bold red of a statement's final balance. */
const HIGHLIGHT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFDC2626' } };
const THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
  right: { style: 'thin', color: { argb: 'FFBFBFBF' } },
};

export function genericPDF(title: string, headers: string[], rows: Cell[][]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fillColor('#F97316').fontSize(24).font('Helvetica-Bold').text('Mountain Bakes', { align: 'center' });
    doc.fillColor('#6B3B1E').fontSize(13).font('Helvetica').text(title, { align: 'center' });
    doc.fillColor('#333').fontSize(9).text(`Generated: ${format(new Date(), 'dd MMM yyyy HH:mm')}`, { align: 'center' });
    doc.moveDown(1);

    const startX = 40;
    const usable = 760;
    const colW = usable / Math.max(headers.length, 1);

    doc.fillColor('#6B3B1E').fontSize(10).font('Helvetica-Bold');
    let y = doc.y;
    headers.forEach((h, i) => doc.text(String(h), startX + i * colW, y, { width: colW - 4 }));
    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(800, doc.y).strokeColor('#F97316').stroke();
    doc.moveDown(0.3);

    doc.fillColor('#333').font('Helvetica').fontSize(9);
    for (const row of rows) {
      if (doc.y > 520) doc.addPage();
      y = doc.y;
      row.forEach((c, i) => doc.text(String(c ?? ''), startX + i * colW, y, { width: colW - 4 }));
      doc.moveDown(0.7);
    }

    doc.moveDown(2);
    doc.fillColor('#999').fontSize(8).text('Mountain Bakes ERP — Confidential', { align: 'center' });
    doc.end();
  });
}

export async function genericExcel(title: string, headers: string[], rows: Cell[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mountain Bakes ERP';
  const sheet = wb.addWorksheet(title.slice(0, 31));

  sheet.addRow(headers);
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF97316' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  for (const row of rows) sheet.addRow(row);
  autoFit(sheet);

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/**
 * Same styling as `genericExcel`, one sheet per entry — for an export whose
 * on-screen page has more than one table (e.g. a daily summary plus a
 * per-product breakdown) and needs them to land as separate tabs rather than
 * concatenated into one.
 */
export async function genericExcelMultiSheet(sheets: ExcelSheet[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mountain Bakes ERP';
  const used = new Set<string>();

  for (const { title, headers, rows, columns, totalRows, preamble = [], highlight = [], formulas = [], borders, notes = [] } of sheets) {
    const sheet = wb.addWorksheet(uniqueSheetName(title, used));
    // A statement is printed: landscape, the whole width on one page.
    sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    for (const line of preamble) {
      const row = sheet.addRow(trimNote(line.cells));
      if (line.bold || line.size) row.font = { bold: line.bold, size: line.size };
      if (line.highlight) row.eachCell((cell) => { if (cell.value !== '') cell.font = { ...HIGHLIGHT, size: line.size }; });
      line.numFmts?.forEach((numFmt, i) => { if (numFmt) row.getCell(i + 1).numFmt = numFmt; });
    }
    if (preamble.length > 0) sheet.addRow([]);
    const headerAt = sheet.rowCount + 1;
    sheet.addRow(headers);
    const headerRow = sheet.getRow(headerAt);
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF97316' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    for (const row of rows) {
      sheet.addRow(trimNote(row).map((v, i) => (columns?.[i]?.date && typeof v === 'string' && ISO_DATE.test(v) ? new Date(`${v}T00:00:00Z`) : v)));
    }
    sheet.columns.forEach((c, i) => {
      const numFmt = columns?.[i]?.numFmt;
      // Data rows only, so the header keeps its own look.
      if (numFmt) c.eachCell?.((cell, rowNumber) => { if (rowNumber > headerAt) cell.numFmt = numFmt; });
    });
    for (const i of totalRows ?? []) {
      const row = sheet.getRow(headerAt + 1 + i);
      row.font = { bold: true };
      row.eachCell((cell, col) => {
        const numFmt = columns?.[col - 1]?.totalNumFmt;
        if (numFmt) cell.numFmt = numFmt;
      });
    }
    for (const { row, col } of highlight) sheet.getRow(headerAt + 1 + row).getCell(col + 1).font = HIGHLIGHT;
    for (const { row, col, formula } of formulas) {
      const cell = sheet.getRow(headerAt + 1 + row).getCell(col + 1);
      const result = rows[row]?.[col];
      cell.value = { formula, ...(typeof result === 'number' ? { result } : {}) };
    }
    if (borders) {
      [headers, ...rows].forEach((cells, i) => {
        if (i > 0 && isNote(cells)) return;
        const row = sheet.getRow(headerAt + i);
        for (let col = 1; col <= headers.length; col++) row.getCell(col).border = THIN;
      });
    }
    autoFit(sheet);
    columns?.forEach((c, i) => { if (c.width) sheet.getColumn(i + 1).width = c.width; });
    // After autoFit: a merged note would otherwise widen its first column.
    if (notes.length > 0) {
      sheet.addRow([]);
      const span = Math.max(1, headers.length);
      let lineChars = 0;
      for (let col = 1; col <= span; col++) lineChars += sheet.getColumn(col).width ?? 9;
      for (const note of notes) {
        const row = sheet.addRow([]);
        sheet.mergeCells(row.number, 1, row.number, span);
        const cell = row.getCell(1);
        cell.value = { richText: note.map((p) => ({ text: p.text, ...(p.bold ? { font: { bold: true } } : {}) })) };
        cell.alignment = { wrapText: true, vertical: 'top' };
        // Excel does not size a merged cell's row to its text, so set it: ~15pt a line.
        const chars = note.reduce((a, p) => a + p.text.length, 0);
        row.height = Math.max(1, Math.ceil((chars * 1.1) / lineChars)) * 15 + 3;
      }
    }
  }

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A line with text in its first cell only — a title, a footnote. */
const isNote = (cells: Cell[]) => cells.length > 0 && cells.slice(1).every((v) => v === '' || v === null || v === undefined);

/**
 * A note keeps only its first cell. The blank ('') cells after it would stop
 * its text spilling across the empty columns, cutting it at the first one.
 */
function trimNote(cells: Cell[]): Cell[] {
  return isNote(cells) ? cells.slice(0, 1) : cells;
}

/** Roughly what a cell shows, in characters: a number as its format draws it, a date as dd mmm yyyy. */
function shownLength(cell: ExcelJS.Cell): number {
  // A formula cell shows its result.
  const raw = cell.value;
  const v = raw !== null && typeof raw === 'object' && 'formula' in raw ? (raw as { result?: ExcelJS.CellValue }).result : raw;
  if (v === null || v === undefined || v === '') return 0;
  if (v instanceof Date) return 11;
  if (typeof v === 'number') {
    const digits = Math.round(Math.abs(v)).toLocaleString('en-US').length + (v < 0 ? 1 : 0);
    const fmt = typeof cell.numFmt === 'string' ? cell.numFmt : '';
    return digits + (fmt.includes('Rs.') ? 4 : 0) + (fmt.includes('0.00') ? 3 : 0);
  }
  return String(v).length;
}

/**
 * Every column as wide as its widest cell (owner's call, 2026-10-29), header
 * included, so nothing shows cut off or as ####. A note line is left out: it
 * spills across the empty columns beside it instead of widening the first.
 * Row heights are left unset, so Excel sizes each row to its font (a
 * sheet's notes, which are merged, set their own).
 */
function autoFit(sheet: ExcelJS.Worksheet): void {
  const widths: number[] = [];
  sheet.eachRow((row) => {
    // A styled row (a bold title) has empty cells too: count the ones with text.
    let valued = 0;
    row.eachCell((cell) => { if (shownLength(cell) > 0) valued++; });
    if (valued <= 1) return;
    row.eachCell((cell, col) => {
      const shown = shownLength(cell) * ((cell.font ?? row.font)?.bold ? 1.1 : 1);
      widths[col - 1] = Math.max(widths[col - 1] ?? 0, Math.ceil(shown));
    });
  });
  // At least 10: ExcelJS leaves a width of exactly 9 (its default) unwritten.
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = Math.min(60, Math.max(10, (w ?? 0) + 2)); });
}

/**
 * A tab name Excel will accept. Tab titles can now come from data (a branch
 * name), and ExcelJS throws on the characters Excel forbids, on a name over 31
 * characters, and on a repeat — case-insensitive, so "Saddar" and "SADDAR" clash.
 * A repeat gets " (2)", " (3)"… rather than failing the whole export.
 */
function uniqueSheetName(title: string, used: Set<string>): string {
  const base = title.replace(/[*?:\\/[\]]/g, '-').replace(/^'+|'+$/g, '').trim() || 'Sheet';
  let name = base.slice(0, 31);
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

export function genericCSV(headers: string[], rows: Cell[][]): string {
  return [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
}
