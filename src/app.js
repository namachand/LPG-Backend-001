import express from "express";
import cors from "cors";
import routes from "./routes/authRoutes.js";
import salesRoutes from "./routes/salesRoutes.js";
import driverRoutes from "./routes/driverRoutes.js";
import stockRoutes from "./routes/stockRoutes.js"
import settlementRoutes from "./routes/settlementRoutes.js"
import customerIssueRoutes from "./routes/customerIssueRoutes.js"
import getUserSettingRoutes from "./routes/userRoutes.js"
import getExpenseRoutes from "./routes/expenseRoutes.js"
import godownRoutes from "./routes/godownRoutes.js";


const app = express();
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());

app.use("/api/auth", routes);
app.use("/api/sales", salesRoutes);
app.use("/api/drivers", driverRoutes);
app.use("/api/stocks", stockRoutes);
app.use("/api/settlements", settlementRoutes);
app.use("/api/issues", customerIssueRoutes);
app.use("/api/users", getUserSettingRoutes);
app.use("/api/expenses", getExpenseRoutes);
app.use("/api/godown", godownRoutes);





export default app;