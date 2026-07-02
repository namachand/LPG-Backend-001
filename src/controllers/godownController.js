import db from "../config/db.js";
import { syncPurchaseApprovalState } from "./purchaseController.js";

const DEFAULT_STOCK_AREA_ID = 1;
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const getTodayIsoDate = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const resolveDateRange = (query = {}) => {
  const rawStartDate = String(query?.startDate || "");
  const rawEndDate = String(query?.endDate || "");

  const startDate = DATE_ONLY_REGEX.test(rawStartDate) ? rawStartDate : null;
  const endDate = DATE_ONLY_REGEX.test(rawEndDate) ? rawEndDate : null;

  if (!startDate && !endDate) {
    const today = getTodayIsoDate();
    return { startDate: today, endDate: today };
  }

  const computedStartDate = startDate || endDate;
  const computedEndDate = endDate || startDate;

  if (computedStartDate <= computedEndDate) {
    return { startDate: computedStartDate, endDate: computedEndDate };
  }

  return { startDate: computedEndDate, endDate: computedStartDate };
};

const increaseStock = async (
  connection,
  {
    productId,
    quantity = 0,
    returnQuantity = 0,
    emptyQuantity = 0,
    defectiveQuantity = 0,
  }
) => {
  const qty = Number(quantity || 0);
  const returnQty = Number(returnQuantity || 0);
  const emptyQty = Number(emptyQuantity || 0);
  const defectiveQty = Number(defectiveQuantity || 0);

  if (qty === 0 && returnQty === 0 && emptyQty === 0 && defectiveQty === 0) {
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
    [productId, DEFAULT_STOCK_AREA_ID]
  );

  if (rows.length) {
    await connection.execute(
      `
      UPDATE stock
      SET
        quantity = COALESCE(quantity, 0) + ?,
        quantity_return = COALESCE(quantity_return, 0) + ?,
        empty_quantity = COALESCE(empty_quantity, 0) + ?,
        defective_quantity = COALESCE(defective_quantity, 0) + ?,
        updated_at = NOW()
      WHERE id = ?
      `,
      [qty, returnQty, emptyQty, defectiveQty, rows[0].id]
    );
    return;
  }

  await connection.execute(
    `
    INSERT INTO stock
    (
      product_id,
      stock_area_id,
      quantity,
      quantity_return,
      empty_quantity,
      defective_quantity
    )
    VALUES (?, NULL, ?, ?, ?, ?)
    `,
    [productId, qty, returnQty, emptyQty, defectiveQty]
  );
};

const getAvailableStockForUpdate = async (connection, productId) => {
  const [rows] = await connection.execute(
    `
    SELECT COALESCE(SUM(quantity), 0) AS quantity
    FROM stock
    WHERE product_id = ?
    FOR UPDATE
    `,
    [productId]
  );

  return Number(rows[0]?.quantity || 0);
};

const consumeStockQuantity = async (connection, productId, requiredQty) => {
  let remaining = Number(requiredQty || 0);

  if (remaining <= 0) {
    return;
  }

  const [rows] = await connection.execute(
    `
    SELECT id, COALESCE(quantity, 0) AS quantity
    FROM stock
    WHERE product_id = ?
    ORDER BY (stock_area_id = ?) DESC, id ASC
    FOR UPDATE
    `,
    [productId, DEFAULT_STOCK_AREA_ID]
  );

  for (const row of rows) {
    if (remaining <= 0) {
      break;
    }

    const currentQty = Number(row.quantity || 0);

    if (currentQty <= 0) {
      continue;
    }

    const deductQty = Math.min(currentQty, remaining);

    await connection.execute(
      `
      UPDATE stock
      SET quantity = GREATEST(COALESCE(quantity, 0) - ?, 0),
          updated_at = NOW()
      WHERE id = ?
      `,
      [deductQty, row.id]
    );

    remaining -= deductQty;
  }
};

const getStockMetricTotalForUpdate = async (
  connection,
  productId,
  metricColumn
) => {
  const safeColumn =
    metricColumn === "empty_quantity" || metricColumn === "defective_quantity"
      ? metricColumn
      : null;

  if (!safeColumn) {
    throw new Error("Unsupported stock metric");
  }

  const [rows] = await connection.execute(
    `
    SELECT COALESCE(SUM(${safeColumn}), 0) AS total
    FROM stock
    WHERE product_id = ?
    FOR UPDATE
    `,
    [Number(productId)]
  );

  return Number(rows[0]?.total || 0);
};

const consumeStockMetric = async (
  connection,
  productId,
  metricColumn,
  requiredQty
) => {
  const safeColumn =
    metricColumn === "empty_quantity" || metricColumn === "defective_quantity"
      ? metricColumn
      : null;

  if (!safeColumn) {
    throw new Error("Unsupported stock metric");
  }

  let remaining = Number(requiredQty || 0);

  if (remaining <= 0) {
    return;
  }

  const [rows] = await connection.execute(
    `
    SELECT id, COALESCE(${safeColumn}, 0) AS metric_qty
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
      SET ${safeColumn} = GREATEST(COALESCE(${safeColumn}, 0) - ?, 0),
          updated_at = NOW()
      WHERE id = ?
      `,
      [deductQty, row.id]
    );

    remaining -= deductQty;
  }
};

