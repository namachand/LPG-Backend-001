import 'dotenv/config';
import db from './src/config/db.js';

async function run() {
  try {
    const [result] = await db.query(
      `DELETE FROM users WHERE role = 'CUSTOMER' AND (consumer_number IS NULL OR consumer_number = '')`
    );
    console.log(`Deleted rows: ${result.affectedRows}`);
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    process.exit(0);
  }
}

run();
