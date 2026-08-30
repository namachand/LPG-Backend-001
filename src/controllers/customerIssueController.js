import db from "../config/db.js";

let hasAssignedToColumnCache = false;

const ensureAssignedToColumn = async (connection) => {
  if (hasAssignedToColumnCache) return;

  const [columnRows] = await connection.query("SHOW COLUMNS FROM customer_complaints LIKE 'assigned_to'");
  if (!columnRows.length) {
    await connection.query("ALTER TABLE customer_complaints ADD COLUMN assigned_to INT NULL AFTER status");
  }

  hasAssignedToColumnCache = true;
};

export const getCustomerIssuesDashboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureAssignedToColumn(connection);

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const offset = (page - 1) * limit;

    const search = (req.query.search || "").trim();
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;

    const filters = ["cc.agency_id = ?"];
    const params = [req.user.agency_id];

    if (search) {
      filters.push(`
        (
          CONCAT('CMP-', LPAD(cc.id, 4, '0')) LIKE ?
          OR cu.name LIKE ?
          OR cc.issue_type LIKE ?
          OR cc.description LIKE ?
          OR au.name LIKE ?
        )
      `);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (startDate) {
      filters.push(`cc.created_at >= ?`);
      params.push(`${startDate} 00:00:00`);
    }

    if (endDate) {
      filters.push(`cc.created_at <= ?`);
      params.push(`${endDate} 23:59:59`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    // Summary cards
    const [summaryRows] = await connection.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN cc.status = 'OPEN' THEN 1 ELSE 0 END), 0) AS openIssues,
        COALESCE(SUM(CASE WHEN cc.status = 'RESOLVED' THEN 1 ELSE 0 END), 0) AS resolvedIssues,
        COALESCE(SUM(
          CASE
            WHEN cc.status = 'RESOLVED'
             AND YEARWEEK(COALESCE(cc.updated_at, cc.created_at), 1) = YEARWEEK(CURDATE(), 1)
            THEN 1 ELSE 0
          END
        ), 0) AS resolvedThisWeek
      FROM customer_complaints cc
      INNER JOIN users cu ON cu.id = cc.customer_id
      LEFT JOIN users au ON au.id = cc.assigned_to
      ${whereClause}
      `,
      [...params]
    );

    // Count for pagination
    const [countRows] = await connection.query(
      `
      SELECT COUNT(*) AS total
      FROM customer_complaints cc
      INNER JOIN users cu ON cu.id = cc.customer_id
      LEFT JOIN users au ON au.id = cc.assigned_to
      ${whereClause}
      `,
      [...params]
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.ceil(total / limit);

    // Table rows
    const [rows] = await connection.query(
      `
      SELECT
        cc.id,
        CONCAT('CMP-', LPAD(cc.id, 4, '0')) AS issueCode,
        cu.name AS customer,
        COALESCE(cc.description, cc.issue_type) AS issue,
        COALESCE(cc.priority, 'MEDIUM') AS priority,
        DATE_FORMAT(cc.created_at, '%Y-%m-%d') AS date,
        COALESCE(au.name, 'Unassigned') AS assignedTo,
        cc.status
      FROM customer_complaints cc
      INNER JOIN users cu ON cu.id = cc.customer_id
      LEFT JOIN users au ON au.id = cc.assigned_to
      ${whereClause}
      ORDER BY cc.created_at DESC, cc.id DESC
      LIMIT ?
      OFFSET ?
      `,
      [...params, limit, offset]
    );

    return res.status(200).json({
      success: true,
      summary: {
        openIssues: Number(summaryRows[0]?.openIssues || 0),
        resolvedIssues: Number(summaryRows[0]?.resolvedIssues || 0),
        resolvedThisWeek: Number(summaryRows[0]?.resolvedThisWeek || 0),
      },
      data: rows.map((row) => ({
        id: row.issueCode,
        customer: row.customer,
        issue: row.issue,
        priority: row.priority,
        date: row.date,
        assignedTo: row.assignedTo,
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
    console.error("getCustomerIssuesDashboard error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customer issues dashboard",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};