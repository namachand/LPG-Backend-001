import mysql from "mysql2/promise";

// Prefer a full connection URL (Railway provides DATABASE_URL / MYSQL_URL),
// then discrete env vars (Railway's MYSQL* or custom DB_*), and finally fall
// back to local development defaults so `npm run dev` keeps working as before.
const connectionUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;

// IST timezone ensures MySQL NOW() / DATE() align with the app's date logic.
// Without this, a sale created at 00:17 IST (18:47 UTC) gets stored as the
// previous UTC date, making it invisible in date-filtered queries for today.
const MYSQL_TIMEZONE = process.env.DB_TIMEZONE || "+05:30";

const db = connectionUrl
  ? mysql.createPool({ uri: connectionUrl, timezone: MYSQL_TIMEZONE, connectionLimit: 20, queueLimit: 0 })
  : mysql.createPool({
      host: process.env.MYSQLHOST || process.env.DB_HOST || "localhost",
      user: process.env.MYSQLUSER || process.env.DB_USER || "root",
      password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || "M@nish@123",
      database: process.env.MYSQLDATABASE || process.env.DB_NAME || "auth_db",
      port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
      timezone: MYSQL_TIMEZONE,
      connectionLimit: 20,
      queueLimit: 0,
    });

export default db;
