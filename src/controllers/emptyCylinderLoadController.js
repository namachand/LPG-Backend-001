import db from "../config/db.js";

const DEFAULT_STOCK_AREA_ID = 1;

const LOAD_STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  COMPLETED: "COMPLETED",
};

// Stock-transaction approval markers, matching the convention used across the
// godown stock-out flow (0 = pending/reserved, 1 = approved/finalized,
// 2 = cancelled/voided).
const TXN_PENDING = 0;
const TXN_APPROVED = 1;
const TXN_VOID = 2;

// --- Small stock helpers (replicated from godownController's private helpers so
// this parallel flow does not have to modify the existing controller). ---

const getAvailableEmptyForUpdate = async (connection, productId) => {
  const [rows] = await connection.execute(
    `
    SELECT COALESCE(SUM(empty_quantity), 0) AS total
    FROM stock
    WHERE product_id = ?
    FOR UPDATE
    `,
    [Number(productId)]
  );

  return Number(rows[0]?.total || 0);
};

// Reserve (deduct) empty cylinders from the godown's available empty stock.
const consumeEmptyStock = async (connection, productId, requiredQty) => {
  let remaining = Number(requiredQty || 0);

  if (remaining <= 0) {
    return;
  }

  const [rows] = await connection.execute(
    `
    SELECT id, COALESCE(empty_quantity, 0) AS metric_qty
    FROM stock
    WHERE product_id = ?
    ORDER BY (stock_area_id = ?) DESC, id ASC
    FOR UPDATE
    `,
    [Number(productId), DEFAULT_STOCK_AREA_ID]
  );

  for (const row of rows) {
    if (remaining <= 0) {
      break;
    }

    const currentQty = Number(row.metric_qty || 0);

    if (currentQty <= 0) {
      continue;
    }

    const deductQty = Math.min(currentQty, remaining);

    await connection.execute(
      `
      UPDATE stock
      SET empty_quantity = GREATEST(COALESCE(empty_quantity, 0) - ?, 0),
          updated_at = NOW()
      WHERE id = ?
      `,
      [deductQty, row.id]
    );

    remaining -= deductQty;
  }
};

// Restore empty cylinders back into godown empty stock (used when a load is
// rejected). Mirrors the add-back path in godownController.
const restoreEmptyStock = async (connection, productId, qty) => {
  const quantity = Number(qty || 0);

  if (!quantity || quantity <= 0) {
    return;
  }

  const [rows] = await connection.execute(
    `
    SELECT id
    FROM stock
    WHERE product_id = ?
    ORDER BY (stock_area_id = ?) DESC, id ASC
    LIMIT 1
    FOR UPDATE
    `,
    [Number(productId), DEFAULT_STOCK_AREA_ID]
  );

  if (rows.length) {
    await connection.execute(
      `
      UPDATE stock
      SET empty_quantity = COALESCE(empty_quantity, 0) + ?,
          updated_at = NOW()
      WHERE id = ?
      `,
      [quantity, rows[0].id]
    );
    return;
  }

  await connection.execute(
    `
    INSERT INTO stock (product_id, stock_area_id, quantity, empty_quantity, defective_quantity)
    VALUES (?, NULL, 0, ?, 0)
    `,
    [Number(productId), quantity]
  );
};

