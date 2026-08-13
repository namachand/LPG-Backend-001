import fs from 'fs';

const file = 'src/controllers/cashierController.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Add ensureSplitPaymentsColumns before ensureTransferVoucherPaymentColumns
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
};

`;
  content = content.replace('const ensureTransferVoucherPaymentColumns = async (connection) => {', ensureHelper + 'const ensureTransferVoucherPaymentColumns = async (connection) => {');
}

// Helper to replace standard request endpoint logic
function replaceRequestEndpoint(content, funcName) {
  const funcRegex = new RegExp(`export const ${funcName} = async \\(req, res\\) => \\{\\s+const connection = await db.getConnection\\(\\);\\s+try \\{`);
  
  if (!funcRegex.test(content)) {
    console.error(`Function ${funcName} not found or matched`);
    return content;
  }

  // Find the boundary of the try block by looking for "const requestId"
  const tryBlockRegex = new RegExp(`(export const ${funcName} = async \\(req, res\\) => \\{\\s+const connection = await db.getConnection\\(\\);\\s+try \\{\n)(?:\\s+await ensure.*\\(connection\\);\n)*\\s+const requestId = Number\\(req\\.params\\.requestId\\);`);
  
  // Replace the start to inject ensureSplitPaymentsColumns
  content = content.replace(tryBlockRegex, (match, p1) => {
    let newStart = match.replace('const requestId', 'await ensureSplitPaymentsColumns(connection);\n\n    const requestId');
    return newStart;
  });

  // Replace parsing
  const parsingRegex = /(const requestId = Number\(req\.params\.requestId\);)\s+(const paymentMode = String\(req\.body\?\.paymentMode \|\| "CASH"\)\.toUpperCase\(\);)\s+(const paymentId = String\(req\.body\?\.paymentId \|\| ""\)\.trim\(\);)/;
  content = content.replace(
    parsingRegex,
    `$1
    const payments = Array.isArray(req.body?.payments) ? req.body.payments : null;
    let paymentMode = String(req.body?.paymentMode || "CASH").toUpperCase();
    let paymentId = String(req.body?.paymentId || "").trim();
    let splitPaymentsJson = null;

    if (payments && payments.length > 0) {
      paymentMode = "SPLIT";
      paymentId = payments.map(p => p.paymentId).filter(Boolean).join(',') || null;
      splitPaymentsJson = JSON.stringify(payments);
    }`
  );

  return content;
}

content = replaceRequestEndpoint(content, 'collectCashierPenaltyRequest');
content = replaceRequestEndpoint(content, 'collectCashierNameChangeRequest');
content = replaceRequestEndpoint(content, 'collectCashierTransferVoucherRequest');
content = replaceRequestEndpoint(content, 'collectCashierNewConnectionRequest');

// Generic replaces for the shared validations/queries in all 4 functions
content = content.replace(
  /const allowedModes = \["CASH", "UPI", "CARD", "BANK_TRANSFER"\];/g,
  'const allowedModes = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "SPLIT"];'
);

content = content.replace(
  /if \(paymentMode !== "CASH" && !paymentId\) \{/g,
  'if (paymentMode !== "CASH" && paymentMode !== "SPLIT" && !paymentId) {'
);

// We need to carefully replace the UPDATE queries for each to add split_payments
function replaceUpdateQuery(content, table) {
  const updateQueryRegex = new RegExp(`UPDATE ${table}\\s+SET\\s+payment_mode = \\?,\\s+payment_reference_id = \\?,`);
  content = content.replace(
    updateQueryRegex,
    `UPDATE ${table}
      SET
        payment_mode = ?,
        payment_reference_id = ?,
        split_payments = ?,`
  );

  const updateParamsRegex = /\[paymentMode, paymentId \|\| null,/g;
  // This is generic, we should only replace where it applies.
  return content;
}

content = replaceUpdateQuery(content, 'customer_pr_penalties');
content = replaceUpdateQuery(content, 'customer_name_change_requests');
content = replaceUpdateQuery(content, 'customer_connection_transfers');
content = replaceUpdateQuery(content, 'customer_new_connections');

// Replace all instances of `[paymentMode, paymentId || null,` with `[paymentMode, paymentId || null, splitPaymentsJson,`
// in the context of these 4 updates. Since all 4 have remarks or similar next, we can do a global replace for this specific array pattern.
content = content.replace(/\[paymentMode, paymentId \|\| null, remarks \|\| null/g, '[paymentMode, paymentId || null, splitPaymentsJson, remarks || null');


fs.writeFileSync(file, content);
console.log('Script completed');
