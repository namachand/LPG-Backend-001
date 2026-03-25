import mysql from "mysql2/promise";

// const db = mysql.createPool({
//   host: "localhost",
//   user: "root",
//   password: "M@nish@123", // same as Workbench
//   database: "auth_db",
// });

const db = mysql.createPool({
  host: "mysql.railway.internal",
  user: "root",
  password: "cuquXHarOGofWPUWLlqIeZVytwfmwpxR",
  database: "railway", 
  port: "3306"
});

export default db;