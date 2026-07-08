import db from "../config/db.js";

const cashierDayLog = {
  opening: null,
  closing: null,
};

const getLatestClosingBalance = async (connection) => {
  const [rows] = await connection.query(
    `SELECT total_cash FROM cashier_closings ORDER BY id DESC LIMIT 1`
  );
  return rows.length ? Number(rows[0].total_cash || 0) : null;
};

const purchaseExpenseTripJoin = `
  LEFT JOIN purchase_trips pt ON pt.id = (
    SELECT pt2.id
    FROM purchase_trips pt2
    WHERE pt2.purchase_manager_id = e.created_by
      AND e.created_at >= pt2.started_at
      AND (pt2.ended_at IS NULL OR e.created_at <= pt2.ended_at)
    ORDER BY pt2.started_at DESC, pt2.id DESC
    LIMIT 1
  )
`;

const DEFAULT_STOCK_AREA_ID = 1;
const ALLOWED_CASHIER_REQUEST_PAYMENT_MODES = ["CASH", "UPI", "CARD", "BANK_TRANSFER"];

const consumeStockForCashierSale = async (connection, productId, requiredQty) => {
  let remaining = Number(requiredQty || 0);
  let sourceStockAreaId = null;

  if (remaining <= 0) {
    return;
  }

  const [availableRows] = await connection.query(
    `
    SELECT COALESCE(SUM(quantity), 0) AS available_qty
    FROM stock
    WHERE product_id = ?
    FOR UPDATE
    `,
    [Number(productId)]
  );

  const availableQty = Number(availableRows[0]?.available_qty || 0);

  if (availableQty < remaining) {
    throw new Error(
      `Insufficient stock for product ${productId}. Available ${availableQty}, required ${remaining}`
    );
  }

  const [rows] = await connection.query(
    `
    SELECT id, stock_area_id, COALESCE(quantity, 0) AS quantity
    FROM stock
    WHERE product_id = ?
    ORDER BY (stock_area_id = ?) DESC, id ASC
    FOR UPDATE
    `,
    [Number(productId), DEFAULT_STOCK_AREA_ID]
  );

  for (const row of rows) {
    if (remaining <= 0) {
      break;
    }

    const currentQty = Number(row.quantity || 0);
    if (currentQty <= 0) {
      continue;
    }

    const deductQty = Math.min(currentQty, remaining);

    if (sourceStockAreaId === null && row.stock_area_id !== null && row.stock_area_id !== undefined) {
      sourceStockAreaId = Number(row.stock_area_id);
    }

    await connection.query(
      `
      UPDATE stock
      SET quantity = GREATEST(COALESCE(quantity, 0) - ?, 0),
          updated_at = NOW()
      WHERE id = ?
      `,
      [deductQty, row.id]
    );

    remaining -= deductQty;
  }

  return sourceStockAreaId;
};

const validateCashierRequestPayment = (paymentMode, paymentId) => {
  if (!ALLOWED_CASHIER_REQUEST_PAYMENT_MODES.includes(paymentMode)) {
    return "Invalid payment mode";
  }

  if (paymentMode !== "CASH" && !paymentId) {
    return "Payment ID is required for non-cash modes";
  }

  return "";
};

