import admin from "../config/firebaseAdmin.js";
import db from "../config/db.js";
import { generateToken } from "../utils/generateToken.js";

export const googleLogin = async (req, res) => {
  const decoded = await admin.auth().verifyIdToken(req.body.token);

  let [rows] = await db.execute(
    "SELECT * FROM users WHERE email=?",
    [decoded.email]
  );

  let user = rows[0];

  if (!user) {
    const [r] = await db.execute(
      "INSERT INTO users (email) VALUES (?)",
      [decoded.email]
    );
    user = { id: r.insertId, email: decoded.email };
  }

  res.json({ token: generateToken(user), user });
};

export const phoneLogin = async (req, res) => {
  const decoded = await admin.auth().verifyIdToken(req.body.token);

  let [rows] = await db.execute(
    "SELECT * FROM users WHERE phone=?",
    [decoded.phone_number]
  );

  let user = rows[0];

  if (!user) {
    const [r] = await db.execute(
      "INSERT INTO users (phone) VALUES (?)",
      [decoded.phone_number]
    );
    user = { id: r.insertId, phone: decoded.phone_number };
  }

  res.json({ token: generateToken(user), user });
};