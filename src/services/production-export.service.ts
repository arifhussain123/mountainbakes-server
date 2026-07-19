import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { format } from 'date-fns';

// Generic tabular exporters for Production reports (the order-shaped exporters in
// export.service.ts don't fit production data). Each takes a title + headers +
// rows and produces a branded PDF / Excel / CSV.

type Cell = string | number;

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
  headerRow.height = 20;

  for (const row of rows) sheet.addRow(row);
  sheet.columns.forEach((c) => { c.width = 18; });

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

export function genericCSV(headers: string[], rows: Cell[][]): string {
  return [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
}
