import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { format } from 'date-fns';

interface OrderRow {
  orderNumber: string;
  branchName: string;
  customerName: string;
  customerPhone: string;
  grandTotal: number;
  status: string;
  paymentMethod: string;
  createdAt: string;
  items: Array<{ productName: string; qty: number; unitPrice: number; lineTotal: number }>;
}

export async function exportToPDF(orders: OrderRow[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks: Buffer[] = [];

    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fillColor('#F97316').fontSize(28).font('Helvetica-Bold').text('Mountain Bakes', { align: 'center' });
    doc.fillColor('#6B3B1E').fontSize(14).font('Helvetica').text('Sales Report', { align: 'center' });
    doc.fillColor('#333').fontSize(10).text(`Generated: ${format(new Date(), 'dd MMM yyyy HH:mm')}`, { align: 'center' });
    doc.moveDown(1.5);

    // Summary
    const total = orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.grandTotal, 0);
    doc.fillColor('#F97316').fontSize(12).font('Helvetica-Bold').text(`Total Orders: ${orders.length}   |   Total Revenue: Rs.${total.toLocaleString()}`);
    doc.moveDown();

    // Table header
    doc.fillColor('#6B3B1E').fontSize(10).font('Helvetica-Bold');
    const cols = [40, 110, 200, 290, 370, 440, 510];
    doc.text('Order #', cols[0]!, doc.y);
    doc.text('Branch', cols[1]!, doc.y);
    doc.text('Customer', cols[2]!, doc.y);
    doc.text('Total', cols[3]!, doc.y);
    doc.text('Status', cols[4]!, doc.y);
    doc.text('Date', cols[5]!, doc.y);
    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(560, doc.y).strokeColor('#F97316').stroke();
    doc.moveDown(0.3);

    // Rows
    doc.fillColor('#333').font('Helvetica').fontSize(9);
    for (const o of orders) {
      if (doc.y > 720) doc.addPage();
      const y = doc.y;
      doc.text(o.orderNumber, cols[0]!, y);
      doc.text(o.branchName || '', cols[1]!, y);
      doc.text(o.customerName, cols[2]!, y);
      doc.text(`Rs.${o.grandTotal.toLocaleString()}`, cols[3]!, y);
      doc.text(o.status, cols[4]!, y);
      doc.text(o.createdAt?.slice(0, 10) || '', cols[5]!, y);
      doc.moveDown(0.7);
    }

    // Footer
    doc.moveDown(2);
    doc.fillColor('#999').fontSize(8).text('Mountain Bakes ERP — Confidential', { align: 'center' });

    doc.end();
  });
}

export async function exportToExcel(orders: OrderRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Mountain Bakes ERP';

  const sheet = workbook.addWorksheet('Orders Report', {
    pageSetup: { paperSize: 9, orientation: 'landscape' },
  });

  sheet.columns = [
    { header: 'Order #', key: 'orderNumber', width: 14 },
    { header: 'Branch', key: 'branchName', width: 22 },
    { header: 'Customer', key: 'customerName', width: 22 },
    { header: 'Phone', key: 'customerPhone', width: 14 },
    { header: 'Total (Rs.)', key: 'grandTotal', width: 14 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Payment', key: 'paymentMethod', width: 12 },
    { header: 'Date', key: 'date', width: 14 },
  ];

  // Style header
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF97316' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFE8873A' } } };
  });
  headerRow.height = 22;

  for (const o of orders) {
    const row = sheet.addRow({
      orderNumber: o.orderNumber,
      branchName: o.branchName,
      customerName: o.customerName,
      customerPhone: o.customerPhone,
      grandTotal: o.grandTotal,
      status: o.status,
      paymentMethod: o.paymentMethod,
      date: o.createdAt?.slice(0, 10) || '',
    });

    // Color-code status
    const statusCell = row.getCell('status');
    if (o.status === 'delivered') statusCell.font = { color: { argb: 'FF16A34A' }, bold: true };
    else if (o.status === 'cancelled') statusCell.font = { color: { argb: 'FFDC2626' }, bold: true };
    else if (o.status === 'pending') statusCell.font = { color: { argb: 'FFD97706' }, bold: true };
  }

  // Summary row
  sheet.addRow([]);
  const summaryRow = sheet.addRow({
    orderNumber: 'TOTAL',
    grandTotal: orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.grandTotal, 0),
  });
  summaryRow.getCell('orderNumber').font = { bold: true };
  summaryRow.getCell('grandTotal').font = { bold: true, color: { argb: 'FFF97316' } };

  return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

export function exportToCSV(orders: OrderRow[]): string {
  const headers = ['Order #', 'Branch', 'Customer', 'Phone', 'Total', 'Status', 'Payment', 'Date'];
  const rows = orders.map((o) => [
    o.orderNumber,
    o.branchName,
    o.customerName,
    o.customerPhone,
    o.grandTotal,
    o.status,
    o.paymentMethod,
    o.createdAt?.slice(0, 10) || '',
  ]);

  return [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}
