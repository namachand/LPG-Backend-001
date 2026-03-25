import express from "express";
import cors from "cors";
import routes from "./routes/authRoutes.js";

const app = express();
app.use(cors({
  origin: "https://lpg-frontend-001.vercel.app/",
  credentials: true
}));
app.use(express.json());

app.use("/api/auth", routes);

export default app;