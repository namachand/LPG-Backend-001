import dotenv from 'dotenv';
dotenv.config();


async function run() {
  try {
    const { default: db } = await import('./src/config/db.js');
    console.log("Applying database changes...");
    
    try {
      await db.execute('ALTER TABLE `users` ADD COLUMN `consumer_id` varchar(50) DEFAULT NULL');
      console.log("Added consumer_id column.");
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log("consumer_id column already exists.");
      } else {
        console.error("Error adding consumer_id:", e.message);
      }
    }

    try {
      await db.execute('ALTER TABLE `users` ADD COLUMN `consumer_number` varchar(50) DEFAULT NULL');
      console.log("Added consumer_number column.");
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log("consumer_number column already exists.");
      } else {
        console.error("Error adding consumer_number:", e.message);
      }
    }
    
    console.log("Database schema changes applied successfully.");
  } catch (error) {
    console.error("General error:", error);
  } finally {
    process.exit(0);
  }
}

run();