export const getGodownDashboardData = async (req, res) => {
  try {
    const { startDate, endDate } = resolveDateRange(req.query);

    const [stockRows] = await db.execute(`
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type,
        c.name AS category_name,
        COALESCE(SUM(s.quantity), 0) AS system_quantity,
        COALESCE(SUM(s.empty_quantity), 0) AS empty_quantity,
        COALESCE(SUM(s.defective_quantity), 0) AS defective_quantity
      FROM products p
      LEFT JOIN stock s ON s.product_id = p.id
      LEFT JOIN categories c ON c.id = p.category_id
      GROUP BY p.id, p.name, p.type, c.name
    `);

    const [allocatedTodayRows] = await db.execute(`
      SELECT
        COALESCE(SUM(st.quantity), 0) AS allocated_today
      FROM stock_transactions st
      WHERE st.type = 'ADJUSTMENT_SUBTRACT'
        AND st.stock_from = 'godown'
        AND COALESCE(st.isApproved, 0) = 1
        AND DATE(st.created_at) BETWEEN ? AND ?
    `, [startDate, endDate]);

    const [returnedTodayRows] = await db.execute(`
      SELECT
        COALESCE(SUM(st.quantity), 0) AS returned_today
      FROM stock_transactions st
      LEFT JOIN sales linked_sale
        ON linked_sale.id = st.reference_id
       AND linked_sale.driver_id = st.driver_id
      WHERE st.driver_id IS NOT NULL
        AND COALESCE(st.isApproved, 0) = 0
        AND DATE(st.created_at) BETWEEN ? AND ?
        AND st.type IN ('EMPTY_RETURN', 'PURCHASE_RETURN')
        AND (
          st.type <> 'EMPTY_RETURN'
          OR linked_sale.id IS NULL
        )
    `, [startDate, endDate]);

    const [recentActivityRows] = await db.execute(
      `
      SELECT
        st.id,
        st.type,
        st.stock_from,
        st.quantity,
        st.created_at,
        COALESCE(st.is_defective, 0) AS is_defective,
        p.name AS product_name,
        u.name AS driver_name
      FROM stock_transactions st
      LEFT JOIN products p ON p.id = st.product_id
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      WHERE DATE(st.created_at) BETWEEN ? AND ?
      ORDER BY st.created_at DESC
      LIMIT 10
      `,
      [startDate, endDate]
    );

    // Count cashier sales (office sales)
    const [cashierSalesRows] = await db.execute(`
      SELECT COUNT(*) AS cashier_sale_count
      FROM sales s
      WHERE s.sales_from = 'CASHIER'
        AND DATE(s.created_at) BETWEEN ? AND ?
    `, [startDate, endDate]);

    const normalizeType = (row) => {
      return String(row.product_type || "").toUpperCase() === "COMMERCIAL"
        ? "COMMERCIAL"
        : "DOMESTIC";
    };

    const cashierSaleStock = Number(cashierSalesRows[0]?.cashier_sale_count || 0);

    const initial = {
      available: {
        domestic: { total: 0, system: 0, defective: 0, items: [] },
        commercial: { total: 0, system: 0, defective: 0, items: [] },
      },
      empty: {
        domestic: { total: 0, system: 0, defective: 0, items: [] },
        commercial: { total: 0, system: 0, defective: 0, items: [] },
      },
      allocatedToday: 0,
      returnedToday: 0,
      totalDefectives: 0,
      cashierSaleStock,
      recentActivities: [],
    };

    stockRows.forEach((row) => {
      const group = normalizeType(row);
      const key = group === "COMMERCIAL" ? "commercial" : "domestic";

      const systemQty = Number(row.system_quantity || 0);
      const emptyQty = Number(row.empty_quantity || 0);
      const defectiveQty = Number(row.defective_quantity || 0);

      const availablePhysical = Math.max(systemQty, 0);
      const defectivePhysical = Math.max(defectiveQty, 0);
      const emptyPhysical = Math.max(emptyQty, 0);

      initial.available[key].system += systemQty;
      initial.available[key].defective += defectivePhysical;
      initial.available[key].total += availablePhysical;

      initial.empty[key].total += emptyPhysical;
      initial.empty[key].system += emptyPhysical;

      initial.available[key].items.push({
        product_id: row.product_id,
        item: row.product_name,
        physical: availablePhysical,
        system: systemQty,
        diff: availablePhysical - systemQty,
      });
    });

    // Keep empty cards sourced from stock.empty_quantity only.
    // This guarantees values change only after approval updates stock.

    initial.totalDefectives = stockRows.reduce(
      (sum, row) => sum + Number(row.defective_quantity || 0),
      0
    );
    initial.allocatedToday = Number(allocatedTodayRows[0]?.allocated_today || 0);
    initial.returnedToday = Number(returnedTodayRows[0]?.returned_today || 0);

    initial.recentActivities = recentActivityRows.map((row) => {
      const qty = Number(row.quantity || 0);
      const productName = row.product_name || "Cylinder";
      const driverName = row.driver_name || "Driver";
      const activityType = String(row.type || "").toUpperCase();

      if (activityType === "ADJUSTMENT_SUBTRACT") {
        return {
          id: row.id,
          title: `${qty} ${productName} allocated to ${driverName}`,
          icon: "arrow-up-circle-outline",
          color: "primary",
          createdAt: row.created_at,
        };
      }

      if (activityType === "ADJUSTMENT_ADD") {
        return {
          id: row.id,
          title: `${qty} ${productName} received from Depot`,
          icon: "arrow-down-circle-outline",
          color: "green",
          createdAt: row.created_at,
        };
      }

      if (activityType === "EMPTY_RETURN") {
        return {
          id: row.id,
          title: `${qty} empty ${productName} returned by ${driverName}`,
          icon: "refresh-outline",
          color: "orange",
          createdAt: row.created_at,
        };
      }

      if (activityType === "PURCHASE_RETURN" && Number(row.is_defective) === 1) {
        return {
          id: row.id,
          title: `${qty} defective ${productName} logged from ${driverName}`,
          icon: "warning-outline",
          color: "danger",
          createdAt: row.created_at,
        };
      }

      return {
        id: row.id,
        title: `${qty} ${productName} activity by ${driverName}`,
        icon: "time-outline",
        color: "primary",
        createdAt: row.created_at,
      };
    });

    return res.json({
      success: true,
      data: initial,
    });
  } catch (error) {
    console.error("getGodownDashboardData error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch godown dashboard data",
    });
  }
};

