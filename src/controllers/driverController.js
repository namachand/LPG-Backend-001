import db from "../config/db.js";

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
      payment_method,
      amount,

      empty_cylinder_collected = false,

      delivered_qty = quantity,
      empty_cylinder_qty = 0,
      empty_cylinder_status = "PENDING",
      defective_qty = 0,
    } = req.body;

    // =========================
    // VALIDATIONS
    // =========================
    if (!driver_id) {
      return res.status(400).json({
        success: false,
        message: "driver_id is required",
      });
    }

    if (!customer_name || !customer_name.trim()) {
      return res.status(400).json({
        success: false,
        message: "customer_name is required",
      });
    }

    if (!address || !address.trim()) {
      return res.status(400).json({
        success: false,
        message: "address is required",
      });
    }

    if (!cylinder_type || !["DOMESTIC", "COMMERCIAL"].includes(cylinder_type)) {
      return res.status(400).json({
        success: false,
        message: "cylinder_type must be DOMESTIC or COMMERCIAL",
      });
    }

    if (!product_id) {
      return res.status(400).json({
        success: false,
        message: "product_id is required",
      });
    }

    if (
      !payment_method ||
      !["CASH", "UPI", "ONLINE", "CREDIT"].includes(payment_method)
    ) {
      return res.status(400).json({
        success: false,
        message: "payment_method must be CASH, UPI, ONLINE or CREDIT",
      });
    }

    const numericDriverId = Number(driver_id);
    const numericProductId = Number(product_id);
    const numericQuantity = Number(quantity);
    const numericAmount = Number(amount);

    const numericDeliveredQty = Number(delivered_qty || quantity);
    const numericEmptyCylinderQty = Number(empty_cylinder_qty || 0);
    const numericDefectiveQty = Number(defective_qty || 0);

    if (Number.isNaN(numericDriverId)) {
      return res.status(400).json({
        success: false,
        message: "driver_id must be a valid number",
      });
    }

    if (Number.isNaN(numericProductId)) {
      return res.status(400).json({
        success: false,
        message: "product_id must be a valid number",
      });
    }

    if (Number.isNaN(numericQuantity) || numericQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "quantity must be greater than 0",
      });
    }

    if (Number.isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "amount must be greater than 0",
      });
    }

    if (Number.isNaN(numericEmptyCylinderQty) || numericEmptyCylinderQty < 0) {
      return res.status(400).json({
        success: false,
        message: "empty_cylinder_qty must be 0 or greater",
      });
    }

    if (numericEmptyCylinderQty > numericQuantity) {
      return res.status(400).json({
        success: false,
        message: "empty_cylinder_qty cannot be greater than ordered quantity",
      });
    }

    if (Number.isNaN(numericDefectiveQty) || numericDefectiveQty < 0) {
      return res.status(400).json({
        success: false,
        message: "defective_qty must be 0 or greater",
      });
    }

    if (numericDefectiveQty > numericEmptyCylinderQty) {
      return res.status(400).json({
        success: false,
        message: "defective_qty cannot be greater than empty_cylinder_qty",
      });
    }

    const emptyCylinderStatus = getEmptyCylinderStatus(
      numericQuantity,
      numericEmptyCylinderQty
    );

    // =========================
    // START TRANSACTION
    // =========================
    await connection.beginTransaction();

    // =========================
    // CHECK DRIVER EXISTS
    // =========================
    const [driverRows] = await connection.execute(
      `
      SELECT id
      FROM drivers
      WHERE id = ?
      LIMIT 1
      `,
      [numericDriverId]
    );

    if (!driverRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    // =========================
    // CHECK PRODUCT EXISTS
    // =========================
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
        message: "Selected product not found",
      });
    }

    const selectedProduct = productRows[0];

    if (selectedProduct.type !== cylinder_type) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Selected product does not match selected cylinder type",
      });
    }

    // =========================
    // FIND OR CREATE CUSTOMER
    // =========================
    let customerId = null;

    if (phone && phone.trim()) {
      const [existingCustomerRows] = await connection.execute(
        `
        SELECT id
        FROM users
        WHERE phone = ?
        LIMIT 1
        `,
        [phone.trim()]
      );

      if (existingCustomerRows.length) {
        customerId = existingCustomerRows[0].id;

        await connection.execute(
          `
          UPDATE users
          SET name = ?, role = 'CUSTOMER', status = 'ACTIVE'
          WHERE id = ?
          `,
          [customer_name.trim(), customerId]
        );
      }
    }

    if (!customerId) {
      const [userInsertResult] = await connection.execute(
        `
        INSERT INTO users (
          name,
          phone,
          role,
          status
        )
        VALUES (?, ?, 'CUSTOMER', 'ACTIVE')
        `,
        [customer_name.trim(), phone?.trim() || null]
      );

      customerId = userInsertResult.insertId;
    }

    // =========================
    // CREATE ADDRESS
    // =========================
    const [addressInsertResult] = await connection.execute(
      `
      INSERT INTO addresses (
        user_id,
        address,
        is_default
      )
      VALUES (?, ?, 1)
      `,
      [customerId, address.trim()]
    );

    const addressId = addressInsertResult.insertId;

    // =========================
    // CREATE SALE
    // NOTE:
    // empty_cylinder_qty and empty_cylinder_status removed from sales.
    // They are now stored in sales_items.
    // =========================
    const salePaymentMethod =
      payment_method === "ONLINE"
        ? "ONLINE"
        : payment_method === "UPI"
          ? "UPI"
          : payment_method === "CASH"
            ? "CASH"
            : "PART_PAYMENT";

    const [saleInsertResult] = await connection.execute(
      `
      INSERT INTO sales (
        customer_id,
        driver_id,
        total_amount,
        payment_method,
        status,
        address_id,
        assigned_at
      )
      VALUES (?, ?, ?, ?, 'DELIVERED', ?, NOW())
      `,
      [
        customerId,
        numericDriverId,
        numericAmount,
        salePaymentMethod,
        addressId,
      ]
    );

    const saleId = saleInsertResult.insertId;

    // =========================
    // CREATE SALES ITEM
    // empty_cylinder_qty, empty_cylinder_status,
    // delivered_qty and defective_qty are item-level now.
    // =========================
    await connection.execute(
      `
  INSERT INTO sales_items (
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
  VALUES (?, ?, ?, ?, 'DELIVERED', ?, ?, ?, ?)
  `,
      [
        saleId,
        selectedProduct.id,
        numericQuantity,
        numericAmount,

        numericDeliveredQty,

        numericEmptyCylinderQty,

        empty_cylinder_status || emptyCylinderStatus,

        numericDefectiveQty,
      ]
    );

    // =========================
    // CREATE PAYMENT
    // =========================
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
    } else {
      paymentMethodForPayments = null; // CREDIT
      paymentStatus = "PENDING";
    }

    const [paymentInsertResult] = await connection.execute(
      `
      INSERT INTO payments (
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

    // =========================
    // CREATE SETTLEMENT HISTORY
    // ONLY FOR CASH / UPI
    // =========================
    if (payment_method === "CASH" || payment_method === "UPI") {
      await connection.execute(
        `
        INSERT INTO settlement_history (
          driver_id,
          sale_id,
          payment_id,
          method,
          amount,
          status
        )
        VALUES (?, ?, ?, ?, ?, 'PENDING')
        `,
        [numericDriverId, saleId, paymentId, payment_method, numericAmount]
      );
    }

    // =========================
    // COMMIT
    // =========================
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
        quantity: numericQuantity,
        deliveredQty: numericQuantity,
        amount: numericAmount,
        paymentMethod: payment_method,
        emptyCylinderCollected: numericEmptyCylinderQty > 0,
        emptyCylinderQty: numericEmptyCylinderQty,
        emptyCylinderStatus,
        defectiveQty: numericDefectiveQty,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createDriverSale error:", error);

    if (error?.code === "ER_DUP_ENTRY") {
      return res.status(400).json({
        success: false,
        message: "Phone number already exists with another customer",
        error: error.message,
      });
    }

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

    const [cashRows] = await db.execute(
      `
      SELECT
        sh.id,
        sh.sale_id,
        sh.amount,
        sh.created_at,
        u.name AS customer_name
      FROM settlement_history sh
      INNER JOIN sales s
        ON s.id = sh.sale_id
      LEFT JOIN users u
        ON u.id = s.customer_id
      WHERE sh.driver_id = ?
        AND sh.method = 'CASH'
        AND sh.status = 'PENDING'
      ORDER BY sh.created_at ASC, sh.id ASC
      `,
      [numericDriverId]
    );

    const [upiRows] = await db.execute(
      `
      SELECT
        sh.id,
        sh.sale_id,
        sh.amount,
        sh.created_at,
        u.name AS customer_name
      FROM settlement_history sh
      INNER JOIN sales s
        ON s.id = sh.sale_id
      LEFT JOIN users u
        ON u.id = s.customer_id
      WHERE sh.driver_id = ?
        AND sh.method = 'UPI'
        AND sh.status = 'PENDING'
      ORDER BY sh.created_at ASC, sh.id ASC
      `,
      [numericDriverId]
    );

    const cashCollected = cashRows.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0
    );

    const upiCollected = upiRows.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0
    );

    return res.status(200).json({
      success: true,
      message: "Driver collection summary fetched successfully",
      data: {
        summary: {
          cashCollected: Number(cashCollected || 0),
          upiCollected: Number(upiCollected || 0),
          totalCollected: Number(cashCollected || 0) + Number(upiCollected || 0),
        },
        settlements: {
          cash: cashRows.map((row) => ({
            id: Number(row.id),
            saleId: Number(row.sale_id),
            amount: Number(row.amount || 0),
            customerName: row.customer_name || "Unknown Customer",
            createdAt: row.created_at,
          })),
          upi: upiRows.map((row) => ({
            id: Number(row.id),
            saleId: Number(row.sale_id),
            amount: Number(row.amount || 0),
            customerName: row.customer_name || "Unknown Customer",
            createdAt: row.created_at,
          })),
        },
      },
    });
  } catch (error) {
    console.error("getDriverCollectionSummary error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch driver collection summary",
      error: error.message,
    });
  }
};

export const settleDriverCollectionsByMethod = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driverId } = req.params;
    const { method, denominations } = req.body || {};

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

    if (!["CASH", "UPI", "TOTAL_UPI"].includes(method)) {
      return res.status(400).json({
        success: false,
        message: "method must be CASH, UPI or TOTAL_UPI",
      });
    }

    await connection.beginTransaction();

    // CASH
    if (method === "CASH") {
      let enteredCashTotal = null;

      if (denominations) {
        const d500 = Number(denominations?.["500"] || 0);
        const d100 = Number(denominations?.["100"] || 0);
        const d50 = Number(denominations?.["50"] || 0);
        const d20 = Number(denominations?.["20"] || 0);
        const d10 = Number(denominations?.["10"] || 0);
        const coins = Number(denominations?.coins || 0);

        if ([d500, d100, d50, d20, d10, coins].some((v) => Number.isNaN(v) || v < 0)) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: "Invalid denomination values",
          });
        }

        enteredCashTotal =
          d500 * 500 +
          d100 * 100 +
          d50 * 50 +
          d20 * 20 +
          d10 * 10 +
          coins;
      }

      const [pendingRows] = await connection.execute(
        `
        SELECT sh.id, sh.amount
        FROM settlement_history sh
        WHERE sh.driver_id = ?
          AND sh.method = 'CASH'
          AND sh.status = 'PENDING'
        FOR UPDATE
        `,
        [numericDriverId]
      );

      if (!pendingRows.length) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: "No pending CASH settlements found",
        });
      }

      const expectedTotal = pendingRows.reduce(
        (sum, row) => sum + Number(row.amount || 0),
        0
      );

      if (enteredCashTotal !== null && enteredCashTotal !== expectedTotal) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Entered cash total ₹${enteredCashTotal} does not match expected ₹${expectedTotal}`,
        });
      }

      const [updateResult] = await connection.execute(
        `
        UPDATE settlement_history
        SET status = 'SETTLED'
        WHERE driver_id = ?
          AND method = 'CASH'
          AND status = 'PENDING'
        `,
        [numericDriverId]
      );

      await connection.commit();

      return res.status(200).json({
        success: true,
        message: "CASH settlements marked as settled successfully",
        data: {
          updatedCount: updateResult.affectedRows || 0,
          method: "CASH",
          expectedTotal,
          enteredTotal: enteredCashTotal,
          denominations: denominations || null,
        },
      });
    }

    // UPI
    if (method === "UPI") {
      const [pendingRows] = await connection.execute(
        `
        SELECT sh.id, sh.amount
        FROM settlement_history sh
        WHERE sh.driver_id = ?
          AND sh.method = 'UPI'
          AND sh.status = 'PENDING'
        FOR UPDATE
        `,
        [numericDriverId]
      );

      if (!pendingRows.length) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: "No pending UPI settlements found",
        });
      }

      const expectedTotal = pendingRows.reduce(
        (sum, row) => sum + Number(row.amount || 0),
        0
      );

      const [updateResult] = await connection.execute(
        `
        UPDATE settlement_history
        SET status = 'SETTLED'
        WHERE driver_id = ?
          AND method = 'UPI'
          AND status = 'PENDING'
        `,
        [numericDriverId]
      );

      await connection.commit();

      return res.status(200).json({
        success: true,
        message: "UPI settlements marked as settled successfully",
        data: {
          updatedCount: updateResult.affectedRows || 0,
          method: "UPI",
          expectedTotal,
        },
      });
    }

    // TOTAL COLLECTION -> SETTLE EVERYTHING AS UPI
    if (method === "TOTAL_UPI") {
      const [pendingRows] = await connection.execute(
        `
        SELECT id, amount, method
        FROM settlement_history
        WHERE driver_id = ?
          AND status = 'PENDING'
          AND method IN ('CASH', 'UPI')
        FOR UPDATE
        `,
        [numericDriverId]
      );

      if (!pendingRows.length) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: "No pending collections found to settle in UPI mode",
        });
      }

      const expectedTotal = pendingRows.reduce(
        (sum, row) => sum + Number(row.amount || 0),
        0
      );

      const [updateResult] = await connection.execute(
        `
        UPDATE settlement_history
        SET
          method = 'UPI',
          status = 'SETTLED'
        WHERE driver_id = ?
          AND status = 'PENDING'
          AND method IN ('CASH', 'UPI')
        `,
        [numericDriverId]
      );

      await connection.commit();

      return res.status(200).json({
        success: true,
        message: "All pending collections settled successfully in UPI mode",
        data: {
          updatedCount: updateResult.affectedRows || 0,
          method: "TOTAL_UPI",
          expectedTotal,
        },
      });
    }
  } catch (error) {
    await connection.rollback();
    console.error("settleDriverCollectionsByMethod error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to settle collections",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};


export const getDriverInHandSummary = async (req, res) => {
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

    // =========================
    // TOP SUMMARY CARDS
    // =========================
    const [summaryRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(CASE WHEN s.status IN ('PENDING', 'ASSIGNED', 'DELIVERED') THEN 1 ELSE 0 END), 0) AS allocated,
        COALESCE(SUM(CASE WHEN s.status = 'DELIVERED' THEN 1 ELSE 0 END), 0) AS delivered,
        COALESCE(SUM(CASE WHEN s.status IN ('PENDING', 'ASSIGNED') THEN 1 ELSE 0 END), 0) AS in_hand
      FROM sales s
      WHERE s.driver_id = ?
      `,
      [numericDriverId]
    );

    // =========================
    // RETURN REQUESTS
    // NOTE:
    // assuming stock_transactions.created_by stores driver-related id
    // and pending return requests are ADJUSTMENT_ADD with isApproved = 0
    // =========================
    const [requestRows] = await db.execute(
      `
      SELECT
        st.id,
        st.product_id,
        st.stock_area_id,
        st.quantity,
        st.created_at,
        st.isApproved,
        p.name AS product_name
      FROM stock_transactions st
      LEFT JOIN products p
        ON p.id = st.product_id
      WHERE st.created_by = ?
        AND st.type = 'ADJUSTMENT_ADD'
        AND st.isApproved = 0
      ORDER BY st.created_at DESC, st.id DESC
      `,
      [numericDriverId]
    );

    const summary = {
      allocated: Number(summaryRows[0]?.allocated || 0),
      delivered: Number(summaryRows[0]?.delivered || 0),
      inHand: Number(summaryRows[0]?.in_hand || 0),
    };

    const returnRequests = requestRows.map((item) => ({
      id: Number(item.id),
      productId: Number(item.product_id),
      stockAreaId: Number(item.stock_area_id),
      quantity: Number(item.quantity || 0),
      productName: item.product_name || "Cylinder",
      createdAt: item.created_at,
      isApproved: Number(item.isApproved || 0),
    }));

    return res.status(200).json({
      success: true,
      message: "In-hand summary fetched successfully",
      data: {
        summary,
        returnRequests,
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

    const safePage = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const safeLimit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 2;
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

    // =========================
    // GET DISTINCT DATES WITH PAGINATION
    // NOTE:
    // LIMIT / OFFSET are safely sanitized integers and inlined
    // =========================
    const [dateRows] = await db.execute(
      `
      SELECT DATE(s.delivered_at) AS delivery_date
      FROM sales s
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
        AND s.delivered_at IS NOT NULL
      GROUP BY DATE(s.delivered_at)
      ORDER BY delivery_date DESC
      LIMIT ${safeLimit} OFFSET ${offset}
      `,
      [numericDriverId]
    );

    const [countRows] = await db.execute(
      `
      SELECT COUNT(*) AS totalDates
      FROM (
        SELECT DATE(s.delivered_at) AS delivery_date
        FROM sales s
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND s.delivered_at IS NOT NULL
        GROUP BY DATE(s.delivered_at)
      ) t
      `,
      [numericDriverId]
    );

    const totalDates = Number(countRows[0]?.totalDates || 0);
    const totalPages = Math.ceil(totalDates / safeLimit);

    if (!dateRows.length) {
      return res.status(200).json({
        success: true,
        message: "Collection history fetched successfully",
        data: {
          items: [],
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
    }

    const items = [];

    for (const dateRow of dateRows) {
      const deliveryDate = dateRow.delivery_date;

      const [dailyTotalRows] = await db.execute(
        `
        SELECT
          COALESCE(SUM(p.amount), 0) AS total_amount
        FROM sales s
        LEFT JOIN payments p
          ON p.sale_id = s.id
         AND p.status = 'SUCCESS'
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND DATE(s.delivered_at) = ?
        `,
        [numericDriverId, deliveryDate]
      );

      const [methodSummaryRows] = await db.execute(
        `
        SELECT
          COALESCE(SUM(CASE WHEN p.method = 'CASH' THEN p.amount ELSE 0 END), 0) AS cash_amount,
          COALESCE(SUM(CASE WHEN p.method = 'UPI' THEN p.amount ELSE 0 END), 0) AS upi_amount,
          COALESCE(SUM(CASE WHEN p.method = 'CARD' THEN p.amount ELSE 0 END), 0) AS online_amount
        FROM sales s
        LEFT JOIN payments p
          ON p.sale_id = s.id
         AND p.status = 'SUCCESS'
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND DATE(s.delivered_at) = ?
        `,
        [numericDriverId, deliveryDate]
      );

      const [settlementSummaryRows] = await db.execute(
        `
        SELECT
          COALESCE(SUM(CASE WHEN sh.method = 'CASH' THEN sh.amount ELSE 0 END), 0) AS settlement_cash_amount,
          COALESCE(SUM(CASE WHEN sh.method = 'UPI' THEN sh.amount ELSE 0 END), 0) AS settlement_upi_amount,
          MAX(CASE WHEN sh.method = 'CASH' AND sh.status = 'SETTLED' THEN sh.created_at END) AS cash_settled_at,
          MAX(CASE WHEN sh.method = 'UPI' AND sh.status = 'SETTLED' THEN sh.created_at END) AS upi_settled_at,
          MAX(CASE WHEN sh.method = 'CASH' THEN sh.status END) AS cash_status,
          MAX(CASE WHEN sh.method = 'UPI' THEN sh.status END) AS upi_status
        FROM settlement_history sh
        INNER JOIN sales s
          ON s.id = sh.sale_id
        WHERE sh.driver_id = ?
          AND DATE(s.delivered_at) = ?
        `,
        [numericDriverId, deliveryDate]
      );

      const [transactionRows] = await db.execute(
        `
        SELECT
          s.id AS sale_id,
          u.name AS customer_name,
          COALESCE(SUM(p.amount), 0) AS amount,
          COALESCE(
            MAX(
              CASE
                WHEN p.status = 'SUCCESS' THEN p.method
                ELSE NULL
              END
            ),
            s.payment_method,
            'N/A'
          ) AS payment_mode,
          s.delivered_at
        FROM sales s
        LEFT JOIN users u
          ON u.id = s.customer_id
        LEFT JOIN payments p
          ON p.sale_id = s.id
         AND p.status = 'SUCCESS'
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND DATE(s.delivered_at) = ?
        GROUP BY s.id, u.name, s.payment_method, s.delivered_at
        ORDER BY s.delivered_at DESC, s.id DESC
        `,
        [numericDriverId, deliveryDate]
      );

      items.push({
        date: deliveryDate,
        totalAmount: Number(dailyTotalRows[0]?.total_amount || 0),
        summary: {
          cash: {
            amount: Number(methodSummaryRows[0]?.cash_amount || 0),
            status: settlementSummaryRows[0]?.cash_status || "PENDING",
            settledAt: settlementSummaryRows[0]?.cash_settled_at || null,
          },
          upi: {
            amount: Number(methodSummaryRows[0]?.upi_amount || 0),
            status: settlementSummaryRows[0]?.upi_status || "PENDING",
            settledAt: settlementSummaryRows[0]?.upi_settled_at || null,
          },
        },
        transactions: transactionRows.map((row) => ({
          saleId: Number(row.sale_id),
          customerName: row.customer_name || "Unknown Customer",
          amount: Number(row.amount || 0),
          paymentMode: row.payment_mode || "N/A",
          deliveredAt: row.delivered_at,
          status: "Paid",
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

    // =========================
    // SUMMARY FROM SALES
    // =========================
    const [summaryRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(s.empty_cylinder_qty), 0) AS collected,
        COALESCE(SUM(
          CASE
            WHEN s.empty_cylinder_status = 'DELIVERED'
            THEN s.empty_cylinder_qty
            ELSE 0
          END
        ), 0) AS returned_qty,
        COALESCE(SUM(
          CASE
            WHEN s.empty_cylinder_status IN ('PENDING', 'PARTIAL_PENDING')
            THEN s.empty_cylinder_qty
            ELSE 0
          END
        ), 0) AS in_hand_qty
      FROM sales s
      WHERE s.driver_id = ?
        AND s.empty_cylinder_qty > 0
        AND DATE(s.created_at) = CURDATE()
      `,
      [numericDriverId]
    );

    // =========================
    // COLLECTED FROM
    // =========================
    const [collectedFromRows] = await db.execute(
      `
      SELECT
        s.id AS sale_id,
        s.empty_cylinder_qty,
        s.empty_cylinder_status,
        s.created_at,
        u.name AS customer_name,
        p.type AS product_type
      FROM sales s
      LEFT JOIN users u
        ON u.id = s.customer_id
      LEFT JOIN sales_items si
        ON si.sale_id = s.id
      LEFT JOIN products p
        ON p.id = si.product_id
      WHERE s.driver_id = ?
        AND s.empty_cylinder_qty > 0
        AND DATE(s.created_at) = CURDATE()
      ORDER BY s.created_at ASC, s.id ASC
      `,
      [numericDriverId]
    );

    // =========================
    // RETURN REQUESTS
    // =========================
    const [returnRequestRows] = await db.execute(
      `
      SELECT
        s.id AS sale_id,
        s.empty_cylinder_qty,
        s.empty_cylinder_status,
        s.created_at
      FROM sales s
      WHERE s.driver_id = ?
        AND s.empty_cylinder_qty > 0
        AND DATE(s.created_at) = CURDATE()
      ORDER BY s.created_at ASC, s.id ASC
      `,
      [numericDriverId]
    );

    return res.status(200).json({
      success: true,
      message: "Empty cylinder today data fetched successfully",
      data: {
        summary: {
          collected: Number(summaryRows[0]?.collected || 0),
          returned: Number(summaryRows[0]?.returned_qty || 0),
          inHand: Number(summaryRows[0]?.in_hand_qty || 0),
        },

        collectedFrom: collectedFromRows.map((row) => ({
          id: Number(row.sale_id),
          saleId: Number(row.sale_id),
          customerName: row.customer_name || "Unknown Customer",
          productType: row.product_type || "N/A",
          quantity: Number(row.empty_cylinder_qty || 0),
          status: row.empty_cylinder_status || "PENDING",
          createdAt: row.created_at,
        })),

        returnRequests: returnRequestRows.map((row) => ({
          id: Number(row.sale_id),
          saleId: Number(row.sale_id),
          quantity: Number(row.empty_cylinder_qty || 0),
          createdAt: row.created_at,
          status: row.empty_cylinder_status || "PENDING",

          // keeping this only if your frontend still expects isApproved
          isApproved: row.empty_cylinder_status === "DELIVERED" ? 1 : 0,
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

    const [historyRows] = await db.execute(
      `
      SELECT
        DATE(st.created_at) AS history_date,
        COALESCE(SUM(st.quantity), 0) AS collected,
        COALESCE(SUM(CASE WHEN st.isApproved = 1 THEN st.quantity ELSE 0 END), 0) AS returned_qty
      FROM stock_transactions st
      INNER JOIN products p
        ON p.id = st.product_id
      INNER JOIN categories c
        ON c.id = p.category_id
      WHERE st.created_by = ?
        AND c.name = 'Empty Cylinder'
        AND st.type = 'ADJUSTMENT_ADD'
      GROUP BY DATE(st.created_at)
      ORDER BY history_date DESC
      `,
      [numericDriverId]
    );

    return res.status(200).json({
      success: true,
      message: "Empty cylinder history fetched successfully",
      data: {
        items: historyRows.map((row) => ({
          date: row.history_date,
          collected: Number(row.collected || 0),
          returned: Number(row.returned_qty || 0),
        })),
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

    const safePage = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const safeLimit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 2;
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

    // ==========================================
    // PERFORMANCE SUMMARY
    // ==========================================
    const [performanceRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(CASE WHEN DATE(s.delivered_at) = CURDATE() THEN 1 ELSE 0 END), 0) AS today_count,
        COALESCE(SUM(CASE WHEN YEARWEEK(s.delivered_at, 1) = YEARWEEK(CURDATE(), 1) THEN 1 ELSE 0 END), 0) AS this_week_count,
        COALESCE(COUNT(s.id), 0) AS total_count
      FROM sales s
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
        AND s.delivered_at IS NOT NULL
      `,
      [numericDriverId]
    );

    // ==========================================
    // GET DISTINCT DELIVERY DATES WITH PAGINATION
    // ==========================================
    const [dateRows] = await db.execute(
      `
      SELECT DATE(s.delivered_at) AS delivery_date
      FROM sales s
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
        AND s.delivered_at IS NOT NULL
      GROUP BY DATE(s.delivered_at)
      ORDER BY delivery_date DESC
      LIMIT ${safeLimit} OFFSET ${offset}
      `,
      [numericDriverId]
    );

    const [countRows] = await db.execute(
      `
      SELECT COUNT(*) AS totalDates
      FROM (
        SELECT DATE(s.delivered_at) AS delivery_date
        FROM sales s
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND s.delivered_at IS NOT NULL
        GROUP BY DATE(s.delivered_at)
      ) t
      `,
      [numericDriverId]
    );

    const totalDates = Number(countRows[0]?.totalDates || 0);
    const totalPages = Math.ceil(totalDates / safeLimit);

    if (!dateRows.length) {
      return res.status(200).json({
        success: true,
        message: "Driver profile history fetched successfully",
        data: {
          performance: {
            today: Number(performanceRows[0]?.today_count || 0),
            thisWeek: Number(performanceRows[0]?.this_week_count || 0),
            total: Number(performanceRows[0]?.total_count || 0),
          },
          items: [],
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
    }

    const items = [];

    for (const row of dateRows) {
      const deliveryDate = row.delivery_date;

      // ==========================================
      // SUMMARY PER DATE
      // ==========================================
      const [summaryRows] = await db.execute(
        `
        SELECT
          COALESCE(SUM(s.total_amount), 0) AS total_amount,
          COUNT(s.id) AS total_deliveries
        FROM sales s
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND DATE(s.delivered_at) = ?
        `,
        [numericDriverId, deliveryDate]
      );

      // ==========================================
      // DELIVERY ROWS PER DATE
      // ==========================================
      const [deliveryRows] = await db.execute(
        `
        SELECT
          s.id AS sale_id,
          u.name AS customer_name,
          a.address,
          COALESCE(MAX(pr.type), 'N/A') AS cylinder_type,
          COALESCE(SUM(si.quantity), 0) AS quantity,
          COALESCE(s.total_amount, 0) AS total_amount,
          COALESCE(
            MAX(
              CASE
                WHEN p.status = 'SUCCESS' THEN p.method
                ELSE NULL
              END
            ),
            s.payment_method,
            'N/A'
          ) AS payment_mode,
          s.delivered_at
        FROM sales s
        LEFT JOIN users u
          ON u.id = s.customer_id
        LEFT JOIN addresses a
          ON a.id = s.address_id
        LEFT JOIN sales_items si
          ON si.sale_id = s.id
        LEFT JOIN products pr
          ON pr.id = si.product_id
        LEFT JOIN payments p
          ON p.sale_id = s.id
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND DATE(s.delivered_at) = ?
        GROUP BY
          s.id,
          u.name,
          a.address,
          s.total_amount,
          s.payment_method,
          s.delivered_at
        ORDER BY s.delivered_at DESC, s.id DESC
        `,
        [numericDriverId, deliveryDate]
      );

      items.push({
        date: deliveryDate,
        totalAmount: Number(summaryRows[0]?.total_amount || 0),
        totalDeliveries: Number(summaryRows[0]?.total_deliveries || 0),
        deliveries: deliveryRows.map((item) => ({
          saleId: Number(item.sale_id),
          customerName: item.customer_name || "Unknown Customer",
          address: item.address || "No address available",
          cylinderType: item.cylinder_type || "N/A",
          quantity: Number(item.quantity || 0),
          totalAmount: Number(item.total_amount || 0),
          paymentMode: item.payment_mode || "N/A",
          deliveredAt: item.delivered_at,
        })),
      });
    }

    return res.status(200).json({
      success: true,
      message: "Driver profile history fetched successfully",
      data: {
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

    if (!type) {
      return res.status(400).json({
        success: false,
        message: "type is required",
      });
    }

    if (!["DOMESTIC", "COMMERCIAL"].includes(type)) {
      return res.status(400).json({
        success: false,
        message: "type must be DOMESTIC or COMMERCIAL",
      });
    }

    const searchText = String(search).trim();

    const [rows] = await db.execute(
      `
      SELECT
        p.id,
        p.name,
        p.type,
        p.price,
        c.name AS category_name
      FROM products p
      LEFT JOIN categories c
        ON c.id = p.category_id
      WHERE p.type = ?
        AND p.name LIKE ?
      ORDER BY p.name ASC
      LIMIT 20
      `,
      [type, `%${searchText}%`]
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
    const { driverId } = req.params;

    const [rows] = await db.execute(
      `
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type,

        SUM(
          CASE
            WHEN si.status IN ('ASSIGNED')
            THEN si.quantity
            ELSE 0
          END
        ) AS total_allocated,

        SUM(
          CASE
            WHEN si.status = 'DELIVERED'
            THEN si.delivered_qty
            ELSE 0
          END
        ) AS delivered,

        SUM(
          CASE
            WHEN si.status = 'ASSIGNED'
            THEN (si.quantity - si.delivered_qty)
            ELSE 0
          END
        ) AS pending,

        MAX(s.created_at) AS last_allocated_at,

        MAX(s.id) AS latest_sale_id

      FROM sales s
      INNER JOIN sales_items si
        ON s.id = si.sale_id
      INNER JOIN products p
        ON p.id = si.product_id

      WHERE s.driver_id = ?
      AND si.status IN ('ASSIGNED', 'DELIVERED')

      GROUP BY p.id, p.name, p.type

      ORDER BY last_allocated_at DESC
      `,
      [driverId]
    );

    const totalAllocated = rows.reduce(
      (sum, item) => sum + Number(item.total_allocated || 0),
      0
    );

    const totalDelivered = rows.reduce(
      (sum, item) => sum + Number(item.delivered || 0),
      0
    );

    const totalPending = rows.reduce(
      (sum, item) => sum + Number(item.pending || 0),
      0
    );

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          totalAllocated,
          delivered: totalDelivered,
          pending: totalPending,
        },

        items: rows.map((item) => ({
          productId: item.product_id,
          productName: item.product_name,
          productType: item.product_type,

          totalAllocated: Number(item.total_allocated || 0),

          delivered: Number(item.delivered || 0),

          pending: Number(item.pending || 0),

          lastAllocatedAt: item.last_allocated_at,

          latestSaleId: item.latest_sale_id,
        })),
      },
    });
  } catch (error) {
    console.error('getAllocatedCylinders error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch allocated cylinders',
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