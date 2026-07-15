import db from "../config/db.js";

const parseConsumerNumberToId = (consumerNumber = "") => {
  const digits = String(consumerNumber).replace(/\D/g, "");
  if (!digits) {
    return null;
  }
  return Number.parseInt(digits, 10);
};

const getCustomerByLookup = async (connection, { consumerNumber, existingName }) => {
  const consumerId = parseConsumerNumberToId(consumerNumber);

  if (consumerId) {
    const [rows] = await connection.query(
      `
      SELECT
        u.id,
        u.name,
        u.phone,
        CONCAT('LPG-', LPAD(u.id, 5, '0')) AS consumer_number,
        COALESCE(a.address, '') AS address
      FROM users u
      LEFT JOIN addresses a ON a.user_id = u.id AND a.is_default = 1
      WHERE u.id = ? AND u.role = 'CUSTOMER'
      LIMIT 1
      `,
      [consumerId]
    );

    return rows[0] || null;
  }

  if (!String(existingName || "").trim()) {
    return null;
  }

  const [rows] = await connection.query(
    `
    SELECT
      u.id,
      u.name,
      u.phone,
      CONCAT('LPG-', LPAD(u.id, 5, '0')) AS consumer_number,
      COALESCE(a.address, '') AS address
    FROM users u
    LEFT JOIN addresses a ON a.user_id = u.id AND a.is_default = 1
    WHERE u.role = 'CUSTOMER' AND u.name LIKE ?
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT 1
    `,
    [`%${String(existingName).trim()}%`]
  );

  return rows[0] || null;
};

const getExistingCustomerSnapshot = async (connection, existingCustomerId) => {
  const [latestConnectionRows] = await connection.query(
    `
    SELECT
      product_details,
      deposit_amount
    FROM customer_new_connections
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [existingCustomerId]
  );

  if (latestConnectionRows.length) {
    const row = latestConnectionRows[0];
    return {
      productDetails: row.product_details || "14.2kg Domestic",
      depositLiability: Number(row.deposit_amount || 0),
    };
  }

  const [salesRows] = await connection.query(
    `
    SELECT
      p.name,
      SUM(si.quantity) AS quantity
    FROM sales s
    INNER JOIN sales_items si ON si.sale_id = s.id
    INNER JOIN products p ON p.id = si.product_id
    WHERE s.customer_id = ?
    GROUP BY p.id, p.name
    ORDER BY p.name ASC
    `,
    [existingCustomerId]
  );

  if (!salesRows.length) {
    return {
      productDetails: "No product history available",
      depositLiability: 0,
    };
  }

  const productDetails = salesRows
    .map((row) => `${row.name} x${Number(row.quantity || 0)}`)
    .join(", ");

  return {
    productDetails,
    depositLiability: 0,
  };
};

const parseAmount = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }
  return Number(amount.toFixed(2));
};

const ensureRegulatorReceivedColumn = async (connection) => {
  const [rows] = await connection.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'customer_connection_transfers'
      AND COLUMN_NAME = 'is_regulator_received'
    `
  );

  if (rows.length) {
    return;
  }

  try {
    await connection.query(
      "ALTER TABLE customer_connection_transfers ADD COLUMN is_regulator_received TINYINT(1) NOT NULL DEFAULT 0 AFTER reason"
    );
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") {
      throw error;
    }
  }
};

