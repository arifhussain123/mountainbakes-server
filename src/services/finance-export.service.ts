import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { format } from 'date-fns';
import type { FinanceReport, FinanceReportColumn } from '../shared';
import { round2 } from './finance-settings.service';

/**
 * One PDF writer, one Excel writer, one CSV writer — for all ten finance reports.
 *
 * This is possible because `buildFinanceReport` returns a uniform descriptor
 * (columns + rows + totals + summary) rather than ten bespoke shapes. The
 * alternative shipped in export.service.ts, which hardcodes the order columns
 * and can therefore only ever export orders; adding a report there means adding
 * a writer. Here a new report needs no export code at all.
 *
 * The brand colours match export.service.ts so a finance PDF and a sales PDF
 * look like they came from the same company.
 */

const BRAND = '#F97316';
const INK = '#6B3B1E';
const BODY = '#333333';
const MUTED = '#999999';

/** en-PK grouping, matching money() in closing-report.service.ts. */
function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '';
  return Number(n).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function cellText(value: unknown, col: FinanceReportColumn): string {
  if (value === null || value === undefined || value === '') return '';
  if (col.format === 'money') return money(Number(value));
  if (col.format === 'number') return Number(value).toLocaleString('en-PK');
  return String(value);
}

/**
 * Shrinks `text` to the longest prefix (plus "…") that fits `maxWidth` at the
 * document's current font/size, or returns it unchanged if it already fits.
 *
 * pdfkit's own `lineBreak: false` / `ellipsis: true` text options do NOT stop
 * a long cell from word-wrapping onto a second line — `ellipsis` there only
 * fires once a `height` cap is reached, not per line. Every cell here is
 * positioned at an absolute (x, y) with a fixed row-height advance, so a
 * second wrapped line draws straight into the row below it — the "headers
 * and rows overlapping" bug. Truncating the string up front keeps every cell
 * to one line, so no wrap can ever happen.
 */
function truncateToWidth(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (maxWidth <= 0 || doc.widthOfString(text) <= maxWidth) return text;
  const ELLIPSIS = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const fits = doc.widthOfString(text.slice(0, mid) + ELLIPSIS) <= maxWidth;
    if (fits) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? ELLIPSIS : text.slice(0, lo) + ELLIPSIS;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * Landscape A4. Finance reports are wide — the cash book alone has ten columns —
 * and portrait would either clip them or shrink the type past legibility.
 *
 * Column widths come from the report descriptor's `width` hints (character-ish
 * units), normalised to the printable width so a report with few columns spreads
 * out and one with many stays inside the page.
 */
