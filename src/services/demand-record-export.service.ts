import ExcelJS from 'exceljs';
import type { DemandRecordResult, DemandRecordRow } from '../shared';
import { getDemandRecord, type DemandRecordQuery } from './branch-account.service';

/**
 * Demand Record → Excel (.xlsx). The same rows and figures as the page, every
 * page of the current filter, so the sheet and the screen cannot disagree:
 * the money comes from getDemandRecord, nothing is recomputed here.
 *
 * Opening and closing balances in the TOTAL row are per branch at the start
 * and end of the period (as on the page), never a sum down the rows.
 */

const PAGE = 500;
const BRAND = 'FF6B3B1E';
const ORANGE = 'FFF97316';
const MONEY = '#,##0.00';

type Col = {
  header: string;
  width: number;
  value: (r: DemandRecordRow) => string | number;
  money?: boolean;
  total?: (d: DemandRecordResult) => number | string;
};

const COLUMNS: Col[] = [
  { header: 'Required Date', width: 13, value: (r) => r.businessDate, total: () => 'TOTAL' },
  { header: 'Demand Number', width: 16, value: (r) => r.demandNumber ?? 'Opening' },
  { header: 'Branch', width: 22, value: (r) => r.branchName },
  { header: 'Delivered', width: 14, money: true, value: (r) => r.delivered, total: (d) => d.totals.delivered },
  { header: 'Actual Sales', width: 14, money: true, value: (r) => r.sales, total: (d) => d.totals.sales },
  { header: 'Return', width: 12, money: true, value: (r) => r.returns, total: (d) => d.totals.returns },
  { header: 'Discount', width: 12, money: true, value: (r) => r.discount, total: (d) => d.totals.discount },
  { header: 'G. Total', width: 14, money: true, value: (r) => r.gTotal, total: (d) => d.totals.gTotal },
  { header: 'Share %', width: 9, value: (r) => r.sharePct },
  { header: 'Share % Frozen', width: 9, value: (r) => (r.pctFrozen ? 'yes' : 'no') },
  { header: 'Company Share', width: 14, money: true, value: (r) => r.companyShare, total: (d) => d.totals.companyShare },
  { header: 'Share on Sales', width: 14, money: true, value: (r) => r.shareOnSales, total: (d) => d.totals.shareOnSales },
  { header: 'Share Received', width: 14, money: true, value: (r) => r.received, total: (d) => d.totals.received },
  { header: 'Adjustments', width: 13, money: true, value: (r) => r.adjustments, total: (d) => d.totals.adjustments },
  { header: 'Previous Balance', width: 15, money: true, value: (r) => r.previousBalance, total: (d) => d.totals.openingBalance },
  { header: 'Closing Balance', width: 15, money: true, value: (r) => r.closingBalance, total: (d) => d.totals.closingBalance },
  { header: 'Status', width: 20, value: (r) => r.status ?? '' },
];

/** Every row of the filter (the API pages at 500), with the period's totals. */
export async function loadAllDemandRecordRows(q: Omit<DemandRecordQuery, 'page' | 'pageSize'>): Promise<DemandRecordResult> {
  const first = await getDemandRecord({ ...q, page: 1, pageSize: PAGE });
  const rows = [...first.rows];
  for (let page = 2; page <= first.pagination.totalPages; page++) {
    rows.push(...(await getDemandRecord({ ...q, page, pageSize: PAGE })).rows);
  }
  return { ...first, rows };
}

export async function exportDemandRecordExcel(data: DemandRecordResult, scopeLabel: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mountain Bakes';
  wb.created = new Date();
  const ws = wb.addWorksheet('Demand Record', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.columns = COLUMNS.map((c) => ({ width: c.width }));

  ws.mergeCells(1, 1, 1, COLUMNS.length);
  const title = ws.getCell(1, 1);
  title.value = `Demand Record — ${scopeLabel}`;
  title.font = { bold: true, size: 14, color: { argb: BRAND } };
  ws.mergeCells(2, 1, 2, COLUMNS.length);
  const sub = ws.getCell(2, 1);
  sub.value = `${data.from} to ${data.to} · Closing Balance = Company Share + Adjustments + Previous Balance − Share Received`;
  sub.font = { size: 9, color: { argb: 'FF777777' } };

  const head = ws.getRow(3);
  COLUMNS.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ORANGE } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  head.height = 30;

  for (const r of data.rows) {
    const row = ws.addRow(COLUMNS.map((c) => c.value(r)));
    COLUMNS.forEach((c, i) => {
      if (c.money) row.getCell(i + 1).numFmt = MONEY;
    });
  }

  ws.addRow([]);
  const total = ws.addRow(COLUMNS.map((c) => (c.total ? c.total(data) : '')));
  COLUMNS.forEach((c, i) => {
    const cell = total.getCell(i + 1);
    cell.font = { bold: true, color: { argb: BRAND } };
    if (c.money) cell.numFmt = MONEY;
    cell.border = { top: { style: 'thin' } };
  });

  const note = ws.addRow([
    `Previous and Closing Balance in the TOTAL row are per branch at the start and end of ${data.from} to ${data.to}, not sums of the rows.`,
  ]);
  note.getCell(1).font = { italic: true, size: 9, color: { argb: 'FF777777' } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
