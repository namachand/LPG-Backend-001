import db from "../config/db.js";

const toTitleCase = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());

const normalizeComplaintStatus = (status) => {
  const text = String(status || "PENDING").toUpperCase();

  if (text === "OPEN") return "Pending";
  return toTitleCase(text.replaceAll("_", " "));
};

const normalizeIssueType = (issueType) => {
  const text = String(issueType || "OTHER").toUpperCase();

  if (text === "LEAKAGE") return "Leakage";
  if (text === "CYLINDER_NOT_RECEIVED") return "Cylinder";
  if (text === "BOOKING_DELAY") return "Booking";
  if (text === "METER_ISSUE") return "Meter";

  return toTitleCase(text.replaceAll("_", " "));
};

export const getDashboardOverview = async (req, res) => {
  const connection = await db.getConnection();
  const agencyId = req.user.agency_id;

  try {
    const [pendingComplaintsRows] = await connection.query(
      `
      SELECT COUNT(*) AS count
      FROM customer_complaints
      WHERE agency_id = ?
        AND UPPER(COALESCE(status, 'PENDING')) IN ('OPEN', 'PENDING', 'ASSIGNED', 'IN_PROGRESS')
      `,
      [agencyId]
    );

    const [leakageComplaintsRows] = await connection.query(
      `
      SELECT COUNT(*) AS count
      FROM customer_complaints
      WHERE agency_id = ?
        AND UPPER(COALESCE(issue_type, '')) = 'LEAKAGE'
        AND UPPER(COALESCE(status, 'PENDING')) IN ('OPEN', 'PENDING', 'ASSIGNED', 'IN_PROGRESS')
      `,
      [agencyId]
    );

    const [totalConnectionsRows] = await connection.query(
      `
      SELECT COUNT(*) AS count
      FROM users
      WHERE agency_id = ?
        AND UPPER(COALESCE(role, '')) = 'CUSTOMER'
      `,
      [agencyId]
    );

    const [transferRequestsRows] = await connection.query(
      `
      SELECT COUNT(*) AS count
      FROM customer_connection_transfers
      WHERE agency_id = ?
        AND UPPER(COALESCE(status, 'PENDING_MANAGER')) IN ('PENDING_MANAGER', 'PENDING')
      `,
      [agencyId]
    );

    const [nameChangeRequestsRows] = await connection.query(
      `
      SELECT COUNT(*) AS count
      FROM customer_name_change_requests
      WHERE agency_id = ?
        AND UPPER(COALESCE(status, 'PENDING')) = 'PENDING'
      `,
      [agencyId]
    );

    const [pendingManagerVerificationRows] = await connection.query(
      `
      SELECT COUNT(*) AS count
      FROM customer_connection_transfers
      WHERE agency_id = ?
        AND UPPER(COALESCE(status, 'PENDING_MANAGER')) = 'PENDING_MANAGER'
      `,
      [agencyId]
    );

    const [recentComplaintRows] = await connection.query(
      `
      SELECT
        cc.id,
        u.name AS customer_name,
        u.consumer_number AS consumer_number,
        cc.issue_type,
        cc.description,
        cc.status,
        DATE_FORMAT(cc.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
      FROM customer_complaints cc
      INNER JOIN users u ON u.id = cc.customer_id
      WHERE cc.agency_id = ?
      ORDER BY cc.created_at DESC, cc.id DESC
      LIMIT 8
      `,
      [agencyId]
    );

    return res.status(200).json({
      success: true,
      data: {
        cards: {
          pendingComplaints: Number(pendingComplaintsRows[0]?.count || 0),
          leakageComplaints: Number(leakageComplaintsRows[0]?.count || 0),
          totalConnections: Number(totalConnectionsRows[0]?.count || 0),
          transferRequests: Number(transferRequestsRows[0]?.count || 0),
          nameChangeRequests: Number(nameChangeRequestsRows[0]?.count || 0),
          pendingManagerVerification: Number(pendingManagerVerificationRows[0]?.count || 0),
        },
        recentComplaints: recentComplaintRows.map((row) => ({
          id: row.id,
          customerName: row.customer_name,
          consumerNumber: row.consumer_number,
          issueType: normalizeIssueType(row.issue_type),
          description: row.description,
          status: normalizeComplaintStatus(row.status),
          createdAt: row.created_at,
        })),
      },
    });
  } catch (error) {
    console.error("getDashboardOverview error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard overview",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

