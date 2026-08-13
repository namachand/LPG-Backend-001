const fs = require('fs');

const file = 'src/controllers/cashierController.js';
let content = fs.readFileSync(file, 'utf8');

// Update recordOfficeSale body destructuring
const officeSaleDestructRegex = /const \{\s*customer_name,\s*phone,\s*address,\s*items = \[\],\s*payment_method = 'CASH',\s*\} = req\.body;/;
const officeSaleDestructReplace = `const {
      customer_name,
      phone,
      address,
      items = [],
      payment_method: originalPaymentMethod = 'CASH',
      payments = null,
    } = req.body;
    const payment_method = payments && payments.length > 0 ? 'SPLIT' : originalPaymentMethod;`;
content = content.replace(officeSaleDestructRegex, officeSaleDestructReplace);

// Update recordOfficeSale payments logic
// Look for the if (payment_method === 'PART_PAYMENT') block up to await connection.commit();
const partPaymentRegex = /if \(payment_method === 'PART_PAYMENT'\) \{[\s\S]*?\} else \{[\s\S]*?\}\s*await connection\.commit\(\);/;

const splitPaymentsLogic = `if (payments && payments.length > 0) {
      let sum = 0;
      for (const p of payments) {
        sum += Number(p.amount);
      }
      if (Math.abs(sum - totalAmount) > 0.01) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: 'Sum of split payments must equal the total amount',
        });
      }

      for (const p of payments) {
        if (Number(p.amount) > 0) {
          await connection.execute(
            \`
            INSERT INTO payments
              (sale_id, amount, method, status, type, created_at)
            VALUES (?, ?, ?, 'SUCCESS', 'COMPANY', NOW())
            \`,
            [saleId, Number(p.amount), p.method || 'CASH']
          );
        }
      }
    } else if (payment_method === 'PART_PAYMENT') {
      // Split a part payment into two payment rows: cash portion + bank/UTR portion.
      const rawCash = Number(req.body.cash_amount);
      const cashPart = Math.min(Math.max(Number.isFinite(rawCash) ? rawCash : 0, 0), totalAmount);
      const bankPart = Math.max(totalAmount - cashPart, 0);

      if (cashPart > 0) {
        await connection.execute(
          \`
          INSERT INTO payments
            (sale_id, amount, method, status, type, created_at)
          VALUES (?, ?, 'CASH', 'SUCCESS', 'COMPANY', NOW())
          \`,
          [saleId, cashPart]
        );
      }

      if (bankPart > 0) {
        await connection.execute(
          \`
          INSERT INTO payments
            (sale_id, amount, method, status, type, created_at)
          VALUES (?, ?, 'UPI', 'SUCCESS', 'COMPANY', NOW())
          \`,
          [saleId, bankPart]
        );
      }

      // Guarantee at least one payment row exists (e.g. zero-value edge case).
      if (cashPart <= 0 && bankPart <= 0) {
        await connection.execute(
          \`
          INSERT INTO payments
            (sale_id, amount, method, status, type, created_at)
          VALUES (?, ?, 'CASH', 'SUCCESS', 'COMPANY', NOW())
          \`,
          [saleId, 0]
        );
      }
    } else {
      // payments.method only supports CASH/UPI/CARD; map anything else to UPI.
      const paymentMethodForRow = ['CASH', 'UPI', 'CARD'].includes(payment_method)
        ? payment_method
        : 'UPI';

      await connection.execute(
        \`
        INSERT INTO payments
          (sale_id, amount, method, status, type, created_at)
        VALUES (?, ?, ?, 'SUCCESS', 'COMPANY', NOW())
        \`,
        [saleId, totalAmount, paymentMethodForRow]
      );
    }

    await connection.commit();`;
    
content = content.replace(partPaymentRegex, splitPaymentsLogic);


