import mysql from "mysql2/promise";

// const db = mysql.createPool({
//   host: "localhost",
//   user: "root",
//   password: "M@nish@123", // same as Workbench
//   database: "auth_db",
// });

// const db = mysql.createPool({
//   host: "containers-xxx.railway.app",
//   user: "root",
//   password: "WRSjIegBMbKrthVZvihkRRDKEaIkQNyW",
//   database: "railway",
//   port: 3306,
// });

const db = mysql.createPool(process.env.DATABASE_URL);


export default db;