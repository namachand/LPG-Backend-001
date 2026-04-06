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

    console.log({drivers})
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