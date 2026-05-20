import db from "../config/db.js";

const getBatchNo = (saleId) => `B-${saleId}`;
const toNumber = (value) => Number(value || 0);
const getProductSizeFromName = (name = "") => {
  const match = String(name).match(/\d+\.?\d*\s?kg/i);
  return match ? match[0].replace(/\s/g, " ") : "";
};

export const getDriverDashboard = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      startDate,
      endDate,
    } = req.query;

    const offset = (page - 1) * limit;

    // =========================
    // DATE FILTER
    // =========================
    let dateFilter = "";
    let dateValues = [];

    if (startDate && endDate) {
      dateFilter = `AND DATE(s.delivered_at) BETWEEN ? AND ?`;
      dateValues = [startDate, endDate];
    }

    // =========================
    // SEARCH FILTER
    // =========================
    let searchFilter = "";
    let searchValues = [];

    if (search) {
      searchFilter = `AND u.name LIKE ?`;
      searchValues = [`%${search}%`];
    }

    // =========================
    // SUMMARY CARDS
    // =========================
    const [summary] = await db.query(
      `
      SELECT 
        COUNT(DISTINCT d.id) AS totalDrivers,

        COUNT(DISTINCT CASE 
          WHEN u.status = 'ACTIVE' THEN d.id 
        END) AS activeToday,

        SUM(CASE 
          WHEN s.status = 'DELIVERED' 
          ${startDate && endDate ? "AND DATE(s.delivered_at) BETWEEN ? AND ?" : ""}
          THEN si.quantity ELSE 0 
        END) AS deliveredToday,

        SUM(CASE 
          WHEN s.status = 'ASSIGNED' 
          THEN si.quantity ELSE 0 
        END) AS cylindersInHand

      FROM drivers d
      JOIN users u ON d.user_id = u.id
      LEFT JOIN sales s ON s.driver_id = d.id
      LEFT JOIN sales_items si ON si.sale_id = s.id
      `,
      dateValues
    );

    // =========================
    // DRIVER TABLE DATA
    // =========================
    const [drivers] = await db.query(
      `
      SELECT 
        d.id,
        u.name,
        u.phone,
        d.rating,
        u.status,

        SUM(CASE 
          WHEN s.status = 'DELIVERED'
          ${dateFilter}
          THEN si.quantity ELSE 0 
        END) AS deliveriesToday,

        SUM(CASE 
          WHEN s.status = 'ASSIGNED' 
          THEN si.quantity ELSE 0 
        END) AS inHand

      FROM drivers d
      JOIN users u ON d.user_id = u.id
      LEFT JOIN sales s ON s.driver_id = d.id
      LEFT JOIN sales_items si ON si.sale_id = s.id

      WHERE 1=1
      ${searchFilter}

      GROUP BY d.id
      ORDER BY deliveriesToday DESC

      LIMIT ? OFFSET ?
      `,
      [...dateValues, ...searchValues, Number(limit), Number(offset)]
    );

    console.log({ drivers })
    // =========================
    // COUNT FOR PAGINATION
    // =========================
    const [countResult] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM drivers d
      JOIN users u ON d.user_id = u.id
      WHERE 1=1
      ${searchFilter}
      `,
      searchValues
    );

    return res.json({
      success: true,
      summary: {
        totalDrivers: summary[0].totalDrivers || 0,
        activeToday: summary[0].activeToday || 0,
        deliveredToday: summary[0].deliveredToday || 0,
        cylindersInHand: summary[0].cylindersInHand || 0,
      },
      data: drivers,
      pagination: {
        total: countResult[0].total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(countResult[0].total / limit),
      },
    });
  } catch (error) {
    console.error("Driver Dashboard Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

export const createDriver = async (req, res) => {
  try {
    const {
      user_id,
      vehicle_number,
      license_number,
      is_available = 1,
      rating = 0
    } = req.body;

    // =========================
    // VALIDATION
    // =========================
    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "user_id is required"
      });
    }

    // =========================
    // INSERT DRIVER
    // =========================
    const [result] = await db.execute(
      `
      INSERT INTO drivers 
      (user_id, vehicle_number, license_number, is_available, rating, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
      `,
      [
        user_id,
        vehicle_number || null,
        license_number || null,
        is_available,
        rating
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Driver created successfully",
      driver_id: result.insertId
    });

  } catch (error) {
    console.error("Create Driver Error:", error);
    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};

export const findCustomerForDriverApp = async (req, res) => {
  try {
    const { query } = req.query;

    if (!query || !String(query).trim()) {
      return res.status(400).json({
        success: false,
        message: "query is required",
      });
    }

    const searchValue = String(query).trim();

    const [rows] = await db.execute(
      `
      SELECT
        u.id,
        u.name,
        u.phone,
        u.email,
        a.address
      FROM users u
      LEFT JOIN addresses a
        ON a.user_id = u.id
      WHERE u.role = 'CUSTOMER'
        AND (
          u.phone = ?
          OR u.id = ?
        )
      ORDER BY a.is_default DESC, a.id DESC
      LIMIT 1
      `,
      [searchValue, Number(searchValue) || 0]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Customer found successfully",
      data: {
        id: Number(rows[0].id),
        name: rows[0].name,
        phone: rows[0].phone,
        email: rows[0].email,
        address: rows[0].address || "",
      },
    });
  } catch (error) {
    console.error("findCustomerForDriverApp error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to find customer",
      error: error.message,
    });
  }
};

export const getDriverDeliveriesApp = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { flag } = req.query;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driverId is required",
      });
    }

    const numericDriverId = Number(driverId);

    if (Number.isNaN(numericDriverId)) {
      return res.status(400).json({
        success: false,
        message: "driverId must be a valid number",
      });
    }

    const [statsRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(
          CASE
            WHEN s.status = 'ASSIGNED'
              AND si.status = 'ASSIGNED'
            THEN COALESCE(si.quantity, 0)
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
        ), 0) AS empties

      FROM sales s
      LEFT JOIN sales_items si ON si.sale_id = s.id
      WHERE s.driver_id = ?
      `,
      [numericDriverId]
    );

    const [collectionRows] = await db.execute(
      `
      SELECT COALESCE(SUM(p.amount), 0) AS collection
      FROM payments p
      INNER JOIN sales s ON s.id = p.sale_id
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
        AND p.status = 'SUCCESS'
      `,
      [numericDriverId]
    );

    let statusFilterQuery = "";

    if (flag === "allocated") {
      statusFilterQuery = `
        AND s.status IN ('PENDING', 'ASSIGNED')
        AND si.status IN ('PENDING', 'ASSIGNED')
      `;
    } else {
      statusFilterQuery = `
        AND s.status = 'DELIVERED'
        AND si.status = 'DELIVERED'
      `;
    }

    const [deliveryRows] = await db.execute(
      `
      SELECT
        s.id AS sale_id,
        u.name AS customer_name,
        a.address,
        COALESCE(
          GROUP_CONCAT(DISTINCT pr.name ORDER BY pr.name SEPARATOR ', '),
          'N/A'
        ) AS product_name,
        COALESCE(SUM(si.delivered_qty), 0) AS quantity,
        COALESCE(MAX(pr.type), 'N/A') AS cylinder_type,
        s.status AS raw_status,
        CASE
          WHEN s.status = 'DELIVERED' THEN 'Delivered'
          WHEN s.status = 'ASSIGNED' THEN 'Pending'
          WHEN s.status = 'PENDING' THEN 'Pending'
          ELSE s.status
        END AS display_status,
        COALESCE(s.total_amount, 0) AS total_amount,
        s.created_at,
        s.delivered_at,
        COALESCE(
          MAX(CASE WHEN p.status = 'SUCCESS' THEN p.method ELSE NULL END),
          s.payment_method,
          'N/A'
        ) AS payment_mode
      FROM sales s
      LEFT JOIN users u ON u.id = s.customer_id
      LEFT JOIN addresses a ON a.id = s.address_id
      LEFT JOIN sales_items si ON si.sale_id = s.id
      LEFT JOIN products pr ON pr.id = si.product_id
      LEFT JOIN payments p ON p.sale_id = s.id
      WHERE s.driver_id = ?
        ${statusFilterQuery}
        AND DATE(COALESCE(s.delivered_at, s.created_at)) = CURDATE()
      GROUP BY
        s.id,
        u.name,
        a.address,
        s.status,
        s.total_amount,
        s.created_at,
        s.delivered_at,
        s.payment_method
      ORDER BY COALESCE(s.delivered_at, s.created_at) DESC, s.id DESC
      `,
      [numericDriverId]
    );

    const allocated = Number(statsRows[0]?.allocated || 0);
    const delivered = Number(statsRows[0]?.delivered || 0);

    const stats = {
      allocated,
      delivered,
      collection: Number(collectionRows[0]?.collection || 0),
      empties: Number(statsRows[0]?.empties || 0),
      inHand: Math.max(allocated - delivered, 0),
      newDelivery: allocated,
    };

    const deliveries = deliveryRows.map((item) => ({
      saleId: Number(item.sale_id),
      customerName: item.customer_name || "Unknown Customer",
      address: item.address || "No address available",
      product: item.product_name || "N/A",
      quantity: Number(item.quantity || 0),
      rawStatus: item.raw_status,
      status: item.display_status,
      totalAmount: Number(item.total_amount || 0),
      createdAt: item.created_at,
      deliveredAt: item.delivered_at,
      paymentMode: item.payment_mode || "N/A",
      showMarkDelivered: item.raw_status !== "DELIVERED",
      cylinderType: item.cylinder_type || "N/A",
    }));

    return res.status(200).json({
      success: true,
      message: "Driver deliveries fetched successfully",
      data: {
        flag: flag || null,
        stats,
        deliveries,
      },
    });
  } catch (error) {
    console.error("getDriverDeliveriesApp error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch driver deliveries",
      error: error.message,
    });
  }
};

