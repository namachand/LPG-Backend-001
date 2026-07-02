import db from "../config/db.js";

export const getIocOtpSummary = async (_req, res) => {
  const connection = await db.getConnection();

  try {
    const [rows] = await connection.query(`
      SELECT
        COUNT(CASE WHEN DATE(dso.created_at) = CURDATE() THEN 1 END) AS today_received,
        COUNT(CASE WHEN DATE(dso.created_at) = CURDATE() AND dso.status = 'PENDING' THEN 1 END) AS today_pending,
        COUNT(CASE WHEN DATE(dso.created_at) = CURDATE() AND dso.status = 'SENT' THEN 1 END) AS today_sent,
        COUNT(CASE WHEN dso.status = 'PENDING' THEN 1 END) AS all_pending
      FROM driver_sale_otps dso
    `);

    const summary = rows[0] || {};

    return res.status(200).json({
      success: true,
      data: {
        todayReceived: Number(summary.today_received || 0),
        todayPending: Number(summary.today_pending || 0),
        todaySent: Number(summary.today_sent || 0),
        allPending: Number(summary.all_pending || 0),
      },
    });
  } catch (error) {
    console.error("getIocOtpSummary error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch OTP summary",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const listIocOtps = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const status = String(req.query.status || "").trim().toUpperCase();
    const date = String(req.query.date || "").trim();
    const driverId = Number(req.query.driverId) || null;

    const filters = [];
    const params = [];

    if (status && status !== "ALL") {
      filters.push("dso.status = ?");
      params.push(status);
    }

    if (date) {
      filters.push("DATE(dso.created_at) = ?");
      params.push(date);
    }

    if (driverId) {
      filters.push("s.driver_id = ?");
      params.push(driverId);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const [rows] = await connection.query(
      `
      SELECT
        dso.id,
        dso.sale_id,
        dso.otp,
        dso.status,
        DATE_FORMAT(dso.created_at, '%d/%m/%Y, %H:%i:%s') AS created_at_formatted,
        cu.name AS customer_name,
        cu.phone AS customer_phone,
        CONCAT('LPG-', LPAD(cu.id, 5, '0')) AS consumer_number,
        s.driver_id,
        du.name AS driver_name
      FROM driver_sale_otps dso
      INNER JOIN sales s ON s.id = dso.sale_id
      LEFT JOIN users cu ON cu.id = s.customer_id
      LEFT JOIN drivers d ON d.id = s.driver_id
      LEFT JOIN users du ON du.id = d.user_id
      ${whereClause}
      ORDER BY dso.created_at DESC
      LIMIT 100
      `,
      params
    );

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("listIocOtps error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch IOC OTPs",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const markIocOtpSent = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const otpId = Number(req.params.id);

    if (!otpId) {
      return res.status(400).json({
        success: false,
        message: "Valid OTP id is required",
      });
    }

    const [result] = await connection.query(
      "UPDATE driver_sale_otps SET status = 'SENT' WHERE id = ? AND status = 'PENDING'",
      [otpId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: "Pending OTP not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP marked as sent to IOC",
    });
  } catch (error) {
    console.error("markIocOtpSent error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update OTP status",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const addIocOtp = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const saleId = Number(req.body?.saleId);
    const otp = String(req.body?.otp || "").trim();

    if (!saleId) {
      return res.status(400).json({ success: false, message: "saleId is required" });
    }

    if (!otp) {
      return res.status(400).json({ success: false, message: "otp is required" });
    }

    const [saleRows] = await connection.query(
      "SELECT id FROM sales WHERE id = ? LIMIT 1",
      [saleId]
    );

    if (!saleRows.length) {
      return res.status(404).json({ success: false, message: "Sale not found" });
    }

    const [result] = await connection.query(
      "INSERT INTO driver_sale_otps (sale_id, otp, status) VALUES (?, ?, 'PENDING')",
      [saleId, otp]
    );

    return res.status(201).json({
      success: true,
      message: "OTP added successfully",
      data: { id: Number(result.insertId) },
    });
  } catch (error) {
    console.error("addIocOtp error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to add OTP",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
