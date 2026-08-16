import db from "./src/config/db.js";

async function run() {
  const driverId = 25572;
  try {
    const [driverRows] = await db.execute("SELECT id FROM drivers WHERE user_id = ? LIMIT 1", [driverId]);
    const numericDriverId = driverRows.length ? driverRows[0].id : driverId;
    console.log("Numeric Driver ID:", numericDriverId);

    const [collected] = await db.execute(`
        SELECT
          si.product_id,
          COALESCE(SUM(si.empty_cylinder_qty), 0) AS collected_qty
        FROM sales s
        INNER JOIN sales_items si
          ON si.sale_id = s.id
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
          AND COALESCE(si.empty_cylinder_qty, 0) > 0
        GROUP BY si.product_id
    `, [numericDriverId]);

    const [returned] = await db.execute(`
        SELECT
          st.product_id,
          COALESCE(SUM(st.quantity), 0) AS returned_qty
        FROM stock_transactions st
        LEFT JOIN sales linked_sale
          ON linked_sale.id = st.reference_id
         AND linked_sale.driver_id = st.driver_id
        WHERE st.driver_id = ?
          AND st.stock_from = 'driver'
          AND COALESCE(st.isApproved, 0) IN (0, 1)
          AND st.type = 'EMPTY_RETURN'
          AND linked_sale.id IS NULL
        GROUP BY st.product_id
    `, [numericDriverId]);

    const [desc] = await db.execute("DESCRIBE stock_transactions");
    console.log("schema:", desc);
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
run();
