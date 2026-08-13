import jwt from "jsonwebtoken";

export const generateToken = (user) => {
  return jwt.sign({ id: user.id, role: user.role, agency_id: user.agency_id }, process.env.JWT_SECRET || "secretkey", {
    expiresIn: "7d",
  });
};