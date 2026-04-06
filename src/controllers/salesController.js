import db from "../config/db.js";

export const getSalesDashboard = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      startDate,
      endDate,
    } = req.query;

    const offset = (page - 1) * limit;

    // Date Filter
    let dateFilter = "";
    const values = [];

    if (startDate && endDate) {
      dateFilter = `AND DATE(s.created_at) BETWEEN ? AND ?`;
      values.push(startDate, endDate);
    }

    // Search Filter
    let searchFilter = "";
    if (search) {
      searchFilter = `AND u.name LIKE ?`;
      values.push(`%${search}%`);
    }

    // =========================
    // SUMMARY DATA
    // =========================
    const [summary] = await db.query(
      `SELECT 
        SUM(CASE WHEN p.method = 'CASH' AND p.type = 'DRIVER' THEN p.amount ELSE 0 END) AS cash,
        SUM(CASE WHEN p.method = 'UPI' AND p.type = 'DRIVER' THEN p.amount ELSE 0 END) AS gpay,
        SUM(CASE WHEN p.type = 'COMPANY' THEN p.amount ELSE 0 END) AS online
        FROM payments p
        JOIN sales s ON p.sale_id = s.id
        WHERE s.status = 'DELIVERED'
      ${dateFilter}
      `,
      values
    );

    // =========================
    // DRIVER TABLE DATA
    // =========================
    const [drivers] = await db.query(
      `
      SELECT 
        d.id,
        u.name AS driver_name,
        COUNT(DISTINCT s.id) AS deliveries,
        SUM(CASE WHEN p.method = 'CASH' AND p.type = 'DRIVER' THEN p.amount ELSE 0 END) AS cash,
        SUM(CASE WHEN p.method = 'UPI' AND p.type = 'DRIVER' THEN p.amount ELSE 0 END) AS gpay,
        SUM(p.amount) AS total
      FROM drivers d
      JOIN users u ON d.user_id = u.id
      LEFT JOIN sales s ON s.driver_id = d.id AND s.status = 'DELIVERED'
      LEFT JOIN payments p ON p.sale_id = s.id
      WHERE 1=1
      ${dateFilter}
      ${searchFilter}
      GROUP BY d.id
      ORDER BY total DESC
      LIMIT ? OFFSET ?
      `,
      [...values, Number(limit), Number(offset)]
    );

    // =========================
    // TOTAL COUNT
    // =========================
    const [countResult] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM drivers d
      JOIN users u ON d.user_id = u.id
      WHERE 1=1
      ${searchFilter}
      `,
      search ? [`%${search}%`] : []
    );

    return res.json({
      success: true,
      summary: summary[0],
      data: drivers,
      pagination: {
        total: countResult[0].total,
        page: Number(page),
        limit: Number(limit),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

export const createSale = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      customer_id,
      driver_id,
      payment_method,
      status = "PENDING",
      address_id,
      items = [],
      payments = []
    } = req.body;

    if (!customer_id || !items.length) {
      return res.status(400).json({
        success: false,
        message: "Customer and items are required"
      });
    }

    await connection.beginTransaction();

    // =========================
    // CALCULATE TOTAL
    // =========================
    const total_amount = items.reduce(
      (sum, item) => sum + item.quantity * item.price,
      0
    );

    // =========================
    // INSERT SALE
    // =========================
    const [saleResult] = await connection.execute(
      `
      INSERT INTO sales 
      (customer_id, driver_id, total_amount, payment_method, status, address_id, created_at, assigned_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        customer_id,
        driver_id || null,
        total_amount,
        payment_method,
        status,
        address_id || null
      ]
    );

    const saleId = saleResult.insertId;

    // =========================
    // INSERT ITEMS
    // =========================
    for (const item of items) {
      await connection.execute(
        `
        INSERT INTO sales_items 
        (sale_id, product_id, quantity, price)
        VALUES (?, ?, ?, ?)
        `,
        [saleId, item.product_id, item.quantity, item.price]
      );
    }

    // =========================
    // INSERT PAYMENTS (MULTIPLE)
    // =========================
    let totalPaid = 0;

    for (const p of payments) {
      await connection.execute(
        `
        INSERT INTO payments
        (sale_id, amount, method, status, type, created_at)
        VALUES (?, ?, ?, ?, ?, NOW())
        `,
        [
          saleId,
          p.amount,
          p.method,
          p.status,
          p.type
        ]
      );

      if (p.status === "SUCCESS") {
        totalPaid += Number(p.amount);
      }
    }

    // =========================
    // VALIDATE PAYMENT (IMPORTANT)
    // =========================
    if (payments.length > 0 && totalPaid > total_amount) {
      throw new Error("Paid amount exceeds total amount");
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Sale created successfully",
      sale_id: saleId,
      total_amount,
      total_paid: totalPaid,
      due_amount: total_amount - totalPaid
    });

  } catch (error) {
    await connection.rollback();
    console.error("Create Sale Error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Server Error"
    });
  } finally {
    connection.release();
  }
};