const ensureNewConnectionCashierTables = async (connection) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS customer_new_connection_products (
      id INT NOT NULL AUTO_INCREMENT,
      connection_id INT NOT NULL,
      product_id INT NOT NULL,
      product_name_snapshot VARCHAR(255) DEFAULT NULL,
      product_type_snapshot VARCHAR(80) DEFAULT NULL,
      product_price_snapshot DECIMAL(10,2) DEFAULT 0,
      status ENUM('PENDING','APPROVED') NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_new_connection_products_connection (connection_id),
      KEY idx_new_connection_products_product (product_id),
      KEY idx_new_connection_products_status (status),
      CONSTRAINT fk_new_connection_products_connection
        FOREIGN KEY (connection_id) REFERENCES customer_new_connections(id) ON DELETE CASCADE,
      CONSTRAINT fk_new_connection_products_product
        FOREIGN KEY (product_id) REFERENCES products(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  const requiredColumns = {
    product_id: "ALTER TABLE customer_new_connections ADD COLUMN product_id INT DEFAULT NULL AFTER product_details",
    id_proof_url: "ALTER TABLE customer_new_connections ADD COLUMN id_proof_url VARCHAR(500) DEFAULT NULL AFTER id_proof_details",
    payment_mode: "ALTER TABLE customer_new_connections ADD COLUMN payment_mode enum('CASH','UPI','CARD','BANK_TRANSFER') DEFAULT NULL AFTER payment_status",
    payment_reference_id: "ALTER TABLE customer_new_connections ADD COLUMN payment_reference_id varchar(120) DEFAULT NULL AFTER payment_mode",
    cashier_remarks: "ALTER TABLE customer_new_connections ADD COLUMN cashier_remarks text AFTER payment_reference_id",
    paid_at: "ALTER TABLE customer_new_connections ADD COLUMN paid_at timestamp NULL DEFAULT NULL AFTER cashier_remarks",
  };

  const [rows] = await connection.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'customer_new_connections'
      AND COLUMN_NAME IN ('product_id', 'id_proof_url', 'payment_mode', 'payment_reference_id', 'cashier_remarks', 'paid_at')
    `
  );

  const existing = new Set(rows.map((row) => String(row.COLUMN_NAME)));
  for (const [columnName, ddl] of Object.entries(requiredColumns)) {
    if (existing.has(columnName)) continue;

    try {
      await connection.query(ddl);
    } catch (error) {
      if (error?.code !== "ER_DUP_FIELDNAME") {
        throw error;
      }
    }
  }
};

export const getCashierDashboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const lastClosing = await getLatestClosingBalance(connection);

    // Optional date-range filter (YYYY-MM-DD). No range => all-time (default).
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    let startDate = DATE_ONLY.test(String(req.query.startDate || '')) ? String(req.query.startDate) : null;
    let endDate = DATE_ONLY.test(String(req.query.endDate || '')) ? String(req.query.endDate) : null;
    if (startDate && !endDate) endDate = startDate;
    if (endDate && !startDate) startDate = endDate;
    if (startDate && endDate && startDate > endDate) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
    const hasRange = Boolean(startDate && endDate);
    const rangeParams = hasRange ? [startDate, endDate] : [];

    const receiptDateClause = hasRange
      ? 'AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?'
      : '';
    const expenseWhereClause = hasRange ? 'WHERE DATE(e.created_at) BETWEEN ? AND ?' : '';
    const pendingExpenseDateClause = hasRange ? 'AND DATE(e.created_at) BETWEEN ? AND ?' : '';
    const settlementDateClause = hasRange ? 'AND DATE(sh.created_at) BETWEEN ? AND ?' : '';

    const [receiptRows] = await connection.query(
      `
      SELECT
        SUM(CASE WHEN p.method = 'CASH' THEN p.amount ELSE 0 END) AS cash,
        SUM(CASE WHEN p.method = 'UPI' THEN p.amount ELSE 0 END) AS upi,
        SUM(CASE WHEN p.method = 'CARD' THEN p.amount ELSE 0 END) AS card
      FROM payments p
      INNER JOIN sales s ON s.id = p.sale_id
      WHERE p.status = 'SUCCESS'
      ${receiptDateClause}
      `,
      rangeParams
    );

    const [expenseRows] = await connection.query(
      `
      SELECT
        COALESCE(SUM(e.amount), 0) AS totalExpenses,
        COALESCE(SUM(CASE WHEN e.status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pendingApproval
      FROM expenses e
      ${expenseWhereClause}
      `,
      rangeParams
    );

    const [pendingExpenses] = await connection.query(
      `
      SELECT
        e.id,
        e.category,
        e.description,
        e.amount,
        DATE_FORMAT(e.created_at, '%Y-%m-%d') AS date,
        COALESCE(u.name, 'Unknown') AS createdBy,
        e.status
      FROM expenses e
      LEFT JOIN users u ON u.id = e.created_by
      WHERE e.status = 'PENDING'
      ${pendingExpenseDateClause}
      ORDER BY e.created_at DESC
      LIMIT 2
      `,
      rangeParams
    );

    const [driverRows] = await connection.query(
      `
      SELECT
        d.id AS driver_id,
        u.name AS driverName,
        COALESCE(SUM(CASE WHEN sh.method = 'CASH' AND sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) AS cashAssigned,
        COALESCE(SUM(CASE WHEN sh.method = 'UPI' AND sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) AS upiAssigned,
        COALESCE(SUM(CASE WHEN sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) AS totalAssigned,
        COALESCE(SUM(CASE WHEN sh.method = 'CASH' AND sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS cashPending,
        COALESCE(SUM(CASE WHEN sh.method = 'UPI' AND sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS upiPending,
        COALESCE(SUM(CASE WHEN sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS totalPending,
        COALESCE(SUM(CASE WHEN sh.status = 'SETTLED' THEN sh.amount ELSE 0 END), 0) AS totalSettled,
        CASE
          WHEN COALESCE(SUM(CASE WHEN sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) > 0 THEN 'Pending'
          WHEN COALESCE(SUM(CASE WHEN sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) > 0 THEN 'Assigned'
          WHEN COALESCE(SUM(CASE WHEN sh.status = 'SETTLED' THEN sh.amount ELSE 0 END), 0) > 0 THEN 'Settled'
          ELSE 'None'
        END AS status
      FROM drivers d
      INNER JOIN users u ON u.id = d.user_id
      LEFT JOIN settlement_history sh ON sh.driver_id = d.id AND sh.status IN ('ASSIGNED', 'PENDING', 'SETTLED') ${settlementDateClause}
      GROUP BY d.id, u.name
      ORDER BY totalPending DESC, u.name ASC
      LIMIT 4
      `,
      rangeParams
    );

    const receiptSummary = receiptRows[0] || { cash: 0, upi: 0, card: 0 };
    const expenseSummary = expenseRows[0] || { totalExpenses: 0, pendingApproval: 0 };
    const totalCashIn = Number(receiptSummary.cash || 0) + Number(receiptSummary.upi || 0) + Number(receiptSummary.card || 0);
    const totalCashOut = Number(expenseSummary.totalExpenses || 0);
    const currentBalance = totalCashIn - totalCashOut;

    return res.status(200).json({
      success: true,
      lastClosingBalance: lastClosing ?? 0,
      metrics: [
        {
          title: 'Opening Balance',
          value: `₹${Number(lastClosing ?? 0).toLocaleString('en-IN')}`,
          description: lastClosing !== null ? 'Last closing balance' : 'No previous closing',
          variant: 'neutral',
          icon: '💼',
        },
        {
          title: 'Total Cash In',
          value: `₹${totalCashIn.toLocaleString('en-IN')}`,
          description: `${driverRows.length} driver entries`,
          variant: 'success',
          badge: '+4.2%',
          icon: '⬆️',
        },
        {
          title: 'Total Cash Out',
          value: `₹${totalCashOut.toLocaleString('en-IN')}`,
          description: `${expenseSummary.pendingApproval} pending approvals`,
          variant: 'danger',
          badge: expenseSummary.pendingApproval > 0 ? `+${expenseSummary.pendingApproval}` : undefined,
          icon: '⬇️',
        },
        {
          title: 'Current Balance',
          value: `₹${currentBalance.toLocaleString('en-IN')}`,
          description: 'Live · last sync just now',
          variant: currentBalance >= 0 ? 'success' : 'danger',
          icon: '💚',
        },
      ],
      chart: {
        labels: ['9', '10', '11', '12', '1', '2', '3', '4', '5', '6', '7', '8'],
        cashIn: [28, 45, 60, 55, 68, 75, 82, 78, 85, 90, 95, 103],
        cashOut: [18, 24, 31, 29, 34, 35, 38, 37, 39, 41, 43, 45],
      },
      actions: [
        {
          title: 'driver collections to verify',
          description: `${driverRows.filter((row) => row.status === 'Pending').length} drivers awaiting confirmation`,
          badge: `${driverRows.filter((row) => row.status === 'Pending').length}`,
          theme: 'warning',
        },
        {
          title: 'expense approvals pending',
          description: 'Vehicle fuel · Office supplies',
          badge: `${expenseSummary.pendingApproval}`,
          theme: 'danger',
        },
        {
          title: 'large transaction flagged',
          description: 'Review transfers above ₹50,000',
          badge: '1',
          theme: 'info',
        },
      ],
      drivers: driverRows.map((driver) => ({
        initials: driver.driverName
          .split(' ')
          .map((part) => part[0])
          .join('')
          .slice(0, 2),
        name: driver.driverName,
        subtitle: `${driver.totalPending ? 'Pending collections' : 'Verified'}`,
        amount: `₹${Number(driver.totalPending || 0).toLocaleString('en-IN')}`,
        status: driver.status,
      })),
      approvals: pendingExpenses.map((expense) => ({
        label: expense.category,
        category: expense.category,
        amount: `₹${Number(expense.amount || 0).toLocaleString('en-IN')}`,
        time: expense.date,
      })),
      receipts: [
        { type: 'UPI Payments', count: 0, amount: `₹${Number(receiptSummary.upi || 0).toLocaleString('en-IN')}`, icon: '📱' },
        { type: 'Bank Transfer', count: 0, amount: `₹${Number(receiptSummary.card || 0).toLocaleString('en-IN')}`, icon: '🏦' },
        { type: 'Card Payments', count: 0, amount: `₹${Number(receiptSummary.card || 0).toLocaleString('en-IN')}`, icon: '💳' },
      ],
    });
  } catch (error) {
    console.error('getCashierDashboard error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch cashier dashboard',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getCashierDriverCollections = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const offset = (page - 1) * limit;
    const [rows] = await connection.query(
      `
      SELECT
        d.id AS driver_id,
        u.name AS driverName,
        COALESCE(SUM(CASE WHEN sh.method = 'CASH' AND sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) AS cashAssigned,
        COALESCE(SUM(CASE WHEN sh.method = 'UPI' AND sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) AS upiAssigned,
        COALESCE(SUM(CASE WHEN sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) AS totalAssigned,
        COALESCE(SUM(CASE WHEN sh.method = 'CASH' AND sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS cashPending,
        COALESCE(SUM(CASE WHEN sh.method = 'UPI' AND sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS upiPending,
        COALESCE(SUM(CASE WHEN sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS totalPending,
        COALESCE(SUM(CASE WHEN sh.method = 'CASH' AND sh.status = 'SETTLED' THEN sh.amount ELSE 0 END), 0) AS cashSettled,
        COALESCE(SUM(CASE WHEN sh.method = 'UPI' AND sh.status = 'SETTLED' THEN sh.amount ELSE 0 END), 0) AS upiSettled,
        COALESCE(SUM(CASE WHEN sh.status = 'SETTLED' THEN sh.amount ELSE 0 END), 0) AS totalSettled,
        COALESCE(SUM(CASE WHEN sh.status = 'ASSIGNED' THEN 1 ELSE 0 END), 0) AS assignedCount,
        COALESCE(SUM(CASE WHEN sh.status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pendingCount,
        COALESCE(SUM(CASE WHEN sh.status = 'SETTLED' THEN 1 ELSE 0 END), 0) AS settledCount,
        CASE
          WHEN COALESCE(SUM(CASE WHEN sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) > 0 THEN 'Pending'
          WHEN COALESCE(SUM(CASE WHEN sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) > 0 THEN 'Assigned'
          WHEN COALESCE(SUM(CASE WHEN sh.status = 'SETTLED' THEN sh.amount ELSE 0 END), 0) > 0 THEN 'Settled'
          ELSE 'None'
        END AS status
      FROM drivers d
      INNER JOIN users u ON u.id = d.user_id
      LEFT JOIN settlement_history sh ON sh.driver_id = d.id AND sh.status IN ('ASSIGNED', 'PENDING', 'SETTLED')
      GROUP BY d.id, u.name
      ORDER BY totalPending DESC, u.name ASC
      LIMIT ?
      OFFSET ?
      `,
      [limit, offset]
    );

    return res.status(200).json({
      success: true,
      data: rows.map((driver) => {
        const cash = Number(
          driver.totalPending > 0
            ? driver.cashPending
            : driver.totalAssigned > 0
            ? driver.cashAssigned
            : driver.cashSettled
        );
        const upi = Number(
          driver.totalPending > 0
            ? driver.upiPending
            : driver.totalAssigned > 0
            ? driver.upiAssigned
            : driver.upiSettled
        );
        const total = Number(
          driver.totalPending > 0
            ? driver.totalPending
            : driver.totalAssigned > 0
            ? driver.totalAssigned
            : driver.totalSettled
        );

        return {
          driver_id: driver.driver_id,
          driverName: driver.driverName,
          cash,
          upi,
          total,
          settled: Number(driver.totalSettled || 0),
          status: driver.status,
          pendingCash: Number(driver.cashPending || 0),
          pendingUpi: Number(driver.upiPending || 0),
          pendingTotal: Number(driver.totalPending || 0),
          assignedCash: Number(driver.cashAssigned || 0),
          assignedUpi: Number(driver.upiAssigned || 0),
          assignedTotal: Number(driver.totalAssigned || 0),
          pendingCount: Number(driver.pendingCount || 0),
          assignedCount: Number(driver.assignedCount || 0),
          settledCount: Number(driver.settledCount || 0),
        };
      }),
      pagination: {
        page,
        limit,
        total: rows.length,
      },
    });
  } catch (error) {
    console.error('getCashierDriverCollections error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch driver collections',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getCashierPenaltyRequests = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const status = String(req.query.status || "ALL").toUpperCase();
    const whereClause =
      status === "PENDING"
        ? "WHERE p.payment_status = 'UNPAID'"
        : status === "PAID"
        ? "WHERE p.payment_status = 'PAID'"
        : "";

    const [rows] = await connection.query(
      `
      SELECT
        p.id,
        p.customer_id,
        p.customer_name_snapshot AS customer_name,
        p.consumer_number_snapshot AS consumer_number,
        p.penalty_reason,
        p.penalty_amount,
        p.payment_mode,
        p.payment_reference_id,
        p.cashier_remarks,
        p.payment_status,
        DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(p.paid_at, '%Y-%m-%d %H:%i:%s') AS paid_at,
        COALESCE(u.phone, '') AS customer_phone,
        COALESCE(a.address, '') AS address
      FROM customer_pr_penalties p
      LEFT JOIN users u ON u.id = p.customer_id
      LEFT JOIN addresses a ON a.user_id = p.customer_id AND a.is_default = 1
      ${whereClause}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 100
      `
    );

    return res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        id: Number(row.id),
        customerId: Number(row.customer_id),
        customerName: row.customer_name,
        consumerNumber: row.consumer_number,
        phone: row.customer_phone,
        address: row.address,
        reason: row.penalty_reason,
        amount: Number(row.penalty_amount || 0),
        paymentMode: row.payment_mode || "",
        paymentId: row.payment_reference_id || "",
        remarks: row.cashier_remarks || "",
        status: String(row.payment_status || "UNPAID").toUpperCase() === "PAID" ? "APPROVED" : "PENDING",
        createdAt: row.created_at,
        paidAt: row.paid_at,
      })),
    });
  } catch (error) {
    console.error("getCashierPenaltyRequests error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cashier penalty requests",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const collectCashierPenaltyRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const requestId = Number(req.params.requestId);
    const paymentMode = String(req.body?.paymentMode || "CASH").toUpperCase();
    const paymentId = String(req.body?.paymentId || "").trim();
    const remarks = String(req.body?.remarks || "").trim();

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Valid request id is required",
      });
    }

    const allowedModes = ["CASH", "UPI", "CARD", "BANK_TRANSFER"];
    if (!allowedModes.includes(paymentMode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment mode",
      });
    }

    if (paymentMode !== "CASH" && !paymentId) {
      return res.status(400).json({
        success: false,
        message: "Payment ID is required for non-cash modes",
      });
    }

    const [result] = await connection.query(
      `
      UPDATE customer_pr_penalties
      SET
        payment_mode = ?,
        payment_reference_id = ?,
        cashier_remarks = ?,
        payment_status = 'PAID',
        paid_at = NOW()
      WHERE id = ? AND payment_status = 'UNPAID'
      `,
      [paymentMode, paymentId || null, remarks || null, requestId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: "Pending request not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Request collected and marked as paid",
    });
  } catch (error) {
    console.error("collectCashierPenaltyRequest error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update cashier request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getCashierNameChangeRequests = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const status = String(req.query.status || "ALL").toUpperCase();
    const whereClause =
      status === "PENDING"
        ? "WHERE r.status = 'PENDING'"
        : status === "APPROVED"
        ? "WHERE r.status = 'APPROVED'"
        : "";

    const [rows] = await connection.query(
      `
      SELECT
        r.id,
        r.customer_id,
        CONCAT('LPG-', LPAD(r.customer_id, 5, '0')) AS consumer_number,
        r.old_name_snapshot,
        r.new_name_requested,
        r.service_fee,
        r.payment_mode,
        r.payment_reference_id,
        r.cashier_remarks,
        r.status,
        DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(r.approved_at, '%Y-%m-%d %H:%i:%s') AS approved_at,
        COALESCE(u.phone, '') AS customer_phone,
        COALESCE(a.address, '') AS address
      FROM customer_name_change_requests r
      LEFT JOIN users u ON u.id = r.customer_id
      LEFT JOIN addresses a ON a.user_id = r.customer_id AND a.is_default = 1
      ${whereClause}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 100
      `
    );

    return res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        id: Number(row.id),
        customerId: Number(row.customer_id),
        customerName: row.new_name_requested,
        consumerNumber: row.consumer_number,
        phone: row.customer_phone,
        address: row.address,
        oldName: row.old_name_snapshot,
        newName: row.new_name_requested,
        amount: Number(row.service_fee || 0),
        paymentMode: row.payment_mode || "",
        paymentId: row.payment_reference_id || "",
        remarks: row.cashier_remarks || "",
        status: String(row.status || "PENDING").toUpperCase() === "APPROVED" ? "APPROVED" : "PENDING",
        createdAt: row.created_at,
        approvedAt: row.approved_at,
      })),
    });
  } catch (error) {
    console.error("getCashierNameChangeRequests error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cashier name change requests",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const collectCashierNameChangeRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const requestId = Number(req.params.requestId);
    const paymentMode = String(req.body?.paymentMode || "CASH").toUpperCase();
    const paymentId = String(req.body?.paymentId || "").trim();
    const remarks = String(req.body?.remarks || "").trim();

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Valid request id is required",
      });
    }

    const allowedModes = ["CASH", "UPI", "CARD", "BANK_TRANSFER"];
    if (!allowedModes.includes(paymentMode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment mode",
      });
    }

    if (paymentMode !== "CASH" && !paymentId) {
      return res.status(400).json({
        success: false,
        message: "Payment ID is required for non-cash modes",
      });
    }

    const [result] = await connection.query(
      `
      UPDATE customer_name_change_requests
      SET
        payment_mode = ?,
        payment_reference_id = ?,
        cashier_remarks = ?,
        status = 'APPROVED',
        approved_at = NOW()
      WHERE id = ? AND status = 'PENDING'
      `,
      [paymentMode, paymentId || null, remarks || null, requestId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: "Pending request not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Name change request approved",
    });
  } catch (error) {
    console.error("collectCashierNameChangeRequest error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update name change request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

const ensureTransferVoucherPaymentColumns = async (connection) => {
  const requiredColumns = {
    payment_mode: "ALTER TABLE customer_connection_transfers ADD COLUMN payment_mode enum('CASH','UPI','CARD','BANK_TRANSFER') DEFAULT NULL AFTER reason",
    payment_reference_id: "ALTER TABLE customer_connection_transfers ADD COLUMN payment_reference_id varchar(120) DEFAULT NULL AFTER payment_mode",
    cashier_remarks: "ALTER TABLE customer_connection_transfers ADD COLUMN cashier_remarks text AFTER payment_reference_id",
  };

  const [rows] = await connection.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'customer_connection_transfers'
      AND COLUMN_NAME IN ('payment_mode', 'payment_reference_id', 'cashier_remarks')
    `
  );

  const existing = new Set(rows.map((row) => String(row.COLUMN_NAME)));
  for (const [columnName, ddl] of Object.entries(requiredColumns)) {
    if (existing.has(columnName)) {
      continue;
    }

    try {
      await connection.query(ddl);
    } catch (error) {
      // Ignore duplicate column race conditions from parallel requests.
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  }
};

export const getCashierTransferVoucherRequests = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureTransferVoucherPaymentColumns(connection);

    const status = String(req.query.status || "ALL").toUpperCase();
    const whereClause =
      status === "PENDING"
        ? "WHERE t.status = 'PENDING_MANAGER'"
        : status === "APPROVED"
        ? "WHERE t.status = 'APPROVED'"
        : "";

    const [rows] = await connection.query(
      `
      SELECT
        t.id,
        t.existing_customer_id,
        t.new_customer_id,
        t.deposit_liability,
        t.reason,
        t.payment_mode,
        t.payment_reference_id,
        t.cashier_remarks,
        t.status,
        DATE_FORMAT(t.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(t.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
        old_u.name AS old_customer_name,
        CONCAT('LPG-', LPAD(t.existing_customer_id, 5, '0')) AS consumer_number,
        new_u.name AS new_customer_name,
        COALESCE(new_u.phone, '') AS new_customer_phone,
        COALESCE(a.address, '') AS new_customer_address
      FROM customer_connection_transfers t
      INNER JOIN users old_u ON old_u.id = t.existing_customer_id
      INNER JOIN users new_u ON new_u.id = t.new_customer_id
      LEFT JOIN addresses a ON a.user_id = t.new_customer_id AND a.is_default = 1
      ${whereClause}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 100
      `
    );

    return res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        id: Number(row.id),
        customerId: Number(row.new_customer_id),
        customerName: row.new_customer_name,
        consumerNumber: row.consumer_number,
        phone: row.new_customer_phone,
        address: row.new_customer_address,
        oldName: row.old_customer_name,
        newName: row.new_customer_name,
        newMobile: row.new_customer_phone,
        newAddress: row.new_customer_address,
        amount: Number(row.deposit_liability || 0),
        reason: row.reason || "",
        paymentMode: row.payment_mode || "",
        paymentId: row.payment_reference_id || "",
        remarks: row.cashier_remarks || "",
        status: String(row.status || "PENDING_MANAGER").toUpperCase() === "APPROVED" ? "APPROVED" : "PENDING",
        createdAt: row.created_at,
        approvedAt: row.updated_at,
      })),
    });
  } catch (error) {
    console.error("getCashierTransferVoucherRequests error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cashier transfer voucher requests",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const collectCashierTransferVoucherRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureTransferVoucherPaymentColumns(connection);

    const requestId = Number(req.params.requestId);
    const paymentMode = String(req.body?.paymentMode || "CASH").toUpperCase();
    const paymentId = String(req.body?.paymentId || "").trim();
    const remarks = String(req.body?.remarks || "").trim();

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Valid request id is required",
      });
    }

    const allowedModes = ["CASH", "UPI", "CARD", "BANK_TRANSFER"];
    if (!allowedModes.includes(paymentMode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment mode",
      });
    }

    if (paymentMode !== "CASH" && !paymentId) {
      return res.status(400).json({
        success: false,
        message: "Payment ID is required for non-cash modes",
      });
    }

    const [result] = await connection.query(
      `
      UPDATE customer_connection_transfers
      SET
        payment_mode = ?,
        payment_reference_id = ?,
        cashier_remarks = ?,
        status = 'APPROVED',
        updated_at = NOW()
      WHERE id = ? AND status = 'PENDING_MANAGER'
      `,
      [paymentMode, paymentId || null, remarks || null, requestId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: "Pending request not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Transfer voucher request approved",
    });
  } catch (error) {
    console.error("collectCashierTransferVoucherRequest error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update transfer voucher request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getCashierNewConnectionRequests = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureNewConnectionCashierTables(connection);

    const status = String(req.query.status || "ALL").toUpperCase();
    const whereClause =
      status === "PENDING"
        ? "WHERE cnc.payment_status = 'PENDING_PAYMENT'"
        : status === "APPROVED" || status === "PAID"
        ? "WHERE cnc.payment_status = 'PAID'"
        : "";

    const [rows] = await connection.query(
      `
      SELECT
        cnc.id,
        cnc.user_id,
        CONCAT('LPG-', LPAD(cnc.user_id, 5, '0')) AS consumer_number,
        cnc.product_details,
        cnc.deposit_amount,
        cnc.gst_amount,
        cnc.total_amount,
        cnc.payment_mode,
        cnc.payment_reference_id,
        cnc.cashier_remarks,
        cnc.payment_status,
        DATE_FORMAT(cnc.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(cnc.paid_at, '%Y-%m-%d %H:%i:%s') AS paid_at,
        u.name AS customer_name,
        COALESCE(u.phone, '') AS customer_phone,
        COALESCE(a.address, '') AS address,
        GROUP_CONCAT(
          DISTINCT COALESCE(ncp.product_name_snapshot, p.name)
          ORDER BY COALESCE(ncp.product_name_snapshot, p.name)
          SEPARATOR ', '
        ) AS selected_products,
        GROUP_CONCAT(
          DISTINCT ncp.product_id
          ORDER BY ncp.product_id
          SEPARATOR ','
        ) AS product_ids
      FROM customer_new_connections cnc
      INNER JOIN users u ON u.id = cnc.user_id
      LEFT JOIN addresses a ON a.user_id = cnc.user_id AND a.is_default = 1
      LEFT JOIN customer_new_connection_products ncp ON ncp.connection_id = cnc.id
      LEFT JOIN products p ON p.id = ncp.product_id
      ${whereClause}
      GROUP BY
        cnc.id,
        cnc.user_id,
        cnc.product_details,
        cnc.deposit_amount,
        cnc.gst_amount,
        cnc.total_amount,
        cnc.payment_mode,
        cnc.payment_reference_id,
        cnc.cashier_remarks,
        cnc.payment_status,
        cnc.created_at,
        cnc.paid_at,
        u.name,
        u.phone,
        a.address
      ORDER BY cnc.created_at DESC, cnc.id DESC
      LIMIT 100
      `
    );

    return res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        id: Number(row.id),
        customerId: Number(row.user_id),
        customerName: row.customer_name,
        consumerNumber: row.consumer_number,
        phone: row.customer_phone,
        address: row.address,
        connectionId: `NC-${String(row.id).padStart(4, "0")}`,
        productDetails: row.selected_products || row.product_details || "",
        productIds: row.product_ids
          ? String(row.product_ids)
              .split(",")
              .filter(Boolean)
              .map((id) => Number(id))
          : [],
        depositAmount: Number(row.deposit_amount || 0),
        gstAmount: Number(row.gst_amount || 0),
        amount: Number(row.total_amount || 0),
        paymentMode: row.payment_mode || "",
        paymentId: row.payment_reference_id || "",
        remarks: row.cashier_remarks || "",
        status: String(row.payment_status || "PENDING_PAYMENT").toUpperCase() === "PAID" ? "APPROVED" : "PENDING",
        createdAt: row.created_at,
        approvedAt: row.paid_at,
      })),
    });
  } catch (error) {
    console.error("getCashierNewConnectionRequests error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cashier new connection requests",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const collectCashierNewConnectionRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureNewConnectionCashierTables(connection);

    const requestId = Number(req.params.requestId);
    const paymentMode = String(req.body?.paymentMode || "CASH").toUpperCase();
    const paymentId = String(req.body?.paymentId || "").trim();
    const remarks = String(req.body?.remarks || "").trim();

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Valid request id is required",
      });
    }

    const paymentError = validateCashierRequestPayment(paymentMode, paymentId);
    if (paymentError) {
      return res.status(400).json({
        success: false,
        message: paymentError,
      });
    }

    await connection.beginTransaction();

    const [result] = await connection.query(
      `
      UPDATE customer_new_connections
      SET
        payment_mode = ?,
        payment_reference_id = ?,
        cashier_remarks = ?,
        payment_status = 'PAID',
        paid_at = NOW(),
        updated_at = NOW()
      WHERE id = ? AND payment_status = 'PENDING_PAYMENT'
      `,
      [paymentMode, paymentId || null, remarks || null, requestId]
    );

    if (!result.affectedRows) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Pending request not found",
      });
    }

    await connection.query(
      `
      UPDATE customer_new_connection_products
      SET status = 'APPROVED', updated_at = NOW()
      WHERE connection_id = ?
      `,
      [requestId]
    );

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "New connection request approved",
    });
  } catch (error) {
    await connection.rollback();
    console.error("collectCashierNewConnectionRequest error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update new connection request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const recordOtherPayment = async (req, res) => {
  const connection = await db.getConnection();
  const cashierId = req.user?.id || 6;
  const { customer_name, method, transfer_id, amount, note } = req.body;

  if (!customer_name || !method || amount === undefined || amount === null) {
    return res.status(400).json({
      success: false,
      message: 'Customer name, method, and amount are required',
    });
  }

  const normalizedMethod = method.toUpperCase();
  const validMethods = ['UPI', 'BANK_TRANSFER', 'CARD'];
  if (!validMethods.includes(normalizedMethod)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid payment method',
    });
  }

  const numericAmount = Number(amount);
  if (Number.isNaN(numericAmount) || numericAmount < 0) {
    return res.status(400).json({
      success: false,
      message: 'Amount must be a valid non-negative number',
    });
  }

  try {
    const [result] = await connection.query(
      `
      INSERT INTO other_payments (
        cashier_id,
        customer_name,
        method,
        transfer_id,
        amount,
        note,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
      [cashierId, customer_name.trim(), normalizedMethod, transfer_id?.trim() || null, numericAmount, note?.trim() || null]
    );

    return res.status(201).json({
      success: true,
      message: 'Other payment saved',
      paymentId: result.insertId,
    });
  } catch (error) {
    console.error('recordOtherPayment error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to save other payment',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getOtherPayments = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const [rows] = await connection.query(
      `
      SELECT
        id,
        customer_name,
        method,
        transfer_id,
        amount,
        note,
        status,
        DATE_FORMAT(created_at, '%Y-%m-%d') AS date
      FROM other_payments
      ORDER BY created_at DESC
      LIMIT 100
      `
    );

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error('getOtherPayments error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch other payments',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getOtherPaymentsSummary = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const [rows] = await connection.query(
      `
      SELECT
        method,
        COUNT(*) AS count,
        COALESCE(SUM(amount), 0) AS totalAmount
      FROM other_payments
      GROUP BY method
      `
    );

    const summary = {
      UPI: { count: 0, totalAmount: 0 },
      BANK_TRANSFER: { count: 0, totalAmount: 0 },
      CARD: { count: 0, totalAmount: 0 },
    };

    rows.forEach((row) => {
      summary[row.method] = {
        count: Number(row.count || 0),
        totalAmount: Number(row.totalAmount || 0),
      };
    });

    return res.status(200).json({
      success: true,
      summary,
    });
  } catch (error) {
    console.error('getOtherPaymentsSummary error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch other payments summary',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const verifyDriverCollections = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const driverId = Number(req.params.driverId);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: 'Driver id is required',
      });
    }

    await connection.beginTransaction();

    const [rows] = await connection.query(
      `
      SELECT id, amount, created_at
      FROM settlement_history
      WHERE driver_id = ?
        AND status = 'PENDING'
      FOR UPDATE
      `,
      [driverId]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'No pending collections found for this driver',
      });
    }

    const totalsByDate = rows.reduce((acc, row) => {
      const rowDate = new Date(row.created_at).toISOString().split('T')[0];
      acc[rowDate] = (acc[rowDate] || 0) + Number(row.amount || 0);
      return acc;
    }, {});

    const [updateResult] = await connection.execute(
      `
      UPDATE settlement_history
      SET status = 'SETTLED'
      WHERE driver_id = ?
        AND status = 'PENDING'
      `,
      [driverId]
    );

    for (const [settlementDate, amount] of Object.entries(totalsByDate)) {
      await connection.execute(
        `
        INSERT INTO settlements (
          driver_id,
          amount,
          status,
          settlement_date
        ) VALUES (?, ?, 'SETTLED', ?)
        ON DUPLICATE KEY UPDATE
          amount = VALUES(amount),
          status = VALUES(status)
        `,
        [driverId, amount, settlementDate]
      );
    }

    await connection.commit();

    const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);

    return res.status(200).json({
      success: true,
      message: 'Driver collections verified and settled',
      data: {
        updatedCount: updateResult.affectedRows,
        totalSettled: total,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error('verifyDriverCollections error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify driver collections',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getLastClosingBalance = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const latest = await getLatestClosingBalance(connection);

    return res.status(200).json({
      success: true,
      total_cash: latest ?? 0,
      hasPrevious: latest !== null,
    });
  } catch (error) {
    console.error('getLastClosingBalance error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch last closing balance',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getClosingSummary = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const [rows] = await connection.query(
      `
      SELECT
        COALESCE(SUM(p.amount), 0) AS cashTotal
      FROM payments p
      INNER JOIN sales s ON s.id = p.sale_id
      WHERE p.method = 'CASH'
        AND p.status = 'SUCCESS'
        AND DATE(p.created_at) = CURDATE()
      `
    );

    return res.status(200).json({
      success: true,
      cashTotal: Number(rows[0]?.cashTotal || 0),
    });
  } catch (error) {
    console.error('getClosingSummary error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch closing summary',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const startCashierDay = async (req, res) => {
  const { totalAmount, denominations } = req.body;

  if (totalAmount === undefined || !denominations) {
    return res.status(400).json({
      success: false,
      message: 'totalAmount and denominations are required',
    });
  }

  const connection = await db.getConnection();

  try {
    const latest = await getLatestClosingBalance(connection);

    if (latest !== null && Number(totalAmount) !== Number(latest)) {
      return res.status(400).json({
        success: false,
        message: `Opening balance must match last closing balance of ₹${latest.toLocaleString('en-IN')}`,
      });
    }

    cashierDayLog.opening = {
      startedAt: new Date().toLocaleString('en-IN', { hour12: true }),
      totalAmount,
      denominations,
    };

    return res.status(200).json({
      success: true,
      message: 'Cashier day started successfully',
      opening: cashierDayLog.opening,
      lastClosingBalance: latest ?? 0,
    });
  } catch (error) {
    console.error('startCashierDay error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to start cashier day',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const closeCashierDay = async (req, res) => {
  const { closingAmount, denominations, differenceReason } = req.body;

  if (closingAmount === undefined || !denominations) {
    return res.status(400).json({
      success: false,
      message: 'closingAmount and denominations are required',
    });
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();
    const [result] = await connection.execute(
      `
      INSERT INTO cashier_closings (total_cash)
      VALUES (?)
      `,
      [closingAmount]
    );

    await connection.commit();

    cashierDayLog.closing = {
      closedAt: new Date().toLocaleString('en-IN', { hour12: true }),
      closingAmount,
      denominations,
      differenceReason: differenceReason || null,
      closingId: result.insertId,
    };

    return res.status(200).json({
      success: true,
      message: 'Cashier day closed successfully',
      closing: cashierDayLog.closing,
    });
  } catch (error) {
    await connection.rollback();
    console.error('closeCashierDay error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to close cashier day',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const recordOfficeSale = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      customer_name,
      phone,
      address,
      items = [],
      payment_method = 'CASH',
    } = req.body;

    if (!customer_name || !phone || !address || !items.length) {
      return res.status(400).json({
        success: false,
        message: 'customer_name, phone, address and items are required',
      });
    }

    const parsedItems = items.map((item) => ({
      product_id: Number(item.product_id),
      quantity: Number(item.quantity),
      price: Number(item.price),
    }));

    if (parsedItems.some((item) => !item.product_id || item.quantity <= 0 || item.price < 0)) {
      return res.status(400).json({
        success: false,
        message: 'Each item must have a valid product_id, positive quantity and price',
      });
    }

    const totalAmount = parsedItems.reduce((sum, item) => sum + item.quantity * item.price, 0);

    await connection.beginTransaction();

    const uniqueProductIds = [...new Set(parsedItems.map((item) => Number(item.product_id)))];
    const productPlaceholders = uniqueProductIds.map(() => '?').join(',');
    const [productRows] = await connection.query(
      `
      SELECT id, name, type, price
      FROM products
      WHERE id IN (${productPlaceholders})
      `,
      uniqueProductIds
    );

    if (productRows.length !== uniqueProductIds.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'One or more selected products are invalid',
      });
    }

    const productMap = new Map(productRows.map((row) => [Number(row.id), row]));

    const deductedStockAreaIds = [];

    for (const item of parsedItems) {
      const product = productMap.get(Number(item.product_id));
      if (!product) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: 'One or more selected products are invalid',
        });
      }

      const sourceStockAreaId = await consumeStockForCashierSale(connection, item.product_id, item.quantity);
      deductedStockAreaIds.push(sourceStockAreaId);
    }

    const cashierUserId = req.user?.id || null;

    let customerId = null;
    const [existingCustomers] = await connection.execute(
      `
      SELECT id
      FROM users
      WHERE phone = ?
      LIMIT 1
      `,
      [phone]
    );

    if (existingCustomers.length) {
      customerId = existingCustomers[0].id;
      await connection.execute(
        `
        UPDATE users
        SET name = ?, role = 'CUSTOMER', updated_at = NOW()
        WHERE id = ?
        `,
        [customer_name, customerId]
      );
    } else {
      const [customerResult] = await connection.execute(
        `
        INSERT INTO users
          (name, phone, role, created_at, updated_at)
        VALUES (?, ?, 'CUSTOMER', NOW(), NOW())
        `,
        [customer_name, phone]
      );
      customerId = customerResult.insertId;
    }

    let addressId = null;
    const [addressRows] = await connection.execute(
      `
      SELECT id
      FROM addresses
      WHERE user_id = ?
        AND address = ?
      LIMIT 1
      `,
      [customerId, address]
    );

    if (addressRows.length) {
      addressId = addressRows[0].id;
    } else {
      const [addressResult] = await connection.execute(
        `
        INSERT INTO addresses
          (user_id, address, created_at, updated_at)
        VALUES (?, ?, NOW(), NOW())
        `,
        [customerId, address]
      );
      addressId = addressResult.insertId;
    }

    const totalQuantity = parsedItems.reduce((sum, item) => sum + item.quantity, 0);

    const [saleResult] = await connection.execute(
      `
      INSERT INTO sales
        (customer_id, driver_id, address_id, total_amount, payment_method, status, created_at, assigned_at, updated_at, empty_cylinder_qty, empty_cylinder_status, sale_type, sales_from)
      VALUES (?, NULL, ?, ?, ?, 'DELIVERED', NOW(), NOW(), NOW(), ?, 'DELIVERED', 'SALE', 'CASHIER')
      `,
      [customerId, addressId, totalAmount, payment_method, totalQuantity]
    );

    const saleId = saleResult.insertId;

    for (const [index, item] of parsedItems.entries()) {
      const sourceStockAreaId = deductedStockAreaIds[index] ?? null;

      await connection.execute(
        `
        INSERT INTO sales_items
          (sale_id, product_id, quantity, price, status, delivered_qty, empty_cylinder_qty, empty_cylinder_status, defective_qty)
        VALUES (?, ?, ?, ?, 'DELIVERED', ?, ?, 'DELIVERED', 0)
        `,
        [saleId, item.product_id, item.quantity, item.price, item.quantity, item.quantity]
      );

      await connection.execute(
        `
        INSERT INTO stock_transactions
        (
          product_id,
          stock_area_id,
          type,
          quantity,
          isApproved,
          reference_id,
          created_by,
          driver_id,
          stock_from,
          is_defective
        )
        VALUES (?, ?, 'ADJUSTMENT_SUBTRACT', ?, 1, ?, ?, NULL, 'godown', 0)
        `,
        [
          item.product_id,
          sourceStockAreaId,
          item.quantity,
          saleId,
          cashierUserId,
        ]
      );

      // Auto-raise empty cylinder return request to godown manager with sold quantity.
      await connection.execute(
        `
        INSERT INTO stock_transactions
        (
          product_id,
          stock_area_id,
          type,
          quantity,
          isApproved,
          reference_id,
          created_by,
          driver_id,
          stock_from,
          is_defective
        )
        VALUES (?, NULL, 'EMPTY_RETURN', ?, 0, ?, ?, NULL, 'godown', 0)
        `,
        [
          item.product_id,
          item.quantity,
          saleId,
          cashierUserId,
        ]
      );
    }

    if (payment_method === 'PART_PAYMENT') {
      // Split a part payment into two payment rows: cash portion + bank/UTR portion.
      const rawCash = Number(req.body.cash_amount);
      const cashPart = Math.min(Math.max(Number.isFinite(rawCash) ? rawCash : 0, 0), totalAmount);
      const bankPart = Math.max(totalAmount - cashPart, 0);

      if (cashPart > 0) {
        await connection.execute(
          `
          INSERT INTO payments
            (sale_id, amount, method, status, type, created_at)
          VALUES (?, ?, 'CASH', 'SUCCESS', 'COMPANY', NOW())
          `,
          [saleId, cashPart]
        );
      }

      if (bankPart > 0) {
        await connection.execute(
          `
          INSERT INTO payments
            (sale_id, amount, method, status, type, created_at)
          VALUES (?, ?, 'UPI', 'SUCCESS', 'COMPANY', NOW())
          `,
          [saleId, bankPart]
        );
      }

      // Guarantee at least one payment row exists (e.g. zero-value edge case).
      if (cashPart <= 0 && bankPart <= 0) {
        await connection.execute(
          `
          INSERT INTO payments
            (sale_id, amount, method, status, type, created_at)
          VALUES (?, ?, 'CASH', 'SUCCESS', 'COMPANY', NOW())
          `,
          [saleId, 0]
        );
      }
    } else {
      // payments.method only supports CASH/UPI/CARD; map anything else to UPI.
      const paymentMethodForRow = ['CASH', 'UPI', 'CARD'].includes(payment_method)
        ? payment_method
        : 'UPI';

      await connection.execute(
        `
        INSERT INTO payments
          (sale_id, amount, method, status, type, created_at)
        VALUES (?, ?, ?, 'SUCCESS', 'COMPANY', NOW())
        `,
        [saleId, totalAmount, paymentMethodForRow]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: 'Office sale created successfully',
      data: {
        saleId,
        totalAmount,
        customerId,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error('recordOfficeSale error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create office sale',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getTodayOfficeSales = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const [rows] = await connection.query(
      `
      SELECT
        s.id,
        CONCAT('B-', LPAD(s.id, 4, '0')) AS billId,
        COALESCE(u.name, 'Walk-in') AS customer,
        COALESCE(GROUP_CONCAT(CONCAT(p.name, ' x', si.quantity) SEPARATOR ', '), '') AS notes,
        s.total_amount AS amount
      FROM sales s
      LEFT JOIN users u ON u.id = s.customer_id
      LEFT JOIN sales_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      WHERE s.sales_from = 'CASHIER'
        AND DATE(s.created_at) = CURDATE()
      GROUP BY s.id, u.name, s.total_amount
      ORDER BY s.created_at DESC
      `
    );

    return res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        billId: row.billId,
        customer: row.customer,
        notes: row.notes,
        amount: Number(row.amount || 0),
      })),
    });
  } catch (error) {
    console.error('getTodayOfficeSales error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch today office sales',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const recordOfficeExpense = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { category, amount, description, bill_url: billUrl } = req.body;
    const adminId = 6;

    if (!adminId) {
      return res.status(400).json({ success: false, message: 'admin_id is required' });
    }

    if (!category || amount === undefined) {
      return res.status(400).json({ success: false, message: 'category and amount are required' });
    }

    const numericAmount = Number(amount);
    if (Number.isNaN(numericAmount) || numericAmount < 0) {
      return res.status(400).json({ success: false, message: 'amount must be a non-negative number' });
    }

    // Ensure a receipt column exists so the uploaded bill can be persisted.
    const [billColumns] = await connection.query(
      `SHOW COLUMNS FROM office_expenses LIKE 'bill_url'`
    );
    let hasBillUrl = billColumns.length > 0;
    if (!hasBillUrl && billUrl) {
      try {
        await connection.query(`ALTER TABLE office_expenses ADD COLUMN bill_url TEXT NULL`);
        hasBillUrl = true;
      } catch (alterError) {
        console.warn('Could not add bill_url column to office_expenses:', alterError.message);
      }
    }

    const extraCols = hasBillUrl ? ', bill_url' : '';
    const extraPlaceholder = hasBillUrl ? ', ?' : '';
    const baseParams = [adminId, category, numericAmount, description || null];
    const billParams = hasBillUrl ? [billUrl || null] : [];

    let result;

    try {
      [result] = await connection.execute(
        `
        INSERT INTO office_expenses (admin_id, category, amount, description${extraCols}, status, created_at, updated_at)
        VALUES (?, ?, ?, ?${extraPlaceholder}, 'PENDING', NOW(), NOW())
        `,
        [...baseParams, ...billParams]
      );
    } catch (queryError) {
      if (queryError?.code !== 'ER_BAD_FIELD_ERROR') {
        throw queryError;
      }

      [result] = await connection.execute(
        `
        INSERT INTO office_expenses (admin_id, category, amount, description${extraCols}, created_at, updated_at)
        VALUES (?, ?, ?, ?${extraPlaceholder}, NOW(), NOW())
        `,
        [...baseParams, ...billParams]
      );
    }

    return res.status(201).json({ success: true, message: 'Office expense recorded', expenseId: result.insertId });
  } catch (error) {
    console.error('recordOfficeExpense error:', error);
    return res.status(500).json({ success: false, message: 'Failed to record office expense', error: error.message });
  } finally {
    connection.release();
  }
};

export const getTodayOfficeExpenses = async (req, res) => {
  const connection = await db.getConnection();

  try {
    let rows;

    try {
      [rows] = await connection.query(
        `
        SELECT
          o.id,
          o.category,
          o.description,
          o.amount,
          DATE_FORMAT(o.created_at, '%Y-%m-%d') AS date,
          COALESCE(u.name, 'Unknown') AS createdBy,
          COALESCE(o.status, 'PENDING') AS status
        FROM office_expenses o
        LEFT JOIN users u ON u.id = o.admin_id
        WHERE DATE(o.created_at) = CURDATE()
        ORDER BY o.created_at DESC
        `
      );
    } catch (queryError) {
      if (queryError?.code !== 'ER_BAD_FIELD_ERROR') {
        throw queryError;
      }

      [rows] = await connection.query(
        `
        SELECT
          o.id,
          o.category,
          o.description,
          o.amount,
          DATE_FORMAT(o.created_at, '%Y-%m-%d') AS date,
          COALESCE(u.name, 'Unknown') AS createdBy
        FROM office_expenses o
        LEFT JOIN users u ON u.id = o.admin_id
        WHERE DATE(o.created_at) = CURDATE()
        ORDER BY o.created_at DESC
        `
      );
    }

    return res.status(200).json({
      success: true,
      data: rows.map((r) => ({ id: `OE-${String(r.id).padStart(3, '0')}`, category: r.category, description: r.description, amount: Number(r.amount || 0), date: r.date, by: r.createdBy, status: r.status || 'PENDING' })),
    });
  } catch (error) {
    console.error('getTodayOfficeExpenses error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch today office expenses', error: error.message });
  } finally {
    connection.release();
  }
};

export const getCashOutExpenseRequests = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const [summaryRows] = await connection.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN e.status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pendingApprovals,
        COALESCE(SUM(CASE WHEN e.status = 'APPROVED' AND DATE(e.created_at) = CURDATE() THEN e.amount ELSE 0 END), 0) AS approvedToday
      FROM expenses e
      INNER JOIN users u ON u.id = e.created_by
      WHERE u.role = 'PURCHASE_MANAGER'
      `
    );

    const [rows] = await connection.query(
      `
      SELECT
        e.id,
        e.category,
        e.description,
        e.amount,
        e.bill_url,
        e.status,
        e.created_at,
        u.name AS created_by_name,
        pt.id AS trip_id,
        pt.odometer_reading,
        pt.end_odometer_reading,
        pt.odometer_image_url,
        pt.end_odometer_image_url,
        pt.started_at,
        pt.ended_at
      FROM expenses e
      INNER JOIN users u ON u.id = e.created_by
      ${purchaseExpenseTripJoin}
      WHERE u.role = 'PURCHASE_MANAGER'
        AND e.status = 'PENDING'
      ORDER BY e.created_at DESC, e.id DESC
      `
    );

    return res.status(200).json({
      success: true,
      summary: {
        pendingApprovals: Number(summaryRows[0]?.pendingApprovals || 0),
        approvedToday: Number(summaryRows[0]?.approvedToday || 0),
      },
      data: rows.map((row) => ({
        id: row.id,
        category: row.category,
        description: row.description,
        amount: Number(row.amount || 0),
        billUrl: row.bill_url,
        status: row.status,
        createdAt: row.created_at,
        createdByName: row.created_by_name,
        tripId: row.trip_id,
        startOdometerReading: Number(row.odometer_reading || 0),
        endOdometerReading: row.end_odometer_reading
          ? Number(row.end_odometer_reading)
          : null,
        startOdometerImageUrl: row.odometer_image_url,
        endOdometerImageUrl: row.end_odometer_image_url,
        tripStartedAt: row.started_at,
        tripEndedAt: row.ended_at,
      })),
    });
  } catch (error) {
    console.error('getCashOutExpenseRequests error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch expense requests',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const reviewCashOutExpenseRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const expenseId = Number(req.params.expenseId);
    const status = String(req.body?.status || '').toUpperCase();
    const rawPaymentMode = String(req.body?.paymentMode || req.body?.payment_method || '').trim().toUpperCase();
    const rawTransactionId = String(req.body?.transactionId || req.body?.transaction_id || '').trim();

    if (!expenseId || !['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'expenseId and a valid status are required',
      });
    }

    const validPaymentModes = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER'];
    const paymentMode = status === 'APPROVED'
      ? (rawPaymentMode || 'CASH')
      : null;
    const transactionId = status === 'APPROVED'
      ? rawTransactionId
      : null;

    if (status === 'APPROVED' && !validPaymentModes.includes(paymentMode)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment mode',
      });
    }

    if (status === 'APPROVED' && paymentMode !== 'CASH' && !transactionId) {
      return res.status(400).json({
        success: false,
        message: 'Transaction ID is required for non-cash payments',
      });
    }

    const [rows] = await connection.query(
      `
      SELECT e.id, e.status, e.description
      FROM expenses e
      INNER JOIN users u ON u.id = e.created_by
      WHERE e.id = ?
        AND u.role = 'PURCHASE_MANAGER'
      LIMIT 1
      `,
      [expenseId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Expense request not found',
      });
    }

    if (rows[0].status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: 'Only pending expense requests can be reviewed',
      });
    }

    let savedViaColumns = false;

    try {
      if (status === 'APPROVED') {
        await connection.query(
          `
          UPDATE expenses
          SET status = ?,
              payment_mode = ?,
              payment_reference = ?
          WHERE id = ?
          `,
          [status, paymentMode, transactionId || null, expenseId]
        );
      } else {
        await connection.query(
          `
          UPDATE expenses
          SET status = ?
          WHERE id = ?
          `,
          [status, expenseId]
        );
      }

      savedViaColumns = true;
    } catch (queryError) {
      // Keep compatibility with environments where migration is not yet applied.
      if (queryError?.code !== 'ER_BAD_FIELD_ERROR') {
        throw queryError;
      }

      if (status === 'APPROVED') {
        const existingDescription = rows[0]?.description ? String(rows[0].description).trim() : '';
        const paymentTag = `[Payment: ${paymentMode}${transactionId ? ` | ${transactionId}` : ''}]`;
        const nextDescription = [existingDescription, paymentTag].filter(Boolean).join(' ');

        await connection.query(
          `
          UPDATE expenses
          SET status = ?,
              description = ?
          WHERE id = ?
          `,
          [status, nextDescription, expenseId]
        );
      } else {
        await connection.query(
          `
          UPDATE expenses
          SET status = ?
          WHERE id = ?
          `,
          [status, expenseId]
        );
      }
    }

    return res.status(200).json({
      success: true,
      message: status === 'APPROVED' ? 'Expense approved successfully' : 'Expense rejected successfully',
      paymentSavedInColumns: savedViaColumns,
    });
  } catch (error) {
    console.error('reviewCashOutExpenseRequest error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to review expense request',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const recordCashierReceipt = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { customer_id, amount, payment_method, receipt_type, notes } = req.body;

    if (!customer_id || !amount || !payment_method) {
      return res.status(400).json({
        success: false,
        message: 'customer_id, amount and payment_method are required',
      });
    }

    await connection.beginTransaction();

    const [saleResult] = await connection.execute(
      `
      INSERT INTO sales
        (customer_id, driver_id, total_amount, payment_method, status, address_id, created_at, assigned_at, updated_at, sale_type, sales_from)
      VALUES
        (?, NULL, ?, ?, 'DELIVERED', NULL, NOW(), NOW(), NOW(), 'SALE', 'CASHIER')
      `,
      [customer_id, amount, payment_method]
    );

    const saleId = saleResult.insertId;

    await connection.execute(
      `
      INSERT INTO payments
        (sale_id, amount, method, status, type, created_at)
      VALUES
        (?, ?, ?, 'SUCCESS', ?, NOW())
      `,
      [saleId, amount, payment_method, receipt_type || 'COMPANY']
    );

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: 'Cashier receipt recorded successfully',
      saleId,
    });
  } catch (error) {
    await connection.rollback();
    console.error('recordCashierReceipt error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to record cashier receipt',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getTodaysCashFlow = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const lastClosing = await getLatestClosingBalance(connection);
    const openingBalance = lastClosing ?? 0;

    // Ensure the payment-mode columns exist on the cashier-request tables we read
    // below (idempotent — safe to call on every request).
    await ensureNewConnectionCashierTables(connection);
    await ensureTransferVoucherPaymentColumns(connection);

    // The expenses table's payment_mode column is only present on migrated DBs
    // (older rows tag the mode inside the description instead). Detect it so
    // non-cash expenses can be excluded from the CASH balance without breaking
    // databases that never got the column.
    const [expenseModeColumn] = await connection.query(
      `
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'expenses'
        AND COLUMN_NAME = 'payment_mode'
      `
    );
    const expensesCashOnlySum = expenseModeColumn.length
      ? "SUM(CASE WHEN e.payment_mode = 'CASH' OR e.payment_mode IS NULL THEN e.amount ELSE 0 END)"
      : "SUM(e.amount)";

    // ---------------- INFLOW (cash-in) ----------------
    // Driver settlements store no payment-mode split, so the settled amount is
    // counted as cash (preserves the previous behavior for this source).
    const [settledInflow] = await connection.query(
      `
      SELECT
        COALESCE(SUM(s.amount), 0) AS total,
        COALESCE(SUM(s.amount), 0) AS cash_total,
        COUNT(DISTINCT s.id) AS count
      FROM settlements s
      WHERE s.status = 'SETTLED'
        AND s.settlement_date = CURDATE()
      `
    );

    const [cashierSalesInflow] = await connection.query(
      `
      SELECT
        COALESCE(SUM(p.amount), 0) AS total,
        COALESCE(SUM(CASE WHEN p.method = 'CASH' THEN p.amount ELSE 0 END), 0) AS cash_total,
        COALESCE(SUM(CASE WHEN p.method = 'UPI' THEN p.amount ELSE 0 END), 0) AS upi_total,
        COUNT(DISTINCT p.id) AS count
      FROM payments p
      INNER JOIN sales s ON s.id = p.sale_id
      WHERE p.status = 'SUCCESS'
        AND s.sales_from = 'CASHIER'
        AND DATE(p.created_at) = CURDATE()
      `
    );

    // Other payments are always non-cash (UPI / bank transfer / card): they add
    // to inflow but never to the cash balance.
    const [otherPaymentsInflow] = await connection.query(
      `
      SELECT
        COALESCE(SUM(op.amount), 0) AS total,
        COALESCE(SUM(CASE WHEN UPPER(op.method) = 'CASH' THEN op.amount ELSE 0 END), 0) AS cash_total,
        COALESCE(SUM(CASE WHEN UPPER(op.method) = 'UPI' THEN op.amount ELSE 0 END), 0) AS upi_total,
        COUNT(DISTINCT op.id) AS count
      FROM other_payments op
      WHERE DATE(op.created_at) = CURDATE()
        AND UPPER(COALESCE(op.status, 'PENDING')) <> 'REJECTED'
      `
    );

    // PR penalty collections — cash-in cashier requests.
    const [prPenaltyInflow] = await connection.query(
      `
      SELECT
        COALESCE(SUM(p.penalty_amount), 0) AS total,
        COALESCE(SUM(CASE WHEN p.payment_mode = 'CASH' THEN p.penalty_amount ELSE 0 END), 0) AS cash_total,
        COALESCE(SUM(CASE WHEN p.payment_mode = 'UPI' THEN p.penalty_amount ELSE 0 END), 0) AS upi_total,
        COUNT(DISTINCT p.id) AS count
      FROM customer_pr_penalties p
      WHERE p.payment_status = 'PAID'
        AND DATE(p.paid_at) = CURDATE()
      `
    );

    // Name change collections — cash-in cashier requests.
    const [nameChangeInflow] = await connection.query(
      `
      SELECT
        COALESCE(SUM(r.service_fee), 0) AS total,
        COALESCE(SUM(CASE WHEN r.payment_mode = 'CASH' THEN r.service_fee ELSE 0 END), 0) AS cash_total,
        COALESCE(SUM(CASE WHEN r.payment_mode = 'UPI' THEN r.service_fee ELSE 0 END), 0) AS upi_total,
        COUNT(DISTINCT r.id) AS count
      FROM customer_name_change_requests r
      WHERE r.status = 'APPROVED'
        AND DATE(r.approved_at) = CURDATE()
      `
    );

    // New connection collections — cash-in cashier requests.
    const [newConnectionInflow] = await connection.query(
      `
      SELECT
        COALESCE(SUM(cnc.total_amount), 0) AS total,
        COALESCE(SUM(CASE WHEN cnc.payment_mode = 'CASH' THEN cnc.total_amount ELSE 0 END), 0) AS cash_total,
        COALESCE(SUM(CASE WHEN cnc.payment_mode = 'UPI' THEN cnc.total_amount ELSE 0 END), 0) AS upi_total,
        COUNT(DISTINCT cnc.id) AS count
      FROM customer_new_connections cnc
      WHERE cnc.payment_status = 'PAID'
        AND DATE(cnc.paid_at) = CURDATE()
      `
    );

    // ---------------- OUTFLOW (cash-out) ----------------
    // Office expenses have no payment-mode column, so they are treated as cash.
    const [officeExpensesOutflow] = await connection.query(
      `
      SELECT
        COALESCE(SUM(oe.amount), 0) AS total,
        COALESCE(SUM(oe.amount), 0) AS cash_total,
        COUNT(DISTINCT oe.id) AS count
      FROM office_expenses oe
      WHERE DATE(oe.created_at) = CURDATE()
      `
    );

    // Approved expenses: only cash (or legacy/untagged) expenses reduce the cash
    // balance. UPI / card / bank-transfer expenses add to outflow but not to cash.
    const [approvedExpensesOutflow] = await connection.query(
      `
      SELECT
        COALESCE(SUM(e.amount), 0) AS total,
        COALESCE(${expensesCashOnlySum}, 0) AS cash_total,
        COUNT(DISTINCT e.id) AS count
      FROM expenses e
      WHERE e.status = 'APPROVED'
        AND DATE(e.created_at) = CURDATE()
      `
    );

    // Transfer voucher collections — cash-out cashier requests.
    const [transferVoucherOutflow] = await connection.query(
      `
      SELECT
        COALESCE(SUM(t.deposit_liability), 0) AS total,
        COALESCE(SUM(CASE WHEN t.payment_mode = 'CASH' THEN t.deposit_liability ELSE 0 END), 0) AS cash_total,
        COUNT(DISTINCT t.id) AS count
      FROM customer_connection_transfers t
      WHERE t.status = 'APPROVED'
        AND DATE(t.updated_at) = CURDATE()
      `
    );

    const inflowSources = [
      settledInflow,
      cashierSalesInflow,
      otherPaymentsInflow,
      prPenaltyInflow,
      nameChangeInflow,
      newConnectionInflow,
    ];
    const outflowSources = [officeExpensesOutflow, approvedExpensesOutflow, transferVoucherOutflow];

    const sumField = (sources, field) =>
      sources.reduce((acc, rows) => acc + Number(rows[0]?.[field] || 0), 0);

    const inflowTotal = sumField(inflowSources, "total");
    const inflowCount = sumField(inflowSources, "count");
    const inflowCashTotal = sumField(inflowSources, "cash_total");
    const inflowUpiTotal = sumField(inflowSources, "upi_total");
    // Anything that is neither cash nor UPI (card / bank transfer) is "bank".
    const inflowBankTotal = Math.max(inflowTotal - inflowCashTotal - inflowUpiTotal, 0);

    const outflowTotal = sumField(outflowSources, "total");
    const outflowCount = sumField(outflowSources, "count");
    const outflowCashTotal = sumField(outflowSources, "cash_total");

    // Current cash balance is CASH ONLY: opening cash + cash received − cash paid.
    // Non-cash inflow/outflow (UPI, card, bank transfer) still shows in the
    // inflow/outflow totals but does not move the cash balance.
    const currentBalance = openingBalance + inflowCashTotal - outflowCashTotal;

    return res.status(200).json({
      success: true,
      openingBalance,
      inflow: { total: inflowTotal, count: inflowCount, cashTotal: inflowCashTotal },
      outflow: { total: outflowTotal, count: outflowCount, cashTotal: outflowCashTotal },
      cashInflow: inflowCashTotal,
      cashOutflow: outflowCashTotal,
      currentBalance,
      breakdown: {
        cash: inflowCashTotal,
        online: inflowUpiTotal,
        bank: inflowBankTotal,
      },
    });
  } catch (error) {
    console.error('getTodaysCashFlow error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch todays cash flow',
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const findCustomerForCashierApp = async (req, res) => {
  try {
    const { query } = req.query;

    if (!query || !String(query).trim()) {
      return res.status(400).json({
        success: false,
        message: "query is required",
      });
    }

    const searchValue = String(query).trim();
    const likeValue = `%${searchValue}%`;
    const numericId = Number(searchValue);

    const [rows] = await db.execute(
      `
      SELECT
        u.id,
        u.name,
        u.phone,
        u.email,
        (
          SELECT a.address
          FROM addresses a
          WHERE a.user_id = u.id
          ORDER BY a.is_default DESC, a.id DESC
          LIMIT 1
        ) AS address
      FROM users u
      WHERE u.role = 'CUSTOMER'
        AND (
          u.name LIKE ?
          OR u.phone LIKE ?
          ${!Number.isNaN(numericId) ? "OR u.id = ?" : ""}
        )
      ORDER BY u.name ASC
      LIMIT 20
      `,
      !Number.isNaN(numericId)
        ? [likeValue, likeValue, numericId]
        : [likeValue, likeValue]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Customers fetched successfully",
      data: rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        phone: row.phone,
        email: row.email,
        address: row.address || "",
      })),
    });
  } catch (error) {
    console.error("findCustomerForCashierApp error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to find customers",
      error: error.message,
    });
  }
};