export const markSaleAsDelivered = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { saleId } = req.params;
    const { saleIds, payment_method, empty_cylinder_qty = 0, empty_product_id, stock_area_id, created_by } = req.body || {};

    // =====================================================
    // BULK MODE
    // PUT /drivers/sales/deliver
    // =====================================================
    if (!saleId) {
      if (!Array.isArray(saleIds) || !saleIds.length) {
        return res.status(400).json({
          success: false,
          message: "saleId param or saleIds array is required",
        });
      }

      const numericSaleIds = saleIds
        .map((id) => Number(id))
        .filter((id) => !Number.isNaN(id));

      if (!numericSaleIds.length) {
        return res.status(400).json({
          success: false,
          message: "saleIds must contain valid numeric ids",
        });
      }

      const placeholders = numericSaleIds.map(() => "?").join(",");

      const [existingRows] = await connection.execute(
        `
        SELECT id, status
        FROM sales
        WHERE id IN (${placeholders})
        `,
        numericSaleIds
      );

      if (!existingRows.length) {
        return res.status(404).json({
          success: false,
          message: "No matching sales found",
        });
      }

      const updatableIds = existingRows
        .filter((item) => item.status === "PENDING" || item.status === "ASSIGNED")
        .map((item) => item.id);

      if (!updatableIds.length) {
        return res.status(200).json({
          success: true,
          message: "No pending or assigned sales to update",
          data: {
            updatedCount: 0,
            mode: "bulk",
            saleIds: [],
          },
        });
      }

      const updatePlaceholders = updatableIds.map(() => "?").join(",");

      const [updateResult] = await connection.execute(
        `
        UPDATE sales
        SET status = 'DELIVERED',
            delivered_at = NOW()
        WHERE id IN (${updatePlaceholders})
        `,
        updatableIds
      );

      return res.status(200).json({
        success: true,
        message: "Sales marked as delivered successfully",
        data: {
          updatedCount: updateResult.affectedRows || 0,
          mode: "bulk",
          saleIds: updatableIds,
        },
      });
    }

    // =====================================================
    // SINGLE MODE
    // PUT /drivers/sale/:saleId/deliver
    // =====================================================
    const numericSaleId = Number(saleId);

    if (Number.isNaN(numericSaleId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid saleId",
      });
    }

    const numericEmptyQty = Number(empty_cylinder_qty || 0);

    if (Number.isNaN(numericEmptyQty) || numericEmptyQty < 0) {
      return res.status(400).json({
        success: false,
        message: "empty_cylinder_qty must be a valid non-negative number",
      });
    }

    await connection.beginTransaction();

    const [saleRows] = await connection.execute(
      `
      SELECT id, status, total_amount
      FROM sales
      WHERE id = ?
      FOR UPDATE
      `,
      [numericSaleId]
    );

    if (!saleRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Sale not found",
      });
    }

    // update sale status always
    await connection.execute(
      `
      UPDATE sales
      SET status = 'DELIVERED',
          delivered_at = NOW()
      WHERE id = ?
      `,
      [numericSaleId]
    );

    // update payment status only, as requested
    await connection.execute(
      `
      UPDATE payments
      SET status = 'SUCCESS'
      WHERE sale_id = ?
      `,
      [numericSaleId]
    );

    // create empty cylinder stock transaction if qty > 0
    if (numericEmptyQty > 0) {
      if (!empty_product_id) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "empty_product_id is required when empty_cylinder_qty > 0",
        });
      }

      if (!stock_area_id) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "stock_area_id is required when empty_cylinder_qty > 0",
        });
      }

      if (!created_by) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "created_by is required when empty_cylinder_qty > 0",
        });
      }

      await connection.execute(
        `
        INSERT INTO stock_transactions (
          product_id,
          stock_area_id,
          type,
          quantity,
          isApproved,
          reference_id,
          created_by
        )
        VALUES (?, ?, 'ADJUSTMENT_ADD', ?, 0, ?, ?)
        `,
        [
          Number(empty_product_id),
          Number(stock_area_id),
          numericEmptyQty,
          numericSaleId,
          Number(created_by),
        ]
      );
    }

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Sale marked as delivered successfully",
      data: {
        updatedCount: 1,
        mode: "single",
        saleId: numericSaleId,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("markSaleAsDelivered error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update delivery status",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

const getEmptyCylinderStatus = (orderedQty, emptyQty) => {
  const ordered = Number(orderedQty || 0);
  const empty = Number(emptyQty || 0);

  if (empty === 0) return "PENDING";

  if (empty === ordered) return "DELIVERED";

  if (empty > 0 && empty < ordered) return "PARTIAL_PENDING";

  return "PENDING";
};

export const createDriverSale = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      driver_id,
      customer_name,
      phone,
      address,

      cylinder_type,
      product_id,
      quantity = 1,

      payment_method = "CASH",
      amount = 0,

      empty_cylinder_collected = false,
      delivered_qty = 1,
      empty_cylinder_qty = 0,
      empty_cylinder_status,
      defective_qty = 0,

      allocation_sale_id = null,
      allocation_sales_item_id = null,
      batch_no = null,
    } = req.body;

    const numericDriverId = Number(driver_id);
    const numericProductId = Number(product_id);
    const numericQuantity = Number(quantity || 1);
    const numericAmount = Number(amount || 0);
    const numericDeliveredQty = Number(delivered_qty || numericQuantity);
    const numericEmptyCylinderQty = Number(empty_cylinder_qty || 0);
    const numericDefectiveQty = Number(defective_qty || 0);

    if (!numericDriverId) {
      return res.status(400).json({
        success: false,
        message: "driver_id is required",
      });
    }

    if (!customer_name || !phone || !address) {
      return res.status(400).json({
        success: false,
        message: "customer_name, phone and address are required",
      });
    }

    if (!numericProductId) {
      return res.status(400).json({
        success: false,
        message: "product_id is required",
      });
    }

    if (!numericQuantity || numericQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "quantity must be greater than 0",
      });
    }

    await connection.beginTransaction();

    const [productRows] = await connection.execute(
      `
      SELECT id, name, type, price
      FROM products
      WHERE id = ?
      LIMIT 1
      `,
      [numericProductId]
    );

    if (!productRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const selectedProduct = productRows[0];

    if (allocation_sales_item_id) {
      const [batchRows] = await connection.execute(
        `
        SELECT
          asi.id AS allocation_sales_item_id,
          asi.sale_id AS allocation_sale_id,
          COALESCE(asi.batch_no, CONCAT('B-', asi.sale_id)) AS batch_no,
          asi.product_id,
          COALESCE(asi.quantity, 0) AS total_allocated,

          COALESCE(delivered_data.delivered_qty, 0) AS delivered_qty,
          COALESCE(return_data.return_qty, 0) AS return_qty,
          COALESCE(return_data.defective_qty, 0) AS defective_qty

        FROM sales_items asi
        INNER JOIN sales a
          ON a.id = asi.sale_id

        LEFT JOIN (
          SELECT
            child.allocation_sales_item_id,
            SUM(COALESCE(child.delivered_qty, child.quantity, 0)) AS delivered_qty
          FROM sales_items child
          INNER JOIN sales cs
            ON cs.id = child.sale_id
          WHERE child.allocation_sales_item_id IS NOT NULL
            AND cs.status = 'DELIVERED'
          GROUP BY child.allocation_sales_item_id
        ) delivered_data
          ON delivered_data.allocation_sales_item_id = asi.id

        LEFT JOIN (
          SELECT
            st.allocation_sales_item_id,
            SUM(CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS return_qty,
            SUM(CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS defective_qty
          FROM stock_transactions st
          WHERE st.stock_from = 'driver'
            AND st.type = 'PURCHASE_RETURN'
            AND st.isApproved IN (0, 1)
            AND st.allocation_sales_item_id IS NOT NULL
          GROUP BY st.allocation_sales_item_id
        ) return_data
          ON return_data.allocation_sales_item_id = asi.id

        WHERE asi.id = ?
          AND a.driver_id = ?
          AND a.status = 'ASSIGNED'
          AND asi.allocation_sales_item_id IS NULL
        LIMIT 1
        FOR UPDATE
        `,
        [Number(allocation_sales_item_id), numericDriverId]
      );

      if (!batchRows.length) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: "Selected batch not found",
        });
      }

      const batch = batchRows[0];

      if (Number(batch.product_id) !== numericProductId) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "Selected batch product does not match selected product",
        });
      }

      const pending =
        toNumber(batch.total_allocated) -
        toNumber(batch.delivered_qty) -
        toNumber(batch.return_qty) -
        toNumber(batch.defective_qty);

      if (numericQuantity > pending) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Only ${pending} cylinder(s) available in selected batch`,
        });
      }
    }

    let customerId = null;

    const [existingCustomers] = await connection.execute(
      `
      SELECT id
      FROM users
      WHERE phone = ?
      LIMIT 1
      `,
      [phone]
    );

    if (existingCustomers.length) {
      customerId = existingCustomers[0].id;

      await connection.execute(
        `
        UPDATE users
        SET name = ?, role = 'CUSTOMER'
        WHERE id = ?
        `,
        [customer_name, customerId]
      );
    } else {
      const [customerResult] = await connection.execute(
        `
        INSERT INTO users
        (
          name,
          phone,
          role,
          created_at,
          updated_at
        )
        VALUES (?, ?, 'CUSTOMER', NOW(), NOW())
        `,
        [customer_name, phone]
      );

      customerId = customerResult.insertId;
    }

    let addressId = null;

    const [addressRows] = await connection.execute(
      `
      SELECT id
      FROM addresses
      WHERE user_id = ?
        AND address = ?
      LIMIT 1
      `,
      [customerId, address]
    );

    if (addressRows.length) {
      addressId = addressRows[0].id;
    } else {
      const [addressResult] = await connection.execute(
        `
        INSERT INTO addresses
        (
          user_id,
          address,
          created_at,
          updated_at
        )
        VALUES (?, ?, NOW(), NOW())
        `,
        [customerId, address]
      );

      addressId = addressResult.insertId;
    }

    const [saleResult] = await connection.execute(
      `
      INSERT INTO sales
      (
        customer_id,
        driver_id,
        address_id,
        total_amount,
        payment_method,
        status,
        created_at,
        updated_at,
        delivered_at
      )
      VALUES (?, ?, ?, ?, ?, 'DELIVERED', NOW(), NOW(), NOW())
      `,
      [
        customerId,
        numericDriverId,
        addressId,
        numericAmount,
        payment_method,
      ]
    );

    const saleId = saleResult.insertId;

    const finalEmptyCylinderStatus =
      empty_cylinder_status ||
      (numericEmptyCylinderQty <= 0
        ? "PENDING"
        : numericEmptyCylinderQty >= numericQuantity
          ? "DELIVERED"
          : "PARTIAL_PENDING");

    const finalBatchNo =
      batch_no ||
      (allocation_sale_id ? getBatchNo(allocation_sale_id) : null);

    await connection.execute(
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
        empty_cylinder_status,
        defective_qty,
        batch_no,
        allocation_sale_id,
        allocation_sales_item_id
      )
      VALUES (?, ?, ?, ?, 'DELIVERED', ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        saleId,
        numericProductId,
        numericQuantity,
        numericAmount,
        numericDeliveredQty,
        numericEmptyCylinderQty,
        finalEmptyCylinderStatus,
        numericDefectiveQty,
        finalBatchNo,
        allocation_sale_id ? Number(allocation_sale_id) : null,
        allocation_sales_item_id ? Number(allocation_sales_item_id) : null,
      ]
    );

    let paymentMethodForPayments = null;
    let paymentStatus = "PENDING";

    if (payment_method === "CASH") {
      paymentMethodForPayments = "CASH";
      paymentStatus = "SUCCESS";
    } else if (payment_method === "UPI") {
      paymentMethodForPayments = "UPI";
      paymentStatus = "SUCCESS";
    } else if (payment_method === "ONLINE") {
      paymentMethodForPayments = "CARD";
      paymentStatus = "SUCCESS";
    }

    const [paymentInsertResult] = await connection.execute(
      `
      INSERT INTO payments
      (
        sale_id,
        amount,
        method,
        status,
        type
      )
      VALUES (?, ?, ?, ?, 'DRIVER')
      `,
      [saleId, numericAmount, paymentMethodForPayments, paymentStatus]
    );

    const paymentId = paymentInsertResult.insertId;

    if (payment_method === "CASH" || payment_method === "UPI") {
      await connection.execute(
        `
        INSERT INTO settlement_history
        (
          driver_id,
          sale_id,
          payment_id,
          method,
          amount,
          status,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, 'ASSIGNED', NOW())
        `,
        [
          numericDriverId,
          saleId,
          paymentId,
          payment_method,
          numericAmount,
        ]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Sale created successfully",
      data: {
        saleId,
        customerId,
        addressId,
        paymentId,

        product: {
          id: Number(selectedProduct.id),
          name: selectedProduct.name,
          type: selectedProduct.type,
        },

        batch: {
          batchNo: finalBatchNo,
          allocationSaleId: allocation_sale_id ? Number(allocation_sale_id) : null,
          allocationSalesItemId: allocation_sales_item_id
            ? Number(allocation_sales_item_id)
            : null,
        },

        quantity: numericQuantity,
        deliveredQty: numericDeliveredQty,
        amount: numericAmount,
        paymentMethod: payment_method,
        emptyCylinderCollected: numericEmptyCylinderQty > 0,
        emptyCylinderQty: numericEmptyCylinderQty,
        emptyCylinderStatus: finalEmptyCylinderStatus,
        defectiveQty: numericDefectiveQty,
      },
    });
  } catch (error) {
    await connection.rollback();

    console.error("createDriverSale error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create sale",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getDriverCollectionSummary = async (req, res) => {
  try {
    const driverId = Number(req.params.driverId);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "Driver id is required",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        sh.id,
        sh.sale_id,
        sh.payment_id,
        sh.method,
        sh.amount,
        sh.status,
        sh.created_at,
        u.name AS customer_name
      FROM settlement_history sh
      INNER JOIN sales s ON s.id = sh.sale_id
      LEFT JOIN users u ON u.id = s.customer_id
      WHERE sh.driver_id = ?
        AND sh.status IN ('ASSIGNED', 'PENDING')
      ORDER BY sh.created_at ASC
      `,
      [driverId]
    );

    const buildGroup = (method, status) => {
      const items = rows.filter(
        (item) => item.method === method && item.status === status
      );

      const amount = items.reduce(
        (sum, item) => sum + Number(item.amount || 0),
        0
      );

      return {
        amount,
        count: items.length,
        status: amount > 0 ? status : null,
        transactions: items.map((item) => ({
          id: Number(item.id),
          saleId: Number(item.sale_id),
          paymentId: Number(item.payment_id),
          amount: Number(item.amount || 0),
          customerName: item.customer_name || "Unknown Customer",
          createdAt: item.created_at,
          status: item.status,
          method: item.method,
        })),
      };
    };

    const cashAssigned = buildGroup("CASH", "ASSIGNED");
    const cashPending = buildGroup("CASH", "PENDING");
    const upiAssigned = buildGroup("UPI", "ASSIGNED");
    const upiPending = buildGroup("UPI", "PENDING");

    const cashTotal = cashAssigned.amount + cashPending.amount;
    const upiTotal = upiAssigned.amount + upiPending.amount;

    return res.status(200).json({
      success: true,
      message: "Collection summary fetched successfully",
      data: {
        summary: {
          cashCollected: cashTotal,
          upiCollected: upiTotal,
          totalCollected: cashTotal + upiTotal,
        },
        settlements: {
          cashAssigned,
          cashPending,
          upiAssigned,
          upiPending,
        },
      },
    });
  } catch (error) {
    console.error("getDriverCollectionSummary error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch collection summary",
      error: error.message,
    });
  }
};

