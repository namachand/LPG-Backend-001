import db from "../config/db.js";
const DEFAULT_PURCHASE_STOCK_AREA_ID = 2;
const purchaseTripColumnCache = new Map();

const hasPurchaseTripColumn = async (connection, columnName) => {
  if (purchaseTripColumnCache.has(columnName)) {
    return purchaseTripColumnCache.get(columnName);
  }

  const [rows] = await connection.query(
    `
    SELECT 1 AS has_column
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'purchase_trips'
      AND COLUMN_NAME = ?
    LIMIT 1
    `,
    [columnName]
  );

  const exists = rows.length > 0;
  purchaseTripColumnCache.set(columnName, exists);
  return exists;
};

const formatTripStatus = (status) => {
  switch (status) {
    case "IN_PROGRESS":
      return "IN_PROGRESS";
    case "WAITING_APPROVAL":
      return "WAITING_APPROVAL";
    case "APPROVED":
      return "APPROVED";
    case "COMPLETED":
      return "COMPLETED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return status;
  }
};

const getFirstPurchaseManager = async (connection) => {
  const [rows] = await connection.query(
    `
    SELECT id, name, company_name, phone
    FROM users
    WHERE role = 'PURCHASE_MANAGER'
    ORDER BY id ASC
    LIMIT 1
    `
  );

  return rows[0] || null;
};

const getDefaultStockArea = async (connection) => {
  const [preferredRows] = await connection.query(
    `
    SELECT id, name
    FROM stock_areas
    WHERE id = ?
    LIMIT 1
    `,
    [DEFAULT_PURCHASE_STOCK_AREA_ID]
  );

  if (preferredRows.length) {
    return preferredRows[0];
  }

  const [rows] = await connection.query(
    `
    SELECT id, name
    FROM stock_areas
    ORDER BY id ASC
    LIMIT 1
    `
  );

  return rows[0] || null;
};

const derivePurchaseLoadType = (productRows) => {
  const uniqueTypes = [...new Set(productRows.map((row) => row.type))];

  if (uniqueTypes.length === 1) {
    return uniqueTypes[0];
  }

  return "MIXED";
};

const getTripOverview = async (connection, tripId) => {
  const hasEndOdometerReading = await hasPurchaseTripColumn(
    connection,
    "end_odometer_reading"
  );
  const hasEndOdometerImage = await hasPurchaseTripColumn(
    connection,
    "end_odometer_image_url"
  );

  const [tripRows] = await connection.query(
    `
    SELECT
      pt.id,
      pt.purchase_manager_id,
      pt.stock_area_id,
      pt.odometer_reading,
      ${hasEndOdometerReading ? "pt.end_odometer_reading" : "NULL"} AS end_odometer_reading,
      pt.odometer_image_url,
      ${hasEndOdometerImage ? "pt.end_odometer_image_url" : "NULL"} AS end_odometer_image_url,
      pt.status,
      pt.started_at,
      pt.ended_at,
      sa.name AS stock_area_name,
      u.name AS purchase_manager_name
    FROM purchase_trips pt
    JOIN users u ON u.id = pt.purchase_manager_id
    LEFT JOIN stock_areas sa ON sa.id = pt.stock_area_id
    WHERE pt.id = ?
    `,
    [tripId]
  );

  if (!tripRows.length) {
    return null;
  }

  const trip = tripRows[0];

  const [loadRows] = await connection.query(
    `
    SELECT
      pl.id,
      pl.product_type,
      pl.invoice_url,
      pl.invoice_source,
      pl.total_quantity,
      pl.status,
      pl.created_at,
      COUNT(pli.id) AS items_count
    FROM purchase_loads pl
    LEFT JOIN purchase_load_items pli ON pli.load_id = pl.id
    WHERE pl.trip_id = ?
    GROUP BY pl.id, pl.product_type, pl.invoice_url, pl.invoice_source, pl.total_quantity, pl.status, pl.created_at
    ORDER BY pl.created_at DESC, pl.id DESC
    `,
    [tripId]
  );

  const [expenseRows] = await connection.query(
    `
    SELECT
      id,
      category,
      description,
      amount,
      bill_url,
      status,
      created_at
    FROM expenses
    WHERE created_by = ?
      AND created_at >= ?
      AND (? IS NULL OR created_at <= ?)
    ORDER BY created_at DESC, id DESC
    `,
    [trip.purchase_manager_id, trip.started_at, trip.ended_at, trip.ended_at]
  );

  return {
    id: trip.id,
    purchaseManagerId: trip.purchase_manager_id,
    purchaseManagerName: trip.purchase_manager_name,
    stockAreaId: trip.stock_area_id,
    stockAreaName: trip.stock_area_name,
    odometerReading: Number(trip.odometer_reading || 0),
    endOdometerReading: trip.end_odometer_reading
      ? Number(trip.end_odometer_reading)
      : null,
    odometerImageUrl: trip.odometer_image_url,
    endOdometerImageUrl: trip.end_odometer_image_url,
    status: trip.status,
    startedAt: trip.started_at,
    endedAt: trip.ended_at,
    loads: loadRows.map((row) => ({
      id: row.id,
      productType: row.product_type,
      invoiceUrl: row.invoice_url,
      invoiceSource: row.invoice_source,
      totalQuantity: Number(row.total_quantity || 0),
      itemsCount: Number(row.items_count || 0),
      status: row.status,
      createdAt: row.created_at,
    })),
    expenses: expenseRows.map((row) => ({
      id: row.id,
      category: row.category,
      description: row.description,
      amount: Number(row.amount || 0),
      billUrl: row.bill_url,
      status: row.status,
      createdAt: row.created_at,
    })),
  };
};