export const getStockDetailByType = async (req, res) => {
  try {
    const rawType = String(req.params.type || "").toLowerCase();
    const { startDate, endDate } = resolveDateRange(req.query);

    const isEmptyView = rawType.startsWith("empty-");

    const normalizedType = ["commercial", "empty-commercial"].includes(rawType)
      ? "COMMERCIAL"
      : ["domestic", "empty-domestic"].includes(rawType)
        ? "DOMESTIC"
        : null;

    if (!normalizedType) {
      return res.status(400).json({
        success: false,
        message: "Invalid stock type",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type,
        COALESCE(SUM(s.quantity), 0) AS quantity,
        COALESCE(SUM(s.empty_quantity), 0) AS empty_quantity,
        COALESCE(SUM(s.defective_quantity), 0) AS defective_quantity
      FROM products p
      LEFT JOIN stock s ON s.product_id = p.id
      WHERE p.type = ?
      GROUP BY p.id, p.name, p.type
      ORDER BY p.name ASC
      `,
      [normalizedType]
    );

    // For empty view:
    //   system   = sales_items.empty_cylinder_qty (what drivers collected — same source as driver app)
    //   physical = stock.empty_quantity (what godown has approved and received)
    let emptyReturnByProduct = {};
    if (isEmptyView) {
      const [emptyTxRows] = await db.execute(
        `
        SELECT
          si.product_id,
          COALESCE(SUM(si.empty_cylinder_qty), 0) AS total_returned
        FROM sales s
        INNER JOIN sales_items si ON si.sale_id = s.id
        WHERE s.status = 'DELIVERED'
          AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
          AND COALESCE(si.empty_cylinder_qty, 0) > 0
          AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
        GROUP BY si.product_id
        `,
        [startDate, endDate]
      );
      emptyTxRows.forEach((r) => {
        emptyReturnByProduct[Number(r.product_id)] = Number(r.total_returned || 0);
      });
    }

    const items = rows.map((row) => {
      const qty = Number(row.quantity || 0);
      const emptyQty = Number(row.empty_quantity || 0);   // stock.empty_quantity (in-stock / approved)
      const defectiveQty = Number(row.defective_quantity || 0);

      let physical, system;

      if (isEmptyView) {
        // system   = what drivers collected (sales_items — same source as driver app)
        // physical = stock.empty_quantity (approved and received at godown)
        physical = emptyQty;
        system = emptyReturnByProduct[Number(row.product_id)] ?? 0;
      } else {
        physical = Math.max(qty - defectiveQty, 0);
        system = Math.max(qty, 0);
      }

      const compactName = String(row.product_name || "")
        .replace(/commercial|domestic/gi, "")
        .replace(/cylinder|cylinders/gi, "")
        .trim();

      return {
        productId: Number(row.product_id),
        productName: row.product_name,
        item: compactName || row.product_name,
        quantity: Math.max(qty - defectiveQty, 0),
        emptyQuantity: emptyQty,
        defectiveQuantity: defectiveQty,
        physical,
        system,
        diff: physical - system,
      };
    });

    const totalAvailable = items.reduce(
      (sum, item) => sum + Number(item.quantity || 0),
      0
    );

    const totalEmpty = items.reduce(
      (sum, item) => sum + Number(item.emptyQuantity || 0),
      0
    );

    const totalDefective = items.reduce(
      (sum, item) => sum + Number(item.defectiveQuantity || 0),
      0
    );

    const totalPhysical = items.reduce(
      (sum, item) => sum + Number(item.physical || 0),
      0
    );

    const totalSystem = items.reduce(
      (sum, item) => sum + Number(item.system || 0),
      0
    );

    const titleMap = {
      domestic: "Domestic Available",
      commercial: "Commercial Available",
      "empty-domestic": "Domestic Empty",
      "empty-commercial": "Commercial Empty",
    };

    const title = titleMap[rawType] || (
      normalizedType === "COMMERCIAL" ? "Commercial Available" : "Domestic Available"
    );

    return res.json({
      success: true,
      data: {
        type: rawType,
        mode: isEmptyView ? "empty" : "available",
        title,
        totalAvailable,
        totalEmpty,
        totalDefective,
        totalStock: isEmptyView ? totalSystem : totalAvailable,
        physical: totalPhysical,
        system: totalSystem,
        diff: totalPhysical - totalSystem,
        showBookings: rawType === "commercial",
        items,
      },
    });
  } catch (error) {
    console.error("getStockDetailByType error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock detail",
      error: error.message,
    });
  }
};

export const getStockInLoads = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        COALESCE(st.reference_id, st.driver_id) AS load_id,
        DATE(st.created_at) AS load_date,
        MAX(st.created_at) AS created_at,
        SUM(st.quantity) AS total_quantity,
        MIN(st.isApproved) AS isApproved,

        d.id AS driver_id,
        d.vehicle_number,
        u.name AS driver_name,
        pu.name AS purchase_manager_name
      FROM stock_transactions st
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      LEFT JOIN purchase_loads pl ON pl.id = st.reference_id
      LEFT JOIN purchase_trips pt ON pt.id = pl.trip_id
      LEFT JOIN users pu ON pu.id = pt.purchase_manager_id
      WHERE st.type = 'PURCHASE'
      GROUP BY
        COALESCE(st.reference_id, st.driver_id),
        DATE(st.created_at),
        d.id,
        d.vehicle_number,
        u.name,
        pu.name
      ORDER BY created_at DESC
    `);

    return res.json({
      success: true,
      data: rows.map((row, index) => ({
        id: row.load_id,
        load: `Load-${index + 1}`,
        date: row.load_date,
        driver_id: row.driver_id,
        driver: row.purchase_manager_name || row.driver_name || "Unknown Driver",
        invoice: `INV-${row.load_id}`,
        vehicle: row.vehicle_number || "N/A",
        qty: Number(row.total_quantity || 0),
        status:
          Number(row.isApproved) === 1
            ? "APPROVED"
            : Number(row.isApproved) === 2
              ? "WAITING_APPROVAL"
              : "IN_PROGRESS",
      })),
    });
  } catch (error) {
    console.error("getStockInLoads error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock in loads",
    });
  }
};

export const getStockInLoadDetail = async (req, res) => {
  try {
    const { loadId } = req.params;

    const [rows] = await db.execute(
      `
      SELECT
        st.id,
        st.product_id,
        st.stock_area_id,
        st.quantity,
        st.isApproved,
        st.reference_id,
        st.driver_id,
        st.created_at,

        p.name AS product_name,
        p.type AS product_type,
        c.name AS category_name,

        d.vehicle_number,
        u.name AS driver_name,
        pu.name AS purchase_manager_name,
        pl.invoice_url
      FROM stock_transactions st
      JOIN products p ON p.id = st.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      LEFT JOIN purchase_loads pl ON pl.id = st.reference_id
      LEFT JOIN purchase_trips pt ON pt.id = pl.trip_id
      LEFT JOIN users pu ON pu.id = pt.purchase_manager_id
      WHERE st.type = 'PURCHASE'
        AND COALESCE(st.reference_id, st.driver_id) = ?
      ORDER BY st.id ASC
      `,
      [loadId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Stock in load not found",
      });
    }

    const totalQty = rows.reduce(
      (sum, row) => sum + Number(row.quantity || 0),
      0
    );

    return res.json({
      success: true,
      data: {
        id: loadId,
        load: "Load-1",
        date: rows[0].created_at,
        driver: rows[0].purchase_manager_name || rows[0].driver_name || "Unknown Driver",
        vehicle: rows[0].vehicle_number || "N/A",
        depot: "HP Gas Depot - Sector 12",
        invoice: `INV-${loadId}`,
        invoiceImageUrl: rows[0].invoice_url || null,
        qty: totalQty,
        status:
          Number(rows[0].isApproved) === 1
            ? "APPROVED"
            : Number(rows[0].isApproved) === 2
              ? "WAITING_APPROVAL"
              : "IN_PROGRESS",
        items: rows.map((row) => ({
          transaction_id: row.id,
          product_id: row.product_id,
          item: row.product_name,
          category: row.category_name,
          type: row.product_type,
          quantity: Number(row.quantity || 0),
        })),
      },
    });
  } catch (error) {
    console.error("getStockInLoadDetail error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock in load detail",
    });
  }
};

export const approveStockInLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { loadId } = req.params;

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `
      SELECT id, product_id, quantity
      FROM stock_transactions
      WHERE type = 'PURCHASE'
        AND COALESCE(reference_id, driver_id) = ?
        AND isApproved = 2
      `,
      [loadId]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No waiting-approval stock found for approval",
      });
    }

    for (const row of rows) {
      await increaseStock(connection, {
        productId: Number(row.product_id),
        quantity: Number(row.quantity || 0),
      });
    }

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = 1
      WHERE type = 'PURCHASE'
        AND COALESCE(reference_id, driver_id) = ?
        AND isApproved = 2
      `,
      [loadId]
    );

    await syncPurchaseApprovalState(connection, loadId);

    await connection.commit();

    return res.json({
      success: true,
      message: "Stock approved successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveStockInLoad error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to approve stock",
    });
  } finally {
    connection.release();
  }
};

export const getDriverLists = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT 
        d.id AS driver_id,
        d.vehicle_number,
        u.name AS driver_name
      FROM drivers d
      JOIN users u ON u.id = d.user_id
      ORDER BY u.name ASC
    `);

    return res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.driver_id,
        name: row.driver_name,
        vehicle: row.vehicle_number || "N/A",
      })),
    });
  } catch (error) {
    console.error("getDriverLists error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch drivers",
    });
  }
};

export const getCylinderProducts = async (req, res) => {
  try {
    const mode = String(req.query.mode || "").toLowerCase();

    if (mode === "dispatch") {
      const [dispatchRows] = await db.execute(
        `
        SELECT
          p.id,
          p.name,
          p.type,
          c.name AS category_name,
          COALESCE(SUM(s.empty_quantity), 0) AS empty_available,
          COALESCE(SUM(s.defective_quantity), 0) AS defective_available
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN stock s ON s.product_id = p.id
        GROUP BY p.id, p.name, p.type, c.name
        HAVING COALESCE(SUM(s.empty_quantity), 0) > 0
           OR COALESCE(SUM(s.defective_quantity), 0) > 0
        ORDER BY p.type ASC, p.name ASC
        `
      );

      return res.json({
        success: true,
        data: {
          domestic: dispatchRows
            .filter(
              (item) =>
                String(item.type || "").toUpperCase() !== "COMMERCIAL"
            )
            .map((item) => ({
              id: item.id,
              name: item.name,
              category: item.category_name,
              emptyAvailable: Number(item.empty_available || 0),
              defectiveAvailable: Number(item.defective_available || 0),
            })),
          commercial: dispatchRows
            .filter(
              (item) =>
                String(item.type || "").toUpperCase() === "COMMERCIAL"
            )
            .map((item) => ({
              id: item.id,
              name: item.name,
              category: item.category_name,
              emptyAvailable: Number(item.empty_available || 0),
              defectiveAvailable: Number(item.defective_available || 0),
            })),
        },
      });
    }

    const [rows] = await db.execute(`
      SELECT
        p.id,
        p.name,
        p.type,
        c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      ORDER BY p.type ASC, p.name ASC
    `);

    return res.json({
      success: true,
      data: {
        domestic: rows
          .filter((item) =>
            `${item.type} ${item.category_name} ${item.name}`
              .toLowerCase()
              .includes("domestic")
          )
          .map((item) => ({
            id: item.id,
            name: item.name,
            category: item.category_name,
          })),

        commercial: rows
          .filter((item) =>
            `${item.type} ${item.category_name} ${item.name}`
              .toLowerCase()
              .includes("commercial")
          )
          .map((item) => ({
            id: item.id,
            name: item.name,
            category: item.category_name,
          })),
      },
    });
  } catch (error) {
    console.error("getCylinderProducts error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch products",
    });
  }
};

