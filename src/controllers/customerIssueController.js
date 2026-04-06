import db from "../config/db.js";

export const getCustomerIssuesDashboard = async (req, res) => {
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
          CONCAT('CI-', LPAD(i.id, 3, '0')) LIKE ?
          OR cu.name LIKE ?
          OR i.title LIKE ?
          OR au.name LIKE ?
        )
      `);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (startDate) {
      filters.push(`i.created_at >= ?`);
      params.push(`${startDate} 00:00:00`);
    }

    if (endDate) {
      filters.push(`i.created_at <= ?`);
      params.push(`${endDate} 23:59:59`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    // Summary cards
    const [summaryRows] = await connection.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN i.status = 'OPEN' THEN 1 ELSE 0 END), 0) AS openIssues,
        COALESCE(SUM(CASE WHEN i.status = 'IN_PROGRESS' THEN 1 ELSE 0 END), 0) AS inProgress,
        COALESCE(SUM(
          CASE
            WHEN i.status = 'RESOLVED'
             AND YEARWEEK(i.created_at, 1) = YEARWEEK(CURDATE(), 1)
            THEN 1 ELSE 0
          END
        ), 0) AS resolvedThisWeek
      FROM issues i
      INNER JOIN users cu ON cu.id = i.customer_id
      LEFT JOIN users au ON au.id = i.assigned_to
      ${whereClause}
      `,
      [...params]
    );

    // Count for pagination
    const [countRows] = await connection.query(
      `
      SELECT COUNT(*) AS total
      FROM issues i
      INNER JOIN users cu ON cu.id = i.customer_id
      LEFT JOIN users au ON au.id = i.assigned_to
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
        i.id,
        CONCAT('CI-', LPAD(i.id, 3, '0')) AS issueCode,
        cu.name AS customer,
        i.title AS issue,
        i.priority,
        DATE_FORMAT(i.created_at, '%Y-%m-%d') AS date,
        COALESCE(au.name, 'Unassigned') AS assignedTo,
        i.status
      FROM issues i
      INNER JOIN users cu ON cu.id = i.customer_id
      LEFT JOIN users au ON au.id = i.assigned_to
      ${whereClause}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT ?
      OFFSET ?
      `,
      [...params, limit, offset]
    );

    return res.status(200).json({
      success: true,
      summary: {
        openIssues: Number(summaryRows[0]?.openIssues || 0),
        inProgress: Number(summaryRows[0]?.inProgress || 0),
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