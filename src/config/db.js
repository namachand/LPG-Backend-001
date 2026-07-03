import mysql from "mysql2/promise";

// Prefer a full connection URL (Railway provides DATABASE_URL / MYSQL_URL),
// then discrete env vars (Railway's MYSQL* or custom DB_*), and finally fall
// back to local development defaults so `npm run dev` keeps working as before.
const connectionUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;

const db = connectionUrl
  ? mysql.createPool(connectionUrl)
  : mysql.createPool({
      host: process.env.MYSQLHOST || process.env.DB_HOST || "localhost",
      user: process.env.MYSQLUSER || process.env.DB_USER || "root",
      password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || "M@nish@123",
      database: process.env.MYSQLDATABASE || process.env.DB_NAME || "auth_db",
      port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
    });

export default db;