export const getStockOutLoads = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        COALESCE(st.reference_id, st.driver_id) AS load_id,
        DATE(st.created_at) AS load_date,
        MAX(st.created_at) AS created_at,

        SUM(CASE WHEN st.type = 'EMPTY_RETURN' THEN st.quantity ELSE 0 END) AS empty_quantity,
        SUM(CASE WHEN st.type = 'PURCHASE_RETURN' AND st.is_defective = 1 THEN st.quantity ELSE 0 END) AS defective_quantity,

        MIN(st.isApproved) AS isApproved,

        d.id AS driver_id,
        d.vehicle_number,
        u.name AS driver_name
      FROM stock_transactions st
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      WHERE (
        (st.type = 'EMPTY_RETURN' AND st.stock_from = 'godown')
        OR (
          st.type = 'PURCHASE_RETURN'
          AND st.is_defective = 1
          AND st.stock_from = 'stock_out'
        )
      )
      GROUP BY
        COALESCE(st.reference_id, st.driver_id),
        DATE(st.created_at),
        d.id,
        d.vehicle_number,
        u.name
      ORDER BY created_at DESC
    `);

    return res.json({
      success: true,
      data: rows.map((row, index) => {
        const emptyQty = Number(row.empty_quantity || 0);
        const defectiveQty = Number(row.defective_quantity || 0);

        return {
          id: row.load_id,
          load: `Load-${index + 1}`,
          date: row.load_date,
          created_at: row.created_at,
          driver_id: row.driver_id,
          driver: row.driver_name || "Unknown Driver",
          invoice: `DSP-${row.load_id}`,
          vehicle: row.vehicle_number || "N/A",
          qty: emptyQty + defectiveQty,
          empty_qty: emptyQty,
          defective_qty: defectiveQty,
          status:
            Number(row.isApproved) === 1
              ? "APPROVED"
              : Number(row.isApproved) === 2
                ? "CANCELLED"
                : "PENDING",
        };
      }),
    });
  } catch (error) {
    console.error("getStockOutLoads error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock out loads",
    });
  }
};

export const createStockOutLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driver_id, reference_id, items = [] } = req.body;

    if (!driver_id || !items.length) {
      return res.status(400).json({
        success: false,
        message: "Driver and items are required",
      });
    }

    const validItems = items.filter((item) => {
      const emptyQty = Number(item.empty_quantity || 0);
      const defectiveQty = Number(item.defective_quantity || 0);

      return Number(item.product_id) && (emptyQty > 0 || defectiveQty > 0);
    });

    if (!validItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one empty or defective quantity is required",
      });
    }

    await connection.beginTransaction();

    const finalReferenceId = reference_id || Date.now();
    const createdBy = req.user?.id || null;

    for (const item of validItems) {
      const productId = Number(item.product_id);
      const emptyQty = Number(item.empty_quantity || 0);
      const defectiveQty = Number(item.defective_quantity || 0);

      if (emptyQty > 0) {
        const availableEmpty = await getStockMetricTotalForUpdate(
          connection,
          productId,
          "empty_quantity"
        );

        if (emptyQty > availableEmpty) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `Only ${availableEmpty} empty cylinder(s) available for product ${productId}`,
          });
        }
      }

      if (defectiveQty > 0) {
        const availableDefective = await getStockMetricTotalForUpdate(
          connection,
          productId,
          "defective_quantity"
        );

        if (defectiveQty > availableDefective) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `Only ${availableDefective} defective cylinder(s) available for product ${productId}`,
          });
        }
      }

      if (emptyQty > 0) {
        await connection.execute(
          `
          INSERT INTO stock_transactions
          (
            product_id,
            stock_area_id,
            type,
            quantity,
            isApproved,
            reference_id,
            driver_id,
            created_by,
            is_defective,
            stock_from
          )
          VALUES (?, ?, 'EMPTY_RETURN', ?, 1, ?, ?, ?, 0, 'godown')
          `,
          [
            productId,
            null,
            emptyQty,
            finalReferenceId,
            driver_id,
            createdBy,
          ]
        );

        await consumeStockMetric(connection, productId, "empty_quantity", emptyQty);
      }

      if (defectiveQty > 0) {
        await connection.execute(
          `
          INSERT INTO stock_transactions
          (
            product_id,
            stock_area_id,
            type,
            quantity,
            isApproved,
            reference_id,
            driver_id,
            created_by,
            is_defective,
            stock_from
          )
          VALUES (?, ?, 'PURCHASE_RETURN', ?, 1, ?, ?, ?, 1, 'stock_out')
          `,
          [
            productId,
            null,
            defectiveQty,
            finalReferenceId,
            driver_id,
            createdBy,
          ]
        );

        await consumeStockMetric(
          connection,
          productId,
          "defective_quantity",
          defectiveQty
        );
      }
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Stock out load created and approved successfully",
      data: {
        reference_id: finalReferenceId,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createStockOutLoad error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create stock out load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getStockOutLoadDetail = async (req, res) => {
  try {
    const { loadId } = req.params;

    const [rows] = await db.execute(
      `
      SELECT
        st.id,
        st.product_id,
        st.stock_area_id,
        st.quantity,
        st.type AS transaction_type,
        st.is_defective,
        st.isApproved,
        st.reference_id,
        st.driver_id,
        st.created_at,

        p.name AS product_name,
        p.type AS product_type,
        c.name AS category_name,

        d.vehicle_number,
        u.name AS driver_name
      FROM stock_transactions st
      JOIN products p ON p.id = st.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      WHERE COALESCE(st.reference_id, st.driver_id) = ?
        AND (
          (st.type = 'EMPTY_RETURN' AND st.stock_from = 'godown')
          OR (
            st.type = 'PURCHASE_RETURN'
            AND st.is_defective = 1
            AND st.stock_from = 'stock_out'
          )
        )
      ORDER BY st.id ASC
      `,
      [loadId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Stock out load not found",
      });
    }

    const emptyItems = rows
      .filter((row) => row.transaction_type === "EMPTY_RETURN")
      .map((row) => ({
        transaction_id: row.id,
        product_id: row.product_id,
        item: row.product_name,
        category: row.category_name,
        type: row.product_type,
        quantity: Number(row.quantity || 0),
      }));

    const defectiveItems = rows
      .filter(
        (row) =>
          row.transaction_type === "PURCHASE_RETURN" &&
          Number(row.is_defective) === 1
      )
      .map((row) => ({
        transaction_id: row.id,
        product_id: row.product_id,
        item: row.product_name,
        category: row.category_name,
        type: row.product_type,
        quantity: Number(row.quantity || 0),
      }));

    const emptyQty = emptyItems.reduce(
      (sum, row) => sum + Number(row.quantity || 0),
      0
    );

    const defectiveQty = defectiveItems.reduce(
      (sum, row) => sum + Number(row.quantity || 0),
      0
    );

    return res.json({
      success: true,
      data: {
        id: loadId,
        load: "Load-1",
        date: rows[0].created_at,
        driver: rows[0].driver_name || "Unknown Driver",
        vehicle: rows[0].vehicle_number || "N/A",
        depot: "HP Gas Depot - Sector 12",
        invoice: `DSP-${loadId}`,
        qty: emptyQty + defectiveQty,
        empty_qty: emptyQty,
        defective_qty: defectiveQty,
        status:
          Number(rows[0].isApproved) === 1
            ? "APPROVED"
            : Number(rows[0].isApproved) === 2
              ? "CANCELLED"
              : "PENDING",
        items: emptyItems,
        defective_items: defectiveItems,
      },
    });
  } catch (error) {
    console.error("getStockOutLoadDetail error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock out load detail",
    });
  }
};

export const approveStockOutLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { loadId } = req.params;

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `
      SELECT 
        id,
        product_id,
        quantity,
        type,
        is_defective
      FROM stock_transactions
      WHERE COALESCE(reference_id, driver_id) = ?
        AND stock_from IN ('godown', 'stock_out')
        AND isApproved = 0
        AND (
          type = 'EMPTY_RETURN'
          OR (type = 'PURCHASE_RETURN' AND is_defective = 1)
        )
      `,
      [loadId]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No pending stock out found for approval",
      });
    }

    for (const row of rows) {
      if (row.type === "EMPTY_RETURN") {
        await increaseStock(connection, {
          productId: Number(row.product_id),
          emptyQuantity: Number(row.quantity || 0),
        });
      }

      if (row.type === "PURCHASE_RETURN" && Number(row.is_defective) === 1) {
        await increaseStock(connection, {
          productId: Number(row.product_id),
          defectiveQuantity: Number(row.quantity || 0),
        });
      }
    }

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = 1
      WHERE COALESCE(reference_id, driver_id) = ?
        AND stock_from IN ('godown', 'stock_out')
        AND isApproved = 0
        AND (
          type = 'EMPTY_RETURN'
          OR (type = 'PURCHASE_RETURN' AND is_defective = 1)
        )
      `,
      [loadId]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: "Stock out approved successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveStockOutLoad error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to approve stock out",
    });
  } finally {
    connection.release();
  }
};
export const getDefectiveLoads = async (req, res) => {
  try {
    const { startDate, endDate } = resolveDateRange(req.query);

    const [rows] = await db.execute(
      `
      SELECT
        COALESCE(st.reference_id, st.id) AS load_id,
        st.reference_id,
        st.stock_from,
        DATE(st.created_at) AS load_date,
        MAX(st.created_at) AS created_at,
        SUM(st.quantity) AS total_quantity,

        d.id AS driver_id,
        d.vehicle_number,
        u.name AS driver_name,

        GROUP_CONCAT(p.name SEPARATOR ', ') AS products
      FROM stock_transactions st
      JOIN products p ON p.id = st.product_id
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      WHERE st.type = 'PURCHASE_RETURN'
        AND COALESCE(st.is_defective, 0) = 1
        AND st.stock_from != 'stock_out'
        AND DATE(st.created_at) BETWEEN ? AND ?
      GROUP BY
        COALESCE(st.reference_id, st.id),
        st.reference_id,
        st.stock_from,
        DATE(st.created_at),
        d.id,
        d.vehicle_number,
        u.name
      ORDER BY created_at DESC
      `,
      [startDate, endDate]
    );

    const loads = rows.map((row) => {
      const source = row.stock_from || "default";

      let tag = "FOUND IN GODOWN";
      let title = "Godown Defective";
      let desc = "Defective cylinder found in stock";
      let person = "Storekeeper";
      let type = "godown";

      if (source === "depot") {
        tag = "FROM DEPOT LOAD";
        title = `Load-${row.load_id}`;
        desc = "Found during depot unload";
        person = row.driver_name || "Depot";
        type = "depot";
      }

      if (source === "driver") {
        tag = "DELIVERY BOY RETURN";
        title = `Trip-DLV-${row.load_id}`;
        desc = "Customer returned damaged cylinder";
        person = row.driver_name || "Driver";
        type = "delivery";
      }

      return {
        id: row.load_id,
        title,
        tag,
        desc,
        person,
        time: new Date(row.created_at).toLocaleTimeString("en-IN", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        qty: Number(row.total_quantity || 0),
        type,
        stock_from: source,
        date: row.load_date,
      };
    });

    const summary = {
      depot: loads
        .filter((x) => x.stock_from === "depot")
        .reduce((sum, x) => sum + x.qty, 0),

      godown: loads
        .filter((x) => x.stock_from === "godown")
        .reduce((sum, x) => sum + x.qty, 0),

      delivery: loads
        .filter((x) => x.stock_from === "driver")
        .reduce((sum, x) => sum + x.qty, 0),
    };

    return res.json({
      success: true,
      data: {
        summary,
        loads,
      },
    });
  } catch (error) {
    console.error("getDefectiveLoads error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch defective loads",
    });
  }
};

