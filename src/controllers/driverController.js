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
        COALESCE(SUM(CASE WHEN s.status = 'ASSIGNED' THEN 1 ELSE 0 END), 0) AS allocated,
        COALESCE(SUM(CASE WHEN s.status = 'DELIVERED' THEN 1 ELSE 0 END), 0) AS delivered,
        COALESCE(SUM(CASE WHEN s.status IN ('ASSIGNED', 'PENDING') THEN 1 ELSE 0 END), 0) AS in_hand,
        COALESCE(SUM(CASE WHEN s.status = 'ASSIGNED' THEN 1 ELSE 0 END), 0) AS new_delivery
      FROM sales s
      WHERE s.driver_id = ?
      `,
      [numericDriverId]
    );

    const [collectionRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(p.amount), 0) AS collection
      FROM payments p
      INNER JOIN sales s
        ON s.id = p.sale_id
      WHERE s.driver_id = ?
        AND p.status = 'SUCCESS'
      `,
      [numericDriverId]
    );

    let statusFilterQuery = "";
    let queryParams = [numericDriverId];

    if (flag === "allocated") {
      statusFilterQuery = `
        AND s.status IN ('DELIVERED', 'PENDING', 'ASSIGNED')
      `;
    } else if (flag === "delivered") {
      statusFilterQuery = `
        AND s.status = 'DELIVERED'
      `;
    } else {
      statusFilterQuery = `
        AND s.status IN ('DELIVERED', 'PENDING', 'ASSIGNED', 'CANCELLED')
      `;
    }

    const [deliveryRows] = await db.execute(
      `
      SELECT
        s.id AS sale_id,
        u.name AS customer_name,
        a.address,
        COALESCE(GROUP_CONCAT(DISTINCT pr.name ORDER BY pr.name SEPARATOR ', '), 'N/A') AS product_name,
        COALESCE(SUM(si.quantity), 0) AS quantity,
        COALESCE(MAX(pr.type), 'N/A') AS cylinder_type,
        s.status AS raw_status,
        CASE
          WHEN s.status = 'DELIVERED' THEN 'Delivered'
          WHEN s.status IN ('PENDING', 'ASSIGNED') THEN 'Pending'
          WHEN s.status = 'CANCELLED' THEN 'Cancelled'
          ELSE s.status
        END AS display_status,
        COALESCE(s.total_amount, 0) AS total_amount,
        s.created_at,
        s.delivered_at,
        COALESCE(
          MAX(
            CASE
              WHEN p.status = 'SUCCESS' THEN p.method
              ELSE NULL
            END
          ),
          s.payment_method,
          'N/A'
        ) AS payment_mode
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
        ${statusFilterQuery}
      GROUP BY
        s.id,
        u.name,
        a.address,
        s.status,
        s.total_amount,
        s.created_at,
        s.delivered_at,
        s.payment_method
      ORDER BY
        CASE
          WHEN s.status IN ('PENDING', 'ASSIGNED') THEN 0
          WHEN s.status = 'DELIVERED' THEN 1
          WHEN s.status = 'CANCELLED' THEN 2
          ELSE 3
        END,
        COALESCE(s.delivered_at, s.created_at) DESC,
        s.id DESC
      `,
      queryParams
    );

    const stats = {
      allocated: Number(statsRows[0]?.allocated || 0),
      delivered: Number(statsRows[0]?.delivered || 0),
      collection: Number(collectionRows[0]?.collection || 0),
      empties: 0,
      inHand: Number(statsRows[0]?.in_hand || 0),
      newDelivery: Number(statsRows[0]?.new_delivery || 0)
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
      showMarkDelivered:
        item.raw_status === "PENDING" || item.raw_status === "ASSIGNED",
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
    console.error("getAppDriverDeliveries error:", error);
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

export const createDriverSale = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      driver_id,
      customer_name,
      phone,
      address,
      cylinder_type,
      quantity,
      payment_method,
      amount,
      empty_cylinder_collected,
    } = req.body;

    // =========================
    // VALIDATION
    // =========================
    if (!driver_id) {
      return res.status(400).json({
        success: false,
        message: "driver_id is required",
      });
    }

    if (!customer_name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "customer_name is required",
      });
    }

    if (!phone?.trim()) {
      return res.status(400).json({
        success: false,
        message: "phone is required",
      });
    }

    if (!address?.trim()) {
      return res.status(400).json({
        success: false,
        message: "address is required",
      });
    }

    if (!["DOMESTIC", "COMMERCIAL"].includes(cylinder_type)) {
      return res.status(400).json({
        success: false,
        message: "cylinder_type must be DOMESTIC or COMMERCIAL",
      });
    }

    if (!quantity || Number(quantity) <= 0) {
      return res.status(400).json({
        success: false,
        message: "quantity must be greater than 0",
      });
    }

    if (!["CASH", "UPI", "ONLINE", "CREDIT"].includes(payment_method)) {
      return res.status(400).json({
        success: false,
        message: "payment_method must be CASH, UPI, ONLINE or CREDIT",
      });
    }

    if (amount === undefined || amount === null || Number(amount) < 0) {
      return res.status(400).json({
        success: false,
        message: "amount must be a valid non-negative number",
      });
    }

    const numericDriverId = Number(driver_id);
    const numericQuantity = Number(quantity);
    const numericAmount = Number(amount);

    if (Number.isNaN(numericDriverId)) {
      return res.status(400).json({
        success: false,
        message: "driver_id must be a valid number",
      });
    }

    await connection.beginTransaction();

    // =========================
    // CHECK DRIVER EXISTS
    // sales.driver_id references drivers.id
    // =========================
    const [driverRows] = await connection.execute(
      `SELECT id FROM drivers WHERE id = ? LIMIT 1`,
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
    // CREATE / REUSE CUSTOMER
    // users.role = CUSTOMER
    // reuse by phone if already exists
    // =========================
    let customerId;

    const [existingCustomerRows] = await connection.execute(
      `
      SELECT id, name
      FROM users
      WHERE phone = ?
        AND role = 'CUSTOMER'
      LIMIT 1
      `,
      [phone.trim()]
    );

    if (existingCustomerRows.length) {
      customerId = existingCustomerRows[0].id;

      await connection.execute(
        `
        UPDATE users
        SET name = ?, status = 'ACTIVE'
        WHERE id = ?
        `,
        [customer_name.trim(), customerId]
      );
    } else {
      const [customerInsertResult] = await connection.execute(
        `
        INSERT INTO users (name, phone, role, status)
        VALUES (?, ?, 'CUSTOMER', 'ACTIVE')
        `,
        [customer_name.trim(), phone.trim()]
      );

      customerId = customerInsertResult.insertId;
    }

    // =========================
    // CREATE / REUSE ADDRESS
    // use exact address match for this customer
    // =========================
    let addressId;

    const [existingAddressRows] = await connection.execute(
      `
      SELECT id
      FROM addresses
      WHERE user_id = ?
        AND address = ?
      LIMIT 1
      `,
      [customerId, address.trim()]
    );

    if (existingAddressRows.length) {
      addressId = existingAddressRows[0].id;
    } else {
      const [addressInsertResult] = await connection.execute(
        `
        INSERT INTO addresses (user_id, address, is_default)
        VALUES (?, ?, 1)
        `,
        [customerId, address.trim()]
      );

      addressId = addressInsertResult.insertId;
    }

    // =========================
    // FIND / CREATE PRODUCT
    // pick first product for type, else create generic
    // =========================
    let productId;
    let productPrice = numericAmount;

    const [existingProductRows] = await connection.execute(
      `
      SELECT id, price
      FROM products
      WHERE type = ?
      ORDER BY id ASC
      LIMIT 1
      `,
      [cylinder_type]
    );

    if (existingProductRows.length) {
      productId = existingProductRows[0].id;
      productPrice =
        existingProductRows[0].price !== null
          ? Number(existingProductRows[0].price)
          : numericAmount;
    } else {
      const defaultProductName =
        cylinder_type === "DOMESTIC"
          ? "Domestic Cylinder"
          : "Commercial Cylinder";

      const [productInsertResult] = await connection.execute(
        `
        INSERT INTO products (name, type, price)
        VALUES (?, ?, ?)
        `,
        [defaultProductName, cylinder_type, numericAmount]
      );

      productId = productInsertResult.insertId;
      productPrice = numericAmount;
    }

    // =========================
    // MAP PAYMENT METHOD FOR sales
    // CREDIT is not supported by current sales enum
    // so store NULL and skip payment row
    // =========================
    let salesPaymentMethod = null;

    if (payment_method === "CASH") salesPaymentMethod = "CASH";
    if (payment_method === "UPI") salesPaymentMethod = "UPI";
    if (payment_method === "ONLINE") salesPaymentMethod = "ONLINE";

    // =========================
    // CREATE SALE
    // Driver is confirming delivery from app
    // so create as DELIVERED
    // =========================
    const [saleInsertResult] = await connection.execute(
      `
      INSERT INTO sales (
        customer_id,
        driver_id,
        total_amount,
        payment_method,
        status,
        assigned_at,
        delivered_at,
        address_id
      )
      VALUES (?, ?, ?, ?, 'DELIVERED', NOW(), NOW(), ?)
      `,
      [
        customerId,
        numericDriverId,
        numericAmount,
        salesPaymentMethod,
        addressId,
      ]
    );

    const saleId = saleInsertResult.insertId;

    // =========================
    // CREATE SALES ITEM
    // use per unit price from amount/qty
    // =========================
    const unitPrice =
      numericQuantity > 0 ? numericAmount / numericQuantity : productPrice;

    await connection.execute(
      `
      INSERT INTO sales_items (sale_id, product_id, quantity, price)
      VALUES (?, ?, ?, ?)
      `,
      [saleId, productId, numericQuantity, unitPrice]
    );

    // =========================
    // CREATE PAYMENT
    // only when money is actually collected now
    // CREDIT => no payment row
    // ONLINE -> CARD in payments table
    // =========================
    if (payment_method !== "CREDIT") {
      let paymentMethodForPaymentTable = "CASH";

      if (payment_method === "CASH") paymentMethodForPaymentTable = "CASH";
      if (payment_method === "UPI") paymentMethodForPaymentTable = "UPI";
      if (payment_method === "ONLINE") paymentMethodForPaymentTable = "CARD";

      const [paymentInsertResult] = await connection.execute(
        `INSERT INTO payments (sale_id, amount, method, status, type)
        VALUES (?, ?, ?, 'SUCCESS', 'DRIVER')
        `,
        [saleId, numericAmount, paymentMethodForPaymentTable]
      );

      const paymentId = paymentInsertResult.insertId;

      // only create settlement rows for CASH / UPI
      if (paymentMethodForPaymentTable === "CASH" || paymentMethodForPaymentTable === "UPI") {
        await connection.execute(
          `INSERT INTO settlement_history (
            driver_id,
            sale_id,
            payment_id,
            method,
            amount,
            status
          )
          VALUES (?, ?, ?, ?, ?, 'PENDING')
          `,
          [numericDriverId, saleId, paymentId, paymentMethodForPaymentTable, numericAmount]
        );
      }

    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Driver sale created successfully",
      data: {
        sale_id: saleId,
        customer_id: customerId,
        address_id: addressId,
        product_id: productId,
        empty_cylinder_collected: !!empty_cylinder_collected,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createDriverSale error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create driver sale",
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

    // =========================
    // TOP SUMMARY
    // =========================
    const [summaryRows] = await db.execute(
      `SELECT
        COALESCE(SUM(CASE WHEN sh.method = 'CASH' AND sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS cash_collected,
        COALESCE(SUM(CASE WHEN sh.method = 'UPI' AND sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS upi_collected
      FROM settlement_history sh
      WHERE sh.driver_id = ?
      `,
      [numericDriverId]
    );

    // =========================
    // PENDING SETTLEMENT ITEMS
    // =========================
    const [settlementRows] = await db.execute(
      `
      SELECT
        sh.id AS settlement_id,
        sh.driver_id,
        sh.sale_id,
        sh.payment_id,
        sh.method,
        sh.amount,
        sh.status,
        sh.created_at,
        u.name AS customer_name
      FROM settlement_history sh
      INNER JOIN sales s
        ON s.id = sh.sale_id
      LEFT JOIN users u
        ON u.id = s.customer_id
      WHERE sh.driver_id = ?
        AND sh.status = 'PENDING'
      ORDER BY
        CASE WHEN sh.method = 'CASH' THEN 0 ELSE 1 END,
        sh.created_at DESC,
        sh.id DESC
      `,
      [numericDriverId]
    );

    const cashItems = settlementRows
      .filter((item) => item.method === "CASH")
      .map((item) => ({
        settlementId: item.settlement_id,
        customerName: item.customer_name || "Unknown Customer",
        amount: Number(item.amount || 0),
        createdAt: item.created_at,
        method: item.method,
        status: item.status,
      }));

    const upiItems = settlementRows
      .filter((item) => item.method === "UPI")
      .map((item) => ({
        settlementId: item.settlement_id,
        customerName: item.customer_name || "Unknown Customer",
        amount: Number(item.amount || 0),
        createdAt: item.created_at,
        method: item.method,
        status: item.status,
      }));

    return res.status(200).json({
      success: true,
      message: "Collection summary fetched successfully",
      data: {
        summary: {
          cashCollected: Number(summaryRows[0]?.cash_collected || 0),
          upiCollected: Number(summaryRows[0]?.upi_collected || 0),
        },
        settlements: {
          cash: cashItems,
          upi: upiItems,
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
  try {
    const { driverId } = req.params;
    const { method, denominations } = req.body;

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

    if (!["CASH", "UPI"].includes(method)) {
      return res.status(400).json({
        success: false,
        message: "method must be CASH or UPI",
      });
    }

    let enteredCashTotal = null;

    if (method === "CASH" && denominations) {
      const d500 = Number(denominations?.["500"] || 0);
      const d100 = Number(denominations?.["100"] || 0);
      const d50 = Number(denominations?.["50"] || 0);
      const d20 = Number(denominations?.["20"] || 0);
      const d10 = Number(denominations?.["10"] || 0);
      const coins = Number(denominations?.coins || 0);

      if ([d500, d100, d50, d20, d10, coins].some((v) => Number.isNaN(v) || v < 0)) {
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

    const [pendingRows] = await db.execute(
      `
      SELECT id, amount
      FROM settlement_history
      WHERE driver_id = ?
        AND method = ?
        AND status = 'PENDING'
      `,
      [numericDriverId, method]
    );

    if (!pendingRows.length) {
      return res.status(404).json({
        success: false,
        message: `No pending ${method} settlements found`,
      });
    }

    const expectedTotal = pendingRows.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0
    );

    if (method === "CASH" && enteredCashTotal !== null && enteredCashTotal !== expectedTotal) {
      return res.status(400).json({
        success: false,
        message: `Entered cash total ₹${enteredCashTotal} does not match expected ₹${expectedTotal}`,
      });
    }

    const [updateResult] = await db.execute(
      `
      UPDATE settlement_history
      SET status = 'SETTLED'
      WHERE driver_id = ?
        AND method = ?
        AND status = 'PENDING'
      `,
      [numericDriverId, method]
    );

    return res.status(200).json({
      success: true,
      message: `${method} settlements marked as settled successfully`,
      data: {
        updatedCount: updateResult.affectedRows || 0,
        method,
        expectedTotal,
        enteredTotal: enteredCashTotal,
        denominations: method === "CASH" ? denominations || null : null,
      },
    });
  } catch (error) {
    console.error("settleDriverCollectionsByMethod error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to settle collections",
      error: error.message,
    });
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

    // summary
    const [summaryRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(st.quantity), 0) AS collected,
        COALESCE(SUM(CASE WHEN st.isApproved = 1 THEN st.quantity ELSE 0 END), 0) AS returned_qty,
        COALESCE(SUM(CASE WHEN st.isApproved = 0 THEN st.quantity ELSE 0 END), 0) AS in_hand_qty
      FROM stock_transactions st
      INNER JOIN products p
        ON p.id = st.product_id
      INNER JOIN categories c
        ON c.id = p.category_id
      WHERE st.created_by = ?
        AND c.name = 'Empty Cylinder'
        AND st.type = 'ADJUSTMENT_ADD'
        AND DATE(st.created_at) = CURDATE()
      `,
      [numericDriverId]
    );

    // collected from
    const [collectedFromRows] = await db.execute(
      `
      SELECT
        st.id,
        st.quantity,
        st.created_at,
        p.type AS product_type,
        u.name AS customer_name
      FROM stock_transactions st
      INNER JOIN products p
        ON p.id = st.product_id
      INNER JOIN categories c
        ON c.id = p.category_id
      LEFT JOIN users u
        ON u.id = st.reference_id
      WHERE st.created_by = ?
        AND c.name = 'Empty Cylinder'
        AND st.type = 'ADJUSTMENT_ADD'
        AND DATE(st.created_at) = CURDATE()
      ORDER BY st.created_at ASC, st.id ASC
      `,
      [numericDriverId]
    );

    // return requests
    const [returnRequestRows] = await db.execute(
      `
      SELECT
        st.id,
        st.quantity,
        st.created_at,
        st.isApproved
      FROM stock_transactions st
      INNER JOIN products p
        ON p.id = st.product_id
      INNER JOIN categories c
        ON c.id = p.category_id
      WHERE st.created_by = ?
        AND c.name = 'Empty Cylinder'
        AND st.type = 'ADJUSTMENT_ADD'
        AND DATE(st.created_at) = CURDATE()
      ORDER BY st.created_at ASC, st.id ASC
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
          id: Number(row.id),
          customerName: row.customer_name || "Unknown Customer",
          productType: row.product_type || "N/A",
          quantity: Number(row.quantity || 0),
          createdAt: row.created_at,
        })),
        returnRequests: returnRequestRows.map((row) => ({
          id: Number(row.id),
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
        st.id,
        st.product_id,
        st.stock_area_id,
        st.quantity
      FROM stock_transactions st
      INNER JOIN products p
        ON p.id = st.product_id
      INNER JOIN categories c
        ON c.id = p.category_id
      WHERE st.created_by = ?
        AND c.name = 'Empty Cylinder'
        AND st.type = 'ADJUSTMENT_ADD'
        AND st.isApproved = 0
        AND DATE(st.created_at) = CURDATE()
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
      const productId = Number(row.product_id);
      const stockAreaId = Number(row.stock_area_id);
      const qty = Number(row.quantity || 0);

      const [stockRows] = await connection.execute(
        `
        SELECT id
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

    await connection.execute(
      `
      UPDATE stock_transactions st
      INNER JOIN products p
        ON p.id = st.product_id
      INNER JOIN categories c
        ON c.id = p.category_id
      SET st.isApproved = 1
      WHERE st.created_by = ?
        AND c.name = 'Empty Cylinder'
        AND st.type = 'ADJUSTMENT_ADD'
        AND st.isApproved = 0
        AND DATE(st.created_at) = CURDATE()
      `,
      [numericDriverId]
    );

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