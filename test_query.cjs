const mysql = require('mysql2/promise');
require('dotenv').config();

async function run() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  
  const [rows] = await conn.query("SELECT id, amount, status, created_at FROM settlement_history WHERE driver_id = 25572 AND status = 'ASSIGNED' AND method = 'CASH' ORDER BY created_at ASC");
  console.log(rows);
  
  await conn.end();
}
run();
