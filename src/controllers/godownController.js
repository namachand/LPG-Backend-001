import db from "../config/db.js";

export const getGodownDashboardData = async (req, res) => {
  try {
    const [stockRows] = await db.execute(`
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type,
        c.name AS category_name,
        COALESCE(s.quantity, 0) AS system_quantity,
        COALESCE(s.empty_quantity, 0) AS empty_quantity,
        COALESCE(s.defective_quantity, 0) AS defective_quantity
      FROM stock s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN categories c ON c.id = p.category_id
    `);

    const [salesRows] = await db.execute(`
      SELECT
        si.product_id,
        p.name AS product_name,
        p.type AS product_type,
        c.name AS category_name,
        SUM(CASE WHEN sa.status = 'ASSIGNED' THEN si.quantity ELSE 0 END) AS allocated_today,
        SUM(CASE WHEN sa.status = 'CANCELLED' THEN si.quantity ELSE 0 END) AS returned_today
      FROM sales sa
      JOIN sales_items si ON si.sale_id = sa.id
      JOIN products p ON p.id = si.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE DATE(sa.created_at) = CURDATE()
      GROUP BY si.product_id, p.name, p.type, c.name
    `);

    const salesMap = {};
    salesRows.forEach((row) => {
      salesMap[row.product_id] = row;
    });

    const normalizeType = (row) => {
      const value = `${row.product_type || ""} ${row.category_name || ""} ${row.product_name || ""}`.toLowerCase();

      if (value.includes("commercial")) return "COMMERCIAL";
      return "DOMESTIC";
    };

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
      cashierSaleStock: 27,
    };

    stockRows.forEach((row) => {
      const group = normalizeType(row);
      const key = group === "COMMERCIAL" ? "commercial" : "domestic";

      const systemQty = Number(row.system_quantity || 0);
      const emptyQty = Number(row.empty_quantity || 0);
      const defectiveQty = Number(row.defective_quantity || 0);

      const availablePhysical = Math.max(systemQty - defectiveQty, 0);
      const emptyPhysical = emptyQty;

      initial.available[key].system += systemQty;
      initial.available[key].defective += defectiveQty;
      initial.available[key].total += availablePhysical;

      initial.empty[key].system += emptyQty;
      initial.empty[key].total += emptyPhysical;

      initial.totalDefectives += defectiveQty;

      initial.available[key].items.push({
        product_id: row.product_id,
        item: row.product_name,
        physical: availablePhysical,
        system: systemQty,
        diff: availablePhysical - systemQty,
      });

      initial.empty[key].items.push({
        product_id: row.product_id,
        item: row.product_name,
        physical: emptyPhysical,
        system: emptyQty,
        diff: 0,
      });
    });

    salesRows.forEach((row) => {
      initial.allocatedToday += Number(row.allocated_today || 0);
      initial.returnedToday += Number(row.returned_today || 0);
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
        u.name AS driver_name
      FROM stock_transactions st
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      WHERE st.type = 'PURCHASE'
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
      data: rows.map((row, index) => ({
        id: row.load_id,
        load: `Load-${index + 1}`,
        date: row.load_date,
        driver_id: row.driver_id,
        driver: row.driver_name || "Unknown Driver",
        invoice: `INV-${row.load_id}`,
        vehicle: row.vehicle_number || "N/A",
        qty: Number(row.total_quantity || 0),
        status: Number(row.isApproved) === 1 ? "APPROVED" : "PENDING",
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
        u.name AS driver_name
      FROM stock_transactions st
      JOIN products p ON p.id = st.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
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
        driver: rows[0].driver_name || "Unknown Driver",
        vehicle: rows[0].vehicle_number || "N/A",
        depot: "HP Gas Depot - Sector 12",
        invoice: `INV-${loadId}`,
        qty: totalQty,
        status: Number(rows[0].isApproved) === 1 ? "APPROVED" : "PENDING",
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
      SELECT id, product_id, stock_area_id, quantity
      FROM stock_transactions
      WHERE type = 'PURCHASE'
        AND COALESCE(reference_id, driver_id) = ?
        AND isApproved = 0
      `,
      [loadId]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No pending stock found for approval",
      });
    }

    for (const row of rows) {
      await connection.execute(
        `
        UPDATE stock
        SET quantity = quantity + ?
        WHERE product_id = ? AND stock_area_id = ?
        `,
        [row.quantity, row.product_id, row.stock_area_id]
      );
    }

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = 1
      WHERE type = 'PURCHASE'
        AND COALESCE(reference_id, driver_id) = ?
      `,
      [loadId]
    );

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
      WHERE st.type IN ('EMPTY_RETURN', 'PURCHASE_RETURN')
        AND (
          st.type = 'EMPTY_RETURN'
          OR (st.type = 'PURCHASE_RETURN' AND st.is_defective = 1)
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
        const totalQty = emptyQty + defectiveQty;

        return {
          id: row.load_id,
          load: `Load-${index + 1}`,
          date: row.load_date,
          driver_id: row.driver_id,
          driver: row.driver_name || "Unknown Driver",
          invoice: `DSP-${row.load_id}`,
          vehicle: row.vehicle_number || "N/A",
          qty: totalQty,
          empty_qty: emptyQty,
          defective_qty: defectiveQty,
          status: Number(row.isApproved) === 1 ? "APPROVED" : "PENDING",
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

    for (const item of validItems) {
      const emptyQty = Number(item.empty_quantity || 0);
      const defectiveQty = Number(item.defective_quantity || 0);

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
          VALUES (?, ?, 'EMPTY_RETURN', ?, 0, ?, ?, ?, 0, 'driver')
          `,
          [
            item.product_id,
            1,
            emptyQty,
            finalReferenceId,
            driver_id,
            req.user?.id || null,
          ]
        );
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
          VALUES (?, ?, 'PURCHASE_RETURN', ?, 0, ?, ?, ?, 1, 'driver')
          `,
          [
            item.product_id,
            1,
            defectiveQty,
            finalReferenceId,
            driver_id,
            req.user?.id || null,
          ]
        );
      }
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Stock out load created successfully",
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
          st.type = 'EMPTY_RETURN'
          OR (st.type = 'PURCHASE_RETURN' AND st.is_defective = 1)
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
        status: Number(rows[0].isApproved) === 1 ? "APPROVED" : "PENDING",
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
        stock_area_id,
        quantity,
        type,
        is_defective
      FROM stock_transactions
      WHERE COALESCE(reference_id, driver_id) = ?
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
        await connection.execute(
          `
          UPDATE stock
          SET empty_quantity = COALESCE(empty_quantity, 0) + ?
          WHERE product_id = ?
            AND stock_area_id = ?
          `,
          [Number(row.quantity || 0), row.product_id, row.stock_area_id || 1]
        );
      }

      if (row.type === "PURCHASE_RETURN" && Number(row.is_defective) === 1) {
        await connection.execute(
          `
          UPDATE stock
          SET defective_quantity = COALESCE(defective_quantity, 0) + ?
          WHERE product_id = ?
            AND stock_area_id = ?
          `,
          [Number(row.quantity || 0), row.product_id, row.stock_area_id || 1]
        );
      }
    }

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = 1
      WHERE COALESCE(reference_id, driver_id) = ?
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
    const [rows] = await db.execute(`
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
      GROUP BY
        COALESCE(st.reference_id, st.id),
        st.reference_id,
        st.stock_from,
        DATE(st.created_at),
        d.id,
        d.vehicle_number,
        u.name
      ORDER BY created_at DESC
    `);

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
          stock_from
        )
        VALUES (?, ?, 'PURCHASE_RETURN', ?, 1, ?, ?, ?, ?)
        `,
        [
          item.product_id,
          1,
          item.quantity,
          finalReferenceId,
          stock_from === "driver" ? driver_id : null,
          req.user?.id || null,
          stock_from,
        ]
      );

      await connection.execute(
        `
        UPDATE stock
        SET defective_quantity = COALESCE(defective_quantity, 0) + ?
        WHERE product_id = ?
          AND stock_area_id = 1
        `,
        [item.quantity, item.product_id]
      );
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

    let dateCondition = "DATE(s.created_at) = CURDATE()";

    if (filter === "yesterday") {
      dateCondition = "DATE(s.created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)";
    }

    if (filter === "week") {
      dateCondition = "YEARWEEK(s.created_at, 1) = YEARWEEK(CURDATE(), 1)";
    }

    const [rows] = await db.execute(`
      SELECT
        d.id AS driver_id,
        d.vehicle_number,
        u.name AS driver_name,

        COALESCE(SUM(
          CASE
            WHEN ${dateCondition}
              AND s.status = 'ASSIGNED'
              AND si.status = 'ASSIGNED'
            THEN si.quantity
            ELSE 0
          END
        ), 0) AS allocated,

        COALESCE(SUM(
          CASE
            WHEN ${dateCondition}
              AND s.status = 'DELIVERED'
              AND si.status = 'DELIVERED'
            THEN COALESCE(si.delivered_qty, si.quantity, 0)
            ELSE 0
          END
        ), 0) AS delivered,

        COALESCE(SUM(
          CASE
            WHEN ${dateCondition}
              AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
            THEN COALESCE(si.empty_cylinder_qty, 0)
            ELSE 0
          END
        ), 0) AS empty_collected

      FROM drivers d
      JOIN users u ON u.id = d.user_id
      LEFT JOIN sales s ON s.driver_id = d.id
      LEFT JOIN sales_items si ON si.sale_id = s.id

      GROUP BY
        d.id,
        d.vehicle_number,
        u.name

      ORDER BY u.name ASC
    `);

    return res.json({
      success: true,
      data: rows.map((row) => {
        const allocated = Number(row.allocated || 0);
        const delivered = Number(row.delivered || 0);

        return {
          id: row.driver_id,
          name: row.driver_name,
          vehicle: row.vehicle_number || "N/A",
          allocated,
          delivered,
          empty: Number(row.empty_collected || 0),
          inHand: Math.max(allocated - delivered, 0),
        };
      }),
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

    const totalAmount = 0;

    const [saleResult] = await connection.execute(
      `
      INSERT INTO sales
      (
        driver_id,
        total_amount,
        payment_method,
        status,
        created_at,
        updated_at
        assigned_at
      )
      VALUES (?, ?, 'ONLINE', 'ASSIGNED', NOW(), NOW(), NOW())
      `,
      [driver_id, totalAmount]
    );

    const saleId = saleResult.insertId;

    for (const item of validItems) {
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
          defective_qty
        )
        VALUES (?, ?, ?, 0, 'ASSIGNED', 0, 0, 0)
        `,
        [saleId, item.product_id, item.quantity]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Driver allocation created successfully",
      data: {
        sale_id: saleId,
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
    const [drivers] = await db.execute(`
      SELECT 
        d.id AS driver_id,
        d.vehicle_number,
        u.name AS driver_name
      FROM drivers d
      JOIN users u ON u.id = d.user_id
      ORDER BY u.name ASC
    `);

    const [rows] = await db.execute(`
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
      JOIN products p ON p.id = st.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE st.driver_id IS NOT NULL
        AND st.isApproved = 0
        AND DATE(st.created_at) = CURDATE()
        AND st.type IN ('EMPTY_RETURN', 'PURCHASE_RETURN')
      ORDER BY st.created_at DESC
    `);

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

    let typeCondition = "";
    let params = [driver_id];

    if (condition === "empty") {
      typeCondition = `type = 'EMPTY_RETURN'`;
    } else if (condition === "normal") {
      typeCondition = `type = 'PURCHASE_RETURN' AND is_defective = 0`;
    } else if (condition === "defective") {
      typeCondition = `type = 'PURCHASE_RETURN' AND is_defective = 1`;
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid condition",
      });
    }

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `
      SELECT id, product_id, stock_area_id, quantity, type, is_defective
      FROM stock_transactions
      WHERE driver_id = ?
        AND isApproved = 0
        AND DATE(created_at) = CURDATE()
        AND ${typeCondition}
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
        await connection.execute(
          `
          UPDATE stock
          SET empty_quantity = COALESCE(empty_quantity, 0) + ?
          WHERE product_id = ?
            AND stock_area_id = ?
          `,
          [row.quantity, row.product_id, row.stock_area_id || 1]
        );
      }

      if (condition === "normal") {
        await connection.execute(
          `
          UPDATE stock
          SET quantity = COALESCE(quantity, 0) + ?
          WHERE product_id = ?
            AND stock_area_id = ?
          `,
          [row.quantity, row.product_id, row.stock_area_id || 1]
        );
      }

      if (condition === "defective") {
        await connection.execute(
          `
          UPDATE stock
          SET defective_quantity = COALESCE(defective_quantity, 0) + ?
          WHERE product_id = ?
            AND stock_area_id = ?
          `,
          [row.quantity, row.product_id, row.stock_area_id || 1]
        );
      }
    }

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = 1
      WHERE driver_id = ?
        AND isApproved = 0
        AND DATE(created_at) = CURDATE()
        AND ${typeCondition}
      `,
      params
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

