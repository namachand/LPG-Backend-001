import db from "../config/db.js";

export const getCashSettlementDashboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const offset = (page - 1) * limit;

    const search = (req.query.search || "").trim();
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;

    const agencyId = req.user.agency_id;

    const driverFilters = [`d.agency_id = ?`];
    const driverParams = [agencyId];

    if (search) {
      driverFilters.push(`u.name LIKE ?`);
      driverParams.push(`%${search}%`);
    }

    const driverWhereClause = driverFilters.length
      ? `WHERE ${driverFilters.join(" AND ")}`
      : "";

    const paymentDateFilters = [];
    const paymentDateParams = [];

    if (startDate) {
      paymentDateFilters.push(`p.created_at >= ?`);
      paymentDateParams.push(`${startDate} 00:00:00`);
    }

    if (endDate) {
      paymentDateFilters.push(`p.created_at <= ?`);
      paymentDateParams.push(`${endDate} 23:59:59`);
    }

    const paymentDateWhereClause = paymentDateFilters.length
      ? `AND ${paymentDateFilters.join(" AND ")}`
      : "";

    const settlementDateFilters = [];
    const settlementDateParams = [];

    if (startDate) {
      settlementDateFilters.push(`s.settlement_date >= ?`);
      settlementDateParams.push(startDate);
    }

    if (endDate) {
      settlementDateFilters.push(`s.settlement_date <= ?`);
      settlementDateParams.push(endDate);
    }

    const settlementDateWhereClause = settlementDateFilters.length
      ? `AND ${settlementDateFilters.join(" AND ")}`
      : "";

    const [summaryRows] = await connection.query(
      `
      SELECT
        COALESCE(SUM(x.collected), 0) AS totalCollected,
        COALESCE(SUM(x.settled), 0) AS settledToday,
        COALESCE(SUM(x.collected - x.settled), 0) AS totalPending
      FROM (
        SELECT
          d.id AS driver_id,
          COALESCE(pay.collected, 0) AS collected,
          COALESCE(sett.settled, 0) AS settled
        FROM drivers d
        LEFT JOIN (
          SELECT
            sa.driver_id,
            SUM(p.amount) AS collected
          FROM payments p
          INNER JOIN sales sa ON sa.id = p.sale_id
          WHERE sa.status = 'DELIVERED'
            AND p.status = 'SUCCESS'
            AND (sa.payment_method != 'ONLINE' OR sa.payment_method IS NULL)
            AND p.method IN ('CASH', 'UPI')
            AND sa.agency_id = ?
            ${paymentDateWhereClause}
          GROUP BY sa.driver_id
        ) pay ON pay.driver_id = d.id
        LEFT JOIN (
          SELECT
            s.driver_id,
            SUM(s.amount) AS settled
          FROM settlements s
          WHERE s.agency_id = ?
            ${settlementDateWhereClause}
          GROUP BY s.driver_id
        ) sett ON sett.driver_id = d.id
      ) x
      `,
      [agencyId, ...paymentDateParams, agencyId, ...settlementDateParams]
    );

    const [countRows] = await connection.query(
      `
      SELECT COUNT(*) AS total
      FROM drivers d
      INNER JOIN users u ON u.id = d.user_id
      ${driverWhereClause}
      `,
      [...driverParams]
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.ceil(total / limit);

    const [rows] = await connection.query(
      `
      SELECT
        d.id AS driver_id,
        u.name AS driverName,
        COALESCE(pay.collected, 0) AS collected,
        COALESCE(sett.settled, 0) AS settled,
        COALESCE(pay.collected, 0) - COALESCE(sett.settled, 0) AS pending,
        sett.lastSettlementDate AS settlementDate,
        CASE
          WHEN COALESCE(pay.collected, 0) = 0 THEN 'NO_ACTIVITY'
          WHEN COALESCE(pay.collected, 0) - COALESCE(sett.settled, 0) = 0 THEN 'SETTLED'
          WHEN COALESCE(sett.settled, 0) > 0 THEN 'PARTIAL'
          ELSE 'PENDING'
        END AS status
      FROM drivers d
      INNER JOIN users u ON u.id = d.user_id

      LEFT JOIN (
        SELECT
          sa.driver_id,
          SUM(p.amount) AS collected
        FROM payments p
        INNER JOIN sales sa ON sa.id = p.sale_id
        WHERE sa.status = 'DELIVERED'
          AND p.status = 'SUCCESS'
          AND (sa.payment_method != 'ONLINE' OR sa.payment_method IS NULL)
          AND p.method IN ('CASH', 'UPI')
          AND sa.agency_id = ?
          ${paymentDateWhereClause}
        GROUP BY sa.driver_id
      ) pay ON pay.driver_id = d.id

      LEFT JOIN (
        SELECT
          s.driver_id,
          SUM(s.amount) AS settled,
          MAX(s.settlement_date) AS lastSettlementDate
        FROM settlements s
        WHERE s.agency_id = ?
          ${settlementDateWhereClause}
        GROUP BY s.driver_id
      ) sett ON sett.driver_id = d.id

      ${driverWhereClause}
      ORDER BY u.name ASC
      LIMIT ?
      OFFSET ?
      `,
      [
        agencyId,
        ...paymentDateParams,
        agencyId,
        ...settlementDateParams,
        ...driverParams,
        limit,
        offset,
      ]
    );

    return res.status(200).json({
      success: true,
      summary: {
        totalPending: Number(summaryRows[0]?.totalPending || 0),
        settledToday: Number(summaryRows[0]?.settledToday || 0),
        totalCollected: Number(summaryRows[0]?.totalCollected || 0),
      },
      data: rows.map((row) => ({
        driver_id: row.driver_id,
        driverName: row.driverName,
        collected: Number(row.collected || 0),
        settled: Number(row.settled || 0),
        pending: Number(row.pending || 0),
        date: row.settlementDate,
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
    console.error("getCashSettlementDashboard error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cash settlement dashboard",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const upsertSettlement = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driver_id, amount, status, settlement_date } = req.body;

    if (!driver_id || !amount || !status || !settlement_date) {
      return res.status(400).json({
        success: false,
        message: "driver_id, amount, status and settlement_date are required",
      });
    }

    const agencyId = req.user.agency_id;

    await connection.query(
      `
      INSERT INTO settlements (
        driver_id,
        amount,
        status,
        settlement_date,
        agency_id
      )
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        amount = VALUES(amount),
        status = VALUES(status)
      `,
      [driver_id, amount, status, settlement_date, agencyId]
    );

    return res.status(200).json({
      success: true,
      message: "Settlement saved successfully",
    });
  } catch (error) {
    console.error("upsertSettlement error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to save settlement",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};