// Update createCashierReceipt
// Find where it destructures
const createReceiptRegex = /export const createCashierReceipt = async \(req, res\) => \{\s*const \{\s*type,\s*receipt_type,\s*amount,\s*description,\s*payment_mode,\s*paymentMode,\s*transfer_id,\s*transferId,\s*\} = req\.body \|\| \{\};/;
const createReceiptReplace = `export const createCashierReceipt = async (req, res) => {
  const {
    type,
    receipt_type,
    amount,
    description,
    payment_mode,
    paymentMode,
    transfer_id,
    transferId,
    payments = null,
  } = req.body || {};`;
content = content.replace(createReceiptRegex, createReceiptReplace);

const createReceiptModeRegex = /const rawMode = payment_mode \?\? paymentMode;\s*const normalizedMode = rawMode \? normalizeReceiptEnum\(rawMode\) : 'CASH';\s*if \(!RECEIPT_PAYMENT_MODES\.includes\(normalizedMode\)\) \{\s*return res\.status\(400\)\.json\(\{\s*success: false,\s*message: \`payment_mode must be one of \$\{RECEIPT_PAYMENT_MODES\.join\(', '\)\}\`,\s*\}\);\s*\}/;

const createReceiptModeReplace = `let rawMode = payment_mode ?? paymentMode;
  let splitPaymentsJson = null;

  if (payments && payments.length > 0) {
    let sum = 0;
    for (const p of payments) {
      sum += Number(p.amount);
    }
    if (Math.abs(sum - Number(amount)) > 0.01) {
      return res.status(400).json({
        success: false,
        message: 'Sum of split payments must equal the total amount',
      });
    }
    rawMode = 'SPLIT';
    splitPaymentsJson = JSON.stringify(payments);
  }

  const normalizedMode = rawMode === 'SPLIT' ? 'SPLIT' : (rawMode ? normalizeReceiptEnum(rawMode) : 'CASH');

  if (normalizedMode !== 'SPLIT' && !RECEIPT_PAYMENT_MODES.includes(normalizedMode)) {
    return res.status(400).json({
      success: false,
      message: \`payment_mode must be one of \${RECEIPT_PAYMENT_MODES.join(', ')}\`,
    });
  }`;
content = content.replace(createReceiptModeRegex, createReceiptModeReplace);

const receiptEnsureRegex = /await ensureCashierReceiptsTable\(connection\);/;
const receiptEnsureReplace = `await ensureCashierReceiptsTable(connection);\n    await ensureSplitPaymentsColumns(connection);`;
content = content.replace(receiptEnsureRegex, receiptEnsureReplace);

// Update INSERT INTO cashier_receipts to include split_payments
const receiptInsertRegex = /INSERT INTO cashier_receipts \(\s*cashier_id,\s*receipt_type,\s*amount,\s*description,\s*payment_mode,\s*transfer_id,\s*created_at,\s*updated_at\s*\)\s*VALUES \(\s*\?,\s*\?,\s*\?,\s*\?,\s*\?,\s*\?,\s*NOW\(\),\s*NOW\(\)\s*\)/;
const receiptInsertReplace = `INSERT INTO cashier_receipts (
        cashier_id,
        receipt_type,
        amount,
        description,
        payment_mode,
        split_payments,
        transfer_id,
        created_at,
        updated_at
      )
      VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        NOW(),
        NOW()
      )`;
content = content.replace(receiptInsertRegex, receiptInsertReplace);

const receiptParamsRegex = /\[\s*cashierId,\s*normalizedType,\s*numericAmount,\s*trimmedDescription,\s*normalizedMode,\s*trimmedTransferId,\s*\]/;
const receiptParamsReplace = `[
        cashierId,
        normalizedType,
        numericAmount,
        trimmedDescription,
        normalizedMode,
        splitPaymentsJson,
        trimmedTransferId,
      ]`;
content = content.replace(receiptParamsRegex, receiptParamsReplace);

fs.writeFileSync(file, content);
console.log('Script 2 completed');
