import db from "../config/db.js";

export const createExpense = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      category,
      description = null,
      amount,
      createdBy,
      billUrl = null,
    } = req.body || {};

    if (!category || amount === undefined || amount === null || !createdBy) {
      return res.status(400).json({
        success: false,
        message: "category, amount and createdBy are required",
      });
    }

    const parsedAmount = Number(amount);

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "amount must be greater than 0",
      });
    }

    const [result] = await connection.query(
      `
      INSERT INTO expenses (category, description, amount, bill_url, created_by, status)
      VALUES (?, ?, ?, ?, ?, 'PENDING')
      `,
      [category, description, parsedAmount, billUrl, createdBy]
    );

    return res.status(201).json({
      success: true,
      message: "Expense created successfully",
      data: {
        id: result.insertId,
        category,
        description,
        amount: parsedAmount,
        billUrl,
        status: "PENDING",
      },
    });
  } catch (error) {
    console.error("createExpense error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create expense",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getExpensesDashboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const offset = (page - 1) * limit;

    const search = (req.query.search || "").trim();
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;

    const filters = [];
    const params = [];

    if (search) {
      filters.push(`
        (
          CONCAT('E-', LPAD(e.id, 3, '0')) LIKE ?
          OR e.category LIKE ?
          OR e.description LIKE ?
          OR u.name LIKE ?
        )
      `);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (startDate) {
      filters.push(`e.created_at >= ?`);
      params.push(`${startDate} 00:00:00`);
    }

    if (endDate) {
      filters.push(`e.created_at <= ?`);
      params.push(`${endDate} 23:59:59`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const [summaryRows] = await connection.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN DATE(e.created_at) = CURDATE() THEN e.amount ELSE 0 END), 0) AS todaysExpenses,
        COALESCE(SUM(CASE WHEN YEAR(e.created_at) = YEAR(CURDATE()) AND MONTH(e.created_at) = MONTH(CURDATE()) THEN e.amount ELSE 0 END), 0) AS monthlyTotal,
        COALESCE(SUM(CASE WHEN e.status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pendingApproval
      FROM expenses e
      LEFT JOIN users u ON u.id = e.created_by
      ${whereClause}
      `,
      [...params]
    );

    const [countRows] = await connection.query(
      `
      SELECT COUNT(*) AS total
      FROM expenses e
      LEFT JOIN users u ON u.id = e.created_by
      ${whereClause}
      `,
      [...params]
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.ceil(total / limit);

    const [rows] = await connection.query(
      `
      SELECT
        e.id,
        CONCAT('E-', LPAD(e.id, 3, '0')) AS expenseCode,
        e.category,
        e.description,
        e.amount,
        DATE_FORMAT(e.created_at, '%Y-%m-%d') AS date,
        COALESCE(u.name, 'Unknown') AS createdBy,
        e.status
      FROM expenses e
      LEFT JOIN users u ON u.id = e.created_by
      ${whereClause}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ?
      OFFSET ?
      `,
      [...params, limit, offset]
    );

    return res.status(200).json({
      success: true,
      summary: {
        todaysExpenses: Number(summaryRows[0]?.todaysExpenses || 0),
        monthlyTotal: Number(summaryRows[0]?.monthlyTotal || 0),
        pendingApproval: Number(summaryRows[0]?.pendingApproval || 0),
      },
      data: rows.map((row) => ({
        id: row.expenseCode,
        category: row.category,
        description: row.description,
        amount: Number(row.amount || 0),
        date: row.date,
        by: row.createdBy,
        status: row.status,
      })),
      pagination: {
        total,
        page,
        limit,
        totalPages,
      },
    });
  } catch (error) {
    console.error("getExpensesDashboard error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch expenses dashboard",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};