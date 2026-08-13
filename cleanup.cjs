const fs = require('fs');
const file = 'src/controllers/cashierController.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Remove duplicate split_payments = ?,
content = content.replace(/split_payments = \?,\s+split_payments = \?,/g, 'split_payments = ?,');

// 2. Add ensureSplitPaymentsColumns definition if missing
if (!content.includes('const ensureSplitPaymentsColumns')) {
  const ensureHelper = `const ensureSplitPaymentsColumns = async (connection) => {
  const tables = [
    "customer_pr_penalties",
    "customer_name_change_requests",
    "customer_connection_transfers",
    "customer_new_connections",
    "cashier_receipts",
  ];

  for (const table of tables) {
    try {
      const [rows] = await connection.query(
        \`SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'payment_mode'\`,
        [table]
      );
      if (rows.length && rows[0].COLUMN_TYPE.includes("enum")) {
        await connection.query(\`ALTER TABLE \${table} MODIFY COLUMN payment_mode VARCHAR(50) DEFAULT NULL\`);
      }
    } catch (err) {
      console.error(\`Error modifying payment_mode for \${table}:\`, err.message);
    }

    try {
      const [rows] = await connection.query(
        \`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'split_payments'\`,
        [table]
      );
      if (!rows.length) {
        await connection.query(\`ALTER TABLE \${table} ADD COLUMN split_payments JSON DEFAULT NULL\`);
      }
    } catch (err) {
      console.error(\`Error adding split_payments for \${table}:\`, err.message);
    }
  }
};\n\n`;
  content = content.replace('const ensureCashierClosingPettyCashColumn', ensureHelper + 'const ensureCashierClosingPettyCashColumn');
}

// 3. Inject the call to ensureSplitPaymentsColumns into the 4 endpoints
const endpoints = [
  'collectCashierPenaltyRequest',
  'collectCashierNameChangeRequest',
  'collectCashierTransferVoucherRequest',
  'collectCashierNewConnectionRequest'
];

for (const ep of endpoints) {
  // Use regex to allow variable whitespace
  const regex = new RegExp(`(export const ${ep} = async \\(req, res\\) => \\{\\s+const connection = await db\\.getConnection\\(\\);\\s+try \\{\\s+)const requestId = Number\\(req\\.params\\.requestId\\);`);
  
  if (regex.test(content)) {
    // Make sure we haven't already injected it
    const match = content.match(regex)[1];
    if (!match.includes('await ensureSplitPaymentsColumns')) {
       content = content.replace(regex, `$1await ensureSplitPaymentsColumns(connection);\n    const requestId = Number(req.params.requestId);`);
    }
  } else {
    console.log('Could not find or already modified injection point for', ep);
  }
}

fs.writeFileSync(file, content);
console.log('Cleanup script finished');
