import jwt from "jsonwebtoken";

export const generateToken = (user) => {
  return jwt.sign({ id: user.id, role: user.role }, "secretkey", {
    expiresIn: "7d",
  });
};