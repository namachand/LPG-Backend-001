import "dotenv/config";
import db from "./src/config/db.js";

async function run() {
  const driverId = 25572;
  try {
    const [driverRows] = await db.execute("SELECT id FROM drivers WHERE user_id = ? LIMIT 1", [driverId]);
    const numericDriverId = driverRows.length ? driverRows[0].id : driverId;
    console.log("Numeric Driver ID:", numericDriverId);

    await db.execute("ALTER TABLE settlement_history MODIFY COLUMN method ENUM('CASH','UPI','ONLINE') NOT NULL");
    console.log("Table altered successfully!");
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
run();