export const getPurchaseBootstrap = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const [manager, stockArea, productRows] = await Promise.all([
      getFirstPurchaseManager(connection),
      getDefaultStockArea(connection),
      connection.query(
        `
        SELECT
          p.id,
          p.name,
          p.type,
          c.name AS category_name
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        ORDER BY p.type ASC, p.name ASC
        `
      ),
    ]);

    if (!manager) {
      return res.status(404).json({
        success: false,
        message: "No purchase manager user found",
      });
    }

    const productList = productRows[0];

    return res.json({
      success: true,
      data: {
        manager: {
          id: manager.id,
          name: manager.name,
          companyName: manager.company_name,
          phone: manager.phone,
          vehicleLabel: "TN 09 AB 1234 - 14T Truck",
        },
        defaultStockArea: stockArea,
        products: {
          domestic: productList
            .filter((item) => item.type === "DOMESTIC")
            .map((item) => ({
              id: item.id,
              name: item.name,
              category: item.category_name,
              type: item.type,
            })),
          commercial: productList
            .filter((item) => item.type === "COMMERCIAL")
            .map((item) => ({
              id: item.id,
              name: item.name,
              category: item.category_name,
              type: item.type,
            })),
        },
      },
    });
  } catch (error) {
    console.error("getPurchaseBootstrap error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load purchase bootstrap data",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getPurchaseDashboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.query.userId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const [summaryRows] = await connection.query(
      `
      SELECT
        (
          SELECT COALESCE(COUNT(*), 0)
          FROM purchase_loads pl
          JOIN purchase_trips pt ON pt.id = pl.trip_id
          WHERE pt.purchase_manager_id = ?
            AND pl.status = 'PENDING'
        ) AS pendingLoadApproval,
        (
          SELECT COALESCE(SUM(e.amount), 0)
          FROM expenses e
          WHERE e.created_by = ?
            AND e.status = 'PENDING'
        ) AS pendingExpenses,
        (
          SELECT COALESCE(COUNT(*), 0)
          FROM purchase_trips pt
          WHERE pt.purchase_manager_id = ?
            AND pt.status IN ('APPROVED', 'COMPLETED')
            AND YEAR(pt.started_at) = YEAR(CURDATE())
            AND MONTH(pt.started_at) = MONTH(CURDATE())
        ) AS completedTrips
      `,
      [userId, userId, userId]
    );

    const [recentRows] = await connection.query(
      `
      SELECT
        pt.id,
        pt.status,
        pt.started_at,
        (
          SELECT COUNT(*)
          FROM purchase_loads pl
          WHERE pl.trip_id = pt.id
            AND pl.status <> 'CANCELLED'
        ) AS loads_count,
        (
          SELECT COUNT(*)
          FROM expenses e
          WHERE e.created_by = pt.purchase_manager_id
            AND e.created_at >= pt.started_at
            AND (pt.ended_at IS NULL OR e.created_at <= pt.ended_at)
        ) AS expenses_count
      FROM purchase_trips pt
      WHERE pt.purchase_manager_id = ?
      ORDER BY pt.started_at DESC, pt.id DESC
      LIMIT 10
      `,
      [userId]
    );

    const [activeRows] = await connection.query(
      `
      SELECT id
      FROM purchase_trips
      WHERE purchase_manager_id = ?
        AND status = 'IN_PROGRESS'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
      `,
      [userId]
    );

    const activeTrip = activeRows.length
      ? await getTripOverview(connection, activeRows[0].id)
      : null;

    return res.json({
      success: true,
      data: {
        summary: {
          pendingLoadApproval: Number(summaryRows[0]?.pendingLoadApproval || 0),
          pendingExpenses: Number(summaryRows[0]?.pendingExpenses || 0),
          completedTrips: Number(summaryRows[0]?.completedTrips || 0),
        },
        activeTrip,
        recentTrips: recentRows.map((row) => ({
          id: row.id,
          loads: Number(row.loads_count || 0),
          expenses: Number(row.expenses_count || 0),
          status: formatTripStatus(row.status),
          startedAt: row.started_at,
        })),
      },
    });
  } catch (error) {
    console.error("getPurchaseDashboard error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase dashboard",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const startPurchaseTrip = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      userId,
      stockAreaId = null,
      odometerReading,
      odometerImageUrl = null,
    } = req.body || {};

    const parsedUserId = Number(userId);
    const parsedOdometer = Number(odometerReading);
    const parsedStockAreaId = stockAreaId ? Number(stockAreaId) : DEFAULT_PURCHASE_STOCK_AREA_ID;

    if (!parsedUserId || !Number.isFinite(parsedOdometer) || parsedOdometer <= 0) {
      return res.status(400).json({
        success: false,
        message: "userId and a valid odometerReading are required",
      });
    }

    const [existingRows] = await connection.query(
      `
      SELECT id
      FROM purchase_trips
      WHERE purchase_manager_id = ?
        AND status = 'IN_PROGRESS'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
      `,
      [parsedUserId]
    );

    if (existingRows.length) {
      return res.status(409).json({
        success: false,
        message: "An active purchase trip already exists",
        data: await getTripOverview(connection, existingRows[0].id),
      });
    }

    const [result] = await connection.query(
      `
      INSERT INTO purchase_trips (purchase_manager_id, stock_area_id, odometer_reading, odometer_image_url, status)
      VALUES (?, ?, ?, ?, 'IN_PROGRESS')
      `,
      [parsedUserId, parsedStockAreaId, parsedOdometer, odometerImageUrl]
    );

    return res.status(201).json({
      success: true,
      message: "Purchase trip started successfully",
      data: await getTripOverview(connection, result.insertId),
    });
  } catch (error) {
    console.error("startPurchaseTrip error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to start purchase trip",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getActivePurchaseTrip = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.query.userId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const [rows] = await connection.query(
      `
      SELECT id
      FROM purchase_trips
      WHERE purchase_manager_id = ?
        AND status = 'IN_PROGRESS'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
      `,
      [userId]
    );

    return res.json({
      success: true,
      data: rows.length ? await getTripOverview(connection, rows[0].id) : null,
    });
  } catch (error) {
    console.error("getActivePurchaseTrip error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch active purchase trip",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getPurchaseTrips = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.query.userId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const [rows] = await connection.query(
      `
      SELECT
        pt.id,
        pt.status,
        pt.odometer_reading,
        pt.started_at,
        pt.ended_at,
        (
          SELECT COUNT(*)
          FROM purchase_loads pl
          WHERE pl.trip_id = pt.id
            AND pl.status <> 'CANCELLED'
        ) AS loads_count,
        (
          SELECT COUNT(*)
          FROM expenses e
          WHERE e.created_by = pt.purchase_manager_id
            AND e.created_at >= pt.started_at
            AND (pt.ended_at IS NULL OR e.created_at <= pt.ended_at)
        ) AS expenses_count,
        (
          SELECT COALESCE(SUM(pl.total_quantity), 0)
          FROM purchase_loads pl
          WHERE pl.trip_id = pt.id
            AND pl.status <> 'CANCELLED'
        ) AS total_cylinders,
        (
          SELECT COALESCE(SUM(e.amount), 0)
          FROM expenses e
          WHERE e.created_by = pt.purchase_manager_id
            AND e.created_at >= pt.started_at
            AND (pt.ended_at IS NULL OR e.created_at <= pt.ended_at)
        ) AS total_expenses
      FROM purchase_trips pt
      WHERE pt.purchase_manager_id = ?
      ORDER BY pt.started_at DESC, pt.id DESC
      `,
      [userId]
    );

    return res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        status: formatTripStatus(row.status),
        startKm: Number(row.odometer_reading || 0),
        startedAt: row.started_at,
        endedAt: row.ended_at,
        loadsCount: Number(row.loads_count || 0),
        totalCylinders: Number(row.total_cylinders || 0),
        expensesCount: Number(row.expenses_count || 0),
        totalExpenses: Number(row.total_expenses || 0),
      })),
    });
  } catch (error) {
    console.error("getPurchaseTrips error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase trips",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getPurchaseLoads = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.query.userId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const [rows] = await connection.query(
      `
      SELECT
        pl.id,
        pl.trip_id,
        pl.product_type,
        pl.invoice_url,
        pl.invoice_source,
        pl.total_quantity,
        pl.status,
        pl.created_at,
        pt.status AS trip_status,
        COUNT(pli.id) AS items_count
      FROM purchase_loads pl
      JOIN purchase_trips pt ON pt.id = pl.trip_id
      LEFT JOIN purchase_load_items pli ON pli.load_id = pl.id
      WHERE pt.purchase_manager_id = ?
      GROUP BY pl.id, pl.trip_id, pl.product_type, pl.invoice_url, pl.invoice_source, pl.total_quantity, pl.status, pl.created_at, pt.status
      ORDER BY pl.created_at DESC, pl.id DESC
      `,
      [userId]
    );

    return res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        tripId: row.trip_id,
        productType: row.product_type,
        invoiceUrl: row.invoice_url,
        invoiceSource: row.invoice_source,
        totalQuantity: Number(row.total_quantity || 0),
        itemsCount: Number(row.items_count || 0),
        status: row.status,
        tripStatus: formatTripStatus(row.trip_status),
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error("getPurchaseLoads error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase loads",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getPurchaseLoadDetail = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);

    if (!loadId) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    const [rows] = await connection.query(
      `
      SELECT
        pl.id,
        pl.trip_id,
        pl.product_type,
        pl.invoice_url,
        pl.invoice_source,
        pl.total_quantity,
        pl.status,
        pl.created_at,
        pt.status AS trip_status,
        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type_name,
        c.name AS category_name,
        pli.quantity
      FROM purchase_loads pl
      JOIN purchase_trips pt ON pt.id = pl.trip_id
      LEFT JOIN purchase_load_items pli ON pli.load_id = pl.id
      LEFT JOIN products p ON p.id = pli.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE pl.id = ?
      ORDER BY pli.id ASC
      `,
      [loadId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Purchase load not found",
      });
    }

    return res.json({
      success: true,
      data: {
        id: rows[0].id,
        tripId: rows[0].trip_id,
        productType: rows[0].product_type,
        invoiceUrl: rows[0].invoice_url,
        invoiceSource: rows[0].invoice_source,
        totalQuantity: Number(rows[0].total_quantity || 0),
        status: rows[0].status,
        tripStatus: formatTripStatus(rows[0].trip_status),
        createdAt: rows[0].created_at,
        items: rows
          .filter((row) => row.product_id)
          .map((row) => ({
            productId: row.product_id,
            name: row.product_name,
            type: row.product_type_name,
            category: row.category_name,
            quantity: Number(row.quantity || 0),
          })),
      },
    });
  } catch (error) {
    console.error("getPurchaseLoadDetail error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase load detail",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createPurchaseLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { tripId, createdBy, stockAreaId, items } = req.body || {};

    const parsedTripId = Number(tripId);
    const parsedCreatedBy = Number(createdBy);
    const parsedStockAreaId =
      stockAreaId === undefined || stockAreaId === null || stockAreaId === ""
        ? null
        : Number(stockAreaId);

    if (
      !parsedTripId ||
      !parsedCreatedBy ||
      !Array.isArray(items) ||
      !items.length
    ) {
      return res.status(400).json({
        success: false,
        message: "tripId, createdBy and items are required",
      });
    }

    const normalizedItems = items
      .map((item) => ({
        productId: Number(item.productId),
        quantity: Number(item.quantity),
      }))
      .filter((item) => item.productId && Number.isFinite(item.quantity) && item.quantity > 0);

    if (!normalizedItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one valid item is required",
      });
    }

    const [tripRows] = await connection.query(
      `
      SELECT id, status, stock_area_id
      FROM purchase_trips
      WHERE id = ?
      `,
      [parsedTripId]
    );

    if (!tripRows.length) {
      return res.status(404).json({
        success: false,
        message: "Trip not found",
      });
    }

    if (tripRows[0].status !== "IN_PROGRESS") {
      return res.status(400).json({
        success: false,
        message: "Loads can only be added while the trip is in progress",
      });
    }

    const effectiveStockAreaId =
      parsedStockAreaId ??
      (tripRows[0].stock_area_id ? Number(tripRows[0].stock_area_id) : DEFAULT_PURCHASE_STOCK_AREA_ID);

    if (effectiveStockAreaId !== null) {
      const [stockAreaRows] = await connection.query(
        `
        SELECT id
        FROM stock_areas
        WHERE id = ?
        LIMIT 1
        `,
        [effectiveStockAreaId]
      );

      if (!stockAreaRows.length) {
        return res.status(400).json({
          success: false,
          message: "Invalid stockAreaId. Selected stock area does not exist",
        });
      }
    }

    const productIds = normalizedItems.map((item) => item.productId);
    const placeholders = productIds.map(() => "?").join(",");
    const [productRows] = await connection.query(
      `
      SELECT id, type
      FROM products
      WHERE id IN (${placeholders})
      `,
      productIds
    );

    if (productRows.length !== normalizedItems.length) {
      return res.status(400).json({
        success: false,
        message: "One or more products were not found",
      });
    }

    await connection.beginTransaction();

    const totalQuantity = normalizedItems.reduce(
      (sum, item) => sum + item.quantity,
      0
    );
    const loadProductType = derivePurchaseLoadType(productRows);

    const [loadResult] = await connection.query(
      `
      INSERT INTO purchase_loads (trip_id, created_by, stock_area_id, product_type, total_quantity, status)
      VALUES (?, ?, ?, ?, ?, 'DRAFT')
      `,
      [parsedTripId, parsedCreatedBy, effectiveStockAreaId, loadProductType, totalQuantity]
    );

    const loadId = loadResult.insertId;

    for (const item of normalizedItems) {
      await connection.query(
        `
        INSERT INTO purchase_load_items (load_id, product_id, quantity)
        VALUES (?, ?, ?)
        `,
        [loadId, item.productId, item.quantity]
      );

      if (effectiveStockAreaId !== null) {
        await connection.query(
          `
          INSERT INTO stock_transactions (
            product_id,
            stock_area_id,
            type,
            quantity,
            isApproved,
            reference_id,
            created_by,
            stock_from
          )
          VALUES (?, ?, 'PURCHASE', ?, 0, ?, ?, 'depot')
          `,
          [item.productId, effectiveStockAreaId, item.quantity, loadId, parsedCreatedBy]
        );

        await connection.query(
          `
          INSERT INTO stock (product_id, stock_area_id, quantity, quantity_return, empty_quantity, defective_quantity)
          VALUES (?, ?, 0, 0, 0, 0)
          ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP
          `,
          [item.productId, effectiveStockAreaId]
        );
      }
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Purchase load created successfully",
      data: await getPurchaseLoadDetailData(connection, loadId),
    });
  } catch (error) {
    await connection.rollback();
    console.error("createPurchaseLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create purchase load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const updatePurchaseLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);
    const { stockAreaId, items } = req.body || {};

    const parsedStockAreaId =
      stockAreaId === undefined || stockAreaId === null || stockAreaId === ""
        ? null
        : Number(stockAreaId);

    if (
      !loadId ||
      !Array.isArray(items) ||
      !items.length
    ) {
      return res.status(400).json({
        success: false,
        message: "loadId and items are required",
      });
    }

    const normalizedItems = items
      .map((item) => ({
        productId: Number(item.productId),
        quantity: Number(item.quantity),
      }))
      .filter((item) => item.productId && Number.isFinite(item.quantity) && item.quantity > 0);

    if (!normalizedItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one valid item is required",
      });
    }

    const [loadRows] = await connection.query(
      `
      SELECT pl.id, pl.trip_id, pl.created_by, pl.stock_area_id, pl.status, pt.status AS trip_status, pt.stock_area_id AS trip_stock_area_id
      FROM purchase_loads pl
      JOIN purchase_trips pt ON pt.id = pl.trip_id
      WHERE pl.id = ?
      `,
      [loadId]
    );

    if (!loadRows.length) {
      return res.status(404).json({
        success: false,
        message: "Purchase load not found",
      });
    }

    if (loadRows[0].trip_status !== "IN_PROGRESS") {
      return res.status(400).json({
        success: false,
        message: "Loads can only be edited while the trip is in progress",
      });
    }

    if (loadRows[0].status !== "DRAFT") {
      return res.status(400).json({
        success: false,
        message: "Only draft loads can be edited",
      });
    }

    const effectiveStockAreaId =
      parsedStockAreaId ??
      (loadRows[0].trip_stock_area_id
        ? Number(loadRows[0].trip_stock_area_id)
        : loadRows[0].stock_area_id
          ? Number(loadRows[0].stock_area_id)
          : DEFAULT_PURCHASE_STOCK_AREA_ID);

    if (effectiveStockAreaId !== null) {
      const [stockAreaRows] = await connection.query(
        `
        SELECT id
        FROM stock_areas
        WHERE id = ?
        LIMIT 1
        `,
        [effectiveStockAreaId]
      );

      if (!stockAreaRows.length) {
        return res.status(400).json({
          success: false,
          message: "Invalid stockAreaId. Selected stock area does not exist",
        });
      }
    }

    const productIds = normalizedItems.map((item) => item.productId);
    const placeholders = productIds.map(() => "?").join(",");
    const [productRows] = await connection.query(
      `
      SELECT id, type
      FROM products
      WHERE id IN (${placeholders})
      `,
      productIds
    );

    if (productRows.length !== normalizedItems.length) {
      return res.status(400).json({
        success: false,
        message: "One or more products were not found",
      });
    }

    await connection.beginTransaction();

    const totalQuantity = normalizedItems.reduce((sum, item) => sum + item.quantity, 0);
    const loadProductType = derivePurchaseLoadType(productRows);

    await connection.query(
      `
      UPDATE purchase_loads
      SET stock_area_id = ?, product_type = ?, total_quantity = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      [effectiveStockAreaId, loadProductType, totalQuantity, loadId]
    );

    await connection.query(
      `
      DELETE FROM purchase_load_items
      WHERE load_id = ?
      `,
      [loadId]
    );

    await connection.query(
      `
      DELETE FROM stock_transactions
      WHERE type = 'PURCHASE'
        AND reference_id = ?
        AND isApproved = 0
      `,
      [loadId]
    );

    for (const item of normalizedItems) {
      await connection.query(
        `
        INSERT INTO purchase_load_items (load_id, product_id, quantity)
        VALUES (?, ?, ?)
        `,
        [loadId, item.productId, item.quantity]
      );

      if (effectiveStockAreaId !== null) {
        await connection.query(
          `
          INSERT INTO stock_transactions (
            product_id,
            stock_area_id,
            type,
            quantity,
            isApproved,
            reference_id,
            created_by,
            stock_from
          )
          VALUES (?, ?, 'PURCHASE', ?, 0, ?, ?, 'depot')
          `,
          [
            item.productId,
            effectiveStockAreaId,
            item.quantity,
            loadId,
            Number(loadRows[0].created_by),
          ]
        );

        await connection.query(
          `
          INSERT INTO stock (product_id, stock_area_id, quantity, quantity_return, empty_quantity, defective_quantity)
          VALUES (?, ?, 0, 0, 0, 0)
          ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP
          `,
          [item.productId, effectiveStockAreaId]
        );
      }
    }

    await connection.commit();

    return res.json({
      success: true,
      message: "Purchase load updated successfully",
      data: await getPurchaseLoadDetailData(connection, loadId),
    });
  } catch (error) {
    await connection.rollback();
    console.error("updatePurchaseLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update purchase load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

const getPurchaseLoadDetailData = async (connection, loadId) => {
  const [rows] = await connection.query(
    `
    SELECT
      pl.id,
      pl.trip_id,
      pl.product_type,
      pl.invoice_url,
      pl.invoice_source,
      pl.total_quantity,
      pl.status,
      pl.created_at,
      pt.status AS trip_status,
      p.id AS product_id,
      p.name AS product_name,
      p.type AS product_type_name,
      c.name AS category_name,
      pli.quantity
    FROM purchase_loads pl
    JOIN purchase_trips pt ON pt.id = pl.trip_id
    LEFT JOIN purchase_load_items pli ON pli.load_id = pl.id
    LEFT JOIN products p ON p.id = pli.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE pl.id = ?
    ORDER BY pli.id ASC
    `,
    [loadId]
  );

  if (!rows.length) {
    return null;
  }

  return {
    id: rows[0].id,
    tripId: rows[0].trip_id,
    productType: rows[0].product_type,
    invoiceUrl: rows[0].invoice_url,
    invoiceSource: rows[0].invoice_source,
    totalQuantity: Number(rows[0].total_quantity || 0),
    status: rows[0].status,
    tripStatus: formatTripStatus(rows[0].trip_status),
    createdAt: rows[0].created_at,
    items: rows
      .filter((row) => row.product_id)
      .map((row) => ({
        productId: row.product_id,
        name: row.product_name,
        type: row.product_type_name,
        category: row.category_name,
        quantity: Number(row.quantity || 0),
      })),
  };
};

/**
 * Marks in-progress stock_transactions as waiting-approval for a load.
 * Must be called inside an active transaction.
 */
const _markLoadStockWaiting = async (connection, loadId) => {
  await connection.query(
    `
    UPDATE stock_transactions
    SET isApproved = 2
    WHERE type = 'PURCHASE'
      AND reference_id = ?
      AND isApproved = 0
    `,
    [loadId]
  );
};

/**
 * Approves waiting stock_transactions for a load and updates the stock table.
 * Must be called inside an active transaction.
 */
const _approveLoadStock = async (connection, loadId) => {
  const [txRows] = await connection.query(
    `
    SELECT id, product_id, stock_area_id, quantity
    FROM stock_transactions
    WHERE type = 'PURCHASE'
      AND reference_id = ?
      AND isApproved = 2
    FOR UPDATE
    `,
    [loadId]
  );

  for (const tx of txRows) {
    const productId = Number(tx.product_id);
    const stockAreaId = Number(tx.stock_area_id);
    const qty = Number(tx.quantity || 0);

    const [stockRows] = await connection.query(
      `
      SELECT id
      FROM stock
      WHERE product_id = ? AND stock_area_id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [productId, stockAreaId]
    );

    if (stockRows.length) {
      await connection.query(
        `UPDATE stock SET quantity = quantity + ? WHERE product_id = ? AND stock_area_id = ?`,
        [qty, productId, stockAreaId]
      );
    } else {
      await connection.query(
        `INSERT INTO stock (product_id, stock_area_id, quantity, quantity_return, empty_quantity, defective_quantity)
         VALUES (?, ?, ?, 0, 0, 0)`,
        [productId, stockAreaId, qty]
      );
    }
  }

  if (txRows.length) {
    await connection.query(
      `
      UPDATE stock_transactions
      SET isApproved = 1
      WHERE type = 'PURCHASE'
        AND reference_id = ?
        AND isApproved = 2
      `,
      [loadId]
    );
  }
};