export const settleDriverCollectionsByMethod = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const driverId = Number(req.params.driverId);
    const { method, denominations } = req.body || {};

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "Driver id is required",
      });
    }

    if (!["CASH", "UPI", "TOTAL_UPI"].includes(method)) {
      return res.status(400).json({
        success: false,
        message: "method must be CASH, UPI or TOTAL_UPI",
      });
    }

    await connection.beginTransaction();

    let methodFilter = "";

    if (method === "CASH") methodFilter = "AND method = 'CASH'";
    if (method === "UPI") methodFilter = "AND method = 'UPI'";

    const [rows] = await connection.execute(
      `
      SELECT id, amount
      FROM settlement_history
      WHERE driver_id = ?
        AND status = 'ASSIGNED'
        ${methodFilter}
      FOR UPDATE
      `,
      [driverId]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No assigned collection found to settle",
      });
    }

    const totalAmount = rows.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0
    );

    if (method === "CASH") {
      const enteredCashTotal =
        Number(denominations?.["500"] || 0) * 500 +
        Number(denominations?.["100"] || 0) * 100 +
        Number(denominations?.["50"] || 0) * 50 +
        Number(denominations?.["20"] || 0) * 20 +
        Number(denominations?.["10"] || 0) * 10 +
        Number(denominations?.coins || 0);

      if (enteredCashTotal !== totalAmount) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Expected ₹${totalAmount} but got ₹${enteredCashTotal}`,
        });
      }
    }

    await connection.execute(
      `
      UPDATE settlement_history
      SET status = 'PENDING'
      WHERE driver_id = ?
        AND status = 'ASSIGNED'
        ${methodFilter}
      `,
      [driverId]
    );

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Collection moved to pending cashier approval",
      data: {
        amount: totalAmount,
        method,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("settleDriverCollectionsByMethod error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to settle collection",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getDriverInHandSummary = async (req, res) => {
  try {
    const driverId = Number(req.params.driverId);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driverId is required",
      });
    }

    const [summaryRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(allocated_qty), 0) AS allocated,
        COALESCE(SUM(delivered_qty), 0) AS delivered,
        COALESCE(SUM(return_qty), 0) AS returned,
        COALESCE(SUM(defective_qty), 0) AS defective
      FROM (
        SELECT
          asi.id,
          COALESCE(asi.quantity, 0) AS allocated_qty,
          COALESCE(delivered_data.delivered_qty, 0) AS delivered_qty,
          COALESCE(return_data.return_qty, 0) AS return_qty,
          COALESCE(return_data.defective_qty, 0) AS defective_qty
        FROM sales_items asi
        INNER JOIN sales a
          ON a.id = asi.sale_id

        LEFT JOIN (
          SELECT
            child.allocation_sales_item_id,
            SUM(COALESCE(child.delivered_qty, child.quantity, 0)) AS delivered_qty
          FROM sales_items child
          INNER JOIN sales cs
            ON cs.id = child.sale_id
          WHERE child.allocation_sales_item_id IS NOT NULL
            AND cs.status = 'DELIVERED'
          GROUP BY child.allocation_sales_item_id
        ) delivered_data
          ON delivered_data.allocation_sales_item_id = asi.id

        LEFT JOIN (
          SELECT
            st.allocation_sales_item_id,
            SUM(
              CASE
                WHEN st.is_defective = 0
                THEN COALESCE(st.quantity, 0)
                ELSE 0
              END
            ) AS return_qty,
            SUM(
              CASE
                WHEN st.is_defective = 1
                THEN COALESCE(st.quantity, 0)
                ELSE 0
              END
            ) AS defective_qty
          FROM stock_transactions st
          WHERE st.stock_from = 'driver'
            AND st.type = 'PURCHASE_RETURN'
            AND st.isApproved IN (0, 1)
            AND st.allocation_sales_item_id IS NOT NULL
          GROUP BY st.allocation_sales_item_id
        ) return_data
          ON return_data.allocation_sales_item_id = asi.id

        WHERE a.driver_id = ?
          AND a.status = 'ASSIGNED'
          AND asi.allocation_sales_item_id IS NULL
      ) x
      `,
      [driverId]
    );

    const allocated = toNumber(summaryRows[0]?.allocated);
    const delivered = toNumber(summaryRows[0]?.delivered);
    const returned = toNumber(summaryRows[0]?.returned);
    const defective = toNumber(summaryRows[0]?.defective);

    const inHand = Math.max(
      allocated - delivered - returned - defective,
      0
    );

    const [requestRows] = await db.execute(
      `
      SELECT
        st.id,
        st.product_id,
        st.stock_area_id,
        st.quantity,
        st.created_at,
        st.isApproved,
        st.is_defective,
        st.batch_no,
        st.allocation_sale_id,
        st.allocation_sales_item_id,
        p.name AS product_name,
        p.type AS product_type
      FROM stock_transactions st
      LEFT JOIN products p
        ON p.id = st.product_id
      WHERE st.driver_id = ?
        AND st.stock_from = 'driver'
        AND st.type = 'PURCHASE_RETURN'
        AND st.isApproved = 0
      ORDER BY st.created_at DESC, st.id DESC
      `,
      [driverId]
    );

    const returnRequests = [];
    const defectiveRequests = [];

    requestRows.forEach((item) => {
      const mapped = {
        id: Number(item.id),
        productId: Number(item.product_id),
        stockAreaId: item.stock_area_id ? Number(item.stock_area_id) : null,
        quantity: Number(item.quantity || 0),
        productName: item.product_name || "Cylinder",
        productType: item.product_type || "",
        createdAt: item.created_at,
        isApproved: Number(item.isApproved || 0),
        batchNo: item.batch_no || null,
        allocationSaleId: item.allocation_sale_id
          ? Number(item.allocation_sale_id)
          : null,
        allocationSalesItemId: item.allocation_sales_item_id
          ? Number(item.allocation_sales_item_id)
          : null,
      };

      if (Number(item.is_defective) === 1) {
        defectiveRequests.push(mapped);
      } else {
        returnRequests.push(mapped);
      }
    });

    return res.status(200).json({
      success: true,
      message: "In-hand summary fetched successfully",
      data: {
        summary: {
          allocated,
          delivered,
          returned,
          defective,
          inHand,
        },
        returnRequests,
        defectiveRequests,
      },
    });
  } catch (error) {
    console.error("getDriverInHandSummary error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch in-hand summary",
      error: error.message,
    });
  }
};

