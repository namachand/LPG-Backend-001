/**
 * Carry-forward of driver in-hand cylinders.
 *
 * A driver can end a day still holding cylinders that were neither delivered to
 * a customer nor returned to the godown. Those cylinders are NOT re-issued from
 * godown stock the next day - they are already physically with the driver - so
 * they are never duplicated as new allocation rows. Instead they are computed
 * from the still-open allocation batches and reported as "carried forward" so
 * that the next day's allocated figure reflects everything the driver holds.
 *
 * In-hand for one allocation batch item:
 *   quantity - delivered - returned(empty) - returned(defective)
 *
 * The predicates below intentionally mirror the ones already used by
 * getAllocatedCylinders / getDriverInHandSummary / createDriverAllocation so
 * every screen keeps agreeing on what "in hand" means:
 *   - allocation rows are sales_items with allocation_sales_item_id IS NULL
 *     belonging to a sale with status = 'ASSIGNED'
 *   - deliveries are the child sales_items pointing back at the allocation item
 *     whose sale has status = 'DELIVERED'
 *   - returns are driver PURCHASE_RETURN stock transactions, counted whether
 *     they are approved or still pending (isApproved IN (0, 1)) so a driver
 *     never gets billed twice for cylinders already handed over
 */

// Raw SQL date expressions. Internal constants only - never built from input.
export const CARRY_FORWARD_DATE_EXPR = {
  TODAY: "CURDATE()",
  YESTERDAY: "DATE_SUB(CURDATE(), INTERVAL 1 DAY)",
  // Monday of the current ISO week - matches YEARWEEK(..., 1) used elsewhere.
  WEEK_START: "DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)",
};

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolves the "as of" boundary into an SQL fragment plus its bound params.
 * Accepts either a YYYY-MM-DD string or one of CARRY_FORWARD_DATE_EXPR.
 */
const resolveBoundary = (asOfDate) => {
  if (!asOfDate) {
    return { expr: CARRY_FORWARD_DATE_EXPR.TODAY, params: [] };
  }

  const value = String(asOfDate);

  if (Object.values(CARRY_FORWARD_DATE_EXPR).includes(value)) {
    return { expr: value, params: [] };
  }

  if (DATE_ONLY_REGEX.test(value)) {
    return { expr: "?", params: [value] };
  }

  return { expr: CARRY_FORWARD_DATE_EXPR.TODAY, params: [] };
};

/**
 * Cylinders a driver is still holding from allocations made BEFORE `asOfDate`.
 *
 * @param {object} executor        db pool or a transaction connection
 * @param {object} options
 * @param {number|null} options.driverId   single driver, or null for every driver
 * @param {string|null} options.asOfDate   YYYY-MM-DD or a CARRY_FORWARD_DATE_EXPR (default: today)
 * @param {boolean} options.openingBalance true  -> opening balance: only deliveries/returns
 *                                                  that happened BEFORE asOfDate are netted off,
 *                                                  so the figure stays stable through the day.
 *                                         false -> live balance: every delivery/return to date is
 *                                                  netted off, i.e. what the driver holds right now.
 * @returns {Promise<{ total: number, byDriver: Map<number, number>, byProduct: Array }>}
 */
export const getDriverCarryForward = async (
  executor,
  { driverId = null, asOfDate = null, openingBalance = true } = {}
) => {
  const boundary = resolveBoundary(asOfDate);

  // When building an opening balance, activity on/after the boundary date must
  // not be netted off - it belongs to the day being reported, not to the
  // balance brought forward into it.
  const deliveryCutoff = openingBalance
    ? `AND DATE(COALESCE(cs.delivered_at, cs.created_at)) < ${boundary.expr}`
    : "";
  const returnCutoff = openingBalance
    ? `AND DATE(st.created_at) < ${boundary.expr}`
    : "";

  const driverFilter = driverId ? "AND a.driver_id = ?" : "";

  const params = [
    ...(openingBalance ? boundary.params : []), // delivery cutoff
    ...(openingBalance ? boundary.params : []), // return cutoff
    ...(driverId ? [Number(driverId)] : []),
    ...boundary.params, // allocation date boundary
  ];

  const [rows] = await executor.execute(
    `
    SELECT
      a.driver_id,
      asi.id AS allocation_sales_item_id,
      asi.product_id,
      p.name AS product_name,
      p.type AS product_type,
      COALESCE(asi.batch_no, CONCAT('B-', asi.sale_id)) AS batch_no,
      DATE(COALESCE(a.assigned_at, a.created_at)) AS allocated_date,
      GREATEST(
        COALESCE(asi.quantity, 0)
        - COALESCE(delivered_data.delivered_qty, 0)
        - COALESCE(return_data.return_qty, 0)
        - COALESCE(return_data.defective_qty, 0), 0
      ) AS outstanding

    FROM sales_items asi
    INNER JOIN sales a
      ON a.id = asi.sale_id
    LEFT JOIN products p
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
        ${deliveryCutoff}
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
        ${returnCutoff}
      GROUP BY st.allocation_sales_item_id
    ) return_data
      ON return_data.allocation_sales_item_id = asi.id

    WHERE a.status = 'ASSIGNED'
      AND asi.allocation_sales_item_id IS NULL
      ${driverFilter}
      AND DATE(COALESCE(a.assigned_at, a.created_at)) < ${boundary.expr}
    `,
    params
  );

  const byDriver = new Map();
  const productMap = new Map();
  let total = 0;

  rows.forEach((row) => {
    const outstanding = Number(row.outstanding || 0);

    if (outstanding <= 0) {
      return;
    }

    total += outstanding;

    const rowDriverId = Number(row.driver_id);
    byDriver.set(rowDriverId, Number(byDriver.get(rowDriverId) || 0) + outstanding);

    const productId = Number(row.product_id);
    const key = `${rowDriverId}-${productId}`;

    if (!productMap.has(key)) {
      productMap.set(key, {
        driverId: rowDriverId,
        productId,
        productName: row.product_name || "Cylinder",
        productType: row.product_type || "",
        quantity: 0,
      });
    }

    productMap.get(key).quantity += outstanding;
  });

  return {
    total,
    byDriver,
    byProduct: Array.from(productMap.values()),
  };
};

/**
 * Convenience wrapper for a single driver.
 */
export const getDriverCarryForwardTotal = async (executor, driverId, options = {}) => {
  if (!driverId) {
    return 0;
  }

  const { total } = await getDriverCarryForward(executor, {
    ...options,
    driverId,
  });

  return total;
};
