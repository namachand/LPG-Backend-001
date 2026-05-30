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

export const getCashierDashboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const lastClosing = await getLatestClosingBalance(connection);

    const [receiptRows] = await connection.query(
      `
      SELECT
        SUM(CASE WHEN p.method = 'CASH' THEN p.amount ELSE 0 END) AS cash,
        SUM(CASE WHEN p.method = 'UPI' THEN p.amount ELSE 0 END) AS upi,
        SUM(CASE WHEN p.method = 'CARD' THEN p.amount ELSE 0 END) AS card
      FROM payments p
      INNER JOIN sales s ON s.id = p.sale_id
      WHERE p.status = 'SUCCESS'
      `
    );

    const [expenseRows] = await connection.query(
      `
      SELECT
        COALESCE(SUM(e.amount), 0) AS totalExpenses,
        COALESCE(SUM(CASE WHEN e.status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pendingApproval
      FROM expenses e
      `
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
      ORDER BY e.created_at DESC
      LIMIT 2
      `
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
      LEFT JOIN settlement_history sh ON sh.driver_id = d.id AND sh.status IN ('ASSIGNED', 'PENDING', 'SETTLED')
      GROUP BY d.id, u.name
      ORDER BY totalPending DESC, u.name ASC
      LIMIT 4
      `
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

    for (const item of parsedItems) {
      await connection.execute(
        `
        INSERT INTO sales_items
          (sale_id, product_id, quantity, price, status, delivered_qty, empty_cylinder_qty, empty_cylinder_status, defective_qty)
        VALUES (?, ?, ?, ?, 'DELIVERED', ?, ?, 'DELIVERED', 0)
        `,
        [saleId, item.product_id, item.quantity, item.price, item.quantity, item.quantity]
      );
    }

    await connection.execute(
      `
      INSERT INTO payments
        (sale_id, amount, method, status, type, created_at)
      VALUES (?, ?, ?, 'SUCCESS', 'COMPANY', NOW())
      `,
      [saleId, totalAmount, payment_method]
    );

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
    const { category, amount, description } = req.body;
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

    const [result] = await connection.execute(
      `
      INSERT INTO office_expenses (admin_id, category, amount, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, NOW(), NOW())
      `,
      [adminId, category, numericAmount, description || null]
    );

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
    const [rows] = await connection.query(
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

    return res.status(200).json({
      success: true,
      data: rows.map((r) => ({ id: `OE-${String(r.id).padStart(3, '0')}`, category: r.category, description: r.description, amount: Number(r.amount || 0), date: r.date, by: r.createdBy })),
    });
  } catch (error) {
    console.error('getTodayOfficeExpenses error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch today office expenses', error: error.message });
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

    const [inflow] = await connection.query(
      `
      SELECT COALESCE(SUM(sh.amount), 0) AS total, COUNT(DISTINCT sh.id) AS count
      FROM settlement_history sh
      WHERE sh.status = 'SETTLED'
        AND DATE(sh.created_at) = CURDATE()
      `
    );

    const [outflow] = await connection.query(
      `
      SELECT COALESCE(SUM(oe.amount), 0) AS total, COUNT(DISTINCT oe.id) AS count
      FROM office_expenses oe
      WHERE DATE(oe.created_at) = CURDATE()
      `
    );

    const inflowTotal = Number(inflow[0]?.total || 0);
    const inflowCount = Number(inflow[0]?.count || 0);
    const outflowTotal = Number(outflow[0]?.total || 0);
    const outflowCount = Number(outflow[0]?.count || 0);
    const currentBalance = openingBalance + inflowTotal - outflowTotal;

    return res.status(200).json({
      success: true,
      openingBalance,
      inflow: { total: inflowTotal, count: inflowCount },
      outflow: { total: outflowTotal, count: outflowCount },
      currentBalance,
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