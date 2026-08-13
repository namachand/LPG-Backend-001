const fs = require('fs');

const file = 'src/controllers/cashierController.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Add ensureSplitPaymentsColumns before ensureTransferVoucherPaymentColumns
if (!content.includes('const ensureSplitPaymentsColumns')) {
  const ensureHelper = "const ensureSplitPaymentsColumns = async (connection) => {\n  const tables = [\n    \"customer_pr_penalties\",\n    \"customer_name_change_requests\",\n    \"customer_connection_transfers\",\n    \"customer_new_connections\",\n    \"cashier_receipts\",\n  ];\n\n  for (const table of tables) {\n    try {\n      const [rows] = await connection.query(\n        `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'payment_mode'`,\n        [table]\n      );\n      if (rows.length && rows[0].COLUMN_TYPE.includes(\"enum\")) {\n        await connection.query(`ALTER TABLE ${table} MODIFY COLUMN payment_mode VARCHAR(50) DEFAULT NULL`);\n      }\n    } catch (err) {\n      console.error(`Error modifying payment_mode for ${table}:`, err.message);\n    }\n\n    try {\n      const [rows] = await connection.query(\n        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'split_payments'`,\n        [table]\n      );\n      if (!rows.length) {\n        await connection.query(`ALTER TABLE ${table} ADD COLUMN split_payments JSON DEFAULT NULL`);\n      }\n    } catch (err) {\n      console.error(`Error adding split_payments for ${table}:`, err.message);\n    }\n  }\n};\n\n";
  content = content.replace('const ensureTransferVoucherPaymentColumns = async (connection) => {', ensureHelper + 'const ensureTransferVoucherPaymentColumns = async (connection) => {');
}

// Helper to replace standard request endpoint logic
function replaceRequestEndpoint(content, funcName) {
  const regexStr = "export const " + funcName + " = async \\(req, res\\) => \\{\\s+const connection = await db.getConnection\\(\\);\\s+try \\{";
  const funcRegex = new RegExp(regexStr);
  
  if (!funcRegex.test(content)) {
    console.error("Function " + funcName + " not found or matched");
    return content;
  }

  // Find the boundary of the try block by looking for "const requestId"
  const tryBlockRegexStr = "(" + regexStr + "\\n)(?:\\s+await ensure.*\\(connection\\);\\n)*\\s+const requestId = Number\\(req\\.params\\.requestId\\);";
  const tryBlockRegex = new RegExp(tryBlockRegexStr);
  
  // Replace the start to inject ensureSplitPaymentsColumns
  content = content.replace(tryBlockRegex, (match, p1) => {
    return match.replace('const requestId', 'await ensureSplitPaymentsColumns(connection);\n\n    const requestId');
  });

  // Replace parsing
  const parsingRegex = /(const requestId = Number\(req\.params\.requestId\);)\s+(const paymentMode = String\(req\.body\?\.paymentMode \|\| "CASH"\)\.toUpperCase\(\);)\s+(const paymentId = String\(req\.body\?\.paymentId \|\| ""\)\.trim\(\);)/;
  
  const parsingReplacement = "$1\n    const payments = Array.isArray(req.body?.payments) ? req.body.payments : null;\n    let paymentMode = String(req.body?.paymentMode || \"CASH\").toUpperCase();\n    let paymentId = String(req.body?.paymentId || \"\").trim();\n    let splitPaymentsJson = null;\n\n    if (payments && payments.length > 0) {\n      paymentMode = \"SPLIT\";\n      paymentId = payments.map(p => p.paymentId).filter(Boolean).join(',') || null;\n      splitPaymentsJson = JSON.stringify(payments);\n    }";
  
  content = content.replace(parsingRegex, parsingReplacement);

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
  const updateQueryRegex = new RegExp("UPDATE " + table + "\\s+SET\\s+payment_mode = \\?,\\s+payment_reference_id = \\?,");
  content = content.replace(
    updateQueryRegex,
    "UPDATE " + table + "\n      SET\n        payment_mode = ?,\n        payment_reference_id = ?,\n        split_payments = ?,"
  );
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
