import jwt from "jsonwebtoken";

export const generateToken = (user) => {
  return jwt.sign({ id: user.id }, "secretkey", {
    expiresIn: "7d",
  });
};