export async function exportFinanceReportPDF(report: FinanceReport, companyName = 'Mountain Bakes'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const printable = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // `pdfOmit` columns (e.g. Status, Approved By on the cash book) stay in
    // Excel/CSV, which are worked with, but drop out of the PDF, which is
    // printed and filed.
    const columns = report.columns.filter((c) => !c.pdfOmit);
    const weights = columns.map((c) => c.width ?? 16);
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const widths = weights.map((w) => (w / totalWeight) * printable);
    // Running x position of each column — plain prefix sum. A `reduce` here
    // previously doubled the first column's x and shifted every column after
    // it by one slot, so adjacent headers (and cells) landed on top of each
    // other; this is the actual cause of the overlap.
    const xs: number[] = [];
    let cursorX = left;
    for (const w of widths) {
      xs.push(cursorX);
      cursorX += w;
    }

    // Gutter kept between a cell's text and the next column's — wide enough
    // that two adjacent values (e.g. a full "Balance" figure butting up against
    // "Status") never read as touching, on headers and body rows alike.
    const GUTTER = 10;

    const drawHeader = () => {
      doc.fillColor(BRAND).fontSize(18).font('Helvetica-Bold').text(companyName, left, doc.page.margins.top);
      doc.moveDown(0.25);
      doc.fillColor(INK).fontSize(13).font('Helvetica-Bold').text(report.title, left);
      doc.moveDown(0.25);
      doc.fillColor(BODY).fontSize(8).font('Helvetica').text(report.subtitle, left);
      doc.moveDown(0.25);
      doc
        .fillColor(MUTED)
        .fontSize(7)
        .text(
          `Period ${report.periodFrom} to ${report.periodTo}   ·   ` +
            `Generated ${format(new Date(report.generatedAt), 'dd MMM yyyy HH:mm')} by ${report.generatedBy}`,
          left,
        );
      doc.moveDown(0.8);
    };

    const drawColumnHeads = () => {
      const y = doc.y;
      doc.fillColor(INK).fontSize(7.5).font('Helvetica-Bold');
      columns.forEach((c, i) => {
        const w = widths[i]! - GUTTER;
        doc.text(truncateToWidth(doc, c.label, w), xs[i]!, y, { width: w, align: c.align ?? 'left' });
      });
      doc.y = y + 14;
      doc.moveTo(left, doc.y).lineTo(left + printable, doc.y).strokeColor(BRAND).lineWidth(0.8).stroke();
      doc.y += 5;
    };

    drawHeader();

    // Summary strip — the headline figures, before the detail.
    if (report.summary.length > 0) {
      const y = doc.y;
      const boxWidth = printable / report.summary.length;
      report.summary.forEach((s, i) => {
        const x = left + i * boxWidth;
        doc.fillColor(MUTED).fontSize(7).font('Helvetica').text(s.label, x, y, { width: boxWidth - 6 });
        doc
          .fillColor(INK)
          .fontSize(11)
          .font('Helvetica-Bold')
          .text(s.format === 'number' ? Number(s.value).toLocaleString('en-PK') : money(s.value), x, y + 9, {
            width: boxWidth - 6,
          });
      });
      doc.y = y + 26;
      doc.moveDown(0.3);
    }

    drawColumnHeads();

    // `doc.y` is compared against the page's bottom margin rather than a magic
    // number so the break still works if the page size or margins change.
    const bottom = doc.page.height - doc.page.margins.bottom - 24;

    doc.font('Helvetica').fontSize(7).fillColor(BODY);
    for (const row of report.rows) {
      if (doc.y > bottom) {
        doc.addPage();
        drawHeader();
        drawColumnHeads();
        doc.font('Helvetica').fontSize(7).fillColor(BODY);
      }
      const y = doc.y;
      columns.forEach((c, i) => {
        const w = widths[i]! - GUTTER;
        // One line per cell: a wrapped description would push the row's
        // other cells out of alignment and run into the next row, since
        // each cell is positioned absolutely with a fixed row-height advance.
        doc.text(truncateToWidth(doc, cellText(row[c.key], c), w), xs[i]!, y, { width: w, align: c.align ?? 'left' });
      });
      doc.y = y + 12;
    }

    // Totals footer
    if (Object.keys(report.totals).length > 0) {
      doc.moveTo(left, doc.y + 2).lineTo(left + printable, doc.y + 2).strokeColor(BRAND).lineWidth(0.8).stroke();
      doc.y += 6;
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK);
      columns.forEach((c, i) => {
        const total = report.totals[c.key];
        const text = total !== undefined ? money(total) : i === 0 ? 'TOTAL' : '';
        const w = widths[i]! - GUTTER;
        doc.text(truncateToWidth(doc, text, w), xs[i]!, y, { width: w, align: c.align ?? 'left' });
      });
      doc.y = y + 14;
    }

    doc.fillColor(MUTED).fontSize(6.5).font('Helvetica')
      .text(`${companyName} — Finance Ledger. Confidential.`, left, doc.page.height - doc.page.margins.bottom - 10, {
        width: printable,
        align: 'center',
      });

    doc.end();
  });
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