export const createDefectiveLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      stock_from = "godown",
      driver_id = null,
      reference_id,
      items = [],
      notes = "",
      bay_location = "",
    } = req.body;

    const validStockFrom = ["depot", "godown", "driver"];

    if (!validStockFrom.includes(stock_from)) {
      return res.status(400).json({
        success: false,
        message: "Invalid stock_from value",
      });
    }

    if (stock_from === "driver" && !driver_id) {
      return res.status(400).json({
        success: false,
        message: "Driver is required when stock_from is driver",
      });
    }

    const validItems = items.filter(
      (item) => Number(item.product_id) && Number(item.quantity) > 0
    );

    if (!validItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one defective quantity is required",
      });
    }

    await connection.beginTransaction();

    const finalReferenceId = reference_id || Date.now();

    for (const item of validItems) {
      const productId = Number(item.product_id);
      const qty = Number(item.quantity || 0);

      // When marking cylinders from godown stock as defective, check and
      // consume from available (sellable) quantity first
      if (stock_from === "godown") {
        const availableQty = await getAvailableStockForUpdate(connection, productId);

        if (availableQty < qty) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `Insufficient available stock for product ${productId}. Available: ${availableQty}, required: ${qty}`,
          });
        }

        await consumeStockQuantity(connection, productId, qty);
      }

      await connection.execute(
        `
        INSERT INTO stock_transactions
        (
          product_id,
          stock_area_id,
          type,
          quantity,
          isApproved,
          is_defective,
          reference_id,
          driver_id,
          created_by,
          stock_from
        )
        VALUES (?, ?, 'PURCHASE_RETURN', ?, 1, 1, ?, ?, ?, ?)
        `,
        [
          productId,
          null,
          qty,
          finalReferenceId,
          stock_from === "driver" ? driver_id : null,
          req.user?.id || null,
          stock_from,
        ]
      );

      await increaseStock(connection, {
        productId,
        defectiveQuantity: qty,
      });
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Defective stock logged successfully",
      data: {
        reference_id: finalReferenceId,
        stock_from,
        notes,
        bay_location,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createDefectiveLoad error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to log defective stock",
    });
  } finally {
    connection.release();
  }
};

