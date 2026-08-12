import db from "../config/db.js";

const normalizeRequestStatus = (value) => {
  const text = String(value || "PENDING").toUpperCase();

  if (text === "PENDING_MANAGER") return "Pending Manager";
  if (text === "PENDING_PAYMENT") return "Pending Payment";
  if (text === "OPEN") return "Pending";

  return text.replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());
};

export const searchCustomersDashboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const search = String(req.query.search || "").trim();

    const params = [];
    let whereClause = "WHERE u.role = 'CUSTOMER'";

    if (search) {
      const digits = search.replace(/\D/g, "");
      whereClause += `
        AND (
          u.name LIKE ?
          OR u.phone LIKE ?
          OR u.consumer_number LIKE ?
          ${digits ? "OR u.id = ?" : ""}
        )
      `;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      if (digits) params.push(Number(digits));
    }

    const [rows] = await connection.query(
      `
      SELECT
        u.id,
        u.name,
        u.phone,
        u.consumer_number AS consumer_number
      FROM users u
      ${whereClause}
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT 50
      `,
      params
    );

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("searchCustomersDashboard error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customers",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getCustomerDashboardDetails = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const customerId = Number(req.params.id);

    if (!customerId) {
      return res.status(400).json({
        success: false,
        message: "Valid customer id is required",
      });
    }

    const [customerRows] = await connection.query(
      `
      SELECT
        u.id,
        u.name,
        u.phone,
        u.consumer_number AS consumer_number,
        COALESCE(a.address, '') AS address
      FROM users u
      LEFT JOIN addresses a ON a.user_id = u.id AND a.is_default = 1
      WHERE u.id = ? AND u.role = 'CUSTOMER'
      LIMIT 1
      `,
      [customerId]
    );

    if (!customerRows.length) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    const [complaintRows] = await connection.query(
      `
      SELECT
        id,
        issue_type,
        description,
        status,
        created_at
      FROM customer_complaints
      WHERE customer_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 20
      `,
      [customerId]
    );

    const [transferRows] = await connection.query(
      `
      SELECT
        t.id,
        t.status,
        t.reason,
        t.created_at,
        COALESCE(cta.agency_name, new_u.name) AS transfer_to_name
      FROM customer_connection_transfers t
      LEFT JOIN users new_u ON new_u.id = t.new_customer_id
      LEFT JOIN customer_transfer_agencies cta ON cta.transfer_id = t.id
      WHERE t.existing_customer_id = ?
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 10
      `,
      [customerId]
    );

    const [nameChangeRows] = await connection.query(
      `
      SELECT
        id,
        status,
        new_name_requested,
        created_at
      FROM customer_name_change_requests
      WHERE customer_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 10
      `,
      [customerId]
    );

    const [connectionRows] = await connection.query(
      `
      SELECT
        id,
        payment_status,
        product_details,
        created_at
      FROM customer_new_connections
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 10
      `,
      [customerId]
    );

    const [penaltyRows] = await connection.query(
      `
      SELECT
        id,
        penalty_reason,
        penalty_amount,
        payment_status,
        created_at
      FROM customer_pr_penalties
      WHERE customer_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 20
      `,
      [customerId]
    );

    const requestHistory = [
      ...transferRows.map((item) => ({
        id: `TR-${item.id}`,
        title: `Transfer - ${item.transfer_to_name || "Customer"}`,
        description: item.reason || "Transfer request",
        status: normalizeRequestStatus(item.status),
        createdAt: item.created_at,
      })),
      ...nameChangeRows.map((item) => ({
        id: `NC-${item.id}`,
        title: `Name Change - ${item.new_name_requested || "Request"}`,
        description: "Name change request",
        status: normalizeRequestStatus(item.status),
        createdAt: item.created_at,
      })),
      ...connectionRows.map((item) => ({
        id: `CN-${item.id}`,
        title: `New Connection - ${item.product_details || "LPG"}`,
        description: "Connection request",
        status: normalizeRequestStatus(item.payment_status),
        createdAt: item.created_at,
      })),
    ]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 20);

    return res.status(200).json({
      success: true,
      data: {
        profile: customerRows[0],
        complaintHistory: complaintRows.map((item) => ({
          id: item.id,
          issueType: String(item.issue_type || "").replaceAll("_", " "),
          description: item.description,
          status: normalizeRequestStatus(item.status),
          createdAt: item.created_at,
        })),
        requestHistory,
        paymentStatus: penaltyRows.map((item) => ({
          id: item.id,
          reason: item.penalty_reason,
          amount: Number(item.penalty_amount || 0),
          status: normalizeRequestStatus(item.payment_status),
          createdAt: item.created_at,
        })),
      },
    });
  } catch (error) {
    console.error("getCustomerDashboardDetails error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customer dashboard details",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
