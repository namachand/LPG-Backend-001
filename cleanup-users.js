import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const { default: db } = await import('./src/config/db.js');
  try {
    console.log("Fetching user stats...");
    const [rows] = await db.query("SELECT role, COUNT(*) as count FROM users GROUP BY role");
    console.log("Roles:", rows);

    const [uploaded] = await db.query("SELECT COUNT(*) as count FROM users WHERE role = 'CUSTOMER'");
    console.log("Total CUSTOMERS:", uploaded[0].count);
    
    // We can delete all CUSTOMERs if they want
    const [deleteResult] = await db.query("DELETE FROM users WHERE role = 'CUSTOMER'");
    console.log(`Deleted ${deleteResult.affectedRows} customers from users table.`);

    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

run();