export const getDeliveryDrivers = async (req, res) => {
  try {
    const { filter = "today" } = req.query;

    let dateSalesCondition = "DATE(s.created_at) = CURDATE()";
    let dateReturnCondition = "DATE(st.created_at) = CURDATE()";

    if (filter === "yesterday") {
      dateSalesCondition = "DATE(s.created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)";
      dateReturnCondition = "DATE(st.created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)";
    }

    if (filter === "week") {
      dateSalesCondition = "YEARWEEK(s.created_at, 1) = YEARWEEK(CURDATE(), 1)";
      dateReturnCondition = "YEARWEEK(st.created_at, 1) = YEARWEEK(CURDATE(), 1)";
    }

    // Get all drivers from the database
    const [allDrivers] = await db.execute(`
      SELECT
        d.id AS driver_id,
        d.vehicle_number,
        u.name AS driver_name
      FROM drivers d
      JOIN users u ON u.id = d.user_id
      ORDER BY u.name ASC
    `);

    // Get allocation stats for each driver within date range
    const [allocationStats] = await db.execute(`
      SELECT
        s.driver_id,
        COALESCE(SUM(
          CASE
            WHEN s.status = 'ASSIGNED'
              AND si.status = 'ASSIGNED'
            THEN si.quantity
            ELSE 0
          END
        ), 0) AS allocated,

        COALESCE(SUM(
          CASE
            WHEN s.status = 'DELIVERED'
              AND si.status = 'DELIVERED'
            THEN COALESCE(si.delivered_qty, si.quantity, 0)
            ELSE 0
          END
        ), 0) AS delivered,

        COALESCE(SUM(
          CASE
            WHEN si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
            THEN COALESCE(si.empty_cylinder_qty, 0)
            ELSE 0
          END
        ), 0) AS empty_collected

      FROM sales s
      JOIN sales_items si ON si.sale_id = s.id
      WHERE ${dateSalesCondition}
      GROUP BY s.driver_id
    `);

    // Get approved in-hand returns for each driver within date range
    const [returnStats] = await db.execute(`
      SELECT
        st.driver_id,
        COALESCE(SUM(
          CASE WHEN st.is_defective = 0 THEN st.quantity ELSE 0 END
        ), 0) AS returned_empty,
        COALESCE(SUM(
          CASE WHEN st.is_defective = 1 THEN st.quantity ELSE 0 END
        ), 0) AS returned_defective
      FROM stock_transactions st
      WHERE st.stock_from = 'driver'
        AND st.type = 'PURCHASE_RETURN'
        AND st.isApproved = 1
        AND ${dateReturnCondition}
      GROUP BY st.driver_id
    `);

    // Create maps for faster lookup
    const allocationMap = new Map();
    allocationStats.forEach((row) => {
      allocationMap.set(Number(row.driver_id), {
        allocated: Number(row.allocated || 0),
        delivered: Number(row.delivered || 0),
        empty: Number(row.empty_collected || 0),
      });
    });

    const returnMap = new Map();
    returnStats.forEach((row) => {
      returnMap.set(Number(row.driver_id), {
        empty: Number(row.returned_empty || 0),
        defective: Number(row.returned_defective || 0),
      });
    });

    // Combine all data for all drivers
    const result = allDrivers.map((driver) => {
      const driverId = Number(driver.driver_id);
      const allocation = allocationMap.get(driverId) || { allocated: 0, delivered: 0, empty: 0 };
      const returns = returnMap.get(driverId) || { empty: 0, defective: 0 };

      return {
        id: driverId,
        name: driver.driver_name,
        vehicle: driver.vehicle_number || "N/A",
        allocated: allocation.allocated,
        delivered: allocation.delivered,
        empty: allocation.empty,
        inHand: Math.max(allocation.allocated - allocation.delivered - returns.empty - returns.defective, 0),
      };
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("getDeliveryDrivers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch delivery drivers",
      error: error.message,
    });
  }
};

export const getDriverDayWiseSummary = async (req, res) => {
  try {
    const { driverId } = req.params;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "Driver ID is required",
      });
    }

    // Fetch all allocations with their delivery status, day-wise
    const [allocationRows] = await db.execute(`
      SELECT
        DATE(COALESCE(s.assigned_at, s.created_at)) AS allocation_date,
        COALESCE(SUM(si.quantity), 0) AS allocated_qty,
        COALESCE(SUM(
          CASE WHEN s.status = 'DELIVERED' 
            THEN COALESCE(si.delivered_qty, si.quantity, 0)
            ELSE 0
          END
        ), 0) AS delivered_qty
      FROM sales s
      JOIN sales_items si ON si.sale_id = s.id
      WHERE s.driver_id = ?
        AND s.status IN ('ASSIGNED', 'DELIVERED')
      GROUP BY DATE(COALESCE(s.assigned_at, s.created_at))
      ORDER BY allocation_date DESC
    `, [driverId]);

    // Fetch approved in-hand returns, day-wise
    const [returnRows] = await db.execute(`
      SELECT
        DATE(st.created_at) AS return_date,
        COALESCE(SUM(
          CASE WHEN st.is_defective = 0 THEN st.quantity ELSE 0 END
        ), 0) AS empty_returned,
        COALESCE(SUM(
          CASE WHEN st.is_defective = 1 THEN st.quantity ELSE 0 END
        ), 0) AS defective_returned
      FROM stock_transactions st
      WHERE st.driver_id = ?
        AND st.stock_from = 'driver'
        AND st.type = 'PURCHASE_RETURN'
        AND st.isApproved = 1
      GROUP BY DATE(st.created_at)
      ORDER BY return_date DESC
    `, [driverId]);

    // Build day-wise summary combining allocations and returns
    const dayWiseMap = new Map();

    const normalizeDateKey = (rawValue) => {
      if (!rawValue) {
        return null;
      }

      if (typeof rawValue === "string") {
        return rawValue.slice(0, 10);
      }

      if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) {
        return rawValue.toISOString().split("T")[0];
      }

      const parsed = new Date(rawValue);

      if (Number.isNaN(parsed.getTime())) {
        return null;
      }

      return parsed.toISOString().split("T")[0];
    };

    allocationRows.forEach((row) => {
      const dateStr = normalizeDateKey(row.allocation_date);

      if (!dateStr) {
        return;
      }

      if (!dayWiseMap.has(dateStr)) {
        dayWiseMap.set(dateStr, {
          date: dateStr,
          allocated: 0,
          delivered: 0,
          inHand: 0,
        });
      }
      const existing = dayWiseMap.get(dateStr);
      existing.allocated += Number(row.allocated_qty || 0);
      existing.delivered += Number(row.delivered_qty || 0);
    });

    returnRows.forEach((row) => {
      const dateStr = normalizeDateKey(row.return_date);

      if (!dateStr) {
        return;
      }

      if (dayWiseMap.has(dateStr)) {
        const existing = dayWiseMap.get(dateStr);
        existing.inHand = Math.max(
          existing.allocated - existing.delivered - Number(row.empty_returned || 0) - Number(row.defective_returned || 0),
          0
        );
      }
    });

    // Calculate in-hand after returns for entries without returns
    dayWiseMap.forEach((value) => {
      if (value.inHand === 0) {
        value.inHand = Math.max(value.allocated - value.delivered, 0);
      }
    });

    const summary = Array.from(dayWiseMap.values()).sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    return res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    console.error("getDriverDayWiseSummary error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch driver day-wise summary",
      error: error.message,
    });
  }
};

