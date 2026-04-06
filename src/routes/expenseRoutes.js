import express from "express";
import { getExpensesDashboard } from "../controllers/expenseController.js";

const router = express.Router();

router.get("/dashboard", getExpensesDashboard);

export default router;