// Ensures the tables backing the empty-cylinder-load flow exist. Follows the
// same CREATE TABLE IF NOT EXISTS convention used elsewhere in the codebase.
// Exported because the purchase-trip flow reads these tables too and cannot
// assume a godown dispatch has already created them.
export const ensureEmptyCylinderLoadTables = async (connection) => {
  await connection.execute(
    `
    CREATE TABLE IF NOT EXISTS empty_cylinder_loads (
      id BIGINT NOT NULL AUTO_INCREMENT,
      assigned_by INT NULL,
      purchase_manager_id INT NOT NULL,
      vehicle_number VARCHAR(50) NULL,
      erv_number VARCHAR(50) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      reject_reason VARCHAR(255) NULL,
      invoice_url VARCHAR(512) NULL,
      dispatched_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      accepted_at TIMESTAMP NULL,
      completed_at TIMESTAMP NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ecl_purchase_manager (purchase_manager_id),
      KEY idx_ecl_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `
  );

  await connection.execute(
    `
    CREATE TABLE IF NOT EXISTS empty_cylinder_load_items (
      id BIGINT NOT NULL AUTO_INCREMENT,
      load_id BIGINT NOT NULL,
      product_id INT NOT NULL,
      category VARCHAR(20) NULL,
      quantity INT NOT NULL,
      stock_transaction_id BIGINT NULL,
      PRIMARY KEY (id),
      KEY idx_ecli_load_id (load_id),
      KEY idx_ecli_product_id (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `
  );

  // Defensive: if the loads table was created by an earlier build without the
  // erv_number column, add it. MySQL has no ADD COLUMN IF NOT EXISTS, so ignore
  // the duplicate-column error.
  try {
    await connection.execute(
      `ALTER TABLE empty_cylinder_loads ADD COLUMN erv_number VARCHAR(50) NULL AFTER vehicle_number`
    );
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") {
      throw error;
    }
  }
};