export const createDriverAllocation = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driver_id, items = [] } = req.body;

    if (!driver_id) {
      return res.status(400).json({
        success: false,
        message: "Driver is required",
      });
    }

    const validItems = items.filter(
      (item) => Number(item.product_id) && Number(item.quantity) > 0
    );

    if (!validItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one product quantity is required",
      });
    }

    await connection.beginTransaction();

    const productIds = [
      ...new Set(validItems.map((item) => Number(item.product_id))),
    ];

    const placeholders = productIds.map(() => "?").join(",");

    const [productRows] = await connection.execute(
      `
      SELECT id, name, price
      FROM products
      WHERE id IN (${placeholders})
      `,
      productIds
    );

    const productMap = new Map(
      productRows.map((row) => [Number(row.id), row])
    );

    for (const item of validItems) {
      if (!productMap.has(Number(item.product_id))) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: `Product ${item.product_id} not found`,
        });
      }
    }

    const requiredByProduct = new Map();

    validItems.forEach((item) => {
      const productId = Number(item.product_id);
      const qty = Number(item.quantity || 0);
      requiredByProduct.set(
        productId,
        Number(requiredByProduct.get(productId) || 0) + qty
      );
    });

    for (const [productId, requiredQty] of requiredByProduct.entries()) {
      const availableQty = await getAvailableStockForUpdate(connection, productId);

      if (availableQty < requiredQty) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for product ${productId}. Available ${availableQty}, required ${requiredQty}`,
        });
      }
    }

    let totalAmount = 0;

    validItems.forEach((item) => {
      const product = productMap.get(Number(item.product_id));
      totalAmount +=
        Number(product?.price || 0) * Number(item.quantity || 0);
    });

    const [saleResult] = await connection.execute(
      `
      INSERT INTO sales
      (
        driver_id,
        total_amount,
        payment_method,
        status,
        sale_type,
        sales_from,
        created_at,
        updated_at,
        assigned_at
      )
      VALUES (?, ?, 'ONLINE', 'ASSIGNED', 'SALE', 'DRIVER', NOW(), NOW(), NOW())
      `,
      [driver_id, totalAmount]
    );

    const saleId = saleResult.insertId;
    const batchNo = `B-${saleId}`;
    const createdBy = req.user?.id || null;

    for (const item of validItems) {
      const productId = Number(item.product_id);
      const quantity = Number(item.quantity || 0);

      const [salesItemResult] = await connection.execute(
        `
        INSERT INTO sales_items
        (
          sale_id,
          product_id,
          quantity,
          price,
          status,
          delivered_qty,
          empty_cylinder_qty,
          defective_qty,
          batch_no,
          allocation_sale_id,
          allocation_sales_item_id
        )
        VALUES (?, ?, ?, 0, 'ASSIGNED', 0, 0, 0, ?, ?, NULL)
        `,
        [saleId, productId, quantity, batchNo, saleId]
      );

      await consumeStockQuantity(connection, productId, quantity);

      await connection.execute(
        `
        INSERT INTO stock_transactions
        (
          product_id,
          stock_area_id,
          type,
          quantity,
          isApproved,
          reference_id,
          driver_id,
          created_by,
          stock_from,
          is_defective,
          batch_no,
          allocation_sale_id,
          allocation_sales_item_id
        )
        VALUES (?, ?, 'ADJUSTMENT_SUBTRACT', ?, 1, ?, ?, ?, 'godown', 0, ?, ?, ?)
        `,
        [
          productId,
          null,
          quantity,
          saleId,
          Number(driver_id),
          createdBy,
          batchNo,
          saleId,
          salesItemResult.insertId,
        ]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Driver allocation created successfully",
      data: {
        sale_id: saleId,
        batch_no: batchNo,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createDriverAllocation error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create driver allocation",
    });
  } finally {
    connection.release();
  }
};

export const getReturnsToday = async (req, res) => {
  try {
    const { startDate, endDate } = resolveDateRange(req.query);

    const [drivers] = await db.execute(
      `
      SELECT DISTINCT
        d.id AS driver_id,
        d.vehicle_number,
        u.name AS driver_name
      FROM stock_transactions st
      LEFT JOIN sales linked_sale
        ON linked_sale.id = st.reference_id
       AND linked_sale.driver_id = st.driver_id
      JOIN drivers d ON d.id = st.driver_id
      JOIN users u ON u.id = d.user_id
      WHERE st.driver_id IS NOT NULL
        AND st.isApproved = 0
        AND DATE(st.created_at) BETWEEN ? AND ?
        AND st.type IN ('EMPTY_RETURN', 'PURCHASE_RETURN')
        AND (
          st.type <> 'EMPTY_RETURN'
          OR linked_sale.id IS NULL
        )
      ORDER BY u.name ASC
      `,
      [startDate, endDate]
    );

    const [rows] = await db.execute(
      `
      SELECT
        st.id,
        st.driver_id,
        st.product_id,
        st.type,
        st.quantity,
        st.isApproved,
        st.is_defective,
        st.created_at,

        p.name AS product_name,
        p.type AS product_type,
        c.name AS category_name
      FROM stock_transactions st
      LEFT JOIN sales linked_sale
        ON linked_sale.id = st.reference_id
       AND linked_sale.driver_id = st.driver_id
      JOIN products p ON p.id = st.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE st.driver_id IS NOT NULL
        AND st.isApproved = 0
        AND DATE(st.created_at) BETWEEN ? AND ?
        AND st.type IN ('EMPTY_RETURN', 'PURCHASE_RETURN')
        AND (
          st.type <> 'EMPTY_RETURN'
          OR linked_sale.id IS NULL
        )
      ORDER BY st.created_at DESC
      `,
      [startDate, endDate]
    );

    const data = drivers.map((driver) => {
      const driverRows = rows.filter(
        (row) => Number(row.driver_id) === Number(driver.driver_id)
      );

      const emptyItems = driverRows.filter(
        (row) => row.type === "EMPTY_RETURN"
      );

      const normalItems = driverRows.filter(
        (row) => row.type === "PURCHASE_RETURN" && Number(row.is_defective) === 0
      );

      const defectiveItems = driverRows.filter(
        (row) => row.type === "PURCHASE_RETURN" && Number(row.is_defective) === 1
      );

      const totalEmpty = emptyItems.reduce(
        (sum, row) => sum + Number(row.quantity || 0),
        0
      );

      const totalNormal = normalItems.reduce(
        (sum, row) => sum + Number(row.quantity || 0),
        0
      );

      const totalDefective = defectiveItems.reduce(
        (sum, row) => sum + Number(row.quantity || 0),
        0
      );

      const total = totalEmpty + totalNormal + totalDefective;

      return {
        driver_id: driver.driver_id,
        driver_name: driver.driver_name,
        vehicle_number: driver.vehicle_number,
        time: driverRows[0]?.created_at || null,
        total,
        empty: totalEmpty,
        normal: totalNormal,
        defective: totalDefective,
        items: driverRows.map((row) => ({
          id: row.id,
          product_id: row.product_id,
          name: row.product_name,
          type: row.product_type,
          category: row.category_name,
          quantity: Number(row.quantity || 0),
          condition:
            row.type === "EMPTY_RETURN"
              ? "empty"
              : Number(row.is_defective) === 1
                ? "defective"
                : "normal",
        })),
      };
    });

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("getReturnsToday error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch returns today",
    });
  }
};

export const approveReturnByCondition = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driver_id, condition } = req.body;

    if (!driver_id || !condition) {
      return res.status(400).json({
        success: false,
        message: "driver_id and condition are required",
      });
    }

    let selectTypeCondition = "";
    let updateTypeCondition = "";
    let params = [driver_id];

    if (condition === "empty") {
      selectTypeCondition = `st.type = 'EMPTY_RETURN'`;
      updateTypeCondition = `st.type = 'EMPTY_RETURN'`;
    } else if (condition === "normal") {
      selectTypeCondition = `st.type = 'PURCHASE_RETURN' AND st.is_defective = 0`;
      updateTypeCondition = `st.type = 'PURCHASE_RETURN' AND st.is_defective = 0`;
    } else if (condition === "defective") {
      selectTypeCondition = `st.type = 'PURCHASE_RETURN' AND st.is_defective = 1`;
      updateTypeCondition = `st.type = 'PURCHASE_RETURN' AND st.is_defective = 1`;
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid condition",
      });
    }

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `
      SELECT st.id, st.product_id, st.quantity, st.type, st.is_defective
      FROM stock_transactions st
      LEFT JOIN sales linked_sale
        ON linked_sale.id = st.reference_id
       AND linked_sale.driver_id = st.driver_id
      WHERE st.driver_id = ?
        AND st.isApproved = 0
        AND (
          st.type <> 'EMPTY_RETURN'
          OR linked_sale.id IS NULL
        )
        AND ${selectTypeCondition}
      `,
      params
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No pending returns found",
      });
    }

    for (const row of rows) {
      if (condition === "empty") {
        await increaseStock(connection, {
          productId: Number(row.product_id),
          emptyQuantity: Number(row.quantity || 0),
        });
      }

      if (condition === "normal") {
        await increaseStock(connection, {
          productId: Number(row.product_id),
          quantity: Number(row.quantity || 0),
        });
      }

      if (condition === "defective") {
        await increaseStock(connection, {
          productId: Number(row.product_id),
          defectiveQuantity: Number(row.quantity || 0),
        });
      }
    }

    await connection.execute(
      `
      UPDATE stock_transactions st
      SET isApproved = 1
      WHERE st.driver_id = ?
        AND st.isApproved = 0
        AND (
          st.type <> 'EMPTY_RETURN'
          OR st.reference_id IS NULL
          OR st.reference_id NOT IN (
            SELECT id FROM sales WHERE driver_id = ?
          )
        )
        AND ${updateTypeCondition}
      `,
      [driver_id, driver_id]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: `${condition} returns approved successfully`,
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveReturnByCondition error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to approve returns",
    });
  } finally {
    connection.release();
  }
};


export const cancelStockOutLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { loadId } = req.params;

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `
      SELECT
        id,
        product_id,
        quantity,
        type,
        is_defective,
        isApproved
      FROM stock_transactions
      WHERE COALESCE(reference_id, driver_id) = ?
        AND stock_from IN ('godown', 'stock_out')
        AND isApproved = 1
        AND (
          type = 'EMPTY_RETURN'
          OR (type = 'PURCHASE_RETURN' AND is_defective = 1)
        )
      `,
      [loadId]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No approved stock out load found to cancel",
      });
    }

    for (const row of rows) {
      const productId = Number(row.product_id);
      const qty = Number(row.quantity || 0);

      if (row.type === "EMPTY_RETURN") {
        await increaseStock(connection, {
          productId,
          emptyQuantity: qty,
        });
      }

      if (row.type === "PURCHASE_RETURN" && Number(row.is_defective) === 1) {
        await increaseStock(connection, {
          productId,
          defectiveQuantity: qty,
        });
      }
    }

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = 2
      WHERE COALESCE(reference_id, driver_id) = ?
        AND stock_from IN ('godown', 'stock_out')
        AND isApproved = 1
        AND (
          type = 'EMPTY_RETURN'
          OR (type = 'PURCHASE_RETURN' AND is_defective = 1)
        )
      `,
      [loadId]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: "Stock out load cancelled successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("cancelStockOutLoad error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to cancel stock out load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getCommercialDriverBookings = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "ALL").toUpperCase();

    const params = [];
    let searchFilter = "";
    let statusFilter = "";

    if (search) {
      searchFilter = `
        AND (
          du.name LIKE ?
          OR cu.name LIKE ?
          OR CAST(s.id AS CHAR) LIKE ?
        )
      `;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (status === "PENDING") {
      statusFilter = `AND st.isApproved = 0`;
    }

    if (status === "DONE") {
      statusFilter = `AND st.isApproved = 1`;
    }

    const [rows] = await db.execute(
      `
      SELECT
        s.id AS booking_id,
        s.status AS booking_status,
        s.total_amount,
        s.created_at,

        d.id AS driver_id,
        d.vehicle_number,
        du.name AS driver_name,
        du.phone AS driver_phone,

        cu.name AS customer_name,
        cu.phone AS customer_phone,
        a.address,

        st.id AS stock_transaction_id,
        st.product_id,
        st.quantity,
        st.isApproved,

        p.name AS product_name,
        p.type AS product_type,
        p.price AS product_price
      FROM stock_transactions st
      INNER JOIN sales s
        ON s.id = st.reference_id
      INNER JOIN drivers d
        ON d.id = st.driver_id
      INNER JOIN users du
        ON du.id = d.user_id
      INNER JOIN users cu
        ON cu.id = s.customer_id
      LEFT JOIN addresses a
        ON a.id = s.address_id
      INNER JOIN products p
        ON p.id = st.product_id
      WHERE s.sale_type = 'BOOKING'
        AND p.type = 'COMMERCIAL'
        AND st.type = 'BOOKING_ADD'
        AND st.stock_from = 'godown'
        ${searchFilter}
        ${statusFilter}
      ORDER BY du.name ASC, s.created_at DESC, s.id DESC
      `,
      params
    );

    const bookingMap = new Map();

    rows.forEach((row) => {
      const bookingId = Number(row.booking_id);

      if (!bookingMap.has(bookingId)) {
        bookingMap.set(bookingId, {
          bookingId,
          status: row.booking_status,
          isApproved: Number(row.isApproved || 0),
          totalAmount: Number(row.total_amount || 0),
          createdAt: row.created_at,
          driverId: Number(row.driver_id),
          driverName: row.driver_name || "Unknown Driver",
          driverPhone: row.driver_phone || "",
          vehicleNumber: row.vehicle_number || "N/A",
          customerName: row.customer_name || "Unknown Customer",
          customerPhone: row.customer_phone || "",
          address: row.address || "",
          totalQty: 0,
          items: [],
        });
      }

      const booking = bookingMap.get(bookingId);

      booking.totalQty += Number(row.quantity || 0);

      booking.items.push({
        stockTransactionId: Number(row.stock_transaction_id),
        productId: Number(row.product_id),
        productName: row.product_name,
        productType: row.product_type,
        quantity: Number(row.quantity || 0),
        price: Number(row.product_price || 0),
      });
    });

    const bookings = Array.from(bookingMap.values());
    const driverMap = new Map();

    bookings.forEach((booking) => {
      if (!driverMap.has(booking.driverId)) {
        driverMap.set(booking.driverId, {
          driverId: booking.driverId,
          driverName: booking.driverName,
          driverPhone: booking.driverPhone,
          vehicleNumber: booking.vehicleNumber,
          totalBookings: 0,
          totalCylinders: 0,
          openBookings: 0,
          bookings: [],
        });
      }

      const driver = driverMap.get(booking.driverId);
      driver.totalBookings += 1;
      driver.totalCylinders += booking.totalQty;

      if (Number(booking.isApproved) === 0) {
        driver.openBookings += 1;
      }

      driver.bookings.push(booking);
    });

    const drivers = Array.from(driverMap.values());

    return res.json({
      success: true,
      data: {
        summary: {
          bookings: bookings.length,
          cylinders: bookings.reduce((sum, item) => sum + item.totalQty, 0),
          drivers: drivers.length,
        },
        drivers,
      },
    });
  } catch (error) {
    console.error("getCommercialDriverBookings error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch commercial bookings",
      error: error.message,
    });
  }
};

