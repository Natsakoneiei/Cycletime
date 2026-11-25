const ExcelJS = require('exceljs');

async function generateDashboardExcel(res, { data, model, line }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Dashboard Data');

  let maxRounds = 10;
  (data || []).forEach(item => {
    if (item.allRounds && item.allRounds.length > maxRounds) maxRounds = item.allRounds.length;
  });

  const headers = ['Main Station', 'Sub Station', 'Operator', 'Checker', 'Average CT (s)'];
  for (let i = 1; i <= maxRounds; i++) headers.push('R' + i);

  const headerRow = sheet.addRow(headers);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
  });

  (data || []).forEach(item => {
    const row = [item.mainStation, item.subStation, item.operator, item.checker, item.total];
    for (let i = 0; i < maxRounds; i++) {
      row.push((item.allRounds && i < item.allRounds.length) ? item.allRounds[i] : '');
    }
    sheet.addRow(row);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `TimeStudy_${model}_${line}_${Date.now()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(Buffer.from(buffer));
}

async function generateMatrixExcel(res, { data }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Summary Filtered Data');

  const headers = ['Date', 'Model', 'Session', 'Station', 'Line', 'Operator', 'Checker', 'Avg CT (s)', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10'];
  const headerRow = sheet.addRow(headers);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } };
  });

  (data || []).forEach(item => {
    sheet.addRow([
      item.timestamp, item.model, item.session, item.station,
      item.line || '-', item.operator || '-', item.checker || '-', item.avgCT,
      item.r1, item.r2, item.r3, item.r4, item.r5, item.r6, item.r7, item.r8, item.r9, item.r10
    ]);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `SummaryMatrix_${Date.now()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(Buffer.from(buffer));
}

module.exports = { generateDashboardExcel, generateMatrixExcel };