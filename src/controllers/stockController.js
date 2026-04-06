import db from "../config/db.js";

export const getStockDashboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const offset = (page - 1) * limit;

    const search = (req.query.search || "").trim();
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;
    const stockAreaId = req.query.stockAreaId ? Number(req.query.stockAreaId) : null;

    const categoryFilters = [];
    const categoryFilterParams = [];

    if (search) {
      categoryFilters.push(`CONCAT(c.name, ' ', CASE WHEN p.type = 'DOMESTIC' THEN 'Domestic' ELSE 'Commercial' END) LIKE ?`);
      categoryFilterParams.push(`%${search}%`);
    }

    const categoryWhereClause = categoryFilters.length
      ? `WHERE ${categoryFilters.join(" AND ")}`
      : "";

    const txFilters = [];
    const txParams = [];

    if (startDate) {
      txFilters.push(`st.created_at >= ?`);
      txParams.push(`${startDate} 00:00:00`);
    }

    if (endDate) {
      txFilters.push(`st.created_at <= ?`);
      txParams.push(`${endDate} 23:59:59`);
    }

    if (stockAreaId) {
      txFilters.push(`st.stock_area_id = ?`);
      txParams.push(stockAreaId);
    }

    const txWhereClause = txFilters.length
      ? `WHERE ${txFilters.join(" AND ")}`
      : "";

    const salesFilters = [];
    const salesParams = [];

    if (startDate) {
      salesFilters.push(`s.created_at >= ?`);
      salesParams.push(`${startDate} 00:00:00`);
    }

    if (endDate) {
      salesFilters.push(`s.created_at <= ?`);
      salesParams.push(`${endDate} 23:59:59`);
    }

    const salesWhereClause = salesFilters.length
      ? `WHERE ${salesFilters.join(" AND ")}`
      : "";

    const areaSalesFilter = stockAreaId
      ? `
        AND EXISTS (
          SELECT 1
          FROM stock stk
          WHERE stk.product_id = p.id
            AND stk.stock_area_id = ?
        )
      `
      : "";

    const areaSalesParams = stockAreaId ? [stockAreaId] : [];

    const [summaryRows] = await connection.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN agg.product_type = 'DOMESTIC' THEN agg.net_stock ELSE 0 END), 0) AS domestic,
        COALESCE(SUM(CASE WHEN agg.product_type = 'COMMERCIAL' THEN agg.net_stock ELSE 0 END), 0) AS commercial,
        COALESCE(SUM(CASE WHEN agg.category_name = '5kg' THEN agg.net_stock ELSE 0 END), 0) AS fiveKg
      FROM (
        SELECT
          p.id AS product_id,
          p.type AS product_type,
          c.name AS category_name,
          SUM(
            CASE
              WHEN st.type = 'PURCHASE' THEN st.quantity
              WHEN st.type = 'PURCHASE_RETURN' THEN -st.quantity
              WHEN st.type = 'ADJUSTMENT_ADD' THEN st.quantity
              WHEN st.type = 'ADJUSTMENT_SUBTRACT' THEN -st.quantity
              ELSE 0
            END
          ) AS net_stock
        FROM stock_transactions st
        INNER JOIN products p ON p.id = st.product_id
        INNER JOIN categories c ON c.id = p.category_id
        ${txWhereClause}
        GROUP BY p.id, p.type, c.name
      ) agg
      `,
      [...txParams]
    );

    const [countRows] = await connection.query(
      `
      SELECT COUNT(*) AS total
      FROM (
        SELECT
          c.id,
          p.type
        FROM categories c
        INNER JOIN products p ON p.category_id = c.id
        ${stockAreaId ? "INNER JOIN stock stk ON stk.product_id = p.id AND stk.stock_area_id = ?" : ""}
        ${categoryWhereClause}
        GROUP BY c.id, p.type
      ) x
      `,
      [
        ...(stockAreaId ? [stockAreaId] : []),
        ...categoryFilterParams,
      ]
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.ceil(total / limit);

    const [detailsRows] = await connection.query(
      `
      SELECT
        c.id AS category_id,
        CONCAT(c.name, ' ', CASE WHEN p.type = 'DOMESTIC' THEN 'Domestic' ELSE 'Commercial' END) AS category,

        COALESCE(st.purchase, 0) - COALESCE(st.purchaseReturn, 0) AS opening,
        COALESCE(sa.sales, 0) AS sales,
        COALESCE(sa.salesReturn, 0) AS salesReturn,
        COALESCE(st.purchase, 0) AS purchase,
        COALESCE(st.purchaseReturn, 0) AS purchaseReturn,
        COALESCE(sa.pendingAssigned, 0) + COALESCE(sa.salesReturn, 0) AS systemStock

      FROM categories c
      INNER JOIN products p ON p.category_id = c.id
      ${stockAreaId ? "INNER JOIN stock stk_filter ON stk_filter.product_id = p.id AND stk_filter.stock_area_id = ?" : ""}

      LEFT JOIN (
        SELECT
          p.category_id,
          p.type,
          SUM(CASE WHEN st.type = 'PURCHASE' THEN st.quantity ELSE 0 END) AS purchase,
          SUM(CASE WHEN st.type = 'PURCHASE_RETURN' THEN st.quantity ELSE 0 END) AS purchaseReturn
        FROM stock_transactions st
        INNER JOIN products p ON p.id = st.product_id
        ${txWhereClause}
        GROUP BY p.category_id, p.type
      ) st
        ON st.category_id = c.id
       AND st.type = p.type

      LEFT JOIN (
        SELECT
          p.category_id,
          p.type,
          SUM(CASE WHEN s.status = 'DELIVERED' THEN si.quantity ELSE 0 END) AS sales,
          SUM(CASE WHEN s.status = 'CANCELLED' THEN si.quantity ELSE 0 END) AS salesReturn,
          SUM(CASE WHEN s.status IN ('PENDING', 'ASSIGNED') THEN si.quantity ELSE 0 END) AS pendingAssigned
        FROM sales_items si
        INNER JOIN sales s ON s.id = si.sale_id
        INNER JOIN products p ON p.id = si.product_id
        ${salesWhereClause}
        ${areaSalesFilter}
        GROUP BY p.category_id, p.type
      ) sa
        ON sa.category_id = c.id
       AND sa.type = p.type

      ${categoryWhereClause}
      GROUP BY c.id, c.name, p.type, st.purchase, st.purchaseReturn, sa.sales, sa.salesReturn, sa.pendingAssigned
      ORDER BY c.id, p.type
      LIMIT ?
      OFFSET ?
      `,
      [
        ...(stockAreaId ? [stockAreaId] : []),
        ...txParams,
        ...salesParams,
        ...areaSalesParams,
        ...categoryFilterParams,
        limit,
        offset,
      ]
    );

    return res.status(200).json({
      success: true,
      summary: {
        domestic: Number(summaryRows[0]?.domestic || 0),
        commercial: Number(summaryRows[0]?.commercial || 0),
        fiveKg: Number(summaryRows[0]?.fiveKg || 0),
      },
      data: detailsRows.map((row) => ({
        category_id: row.category_id,
        category: row.category,
        opening: Number(row.opening || 0),
        sales: Number(row.sales || 0),
        salesReturn: Number(row.salesReturn || 0),
        purchase: Number(row.purchase || 0),
        purchaseReturn: Number(row.purchaseReturn || 0),
        systemStock: Number(row.systemStock || 0),
      })),
      pagination: {
        total,
        page,
        limit,
        totalPages,
      },
    });
  } catch (error) {
    console.error("getStockDashboard error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock dashboard",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getStockAreas = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const [rows] = await connection.query(`
      SELECT
        sa.id,
        sa.name,
        sa.address,
        sa.manager_id
      FROM stock_areas sa
      ORDER BY sa.name ASC
    `);

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("getStockAreas error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock areas",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};