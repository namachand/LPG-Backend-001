import mysql from "mysql2/promise";

const db = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "M@nish@123", // same as Workbench
  database: "auth_db",
});

export default db;