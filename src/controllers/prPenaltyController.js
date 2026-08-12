import db from "../config/db.js";

const parseConsumerNumberToId = (consumerNumber = "") => {
  const digits = String(consumerNumber).replace(/\D/g, "");
  if (!digits) {
    return null;
  }
  return Number.parseInt(digits, 10);
};

const lookupCustomer = async (connection, { consumerNumber, customerName }) => {
  const consumerId = parseConsumerNumberToId(consumerNumber);

  if (consumerId) {
    const [rows] = await connection.query(
      `
      SELECT
        u.id,
        u.name,
        u.phone,
        u.consumer_number AS consumer_number
      FROM users u
      WHERE u.id = ? AND u.role = 'CUSTOMER'
      LIMIT 1
      `,
      [consumerId]
    );

    return rows[0] || null;
  }

  if (!String(customerName || "").trim()) {
    return null;
  }

  const [rows] = await connection.query(
    `
    SELECT
      u.id,
      u.name,
      u.phone,
      u.consumer_number AS consumer_number
    FROM users u
    WHERE u.role = 'CUSTOMER' AND u.name LIKE ?
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT 1
    `,
    [`%${String(customerName).trim()}%`]
  );

  return rows[0] || null;
};

export const lookupPenaltyCustomer = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const consumerNumber = String(req.query.consumerNumber || "").trim();
    const customerName = String(req.query.customerName || "").trim();

    if (!consumerNumber && !customerName) {
      return res.status(400).json({
        success: false,
        message: "consumerNumber or customerName is required",
      });
    }

    const customer = await lookupCustomer(connection, { consumerNumber, customerName });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: Number(customer.id),
        name: customer.name,
        phone: customer.phone,
        consumerNumber: customer.consumer_number,
      },
    });
  } catch (error) {
    console.error("lookupPenaltyCustomer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to lookup customer",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createCustomerPenalty = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { customerId, penaltyReason, penaltyAmount } = req.body || {};

    if (!customerId) {
      return res.status(400).json({
        success: false,
        message: "customerId is required",
      });
    }

    if (!String(penaltyReason || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "penaltyReason is required",
      });
    }

    const amount = Number(penaltyAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "penaltyAmount must be greater than 0",
      });
    }

    const [customerRows] = await connection.query(
      `
      SELECT
        id,
        name,
        consumer_number AS consumer_number
      FROM users
      WHERE id = ? AND role = 'CUSTOMER'
      LIMIT 1
      `,
      [Number(customerId)]
    );

    if (!customerRows.length) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    const customer = customerRows[0];

    const [result] = await connection.query(
      `
      INSERT INTO customer_pr_penalties (
        customer_id,
        consumer_number_snapshot,
        customer_name_snapshot,
        penalty_reason,
        penalty_amount,
        payment_status
      ) VALUES (?, ?, ?, ?, ?, 'UNPAID')
      `,
      [
        Number(customer.id),
        customer.consumer_number,
        customer.name,
        String(penaltyReason).trim(),
        Number(amount.toFixed(2)),
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Penalty recorded successfully",
      data: {
        id: Number(result.insertId),
        paymentStatus: "UNPAID",
      },
    });
  } catch (error) {
    console.error("createCustomerPenalty error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to record penalty",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getRecentCustomerPenalties = async (_req, res) => {
  const connection = await db.getConnection();

  try {
    const [rows] = await connection.query(
      `
      SELECT
        p.id,
        p.customer_id,
        p.consumer_number_snapshot AS consumer_number,
        p.customer_name_snapshot AS customer_name,
        p.penalty_reason,
        p.penalty_amount,
        p.payment_status,
        DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
      FROM customer_pr_penalties p
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 8
      `
    );

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("getRecentCustomerPenalties error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch penalties",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const markPenaltyAsPaid = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const penaltyId = Number(req.params.id);

    if (!penaltyId) {
      return res.status(400).json({
        success: false,
        message: "Valid penalty id is required",
      });
    }

    const [result] = await connection.query(
      `
      UPDATE customer_pr_penalties
      SET payment_status = 'PAID', paid_at = NOW()
      WHERE id = ? AND payment_status = 'UNPAID'
      `,
      [penaltyId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: "Unpaid penalty not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Penalty marked as paid",
    });
  } catch (error) {
    console.error("markPenaltyAsPaid error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update penalty",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