export const returnInHandToGodown = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driverId } = req.params;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driverId is required",
      });
    }

    const numericDriverId = Number(driverId);

    if (Number.isNaN(numericDriverId)) {
      return res.status(400).json({
        success: false,
        message: "driverId must be a valid number",
      });
    }

    await connection.beginTransaction();

    // =========================
    // GET PENDING RETURN REQUESTS
    // =========================
    const [pendingRows] = await connection.execute(
      `
      SELECT
        id,
        product_id,
        stock_area_id,
        quantity
      FROM stock_transactions
      WHERE created_by = ?
        AND type = 'ADJUSTMENT_ADD'
        AND isApproved = 0
      FOR UPDATE
      `,
      [numericDriverId]
    );

    if (!pendingRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No pending return requests found",
      });
    }

    // =========================
    // UPDATE STOCK TABLE
    // =========================
    for (const row of pendingRows) {
      const productId = Number(row.product_id);
      const stockAreaId = Number(row.stock_area_id);
      const qty = Number(row.quantity || 0);

      const [stockRows] = await connection.execute(
        `
        SELECT id, quantity, quantity_return
        FROM stock
        WHERE product_id = ?
          AND stock_area_id = ?
        LIMIT 1
        FOR UPDATE
        `,
        [productId, stockAreaId]
      );

      if (stockRows.length) {
        await connection.execute(
          `
          UPDATE stock
          SET quantity = quantity + ?,
              quantity_return = quantity_return + ?
          WHERE product_id = ?
            AND stock_area_id = ?
          `,
          [qty, qty, productId, stockAreaId]
        );
      } else {
        await connection.execute(
          `
          INSERT INTO stock (
            product_id,
            stock_area_id,
            quantity,
            quantity_return
          )
          VALUES (?, ?, ?, ?)
          `,
          [productId, stockAreaId, qty, qty]
        );
      }
    }

    // =========================
    // APPROVE RETURN REQUESTS
    // =========================
    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = 1
      WHERE created_by = ?
        AND type = 'ADJUSTMENT_ADD'
        AND isApproved = 0
      `,
      [numericDriverId]
    );

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "In-hand cylinders returned to godown successfully",
      data: {
        updatedCount: pendingRows.length,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("returnInHandToGodown error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to return in-hand cylinders",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getDriverCollectionHistory = async (req, res) => {
  try {
    const { driverId } = req.params;

    const parsedPage = parseInt(req.query.page, 10);
    const parsedLimit = parseInt(req.query.limit, 10);

    const safePage =
      Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;

    const safeLimit =
      Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 2;

    const offset = (safePage - 1) * safeLimit;

    const numericDriverId = Number(driverId);

    if (!numericDriverId) {
      return res.status(400).json({
        success: false,
        message: "Valid driverId is required",
      });
    }

    const [dateRows] = await db.execute(
      `
      SELECT DATE(sh.created_at) AS collection_date
      FROM settlement_history sh
      WHERE sh.driver_id = ?
        AND sh.status = 'SETTLED'
      GROUP BY DATE(sh.created_at)
      ORDER BY collection_date DESC
      LIMIT ${safeLimit} OFFSET ${offset}
      `,
      [numericDriverId]
    );

    const [countRows] = await db.execute(
      `
      SELECT COUNT(*) AS totalDates
      FROM (
        SELECT DATE(sh.created_at) AS collection_date
        FROM settlement_history sh
        WHERE sh.driver_id = ?
          AND sh.status = 'SETTLED'
        GROUP BY DATE(sh.created_at)
      ) t
      `,
      [numericDriverId]
    );

    const totalDates = Number(countRows[0]?.totalDates || 0);
    const totalPages = Math.ceil(totalDates / safeLimit);

    const items = [];

    for (const dateRow of dateRows) {
      const collectionDate = dateRow.collection_date;

      const [summaryRows] = await db.execute(
        `
        SELECT
          COALESCE(SUM(CASE WHEN method = 'CASH' THEN amount ELSE 0 END), 0) AS cash_amount,
          COALESCE(SUM(CASE WHEN method = 'UPI' THEN amount ELSE 0 END), 0) AS upi_amount
        FROM settlement_history
        WHERE driver_id = ?
          AND status = 'SETTLED'
          AND DATE(created_at) = ?
        `,
        [numericDriverId, collectionDate]
      );

      const [settlementRows] = await db.execute(
        `
        SELECT status
        FROM settlements
        WHERE driver_id = ?
          AND settlement_date = ?
        LIMIT 1
        `,
        [numericDriverId, collectionDate]
      );

      const cashierStatus = settlementRows[0]?.status || "PENDING";

      const [transactionRows] = await db.execute(
        `
        SELECT
          sh.id,
          sh.sale_id,
          sh.amount,
          sh.method AS payment_mode,
          sh.status AS settlement_history_status,
          sh.created_at,
          u.name AS customer_name
        FROM settlement_history sh
        LEFT JOIN sales s ON s.id = sh.sale_id
        LEFT JOIN users u ON u.id = s.customer_id
        WHERE sh.driver_id = ?
          AND sh.status = 'SETTLED'
          AND DATE(sh.created_at) = ?
        ORDER BY sh.created_at DESC, sh.id DESC
        `,
        [numericDriverId, collectionDate]
      );

      const cashAmount = Number(summaryRows[0]?.cash_amount || 0);
      const upiAmount = Number(summaryRows[0]?.upi_amount || 0);

      const displayStatus =
        cashierStatus === "SETTLED" ? "APPROVED" : "PENDING_APPROVAL";

      items.push({
        date: collectionDate,
        totalAmount: cashAmount + upiAmount,
        summary: {
          cash: {
            amount: cashAmount,
            status: cashAmount > 0 ? displayStatus : null,
            settledAt: null,
          },
          upi: {
            amount: upiAmount,
            status: upiAmount > 0 ? displayStatus : null,
            settledAt: null,
          },
        },
        transactions: transactionRows.map((row) => ({
          saleId: Number(row.sale_id),
          customerName: row.customer_name || "Unknown Customer",
          amount: Number(row.amount || 0),
          paymentMode: row.payment_mode || "N/A",
          deliveredAt: row.created_at,
          status: displayStatus,
        })),
      });
    }

    return res.status(200).json({
      success: true,
      message: "Collection history fetched successfully",
      data: {
        items,
        pagination: {
          page: safePage,
          limit: safeLimit,
          totalItems: totalDates,
          totalPages,
          hasNextPage: safePage < totalPages,
          hasPrevPage: safePage > 1,
        },
      },
    });
  } catch (error) {
    console.error("getDriverCollectionHistory error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch collection history",
      error: error.message,
    });
  }
};

export const getDriverEmptyCylindersToday = async (req, res) => {
  try {
    const { driverId } = req.params;

    const numericDriverId = Number(driverId);

    if (!driverId || Number.isNaN(numericDriverId)) {
      return res.status(400).json({
        success: false,
        message: "Valid driverId is required",
      });
    }

    const [collectedRows] = await db.execute(
      `
      SELECT
        si.id,
        s.id AS sale_id,
        u.name AS customer_name,
        p.type AS product_type,
        COALESCE(si.empty_cylinder_qty, 0) AS quantity,
        COALESCE(s.delivered_at, s.created_at) AS created_at
      FROM sales s
      INNER JOIN sales_items si ON si.sale_id = s.id
      LEFT JOIN users u ON u.id = s.customer_id
      LEFT JOIN products p ON p.id = si.product_id
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
        AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
        AND COALESCE(si.empty_cylinder_qty, 0) > 0
        AND DATE(COALESCE(s.delivered_at, s.created_at)) = CURDATE()
      ORDER BY COALESCE(s.delivered_at, s.created_at) ASC, si.id ASC
      `,
      [numericDriverId]
    );

    const [returnRows] = await db.execute(
      `
      SELECT
        st.id,
        st.product_id,
        st.quantity,
        st.created_at,
        st.isApproved,
        p.name AS product_name
      FROM stock_transactions st
      LEFT JOIN products p ON p.id = st.product_id
      WHERE st.driver_id = ?
        AND st.stock_from = 'driver'
        AND st.type IN ('EMPTY_RETURN')
        AND DATE(st.created_at) = CURDATE()
      ORDER BY st.created_at DESC, st.id DESC
      `,
      [numericDriverId]
    );

    const collected = collectedRows.reduce(
      (sum, row) => sum + Number(row.quantity || 0),
      0
    );

    const returned = returnRows
      .filter((row) => Number(row.isApproved) === 1)
      .reduce((sum, row) => sum + Number(row.quantity || 0), 0);

    return res.status(200).json({
      success: true,
      message: "Empty cylinder today data fetched successfully",
      data: {
        summary: {
          collected,
          returned,
          inHand: Math.max(collected - returned, 0),
        },
        collectedFrom: collectedRows.map((row) => ({
          id: Number(row.id),
          saleId: Number(row.sale_id),
          customerName: row.customer_name || "Unknown Customer",
          productType: row.product_type || "N/A",
          quantity: Number(row.quantity || 0),
          createdAt: row.created_at,
        })),
        returnRequests: returnRows.map((row) => ({
          id: Number(row.id),
          productId: Number(row.product_id),
          productName: row.product_name || "",
          quantity: Number(row.quantity || 0),
          createdAt: row.created_at,
          isApproved: Number(row.isApproved || 0),
        })),
      },
    });
  } catch (error) {
    console.error("getDriverEmptyCylindersToday error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch empty cylinders today data",
      error: error.message,
    });
  }
};

export const getDriverEmptyCylindersHistory = async (req, res) => {
  try {
    const { driverId } = req.params;

    const numericDriverId = Number(driverId);

    if (!driverId || Number.isNaN(numericDriverId)) {
      return res.status(400).json({
        success: false,
        message: "Valid driverId is required",
      });
    }

    const [dateRows] = await db.execute(
      `
      SELECT history_date
      FROM (
        SELECT DATE(COALESCE(s.delivered_at, s.created_at)) AS history_date
        FROM sales s
        INNER JOIN sales_items si ON si.sale_id = s.id
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
          AND COALESCE(si.empty_cylinder_qty, 0) > 0

        UNION

        SELECT DATE(st.created_at) AS history_date
        FROM stock_transactions st
        WHERE st.driver_id = ?
          AND st.stock_from = 'driver'
          AND st.is_defective = 0
          AND st.type IN ('EMPTY_RETURN', 'PURCHASE_RETURN')
      ) x
      GROUP BY history_date
      ORDER BY history_date DESC
      `,
      [numericDriverId, numericDriverId]
    );

    const items = [];

    for (const dateRow of dateRows) {
      const historyDate = dateRow.history_date;

      const [collections] = await db.execute(
        `
        SELECT
          si.id,
          s.id AS sale_id,
          u.name AS customer_name,
          p.type AS product_type,
          COALESCE(si.empty_cylinder_qty, 0) AS quantity,
          COALESCE(s.delivered_at, s.created_at) AS created_at
        FROM sales s
        INNER JOIN sales_items si ON si.sale_id = s.id
        LEFT JOIN users u ON u.id = s.customer_id
        LEFT JOIN products p ON p.id = si.product_id
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
          AND COALESCE(si.empty_cylinder_qty, 0) > 0
          AND DATE(COALESCE(s.delivered_at, s.created_at)) = ?
        ORDER BY COALESCE(s.delivered_at, s.created_at) ASC, si.id ASC
        `,
        [numericDriverId, historyDate]
      );

      const [returns] = await db.execute(
        `
        SELECT
          st.id,
          st.product_id,
          st.quantity,
          st.created_at,
          st.isApproved,
          p.name AS product_name
        FROM stock_transactions st
        LEFT JOIN products p ON p.id = st.product_id
        WHERE st.driver_id = ?
          AND st.stock_from = 'driver'
          AND st.is_defective = 0
          AND st.type IN ('EMPTY_RETURN', 'PURCHASE_RETURN')
          AND DATE(st.created_at) = ?
        ORDER BY st.created_at DESC, st.id DESC
        `,
        [numericDriverId, historyDate]
      );

      const collected = collections.reduce(
        (sum, row) => sum + Number(row.quantity || 0),
        0
      );

      const returned = returns
        .filter((row) => Number(row.isApproved) === 1)
        .reduce((sum, row) => sum + Number(row.quantity || 0), 0);

      items.push({
        date: historyDate,
        collected,
        returned,
        inHand: Math.max(collected - returned, 0),
        collections: collections.map((row) => ({
          id: Number(row.id),
          saleId: Number(row.sale_id),
          customerName: row.customer_name || "Unknown Customer",
          productType: row.product_type || "N/A",
          quantity: Number(row.quantity || 0),
          createdAt: row.created_at,
        })),
        returns: returns.map((row) => ({
          id: Number(row.id),
          productId: Number(row.product_id),
          productName: row.product_name || "",
          quantity: Number(row.quantity || 0),
          createdAt: row.created_at,
          isApproved: Number(row.isApproved || 0),
        })),
      });
    }

    return res.status(200).json({
      success: true,
      message: "Empty cylinder history fetched successfully",
      data: {
        items,
      },
    });
  } catch (error) {
    console.error("getDriverEmptyCylindersHistory error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch empty cylinders history",
      error: error.message,
    });
  }
};

export const createEmptyCylinderReturnRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driver_id, product_id, quantity } = req.body;

    const numericDriverId = Number(driver_id);
    const numericProductId = Number(product_id);
    const numericQuantity = Number(quantity);

    if (!numericDriverId || Number.isNaN(numericDriverId)) {
      return res.status(400).json({
        success: false,
        message: "driver_id is required",
      });
    }

    if (!numericProductId || Number.isNaN(numericProductId)) {
      return res.status(400).json({
        success: false,
        message: "product_id is required",
      });
    }

    if (!numericQuantity || Number.isNaN(numericQuantity) || numericQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "quantity must be greater than 0",
      });
    }

    await connection.beginTransaction();

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
        created_by,
        driver_id,
        stock_from,
        is_defective
      )
      VALUES (?, 1, 'EMPTY_RETURN', ?, 0, ?, ?, ?, 'driver', 0)
      `,
      [
        numericProductId,
        numericQuantity,
        Date.now(),
        numericDriverId,
        numericDriverId,
      ]
    );

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Empty cylinder return request created successfully",
    });
  } catch (error) {
    await connection.rollback();

    console.error("createEmptyCylinderReturnRequest error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create empty cylinder return request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const approveTodayEmptyCylinderReturns = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driverId } = req.params;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driverId is required",
      });
    }

    const numericDriverId = Number(driverId);

    if (Number.isNaN(numericDriverId)) {
      return res.status(400).json({
        success: false,
        message: "driverId must be a valid number",
      });
    }

    await connection.beginTransaction();

    const [pendingRows] = await connection.execute(
      `
      SELECT
        s.id AS sale_id,
        s.empty_cylinder_qty,
        s.empty_cylinder_status,
        COALESCE(SUM(si.quantity), 0) AS sale_quantity
      FROM sales s
      LEFT JOIN sales_items si
        ON si.sale_id = s.id
      WHERE s.driver_id = ?
        AND s.empty_cylinder_qty > 0
        AND s.empty_cylinder_status IN ('PENDING', 'PARTIAL_PENDING')
        AND DATE(s.created_at) = CURDATE()
      GROUP BY s.id, s.empty_cylinder_qty, s.empty_cylinder_status
      FOR UPDATE
      `,
      [numericDriverId]
    );

    if (!pendingRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No pending empty cylinder requests found for today",
      });
    }

    for (const row of pendingRows) {
      const saleId = Number(row.sale_id);
      const emptyCylinderQty = Number(row.empty_cylinder_qty || 0);
      const saleQuantity = Number(row.sale_quantity || 0);

      const nextStatus =
        emptyCylinderQty === saleQuantity ? "DELIVERED" : "PARTIAL_DELIVERED";

      await connection.execute(
        `
        UPDATE sales
        SET empty_cylinder_status = ?
        WHERE id = ?
          AND driver_id = ?
        `,
        [nextStatus, saleId, numericDriverId]
      );
    }

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Today empty cylinders returned to godown successfully",
      data: {
        updatedCount: pendingRows.length,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveTodayEmptyCylinderReturns error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to approve today empty cylinder returns",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getDriverProfileHistory = async (req, res) => {
  try {
    const { driverId } = req.params;

    const parsedPage = parseInt(req.query.page, 10);
    const parsedLimit = parseInt(req.query.limit, 10);

    const safePage =
      Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;

    const safeLimit =
      Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 4;

    const offset = (safePage - 1) * safeLimit;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driverId is required",
      });
    }

    const numericDriverId = Number(driverId);

    if (Number.isNaN(numericDriverId)) {
      return res.status(400).json({
        success: false,
        message: "driverId must be a valid number",
      });
    }

    const [driverRows] = await db.execute(
      `
      SELECT
        d.id,
        d.vehicle_number,
        u.name,
        u.phone
      FROM drivers d
      INNER JOIN users u
        ON u.id = d.user_id
      WHERE d.id = ?
      LIMIT 1
      `,
      [numericDriverId]
    );

    if (!driverRows.length) {
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    const [performanceRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(
          CASE
            WHEN DATE(s.created_at) = CURDATE()
            THEN COALESCE(si.delivered_qty, si.quantity, 0)
            ELSE 0
          END
        ), 0) AS today_count,

        COALESCE(SUM(
          CASE
            WHEN YEARWEEK(s.created_at, 1) = YEARWEEK(CURDATE(), 1)
            THEN COALESCE(si.delivered_qty, si.quantity, 0)
            ELSE 0
          END
        ), 0) AS this_week_count,

        COALESCE(SUM(
          COALESCE(si.delivered_qty, si.quantity, 0)
        ), 0) AS total_count
      FROM sales s
      INNER JOIN sales_items si
        ON si.sale_id = s.id
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
        AND si.status = 'DELIVERED'
      `,
      [numericDriverId]
    );

    const [dateRows] = await db.execute(
      `
      SELECT
        DATE(s.created_at) AS delivery_date
      FROM sales s
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
      GROUP BY DATE(s.created_at)
      ORDER BY delivery_date DESC
      LIMIT ${safeLimit} OFFSET ${offset}
      `,
      [numericDriverId]
    );

    const [countRows] = await db.execute(
      `
      SELECT COUNT(*) AS totalDates
      FROM (
        SELECT DATE(s.created_at) AS delivery_date
        FROM sales s
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
        GROUP BY DATE(s.created_at)
      ) t
      `,
      [numericDriverId]
    );

    const totalDates = Number(countRows[0]?.totalDates || 0);
    const totalPages = Math.max(Math.ceil(totalDates / safeLimit), 1);

    const items = [];

    for (const dateRow of dateRows) {
      const deliveryDate = dateRow.delivery_date;

      const [dailyRows] = await db.execute(
        `
        SELECT
          s.id AS sale_id,
          u.name AS customer_name,
          COALESCE(a.address, '') AS address,

          COALESCE(MAX(p.type), 'N/A') AS cylinder_type,

          COALESCE(
            SUM(COALESCE(si.delivered_qty, si.quantity, 0)),
            0
          ) AS quantity,

          COALESCE(s.total_amount, 0) AS total_amount,

          COALESCE(
            MAX(CASE WHEN pay.status = 'SUCCESS' THEN pay.method ELSE NULL END),
            s.payment_method,
            'N/A'
          ) AS payment_mode,

          s.created_at
        FROM sales s
        LEFT JOIN users u
          ON u.id = s.customer_id
        LEFT JOIN addresses a
          ON a.id = s.address_id
        LEFT JOIN sales_items si
          ON si.sale_id = s.id
        LEFT JOIN products p
          ON p.id = si.product_id
        LEFT JOIN payments pay
          ON pay.sale_id = s.id
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND si.status = 'DELIVERED'
          AND DATE(s.created_at) = ?
        GROUP BY
          s.id,
          u.name,
          a.address,
          s.total_amount,
          s.payment_method,
          s.created_at
        ORDER BY s.created_at ASC, s.id ASC
        `,
        [numericDriverId, deliveryDate]
      );

      const totalAmount = dailyRows.reduce(
        (sum, row) => sum + Number(row.total_amount || 0),
        0
      );

      const totalDeliveries = dailyRows.length;

      items.push({
        date: deliveryDate,
        totalAmount,
        totalDeliveries,
        deliveries: dailyRows.map((row) => ({
          saleId: Number(row.sale_id),
          customerName: row.customer_name || "Unknown Customer",
          address: row.address || "No address available",
          cylinderType: row.cylinder_type || "N/A",
          quantity: Number(row.quantity || 0),
          totalAmount: Number(row.total_amount || 0),
          paymentMode: row.payment_mode || "N/A",
          deliveredAt: row.created_at,
        })),
      });
    }

    return res.status(200).json({
      success: true,
      message: "Driver profile history fetched successfully",
      data: {
        driver: {
          id: Number(driverRows[0].id),
          name: driverRows[0].name || "Driver",
          phone: driverRows[0].phone || "",
          vehicleNumber: driverRows[0].vehicle_number || "N/A",
        },
        performance: {
          today: Number(performanceRows[0]?.today_count || 0),
          thisWeek: Number(performanceRows[0]?.this_week_count || 0),
          total: Number(performanceRows[0]?.total_count || 0),
        },
        items,
        pagination: {
          page: safePage,
          limit: safeLimit,
          totalItems: totalDates,
          totalPages,
          hasNextPage: safePage < totalPages,
          hasPrevPage: safePage > 1,
        },
      },
    });
  } catch (error) {
    console.error("getDriverProfileHistory error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch driver profile history",
      error: error.message,
    });
  }
};

export const searchProductsForDriverApp = async (req, res) => {
  try {
    const { type, search = "" } = req.query;

    const searchText = String(search).trim();

    const params = [`%${searchText}%`];
    let typeFilter = "";

    if (type && ["DOMESTIC", "COMMERCIAL"].includes(String(type))) {
      typeFilter = "AND p.type = ?";
      params.push(String(type));
    }

    const [rows] = await db.execute(
      `
      SELECT
        p.id,
        p.name,
        p.type,
        p.price,
        c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.name LIKE ?
        ${typeFilter}
      ORDER BY p.name ASC
      LIMIT 20
      `,
      params
    );

    return res.status(200).json({
      success: true,
      message: "Products fetched successfully",
      data: rows.map((item) => ({
        id: Number(item.id),
        name: item.name,
        type: item.type,
        price: Number(item.price || 0),
        categoryName: item.category_name || "",
      })),
    });
  } catch (error) {
    console.error("searchProductsForDriverApp error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch products",
      error: error.message,
    });
  }
};

export const getAllocatedCylinders = async (req, res) => {
  try {
    const driverId = Number(req.params.driverId);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "Valid driverId is required",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        asi.id AS allocation_sales_item_id,
        asi.sale_id AS allocation_sale_id,
        COALESCE(asi.batch_no, CONCAT('B-', asi.sale_id)) AS batch_no,
        COALESCE(a.assigned_at, a.created_at) AS allocated_at,

        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type,

        COALESCE(asi.quantity, 0) AS total_allocated,

        COALESCE(delivered_data.delivered_qty, 0) AS delivered_qty,
        COALESCE(return_data.return_qty, 0) AS return_qty,
        COALESCE(return_data.defective_qty, 0) AS defective_qty

      FROM sales_items asi
      INNER JOIN sales a
        ON a.id = asi.sale_id
      INNER JOIN products p
        ON p.id = asi.product_id

      LEFT JOIN (
        SELECT
          child.allocation_sales_item_id,
          SUM(COALESCE(child.delivered_qty, child.quantity, 0)) AS delivered_qty
        FROM sales_items child
        INNER JOIN sales cs
          ON cs.id = child.sale_id
        WHERE child.allocation_sales_item_id IS NOT NULL
          AND cs.status = 'DELIVERED'
        GROUP BY child.allocation_sales_item_id
      ) delivered_data
        ON delivered_data.allocation_sales_item_id = asi.id

      LEFT JOIN (
        SELECT
          st.allocation_sales_item_id,
          SUM(CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS return_qty,
          SUM(CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS defective_qty
        FROM stock_transactions st
        WHERE st.stock_from = 'driver'
          AND st.type = 'PURCHASE_RETURN'
          AND st.isApproved IN (0, 1)
          AND st.allocation_sales_item_id IS NOT NULL
        GROUP BY st.allocation_sales_item_id
      ) return_data
        ON return_data.allocation_sales_item_id = asi.id

      WHERE a.driver_id = ?
        AND a.status = 'ASSIGNED'
        AND asi.allocation_sales_item_id IS NULL

      ORDER BY COALESCE(a.assigned_at, a.created_at) DESC, asi.id DESC
      `,
      [driverId]
    );

    const items = rows.map((row) => {
      const totalAllocated = toNumber(row.total_allocated);
      const delivered = toNumber(row.delivered_qty);
      const returned = toNumber(row.return_qty);
      const defective = toNumber(row.defective_qty);
      const pending = Math.max(totalAllocated - delivered - returned - defective, 0);

      return {
        id: Number(row.allocation_sales_item_id),
        saleItemId: Number(row.allocation_sales_item_id),
        saleId: Number(row.allocation_sale_id),

        allocationSaleId: Number(row.allocation_sale_id),
        allocationSalesItemId: Number(row.allocation_sales_item_id),
        batchNo: row.batch_no,

        productId: Number(row.product_id),
        productName: row.product_name,
        productType: row.product_type,
        size: getProductSizeFromName(row.product_name),

        totalAllocated,
        delivered,
        returned,
        defective,
        pending,

        lastAllocatedAt: row.allocated_at,
        latestSaleId: Number(row.allocation_sale_id),
      };
    });

    const summary = items.reduce(
      (acc, item) => {
        acc.totalAllocated += item.totalAllocated;
        acc.delivered += item.delivered;
        acc.returned += item.returned;
        acc.defective += item.defective;
        acc.pending += item.pending;
        return acc;
      },
      {
        totalAllocated: 0,
        delivered: 0,
        returned: 0,
        defective: 0,
        pending: 0,
      }
    );

    return res.status(200).json({
      success: true,
      message: "Allocated cylinders fetched successfully",
      data: {
        summary,
        items,
      },
    });
  } catch (error) {
    console.error("getAllocatedCylinders error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch allocated cylinders",
      error: error.message,
    });
  }
};

