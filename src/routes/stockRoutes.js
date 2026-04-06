import express from "express";
import { getStockDashboard, getStockAreas } from "../controllers/stockController.js";

const router = express.Router();

router.get("/dashboard", getStockDashboard);
router.get("/areas", getStockAreas);

export default router;