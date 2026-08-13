import jwt from "jsonwebtoken";

export const verifyToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Unauthorized. Missing or invalid token." });
    }

    const token = authHeader.split(" ")[1];
    
    // In generateToken.js, the secret is currently hardcoded as "secretkey"
    const secret = process.env.JWT_SECRET || "secretkey";

    jwt.verify(token, secret, (err, decoded) => {
      if (err) {
        return res.status(403).json({ success: false, message: "Forbidden. Invalid token." });
      }
      
      // decoded will contain { id, role, agency_id, iat, exp }
      req.user = decoded;
      next();
    });
  } catch (error) {
    console.error("Auth Middleware Error:", error);
    res.status(500).json({ success: false, message: "Server error in authentication." });
  }
};
