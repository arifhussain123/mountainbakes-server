import ExcelJS from 'exceljs';
import { STORE_REPORTS, type StoreDashboard, type StoreReport, type StoreReportType } from '../../shared';
import { api, call } from './common';

/**
 * Store dashboard and the ten operational reports. Valuation here is the
 * Store's own (batch cost, or Price Control for a demand) and is never posted
 * anywhere: the Store does not touch the Finance ledger.
 */

export async function dashboard(from: string, to: string, period: 'day' | 'week' | 'month'): Promise<StoreDashboard> {
  return api<StoreDashboard>(await call('store_dashboard', { p_from: from, p_to: to, p_period: period }));
}

export async function report(type: StoreReportType, from: string, to: string, itemId?: string): Promise<StoreReport> {
  const r = await call<{ rows: Array<Record<string, unknown>> }>('store_report', { p_type: type, p_from: from, p_to: to, p_item: itemId ?? null });
  let rows = api<Array<Record<string, unknown>>>(r.rows ?? []);
  if (type === 'stock_valuation') {
    rows = rows.map((x) => ({ ...x, valueAtPrice: Math.round(Number(x['availableQty'] ?? 0) * Number(x['unitPrice'] ?? 0) * 100) / 100 }));
  }
  return { type, from, to, rows };
}

/** The same rows as an .xlsx: numbers stay numbers, money and qty columns get totals. */
export async function reportWorkbook(rep: StoreReport): Promise<Buffer> {
  const def = STORE_REPORTS[rep.type];
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mountain Bakes · Dry Items Store';
  const ws = wb.addWorksheet(def.label.slice(0, 31));
  ws.addRow([def.label]).font = { bold: true, size: 13 };
  ws.addRow([def.dated ? `${rep.from} to ${rep.to}` : `As of ${rep.to}`]);
  ws.addRow([]);
  const head = ws.addRow(def.columns.map((c) => c.header));
  head.font = { bold: true };
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3EBDD' } };
    cell.border = { bottom: { style: 'thin' } };
  });
  for (const r of rep.rows) {
    ws.addRow(def.columns.map((c) => {
      const v = r[c.key];
      if (v == null) return '';
      if (c.kind === 'qty' || c.kind === 'money' || c.kind === 'rate') return Number(v);
      return String(v);
    }));
  }
  const totals = def.columns.map((c, i) =>
    c.kind === 'money' ? rep.rows.reduce((a, r) => a + Number(r[c.key] ?? 0), 0) : i === 0 ? 'Total' : '');
  if (rep.rows.length && def.columns.some((c) => c.kind === 'money')) ws.addRow(totals).font = { bold: true };
  def.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(10, Math.min(36, c.header.length + 4));
    if (c.kind === 'money') col.numFmt = '#,##0.00';
    if (c.kind === 'rate') col.numFmt = '#,##0.0000';
    if (c.kind === 'qty') col.numFmt = '#,##0.###';
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