export async function exportFinanceReportExcel(report: FinanceReport, companyName = 'Mountain Bakes'): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = `${companyName} ERP — Finance Ledger`;
  workbook.created = new Date(report.generatedAt);

  // `excelOmit` columns (e.g. Status, Approved By on the cash book) stay in
  // the PDF/CSV, which are printed and filed, but drop out of the workbook,
  // which is worked with.
  const columns = report.columns.filter((c) => !c.excelOmit);

  // Sheet names cannot exceed 31 characters or contain []:*?/\ — a report title
  // like "Partner Expense Report" is fine, but sanitising here means a future
  // title can never make the whole export throw.
  const sheetName = report.title.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31);
  const sheet = workbook.addWorksheet(sheetName, {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    views: [{ state: 'frozen', ySplit: headerRowCount(report) }],
  });

  sheet.mergeCells(1, 1, 1, Math.max(columns.length, 2));
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = `${companyName} — ${report.title}`;
  titleCell.font = { bold: true, size: 14, color: { argb: 'FF6B3B1E' } };

  sheet.mergeCells(2, 1, 2, Math.max(columns.length, 2));
  const subtitleCell = sheet.getCell(2, 1);
  subtitleCell.value = `${report.subtitle}  ·  Generated ${format(new Date(report.generatedAt), 'dd MMM yyyy HH:mm')} by ${report.generatedBy}`;
  subtitleCell.font = { size: 9, color: { argb: 'FF777777' } };

  let cursor = 3;
  if (report.summary.length > 0) {
    for (const s of report.summary) {
      const row = sheet.getRow(cursor);
      row.getCell(1).value = s.label;
      row.getCell(1).font = { bold: true, size: 9 };
      row.getCell(2).value = s.value;
      row.getCell(2).numFmt = s.format === 'number' ? '#,##0' : '#,##0.00';
      cursor += 1;
    }
    cursor += 1;
  }

  const headerRow = sheet.getRow(cursor);
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.label;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF97316' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  headerRow.height = 20;

  columns.forEach((c, i) => {
    sheet.getColumn(i + 1).width = Math.max(10, (c.width ?? 16) + 2);
  });

  for (const row of report.rows) {
    cursor += 1;
    const r = sheet.getRow(cursor);
    columns.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      const raw = row[c.key];
      // Money and counts stay NUMBERS in the cell, formatted for display. Writing
      // them as pre-formatted strings is the classic export bug: the recipient
      // opens the file, tries to sum a column, and gets zero.
      if (c.format === 'money' || c.format === 'number') {
        cell.value = raw === null || raw === undefined || raw === '' ? null : Number(raw);
        cell.numFmt = c.format === 'money' ? '#,##0.00' : '#,##0';
        cell.alignment = { horizontal: 'right' };
      } else {
        cell.value = raw === null || raw === undefined ? '' : String(raw);
        if (c.align) cell.alignment = { horizontal: c.align };
      }
    });
  }

  if (Object.keys(report.totals).length > 0) {
    cursor += 1;
    const totalRow = sheet.getRow(cursor);
    columns.forEach((c, i) => {
      const cell = totalRow.getCell(i + 1);
      const total = report.totals[c.key];
      if (total !== undefined) {
        cell.value = total;
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      } else if (i === 0) {
        cell.value = 'TOTAL';
      }
      cell.font = { bold: true, color: { argb: 'FF6B3B1E' } };
      cell.border = { top: { style: 'thin', color: { argb: 'FFF97316' } } };
    });
  }

  // Pivot table — a grouped Debit/Credit roll-up, by Ledger Head and Branch,
  // placed to the RIGHT of the main table (one blank column after its last
  // column, i.e. after Balance), top-aligned with the main column-header row
  // rather than stacked underneath it.
  if (report.pivot && report.pivot.rows.length > 0) {
    const pivotCol = columns.length + 2; // one blank gutter column after the last main column
    let pivotRow = headerRow.number;

    sheet.mergeCells(pivotRow, pivotCol, pivotRow, pivotCol + 3);
    const pivotTitleCell = sheet.getCell(pivotRow, pivotCol);
    pivotTitleCell.value = report.pivot.title;
    pivotTitleCell.font = { bold: true, size: 12, color: { argb: 'FF6B3B1E' } };

    pivotRow += 1;
    const pivotHeaderRow = sheet.getRow(pivotRow);
    [report.pivot.rowLabel, 'Branch', 'Debit', 'Credit'].forEach((label, i) => {
      const cell = pivotHeaderRow.getCell(pivotCol + i);
      cell.value = label;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF97316' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.alignment = { vertical: 'middle', horizontal: i < 2 ? 'left' : 'right' };
    });
    pivotHeaderRow.height = 20;

    let pivotDebitTotal = 0;
    let pivotCreditTotal = 0;
    for (const row of report.pivot.rows) {
      pivotRow += 1;
      const r = sheet.getRow(pivotRow);
      r.getCell(pivotCol).value = row.label;
      r.getCell(pivotCol + 1).value = row.branchName;
      r.getCell(pivotCol + 2).value = row.debit;
      r.getCell(pivotCol + 2).numFmt = '#,##0.00';
      r.getCell(pivotCol + 2).alignment = { horizontal: 'right' };
      r.getCell(pivotCol + 3).value = row.credit;
      r.getCell(pivotCol + 3).numFmt = '#,##0.00';
      r.getCell(pivotCol + 3).alignment = { horizontal: 'right' };
      pivotDebitTotal += row.debit;
      pivotCreditTotal += row.credit;
    }

    pivotRow += 1;
    const pivotTotalRow = sheet.getRow(pivotRow);
    pivotTotalRow.getCell(pivotCol).value = 'TOTAL';
    pivotTotalRow.getCell(pivotCol + 2).value = round2(pivotDebitTotal);
    pivotTotalRow.getCell(pivotCol + 2).numFmt = '#,##0.00';
    pivotTotalRow.getCell(pivotCol + 2).alignment = { horizontal: 'right' };
    pivotTotalRow.getCell(pivotCol + 3).value = round2(pivotCreditTotal);
    pivotTotalRow.getCell(pivotCol + 3).numFmt = '#,##0.00';
    pivotTotalRow.getCell(pivotCol + 3).alignment = { horizontal: 'right' };
    [0, 1, 2, 3].forEach((offset) => {
      pivotTotalRow.getCell(pivotCol + offset).font = { bold: true, color: { argb: 'FF6B3B1E' } };
      pivotTotalRow.getCell(pivotCol + offset).border = { top: { style: 'thin', color: { argb: 'FFF97316' } } };
    });

    // Column widths for the pivot's own columns (ledger head / branch names run long).
    sheet.getColumn(pivotCol).width = 26;
    sheet.getColumn(pivotCol + 1).width = 28;
    sheet.getColumn(pivotCol + 2).width = 14;
    sheet.getColumn(pivotCol + 3).width = 14;
  }

  return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/** Rows above the table — used to freeze the header pane at the right place. */
function headerRowCount(report: FinanceReport): number {
  return 2 + (report.summary.length > 0 ? report.summary.length + 1 : 0) + 1;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function exportFinanceReportCSV(report: FinanceReport): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const lines: string[] = [
    esc(report.title),
    esc(report.subtitle),
    esc(`Period ${report.periodFrom} to ${report.periodTo}`),
    '',
  ];

  for (const s of report.summary) lines.push([esc(s.label), esc(s.value)].join(','));
  if (report.summary.length > 0) lines.push('');

  lines.push(report.columns.map((c) => esc(c.label)).join(','));
  for (const row of report.rows) {
    // Raw values, not display-formatted: a CSV is machine input more often than
    // it is a printout, and "1,234.00" inside a cell re-splits on the comma.
    lines.push(report.columns.map((c) => esc(row[c.key] ?? '')).join(','));
  }

  if (Object.keys(report.totals).length > 0) {
    lines.push(
      report.columns
        .map((c, i) => esc(report.totals[c.key] !== undefined ? report.totals[c.key] : i === 0 ? 'TOTAL' : ''))
        .join(','),
    );
  }

  return lines.join('\n');
}