export const approveCommercialDriverBooking = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const bookingId = Number(req.params.bookingId);

    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: "bookingId is required",
      });
    }

    await connection.beginTransaction();

    const [bookingRows] = await connection.execute(
      `
      SELECT id, status
      FROM sales
      WHERE id = ?
        AND sale_type = 'BOOKING'
      FOR UPDATE
      `,
      [bookingId]
    );

    if (!bookingRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    if (bookingRows[0].status !== "PENDING") {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Only pending bookings can be approved",
      });
    }

    const [transactions] = await connection.execute(
      `
      SELECT
        st.id,
        st.product_id,
        st.quantity
      FROM stock_transactions st
      WHERE st.reference_id = ?
        AND st.type = 'BOOKING_ADD'
        AND st.stock_from = 'godown'
        AND st.isApproved = 0
      FOR UPDATE
      `,
      [bookingId]
    );

    if (!transactions.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "No pending booking stock transaction found",
      });
    }

    const requiredByProduct = new Map();

    transactions.forEach((row) => {
      const productId = Number(row.product_id);
      const qty = Number(row.quantity || 0);
      requiredByProduct.set(
        productId,
        Number(requiredByProduct.get(productId) || 0) + qty
      );
    });

    for (const [productId, requiredQty] of requiredByProduct.entries()) {
      const availableQty = await getAvailableStockForUpdate(connection, productId);

      if (availableQty < requiredQty) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for product ${productId}. Available ${availableQty}, required ${requiredQty}`,
        });
      }
    }

    for (const row of transactions) {
      await consumeStockQuantity(
        connection,
        Number(row.product_id),
        Number(row.quantity || 0)
      );
    }

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = 1
      WHERE reference_id = ?
        AND type = 'BOOKING_ADD'
        AND stock_from = 'godown'
      `,
      [bookingId]
    );

    await connection.execute(
      `
      UPDATE sales
      SET status = 'ASSIGNED',
          assigned_at = NOW(),
          updated_at = NOW()
      WHERE id = ?
      `,
      [bookingId]
    );

    await connection.execute(
      `
      UPDATE sales_items
      SET status = 'ASSIGNED'
      WHERE sale_id = ?
      `,
      [bookingId]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: "Booking approved successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveCommercialDriverBooking error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to approve booking",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};