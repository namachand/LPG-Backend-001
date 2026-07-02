import express from "express";
import {
	createExpense,
	getExpensesDashboard,
} from "../controllers/expenseController.js";

const router = express.Router();

router.post("/", createExpense);
router.get("/dashboard", getExpensesDashboard);

export default router;