export const attachPurchaseLoadInvoice = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);
    const { invoiceUrl = null, invoiceSource = null } = req.body || {};

    if (!loadId) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    const [rows] = await connection.query(
      `
      SELECT pl.id, pl.status, pt.status AS trip_status
      FROM purchase_loads pl
      JOIN purchase_trips pt ON pt.id = pl.trip_id
      WHERE pl.id = ?
      `,
      [loadId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Purchase load not found",
      });
    }

    if (rows[0].trip_status !== "IN_PROGRESS") {
      return res.status(400).json({
        success: false,
        message: "Load can only be submitted while the trip is in progress",
      });
    }

    if (rows[0].status === "APPROVED" || rows[0].status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "This load cannot be submitted again",
      });
    }

    await connection.beginTransaction();

    // 1. Promote load to PENDING with optional invoice
    await connection.query(
      `
      UPDATE purchase_loads
      SET invoice_url = ?, invoice_source = ?, status = 'PENDING'
      WHERE id = ?
      `,
      [invoiceUrl, invoiceSource, loadId]
    );

    // 2. Move stock_transactions to waiting approval for this load
    await _markLoadStockWaiting(connection, loadId);

    await connection.commit();

    return res.json({
      success: true,
      message: "Load submitted for approval successfully",
      data: await getPurchaseLoadDetailData(connection, loadId),
    });
  } catch (error) {
    await connection.rollback();
    console.error("attachPurchaseLoadInvoice error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to submit load for approval",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const cancelPurchaseLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);

    if (!loadId) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    await connection.beginTransaction();

    const [rows] = await connection.query(
      `
      SELECT pl.id, pl.status, pt.status AS trip_status
      FROM purchase_loads pl
      JOIN purchase_trips pt ON pt.id = pl.trip_id
      WHERE pl.id = ?
      `,
      [loadId]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Purchase load not found",
      });
    }

    if (rows[0].trip_status !== "IN_PROGRESS") {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Only in-progress trip loads can be cancelled",
      });
    }

    if (rows[0].status !== "DRAFT") {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Only in-progress (draft) loads can be cancelled",
      });
    }

    await connection.query(
      `
      DELETE FROM stock_transactions
      WHERE type = 'PURCHASE'
        AND reference_id = ?
        AND isApproved IN (0, 2)
      `,
      [loadId]
    );

    await connection.query(
      `
      UPDATE purchase_loads
      SET status = 'CANCELLED'
      WHERE id = ?
      `,
      [loadId]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: "Purchase load cancelled successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("cancelPurchaseLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to cancel purchase load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const submitPurchaseTrip = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const tripId = Number(req.params.tripId);
    const { endOdometerImageUrl = null, endOdometerReading } = req.body || {};
    const parsedEndOdometer = Number(endOdometerReading);

    if (!tripId) {
      return res.status(400).json({
        success: false,
        message: "tripId is required",
      });
    }

    if (!endOdometerImageUrl) {
      return res.status(400).json({
        success: false,
        message: "endOdometerImageUrl is required",
      });
    }

    if (!Number.isFinite(parsedEndOdometer) || parsedEndOdometer <= 0) {
      return res.status(400).json({
        success: false,
        message: "A valid endOdometerReading is required",
      });
    }

    await connection.beginTransaction();

    const [tripRows] = await connection.query(
      `
      SELECT id, status
      FROM purchase_trips
      WHERE id = ?
      `,
      [tripId]
    );

    if (!tripRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Trip not found",
      });
    }

    if (!["IN_PROGRESS", "WAITING_APPROVAL", "APPROVED"].includes(tripRows[0].status)) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Trip is not in a valid state for end odometer submission",
      });
    }

    const [loadRows] = await connection.query(
      `
      SELECT id, status
      FROM purchase_loads
      WHERE trip_id = ?
        AND status <> 'CANCELLED'
      `,
      [tripId]
    );

    if (!loadRows.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Create at least one load before submitting the trip",
      });
    }

    const hasDraftLoad = loadRows.some((load) => load.status === "DRAFT");

    if (hasDraftLoad) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Submit all loads for approval before ending the trip",
      });
    }

    // For every active load: ensure approval pipeline state.
    for (const load of loadRows) {
      if (load.status !== "PENDING" && load.status !== "APPROVED") {
        await connection.query(
          `UPDATE purchase_loads SET status = 'PENDING' WHERE id = ?`,
          [load.id]
        );
      }

      await _markLoadStockWaiting(connection, load.id);
    }

    const nextTripStatus = tripRows[0].status === "APPROVED" ? "APPROVED" : "WAITING_APPROVAL";

    const hasEndOdometerReading = await hasPurchaseTripColumn(
      connection,
      "end_odometer_reading"
    );
    const hasEndOdometerImage = await hasPurchaseTripColumn(
      connection,
      "end_odometer_image_url"
    );

    if (hasEndOdometerReading && hasEndOdometerImage) {
      await connection.query(
        `
        UPDATE purchase_trips
        SET status = ?, ended_at = CURRENT_TIMESTAMP, end_odometer_image_url = ?, end_odometer_reading = ?
        WHERE id = ?
        `,
        [nextTripStatus, endOdometerImageUrl, parsedEndOdometer, tripId]
      );
    } else {
      await connection.query(
        `
        UPDATE purchase_trips
        SET status = ?, ended_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [nextTripStatus, tripId]
      );
    }

    await connection.commit();

    return res.json({
      success: true,
      message: "Trip submitted for approval successfully",
      data: await getTripOverview(connection, tripId),
    });
  } catch (error) {
    await connection.rollback();
    console.error("submitPurchaseTrip error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to submit purchase trip",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getPurchaseExpenses = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.query.userId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const [rows] = await connection.query(
      `
      SELECT
        e.id,
        e.category,
        e.description,
        e.amount,
        e.bill_url,
        e.status,
        e.created_at,
        (
          SELECT pt.id
          FROM purchase_trips pt
          WHERE pt.purchase_manager_id = e.created_by
            AND e.created_at >= pt.started_at
            AND (pt.ended_at IS NULL OR e.created_at <= pt.ended_at)
          ORDER BY pt.started_at DESC
          LIMIT 1
        ) AS trip_id
      FROM expenses e
      WHERE e.created_by = ?
      ORDER BY e.created_at DESC, e.id DESC
      `,
      [userId]
    );

    return res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        tripId: row.trip_id ?? undefined,
        category: row.category,
        description: row.description,
        amount: Number(row.amount || 0),
        billUrl: row.bill_url,
        status: row.status,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error("getPurchaseExpenses error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase expenses",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const syncPurchaseApprovalState = async (connection, loadId) => {
  if (!loadId) {
    return;
  }

  const [loadRows] = await connection.query(
    `
    SELECT id, trip_id
    FROM purchase_loads
    WHERE id = ?
    `,
    [loadId]
  );

  if (!loadRows.length) {
    return;
  }

  const tripId = loadRows[0].trip_id;

  await connection.query(
    `
    UPDATE purchase_loads
    SET status = 'APPROVED'
    WHERE id = ?
    `,
    [loadId]
  );

  const [pendingRows] = await connection.query(
    `
    SELECT COUNT(*) AS pendingCount
    FROM purchase_loads
    WHERE trip_id = ?
      AND status IN ('DRAFT', 'PENDING')
    `,
    [tripId]
  );

  if (Number(pendingRows[0]?.pendingCount || 0) === 0) {
    await connection.query(
      `
      UPDATE purchase_trips
      SET status = 'APPROVED'
      WHERE id = ?
        AND status IN ('WAITING_APPROVAL', 'IN_PROGRESS')
      `,
      [tripId]
    );
  }
};