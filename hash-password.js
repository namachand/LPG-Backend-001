import dotenv from "dotenv";
dotenv.config();

import bcrypt from "bcryptjs";

async function run() {
  const { default: db } = await import("./src/config/db.js");
  try {
    const email = "vasu@gmail.com";
    const plaintextPassword = "Password@123";

    console.log(`Hashing password for ${email}...`);
    const hashedPassword = await bcrypt.hash(plaintextPassword, 10);

    const [result] = await db.execute(
      "UPDATE users SET role = 'OWNER' WHERE email = ?",
      [email],
    );

    console.log(`Updated ${result.affectedRows} rows.`);
    console.log(`Password is now correctly hashed in the database!`);

    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

run();