// GET /purchase-managers — assignee list for the godown dispatch screen.
export const getPurchaseManagers = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
      SELECT id, name, phone
      FROM users
      WHERE role = 'PURCHASE_MANAGER'
      ORDER BY name ASC
      `
    );

    return res.json({
      success: true,
      data: rows.map((row) => ({
        id: Number(row.id),
        name: row.name || "Purchase Manager",
        phone: row.phone || "",
      })),
    });
  } catch (error) {
    console.error("getPurchaseManagers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase managers",
    });
  }
};

// POST / — godown creates an empty-cylinder dispatch assigned to a purchase
// manager. Reserves the empties from godown empty stock immediately (pending)
// so they cannot be dispatched twice; the removal is finalized only on accept.
export const createEmptyCylinderLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      assigned_by = null,
      purchase_manager_id,
      vehicle_number = null,
      erv_number = null,
      items = [],
    } = req.body || {};

    const numericPmId = Number(purchase_manager_id);

    if (!numericPmId || Number.isNaN(numericPmId)) {
      return res.status(400).json({
        success: false,
        message: "purchase_manager_id is required",
      });
    }

    const validItems = (Array.isArray(items) ? items : [])
      .map((item) => ({
        product_id: Number(item.product_id),
        quantity: Number(item.quantity || 0),
      }))
      .filter((item) => item.product_id && item.quantity > 0);

    if (!validItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one empty cylinder quantity is required",
      });
    }

    await connection.beginTransaction();

    await ensureEmptyCylinderLoadTables(connection);

    // Confirm the assignee is actually a purchase manager.
    const [pmRows] = await connection.execute(
      `SELECT id FROM users WHERE id = ? AND role = 'PURCHASE_MANAGER' LIMIT 1`,
      [numericPmId]
    );

    if (!pmRows.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Assigned user is not a purchase manager",
      });
    }

    // Validate product + availability up front.
    for (const item of validItems) {
      const [productRows] = await connection.execute(
        `SELECT id, type FROM products WHERE id = ? LIMIT 1`,
        [item.product_id]
      );

      if (!productRows.length) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: `Product ${item.product_id} not found`,
        });
      }

      item.category = String(productRows[0].type || "").toUpperCase();

      const available = await getAvailableEmptyForUpdate(
        connection,
        item.product_id
      );

      if (item.quantity > available) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Only ${available} empty cylinder(s) available for product ${item.product_id}`,
        });
      }
    }

    const createdBy =
      assigned_by != null ? Number(assigned_by) : req.user?.id || null;

    const [loadResult] = await connection.execute(
      `
      INSERT INTO empty_cylinder_loads
      (assigned_by, purchase_manager_id, vehicle_number, erv_number, status, dispatched_at, created_at)
      VALUES (?, ?, ?, ?, 'PENDING', NOW(), NOW())
      `,
      [createdBy, numericPmId, vehicle_number || null, erv_number || null]
    );

    const loadId = loadResult.insertId;

    for (const item of validItems) {
      // Reserve the empties out of available godown stock.
      await consumeEmptyStock(connection, item.product_id, item.quantity);

      // Pending stock movement — finalized on accept, voided on reject.
      const [txnResult] = await connection.execute(
        `
        INSERT INTO stock_transactions
        (product_id, stock_area_id, type, quantity, isApproved, reference_id, driver_id, created_by, is_defective, stock_from)
        VALUES (?, NULL, 'EMPTY_RETURN', ?, ?, ?, NULL, ?, 0, 'godown')
        `,
        [item.product_id, item.quantity, TXN_PENDING, loadId, createdBy]
      );

      await connection.execute(
        `
        INSERT INTO empty_cylinder_load_items
        (load_id, product_id, category, quantity, stock_transaction_id)
        VALUES (?, ?, ?, ?, ?)
        `,
        [
          loadId,
          item.product_id,
          item.category || null,
          item.quantity,
          txnResult.insertId,
        ]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Empty cylinder load dispatched successfully",
      data: { id: Number(loadId) },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createEmptyCylinderLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to dispatch empty cylinder load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

const mapLoadStatusLabel = (status) => {
  switch (status) {
    case LOAD_STATUS.PENDING:
      return "Pending Acceptance";
    case LOAD_STATUS.ACCEPTED:
      return "Accepted";
    case LOAD_STATUS.REJECTED:
      return "Rejected";
    case LOAD_STATUS.COMPLETED:
      return "Completed";
    default:
      return status || "";
  }
};

// GET /?purchaseManagerId= — list loads. Optionally filter by assignee (the
// purchase manager tab) so a manager only sees their own loads.
export const getEmptyCylinderLoads = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureEmptyCylinderLoadTables(connection);

    const purchaseManagerId = Number(req.query.purchaseManagerId);
    const status = String(req.query.status || "").toUpperCase();

    const filters = [];
    const params = [];

    if (purchaseManagerId && !Number.isNaN(purchaseManagerId)) {
      filters.push("ecl.purchase_manager_id = ?");
      params.push(purchaseManagerId);
    }

    if (status && LOAD_STATUS[status]) {
      filters.push("ecl.status = ?");
      params.push(status);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const [rows] = await connection.query(
      `
      SELECT
        ecl.id,
        ecl.vehicle_number,
        ecl.erv_number,
        ecl.status,
        ecl.reject_reason,
        ecl.invoice_url,
        ecl.dispatched_at,
        ecl.accepted_at,
        ecl.completed_at,
        assigner.name AS assigned_by_name,
        COALESCE(SUM(ecli.quantity), 0) AS total_qty,
        COALESCE(SUM(CASE WHEN ecli.category = 'DOMESTIC' THEN ecli.quantity ELSE 0 END), 0) AS domestic_qty,
        COALESCE(SUM(CASE WHEN ecli.category = 'COMMERCIAL' THEN ecli.quantity ELSE 0 END), 0) AS commercial_qty
      FROM empty_cylinder_loads ecl
      LEFT JOIN users assigner ON assigner.id = ecl.assigned_by
      LEFT JOIN empty_cylinder_load_items ecli ON ecli.load_id = ecl.id
      ${whereClause}
      GROUP BY ecl.id, ecl.vehicle_number, ecl.erv_number, ecl.status,
        ecl.reject_reason, ecl.invoice_url, ecl.dispatched_at, ecl.accepted_at,
        ecl.completed_at, assigner.name
      ORDER BY ecl.dispatched_at DESC, ecl.id DESC
      `,
      params
    );

    return res.json({
      success: true,
      data: rows.map((row) => ({
        id: Number(row.id),
        vehicleNumber: row.vehicle_number || "N/A",
        ervNumber: row.erv_number || null,
        assignedBy: row.assigned_by_name || "Godown",
        status: row.status,
        statusLabel: mapLoadStatusLabel(row.status),
        rejectReason: row.reject_reason || null,
        invoiceUrl: row.invoice_url || null,
        dispatchedAt: row.dispatched_at,
        acceptedAt: row.accepted_at,
        completedAt: row.completed_at,
        totalQuantity: Number(row.total_qty || 0),
        domesticQuantity: Number(row.domestic_qty || 0),
        commercialQuantity: Number(row.commercial_qty || 0),
      })),
    });
  } catch (error) {
    console.error("getEmptyCylinderLoads error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch empty cylinder loads",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// GET /:loadId — detail with domestic/commercial breakdown + dispatch summary.
export const getEmptyCylinderLoadDetail = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureEmptyCylinderLoadTables(connection);

    const loadId = Number(req.params.loadId);

    if (!loadId || Number.isNaN(loadId)) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    const [loadRows] = await connection.query(
      `
      SELECT
        ecl.id,
        ecl.vehicle_number,
        ecl.erv_number,
        ecl.status,
        ecl.reject_reason,
        ecl.invoice_url,
        ecl.dispatched_at,
        ecl.accepted_at,
        ecl.completed_at,
        assigner.name AS assigned_by_name,
        pm.name AS purchase_manager_name
      FROM empty_cylinder_loads ecl
      LEFT JOIN users assigner ON assigner.id = ecl.assigned_by
      LEFT JOIN users pm ON pm.id = ecl.purchase_manager_id
      WHERE ecl.id = ?
      LIMIT 1
      `,
      [loadId]
    );

    if (!loadRows.length) {
      return res.status(404).json({
        success: false,
        message: "Empty cylinder load not found",
      });
    }

    const [itemRows] = await connection.query(
      `
      SELECT
        ecli.product_id,
        ecli.category,
        ecli.quantity,
        p.name AS product_name,
        c.name AS category_name
      FROM empty_cylinder_load_items ecli
      LEFT JOIN products p ON p.id = ecli.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE ecli.load_id = ?
      ORDER BY ecli.id ASC
      `,
      [loadId]
    );

    const load = loadRows[0];

    const mapItem = (row) => ({
      productId: Number(row.product_id),
      name: row.product_name || "Cylinder",
      category: row.category || "",
      categoryName: row.category_name || "",
      quantity: Number(row.quantity || 0),
    });

    const domesticItems = itemRows
      .filter((row) => String(row.category || "").toUpperCase() === "DOMESTIC")
      .map(mapItem);

    const commercialItems = itemRows
      .filter((row) => String(row.category || "").toUpperCase() === "COMMERCIAL")
      .map(mapItem);

    const domesticQty = domesticItems.reduce((s, i) => s + i.quantity, 0);
    const commercialQty = commercialItems.reduce((s, i) => s + i.quantity, 0);

    return res.json({
      success: true,
      data: {
        id: Number(load.id),
        vehicleNumber: load.vehicle_number || "N/A",
        ervNumber: load.erv_number || null,
        assignedBy: load.assigned_by_name || "Godown",
        purchaseManager: load.purchase_manager_name || "",
        status: load.status,
        statusLabel: mapLoadStatusLabel(load.status),
        rejectReason: load.reject_reason || null,
        invoiceUrl: load.invoice_url || null,
        dispatchedAt: load.dispatched_at,
        acceptedAt: load.accepted_at,
        completedAt: load.completed_at,
        totalQuantity: domesticQty + commercialQty,
        domesticQuantity: domesticQty,
        commercialQuantity: commercialQty,
        domesticItems,
        commercialItems,
      },
    });
  } catch (error) {
    console.error("getEmptyCylinderLoadDetail error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch empty cylinder load detail",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// PUT /:loadId/accept — PENDING → ACCEPTED. Finalizes the reserved stock
// movement (isApproved = 1). Stock was already reserved at dispatch.
export const acceptEmptyCylinderLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);

    if (!loadId || Number.isNaN(loadId)) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT id, status FROM empty_cylinder_loads WHERE id = ? LIMIT 1 FOR UPDATE`,
      [loadId]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Empty cylinder load not found",
      });
    }

    if (rows[0].status !== LOAD_STATUS.PENDING) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Only a pending load can be accepted (current: ${rows[0].status})`,
      });
    }

    await connection.execute(
      `UPDATE empty_cylinder_loads SET status = 'ACCEPTED', accepted_at = NOW() WHERE id = ?`,
      [loadId]
    );

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = ?
      WHERE reference_id = ?
        AND type = 'EMPTY_RETURN'
        AND stock_from = 'godown'
        AND isApproved = ?
      `,
      [TXN_APPROVED, loadId, TXN_PENDING]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: "Load accepted",
    });
  } catch (error) {
    await connection.rollback();
    console.error("acceptEmptyCylinderLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to accept load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// PUT /:loadId/reject — PENDING → REJECTED. Restores the reserved empties to
// godown stock and voids the pending stock movements.
export const rejectEmptyCylinderLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);
    const reason = String(req.body?.reason || "").trim();

    if (!loadId || Number.isNaN(loadId)) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "A rejection reason is required",
      });
    }

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT id, status FROM empty_cylinder_loads WHERE id = ? LIMIT 1 FOR UPDATE`,
      [loadId]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Empty cylinder load not found",
      });
    }

    if (rows[0].status !== LOAD_STATUS.PENDING) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Only a pending load can be rejected (current: ${rows[0].status})`,
      });
    }

    const [items] = await connection.execute(
      `SELECT product_id, quantity FROM empty_cylinder_load_items WHERE load_id = ?`,
      [loadId]
    );

    for (const item of items) {
      await restoreEmptyStock(
        connection,
        Number(item.product_id),
        Number(item.quantity || 0)
      );
    }

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = ?
      WHERE reference_id = ?
        AND type = 'EMPTY_RETURN'
        AND stock_from = 'godown'
        AND isApproved = ?
      `,
      [TXN_VOID, loadId, TXN_PENDING]
    );

    await connection.execute(
      `UPDATE empty_cylinder_loads SET status = 'REJECTED', reject_reason = ? WHERE id = ?`,
      [reason, loadId]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: "Load rejected and empties returned to godown stock",
    });
  } catch (error) {
    await connection.rollback();
    console.error("rejectEmptyCylinderLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to reject load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// ACCEPTED → COMPLETED, inside a transaction the caller already owns. Shared
// with the purchase-trip flow, where ending an empty-cylinder trip completes
// the underlying load atomically with the trip close. Returns a result object
// instead of an HTTP response so both callers can shape their own reply.
export const completeEmptyLoadInTransaction = async (
  connection,
  loadId,
  invoiceUrl = null
) => {
  const [rows] = await connection.execute(
    `SELECT id, status FROM empty_cylinder_loads WHERE id = ? LIMIT 1 FOR UPDATE`,
    [Number(loadId)]
  );

  if (!rows.length) {
    return { ok: false, message: "Empty cylinder load not found" };
  }

  if (rows[0].status !== LOAD_STATUS.ACCEPTED) {
    return {
      ok: false,
      message: `Only an accepted load can be completed (current: ${rows[0].status})`,
    };
  }

  await connection.execute(
    `
    UPDATE empty_cylinder_loads
    SET status = 'COMPLETED', completed_at = NOW(), invoice_url = COALESCE(?, invoice_url)
    WHERE id = ?
    `,
    [invoiceUrl, Number(loadId)]
  );

  return { ok: true };
};

// PUT /:loadId/complete — ACCEPTED → COMPLETED. Records optional IOC invoice
// and completion time. Stock is already deducted; the stock_transactions rows
// stand as the inventory-history / audit trail.
export const completeEmptyCylinderLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);
    const invoiceUrl = req.body?.invoiceUrl ? String(req.body.invoiceUrl) : null;

    if (!loadId || Number.isNaN(loadId)) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    await connection.beginTransaction();

    const completion = await completeEmptyLoadInTransaction(
      connection,
      loadId,
      invoiceUrl
    );

    if (!completion.ok) {
      await connection.rollback();
      return res
        .status(completion.message.includes("not found") ? 404 : 400)
        .json({
          success: false,
          message: completion.message,
        });
    }

    await connection.commit();

    return res.json({
      success: true,
      message: "Load completed",
    });
  } catch (error) {
    await connection.rollback();
    console.error("completeEmptyCylinderLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to complete load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