export const getDriverDeliveryDetails = async (req, res) => {
  try {
    const { saleId } = req.params;

    if (!saleId) {
      return res.status(400).json({
        success: false,
        message: "saleId is required",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        s.id AS sale_id,
        s.status AS sale_status,
        s.total_amount,
        s.payment_method,
        s.created_at,
        s.delivered_at,

        u.name AS customer_name,
        u.phone AS customer_phone,

        a.address,

        p.name AS product_name,
        p.type AS product_type,
        p.price AS product_price,

        si.quantity,
        si.delivered_qty,
        si.empty_cylinder_qty,
        si.empty_cylinder_status,
        si.defective_qty,
        si.price AS item_price,

        pay.method AS payment_method_used,
        pay.amount AS payment_amount,
        pay.status AS payment_status

      FROM sales s
      LEFT JOIN users u ON u.id = s.customer_id
      LEFT JOIN addresses a ON a.id = s.address_id
      LEFT JOIN sales_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      LEFT JOIN payments pay ON pay.sale_id = s.id

      WHERE s.id = ?
      LIMIT 1
      `,
      [saleId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Delivery not found",
      });
    }

    const row = rows[0];

    return res.status(200).json({
      success: true,
      message: "Delivery details fetched successfully",
      data: {
        saleId: row.sale_id,
        status: row.sale_status,
        deliveredAt: row.delivered_at,
        createdAt: row.created_at,

        customer: {
          name: row.customer_name || "N/A",
          phone: row.customer_phone || "N/A",
          address: row.address || "N/A",
        },

        sales: {
          cylinderType:
            row.product_type === "COMMERCIAL" ? "Commercial" : "Domestic",
          productName: row.product_name || "N/A",
          quantity: Number(row.quantity || 0),
          deliveredQty: Number(row.delivered_qty || 0),
          unitPrice: Number(row.item_price || row.product_price || 0),
          total: Number(row.total_amount || 0),
        },

        returnCylinder: {
          emptyCollected:
            Number(row.empty_cylinder_qty || 0) > 0 ? "Yes" : "No",
          emptyCount: Number(row.empty_cylinder_qty || 0),
          emptyStatus: row.empty_cylinder_status || "PENDING",
          defectiveQty: Number(row.defective_qty || 0),
        },

        payment: {
          method: row.payment_method_used || row.payment_method || "N/A",
          amount: Number(row.payment_amount || row.total_amount || 0),
          status: row.payment_status || "PENDING",
        },
      },
    });
  } catch (error) {
    console.error("getDriverDeliveryDetails error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch delivery details",
      error: error.message,
    });
  }
};

export const createInHandRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      driver_id,
      product_id,
      quantity,
      reason = "",
      is_defective = 0,

      allocation_sale_id = null,
      allocation_sales_item_id = null,
      batch_no = null,

      items = [],
    } = req.body;

    const numericDriverId = Number(driver_id);

    if (!numericDriverId) {
      return res.status(400).json({
        success: false,
        message: "driver_id is required",
      });
    }

    const normalizedItems = Array.isArray(items) && items.length
      ? items
      : [
        {
          product_id,
          quantity,
          allocation_sale_id,
          allocation_sales_item_id,
          batch_no,
        },
      ];

    const validItems = normalizedItems.filter(
      (item) => Number(item.product_id) && Number(item.quantity) > 0
    );

    if (!validItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one valid item is required",
      });
    }

    await connection.beginTransaction();

    for (const item of validItems) {
      const numericProductId = Number(item.product_id);
      const numericQuantity = Number(item.quantity);
      const allocationSalesItemId = item.allocation_sales_item_id
        ? Number(item.allocation_sales_item_id)
        : null;
      const allocationSaleId = item.allocation_sale_id
        ? Number(item.allocation_sale_id)
        : null;

      if (allocationSalesItemId) {
        const [batchRows] = await connection.execute(
          `
          SELECT
            asi.id AS allocation_sales_item_id,
            asi.sale_id AS allocation_sale_id,
            COALESCE(asi.batch_no, CONCAT('B-', asi.sale_id)) AS batch_no,
            asi.product_id,
            COALESCE(asi.quantity, 0) AS total_allocated,

            COALESCE(delivered_data.delivered_qty, 0) AS delivered_qty,
            COALESCE(return_data.return_qty, 0) AS return_qty,
            COALESCE(return_data.defective_qty, 0) AS defective_qty

          FROM sales_items asi
          INNER JOIN sales a
            ON a.id = asi.sale_id

          LEFT JOIN (
            SELECT
              child.allocation_sales_item_id,
              SUM(COALESCE(child.delivered_qty, child.quantity, 0)) AS delivered_qty
            FROM sales_items child
            INNER JOIN sales cs
              ON cs.id = child.sale_id
            WHERE child.allocation_sales_item_id IS NOT NULL
              AND cs.status = 'DELIVERED'
            GROUP BY child.allocation_sales_item_id
          ) delivered_data
            ON delivered_data.allocation_sales_item_id = asi.id

          LEFT JOIN (
            SELECT
              st.allocation_sales_item_id,
              SUM(CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS return_qty,
              SUM(CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS defective_qty
            FROM stock_transactions st
            WHERE st.stock_from = 'driver'
              AND st.type = 'PURCHASE_RETURN'
              AND st.isApproved IN (0, 1)
              AND st.allocation_sales_item_id IS NOT NULL
            GROUP BY st.allocation_sales_item_id
          ) return_data
            ON return_data.allocation_sales_item_id = asi.id

          WHERE asi.id = ?
            AND a.driver_id = ?
            AND asi.product_id = ?
          LIMIT 1
          FOR UPDATE
          `,
          [allocationSalesItemId, numericDriverId, numericProductId]
        );

        if (!batchRows.length) {
          await connection.rollback();
          return res.status(404).json({
            success: false,
            message: "Selected batch item not found",
          });
        }

        const batch = batchRows[0];

        const available =
          toNumber(batch.total_allocated) -
          toNumber(batch.delivered_qty) -
          toNumber(batch.return_qty) -
          toNumber(batch.defective_qty);

        if (numericQuantity > available) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `Only ${available} cylinder(s) available for request in this batch`,
          });
        }
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
          reference_id,
          created_by,
          driver_id,
          stock_from,
          is_defective,
          batch_no,
          allocation_sale_id,
          allocation_sales_item_id
        )
        VALUES (?, 1, 'PURCHASE_RETURN', ?, 0, ?, ?, ?, 'driver', ?, ?, ?, ?)
        `,
        [
          numericProductId,
          numericQuantity,
          allocationSaleId || Date.now(),
          req.user?.id || null,
          numericDriverId,
          Number(is_defective) === 1 ? 1 : 0,
          item.batch_no || (allocationSaleId ? getBatchNo(allocationSaleId) : null),
          allocationSaleId,
          allocationSalesItemId,
        ]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message:
        Number(is_defective) === 1
          ? "Defective request sent for approval"
          : "Return request sent for approval",
    });
  } catch (error) {
    await connection.rollback();

    console.error("createInHandRequest error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create in-hand request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getAllocatedBatchDetail = async (req, res) => {
  try {
    const driverId = Number(req.params.driverId);
    const allocationSalesItemId = Number(req.params.allocationSalesItemId);

    if (!driverId || !allocationSalesItemId) {
      return res.status(400).json({
        success: false,
        message: "driverId and allocationSalesItemId are required",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        asi.id AS allocation_sales_item_id,
        asi.sale_id AS allocation_sale_id,
        COALESCE(asi.batch_no, CONCAT('B-', asi.sale_id)) AS batch_no,
        COALESCE(a.assigned_at, a.created_at) AS allocated_at,

        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type,

        COALESCE(asi.quantity, 0) AS total_allocated,
        COALESCE(delivered_data.delivered_qty, 0) AS delivered_qty,
        COALESCE(return_data.return_qty, 0) AS return_qty,
        COALESCE(return_data.defective_qty, 0) AS defective_qty

      FROM sales_items asi
      INNER JOIN sales a
        ON a.id = asi.sale_id
      INNER JOIN products p
        ON p.id = asi.product_id

      LEFT JOIN (
        SELECT
          child.allocation_sales_item_id,
          SUM(COALESCE(child.delivered_qty, child.quantity, 0)) AS delivered_qty
        FROM sales_items child
        INNER JOIN sales cs
          ON cs.id = child.sale_id
        WHERE child.allocation_sales_item_id IS NOT NULL
          AND cs.status = 'DELIVERED'
        GROUP BY child.allocation_sales_item_id
      ) delivered_data
        ON delivered_data.allocation_sales_item_id = asi.id

      LEFT JOIN (
        SELECT
          st.allocation_sales_item_id,
          SUM(CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS return_qty,
          SUM(CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS defective_qty
        FROM stock_transactions st
        WHERE st.stock_from = 'driver'
          AND st.type = 'PURCHASE_RETURN'
          AND st.isApproved IN (0, 1)
          AND st.allocation_sales_item_id IS NOT NULL
        GROUP BY st.allocation_sales_item_id
      ) return_data
        ON return_data.allocation_sales_item_id = asi.id

      WHERE a.driver_id = ?
        AND asi.id = ?
        AND asi.allocation_sales_item_id IS NULL
      LIMIT 1
      `,
      [driverId, allocationSalesItemId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Batch not found",
      });
    }

    const row = rows[0];

    const totalAllocated = toNumber(row.total_allocated);
    const delivered = toNumber(row.delivered_qty);
    const returned = toNumber(row.return_qty);
    const defective = toNumber(row.defective_qty);
    const pending = Math.max(totalAllocated - delivered - returned - defective, 0);

    return res.status(200).json({
      success: true,
      message: "Batch detail fetched successfully",
      data: {
        allocationSaleId: Number(row.allocation_sale_id),
        allocationSalesItemId: Number(row.allocation_sales_item_id),
        batchNo: row.batch_no,

        productId: Number(row.product_id),
        productName: row.product_name,
        productType: row.product_type,
        size: getProductSizeFromName(row.product_name),

        totalAllocated,
        delivered,
        returned,
        defective,
        pending,

        allocatedAt: row.allocated_at,

        returnItems: [
          {
            productId: Number(row.product_id),
            productName: row.product_name,
            productType: row.product_type,
            size: getProductSizeFromName(row.product_name),
            maxQuantity: pending,
          },
        ],
      },
    });
  } catch (error) {
    console.error("getAllocatedBatchDetail error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch batch detail",
      error: error.message,
    });
  }
};

export const getAvailableBatchesForDriver = async (req, res) => {
  try {
    const driverId = Number(req.params.driverId);
    const { product_id } = req.query;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "Valid driverId is required",
      });
    }

    const productFilter = product_id ? "AND asi.product_id = ?" : "";
    const params = product_id ? [driverId, Number(product_id)] : [driverId];

    const [rows] = await db.execute(
      `
      SELECT
        asi.id AS allocation_sales_item_id,
        asi.sale_id AS allocation_sale_id,
        COALESCE(asi.batch_no, CONCAT('B-', asi.sale_id)) AS batch_no,
        COALESCE(a.assigned_at, a.created_at) AS allocated_at,

        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type,
        p.price AS product_price,

        COALESCE(asi.quantity, 0) AS total_allocated,
        COALESCE(delivered_data.delivered_qty, 0) AS delivered_qty,
        COALESCE(return_data.return_qty, 0) AS return_qty,
        COALESCE(return_data.defective_qty, 0) AS defective_qty

      FROM sales_items asi
      INNER JOIN sales a
        ON a.id = asi.sale_id
      INNER JOIN products p
        ON p.id = asi.product_id

      LEFT JOIN (
        SELECT
          child.allocation_sales_item_id,
          SUM(COALESCE(child.delivered_qty, child.quantity, 0)) AS delivered_qty
        FROM sales_items child
        INNER JOIN sales cs
          ON cs.id = child.sale_id
        WHERE child.allocation_sales_item_id IS NOT NULL
          AND cs.status = 'DELIVERED'
        GROUP BY child.allocation_sales_item_id
      ) delivered_data
        ON delivered_data.allocation_sales_item_id = asi.id

      LEFT JOIN (
        SELECT
          st.allocation_sales_item_id,
          SUM(CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS return_qty,
          SUM(CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS defective_qty
        FROM stock_transactions st
        WHERE st.stock_from = 'driver'
          AND st.type = 'PURCHASE_RETURN'
          AND st.isApproved IN (0, 1)
          AND st.allocation_sales_item_id IS NOT NULL
        GROUP BY st.allocation_sales_item_id
      ) return_data
        ON return_data.allocation_sales_item_id = asi.id

      WHERE a.driver_id = ?
        AND a.status = 'ASSIGNED'
        AND asi.allocation_sales_item_id IS NULL
        ${productFilter}

      ORDER BY COALESCE(a.assigned_at, a.created_at) DESC, asi.id DESC
      `,
      params
    );

    const batches = rows
      .map((row) => {
        const totalAllocated = toNumber(row.total_allocated);
        const delivered = toNumber(row.delivered_qty);
        const returned = toNumber(row.return_qty);
        const defective = toNumber(row.defective_qty);
        const pending = Math.max(totalAllocated - delivered - returned - defective, 0);

        return {
          allocationSaleId: Number(row.allocation_sale_id),
          allocationSalesItemId: Number(row.allocation_sales_item_id),
          batchNo: row.batch_no,

          productId: Number(row.product_id),
          productName: row.product_name,
          productType: row.product_type,
          productPrice: Number(row.product_price || 0),
          size: getProductSizeFromName(row.product_name),

          totalAllocated,
          delivered,
          returned,
          defective,
          pending,

          allocatedAt: row.allocated_at,
        };
      })
      .filter((item) => item.pending > 0);

    return res.status(200).json({
      success: true,
      message: "Available batches fetched successfully",
      data: batches,
    });
  } catch (error) {
    console.error("getAvailableBatchesForDriver error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch available batches",
      error: error.message,
    });
  }
};

export const findBookingCustomer = async (req, res) => {
  try {
    const { phone } = req.query;

    if (!phone || !String(phone).trim()) {
      return res.status(400).json({
        success: false,
        message: "phone is required",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        u.id,
        u.name,
        u.phone,
        a.id AS address_id,
        a.address
      FROM users u
      LEFT JOIN addresses a ON a.user_id = u.id
      WHERE u.role = 'CUSTOMER'
        AND u.phone = ?
      ORDER BY a.is_default DESC, a.id DESC
      LIMIT 1
      `,
      [String(phone).trim()]
    );

    if (!rows.length) {
      return res.status(200).json({
        success: true,
        message: "New customer",
        data: {
          exists: false,
          customer: null,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Customer found",
      data: {
        exists: true,
        customer: {
          id: Number(rows[0].id),
          name: rows[0].name,
          phone: rows[0].phone,
          addressId: rows[0].address_id ? Number(rows[0].address_id) : null,
          address: rows[0].address || "",
        },
      },
    });
  } catch (error) {
    console.error("findBookingCustomer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to find customer",
      error: error.message,
    });
  }
};

export const createBookingCustomer = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { name, phone, address, geo_location_tag } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        message: "Customer name is required",
      });
    }

    if (!phone || !String(phone).trim()) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    if (!address || !String(address).trim()) {
      return res.status(400).json({
        success: false,
        message: "Address is required",
      });
    }

    await connection.beginTransaction();

    const [existingRows] = await connection.execute(
      `
      SELECT id, name, phone
      FROM users
      WHERE phone = ?
        AND role = 'CUSTOMER'
      LIMIT 1
      `,
      [String(phone).trim()]
    );

    if (existingRows.length) {
      const [addressRows] = await connection.execute(
        `
        SELECT id, address
        FROM addresses
        WHERE user_id = ?
        ORDER BY is_default DESC, id DESC
        LIMIT 1
        `,
        [existingRows[0].id]
      );

      await connection.commit();

      return res.status(200).json({
        success: true,
        message: "Customer already exists",
        data: {
          customer: {
            id: Number(existingRows[0].id),
            name: existingRows[0].name,
            phone: existingRows[0].phone,
            addressId: addressRows[0]?.id ? Number(addressRows[0].id) : null,
            address: addressRows[0]?.address || "",
          },
        },
      });
    }

    const [userResult] = await connection.execute(
      `
      INSERT INTO users
      (
        name,
        phone,
        role,
        status,
        created_at
      )
      VALUES (?, ?, 'CUSTOMER', 'ACTIVE', NOW())
      `,
      [String(name).trim(), String(phone).trim()]
    );

    const customerId = userResult.insertId;

    const finalAddress = geo_location_tag
      ? `${String(address).trim()} | Geo: ${String(geo_location_tag).trim()}`
      : String(address).trim();

    const [addressResult] = await connection.execute(
      `
      INSERT INTO addresses
      (
        user_id,
        address,
        is_default,
        created_at
      )
      VALUES (?, ?, 1, NOW())
      `,
      [customerId, finalAddress]
    );

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Customer created successfully",
      data: {
        customer: {
          id: Number(customerId),
          name: String(name).trim(),
          phone: String(phone).trim(),
          addressId: Number(addressResult.insertId),
          address: finalAddress,
        },
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createBookingCustomer error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create customer",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createDriverBooking = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driver_id, customer_id, address_id, items = [] } = req.body;

    const numericDriverId = Number(driver_id);
    const numericCustomerId = Number(customer_id);
    const numericAddressId = Number(address_id);

    if (!numericDriverId || !numericCustomerId || !numericAddressId) {
      return res.status(400).json({
        success: false,
        message: "driver_id, customer_id and address_id are required",
      });
    }

    const validItems = Array.isArray(items)
      ? items.filter(
          (item) => Number(item.product_id) && Number(item.quantity) > 0
        )
      : [];

    if (!validItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one product quantity is required",
      });
    }

    await connection.beginTransaction();

    const productIds = validItems.map((item) => Number(item.product_id));
    const placeholders = productIds.map(() => "?").join(",");

    const [productRows] = await connection.execute(
      `
      SELECT id, name, type, price
      FROM products
      WHERE id IN (${placeholders})
        AND type = 'COMMERCIAL'
      `,
      productIds
    );

    if (productRows.length !== productIds.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Only commercial products are allowed for booking",
      });
    }

    const productMap = new Map();
    productRows.forEach((item) => {
      productMap.set(Number(item.id), item);
    });

    let totalAmount = 0;

    validItems.forEach((item) => {
      const product = productMap.get(Number(item.product_id));
      totalAmount += Number(product.price || 0) * Number(item.quantity || 0);
    });

    const [saleResult] = await connection.execute(
      `
      INSERT INTO sales
      (
        customer_id,
        driver_id,
        total_amount,
        payment_method,
        status,
        address_id,
        sale_type,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, NULL, 'PENDING', ?, 'BOOKING', NOW(), NOW())
      `,
      [numericCustomerId, numericDriverId, totalAmount, numericAddressId]
    );

    const saleId = saleResult.insertId;

    for (const item of validItems) {
      const productId = Number(item.product_id);
      const quantity = Number(item.quantity || 0);
      const product = productMap.get(productId);
      const price = Number(product.price || 0) * quantity;

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
          empty_cylinder_status,
          defective_qty
        )
        VALUES (?, ?, ?, ?, 'PENDING', 0, 0, 'PENDING', 0)
        `,
        [saleId, productId, quantity, price]
      );

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
          allocation_sale_id,
          allocation_sales_item_id
        )
        VALUES (?, 1, 'BOOKING_ADD', ?, 0, ?, ?, ?, 'godown', 0, ?, ?)
        `,
        [
          productId,
          quantity,
          saleId,
          numericDriverId,
          req.user?.id || null,
          saleId,
          salesItemResult.insertId,
        ]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Booking created successfully",
      data: {
        saleId: Number(saleId),
        totalAmount,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createDriverBooking error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create booking",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getDriverBookings = async (req, res) => {
  try {
    const driverId = Number(req.params.driverId);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driverId is required",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        s.id AS sale_id,
        s.status,
        s.total_amount,
        s.created_at,
        s.delivered_at,
        u.name AS customer_name,
        u.phone,
        a.address,
        COALESCE(SUM(si.quantity), 0) AS total_qty,
        COALESCE(MAX(p.type), 'COMMERCIAL') AS cylinder_type,
        GROUP_CONCAT(
          CONCAT(p.name, ' x ', si.quantity)
          ORDER BY p.name
          SEPARATOR ', '
        ) AS product_summary
      FROM sales s
      INNER JOIN users u ON u.id = s.customer_id
      LEFT JOIN addresses a ON a.id = s.address_id
      LEFT JOIN sales_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      WHERE s.driver_id = ?
        AND s.sale_type = 'BOOKING'
      GROUP BY
        s.id,
        s.status,
        s.total_amount,
        s.created_at,
        s.delivered_at,
        u.name,
        u.phone,
        a.address
      ORDER BY s.created_at DESC, s.id DESC
      `,
      [driverId]
    );

    const items = rows.map((item) => ({
      saleId: Number(item.sale_id),
      customerName: item.customer_name || "Unknown Customer",
      phone: item.phone || "",
      address: item.address || "",
      status: item.status,
      totalAmount: Number(item.total_amount || 0),
      totalQty: Number(item.total_qty || 0),
      cylinderType: item.cylinder_type || "COMMERCIAL",
      productSummary: item.product_summary || "",
      createdAt: item.created_at,
      deliveredAt: item.delivered_at,
    }));

    return res.status(200).json({
      success: true,
      message: "Bookings fetched successfully",
      data: {
        total: items.length,
        items,
      },
    });
  } catch (error) {
    console.error("getDriverBookings error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch bookings",
      error: error.message,
    });
  }
};

export const cancelDriverBooking = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const saleId = Number(req.params.saleId);
    const driverId = Number(req.body.driver_id);

    if (!saleId) {
      return res.status(400).json({
        success: false,
        message: "saleId is required",
      });
    }

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driver_id is required",
      });
    }

    await connection.beginTransaction();

    const [saleRows] = await connection.execute(
      `
      SELECT id, status
      FROM sales
      WHERE id = ?
        AND driver_id = ?
        AND sale_type = 'BOOKING'
      FOR UPDATE
      `,
      [saleId, driverId]
    );

    if (!saleRows.length) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    if (saleRows[0].status !== "PENDING") {
      await connection.rollback();

      return res.status(400).json({
        success: false,
        message: "Only pending bookings can be cancelled",
      });
    }

    await connection.execute(
      `
      UPDATE sales
      SET status = 'CANCELLED',
          updated_at = NOW()
      WHERE id = ?
      `,
      [saleId]
    );

    await connection.execute(
      `
      UPDATE sales_items
      SET status = 'CANCELLED'
      WHERE sale_id = ?
      `,
      [saleId]
    );

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Booking cancelled successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("cancelDriverBooking error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to cancel booking",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
