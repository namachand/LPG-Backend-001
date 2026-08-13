const fs = require('fs');
const file = 'src/controllers/cashierController.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  'await ensureTransferVoucherPaymentColumns(connection);',
  'await ensureTransferVoucherPaymentColumns(connection);\n    await ensureSplitPaymentsColumns(connection);'
);

content = content.replace(
  'await ensureNewConnectionCashierTables(connection);',
  'await ensureNewConnectionCashierTables(connection);\n    await ensureSplitPaymentsColumns(connection);'
);

fs.writeFileSync(file, content);
console.log('Cleanup 2 finished');