export const lookupTransferCustomer = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const consumerNumber = String(req.query.consumerNumber || "").trim();
    const existingName = String(req.query.existingName || "").trim();

    if (!consumerNumber && !existingName) {
      return res.status(400).json({
        success: false,
        message: "consumerNumber or existingName is required",
      });
    }

    const customer = await getCustomerByLookup(connection, { consumerNumber, existingName });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Existing customer not found",
      });
    }

    const snapshot = await getExistingCustomerSnapshot(connection, Number(customer.id));

    return res.status(200).json({
      success: true,
      data: {
        id: Number(customer.id),
        name: customer.name,
        phone: customer.phone,
        consumerNumber: customer.consumer_number,
        address: customer.address,
        productDetails: snapshot.productDetails,
        depositLiability: snapshot.depositLiability,
      },
    });
  } catch (error) {
    console.error("lookupTransferCustomer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to lookup customer",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createCustomerTransfer = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      existingCustomerId,
      newCustomerName,
      newCustomerPhone,
      newCustomerAddress,
      reason,
      depositLiability,
      isRegulatorReceived,
      emptyProductId,
      emptyCylinderQty,
    } = req.body || {};

    const regulatorReceivedValue = Number(isRegulatorReceived) === 1 || isRegulatorReceived === true ? 1 : 0;

    // Optional empty-cylinder return received during the transfer. When provided,
    // a pending EMPTY_RETURN request is raised for the godown manager to approve.
    let parsedEmptyProductId = Number(emptyProductId) || null;
    let parsedEmptyQty = Number(emptyCylinderQty) || 0;
    if (!parsedEmptyProductId || parsedEmptyQty <= 0) {
      parsedEmptyProductId = null;
      parsedEmptyQty = 0;
    }

    if (!existingCustomerId) {
      return res.status(400).json({
        success: false,
        message: "existingCustomerId is required",
      });
    }

    if (!String(newCustomerName || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "newCustomerName is required",
      });
    }

    if (!String(newCustomerPhone || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "newCustomerPhone is required",
      });
    }

    if (!String(newCustomerAddress || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "newCustomerAddress is required",
      });
    }

    if (!String(reason || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "reason is required",
      });
    }

    const parsedDepositLiability = parseAmount(depositLiability);

    if (parsedDepositLiability === null) {
      return res.status(400).json({
        success: false,
        message: "depositLiability must be a valid amount",
      });
    }

    const [existingCustomerRows] = await connection.query(
      "SELECT id, name FROM users WHERE id = ? AND role = 'CUSTOMER' LIMIT 1",
      [Number(existingCustomerId)]
    );

    if (!existingCustomerRows.length) {
      return res.status(404).json({
        success: false,
        message: "Existing customer not found",
      });
    }

    const [phoneRows] = await connection.query(
      "SELECT id FROM users WHERE phone = ? LIMIT 1",
      [String(newCustomerPhone).trim()]
    );

    if (phoneRows.length) {
      return res.status(409).json({
        success: false,
        message: "A user with this new customer phone already exists",
      });
    }

    if (parsedEmptyProductId) {
      const [emptyProductRows] = await connection.query(
        "SELECT id FROM products WHERE id = ? LIMIT 1",
        [parsedEmptyProductId]
      );

      if (!emptyProductRows.length) {
        return res.status(404).json({
          success: false,
          message: "Selected empty cylinder product not found",
        });
      }
    }

    const snapshot = await getExistingCustomerSnapshot(connection, Number(existingCustomerId));

    await ensureRegulatorReceivedColumn(connection);

    await connection.beginTransaction();

    const [newUserResult] = await connection.query(
      `
      INSERT INTO users (name, phone, role, status)
      VALUES (?, ?, 'CUSTOMER', 'ACTIVE')
      `,
      [String(newCustomerName).trim(), String(newCustomerPhone).trim()]
    );

    const newCustomerId = Number(newUserResult.insertId);

    await connection.query(
      `
      INSERT INTO addresses (user_id, address, is_default)
      VALUES (?, ?, 1)
      `,
      [newCustomerId, String(newCustomerAddress).trim()]
    );

    const [transferResult] = await connection.query(
      `
      INSERT INTO customer_connection_transfers (
        existing_customer_id,
        new_customer_id,
        product_details_snapshot,
        deposit_liability,
        reason,
        is_regulator_received,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING_MANAGER')
      `,
      [
        Number(existingCustomerId),
        newCustomerId,
        snapshot.productDetails,
        parsedDepositLiability,
        String(reason).trim(),
        regulatorReceivedValue,
      ]
    );

    const transferId = Number(transferResult.insertId);

    // Raise a pending empty-cylinder return request to the godown manager,
    // mirroring the driver flow. No driver is involved, so driver_id is NULL and
    // reference_id points at this transfer; the manager approves it from the
    // Returns screen, which adds the empties into godown stock.
    if (parsedEmptyProductId && parsedEmptyQty > 0) {
      await connection.query(
        `
        INSERT INTO stock_transactions
          (product_id, stock_area_id, type, quantity, isApproved, reference_id, created_by, driver_id, stock_from, is_defective)
        VALUES (?, NULL, 'EMPTY_RETURN', ?, 0, ?, NULL, NULL, 'default', 0)
        `,
        [parsedEmptyProductId, parsedEmptyQty, transferId]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Transfer request sent to manager and cashier",
      data: {
        id: Number(transferResult.insertId),
        existingCustomerId: Number(existingCustomerId),
        newCustomerId,
        newConsumerNumber: `LPG-${String(newCustomerId).padStart(5, "0")}`,
        isRegulatorReceived: regulatorReceivedValue,
        status: "PENDING_MANAGER",
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createCustomerTransfer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create transfer request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getRecentCustomerTransfers = async (_req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureRegulatorReceivedColumn(connection);

    const [rows] = await connection.query(
      `
      SELECT
        t.id,
        t.existing_customer_id,
        t.new_customer_id,
        old_user.name AS existing_customer_name,
        new_user.name AS new_customer_name,
        t.product_details_snapshot,
        t.deposit_liability,
        t.reason,
        t.is_regulator_received,
        t.status,
        DATE_FORMAT(t.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
      FROM customer_connection_transfers t
      INNER JOIN users old_user ON old_user.id = t.existing_customer_id
      INNER JOIN users new_user ON new_user.id = t.new_customer_id
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 8
      `
    );

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("getRecentCustomerTransfers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch recent transfers",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
