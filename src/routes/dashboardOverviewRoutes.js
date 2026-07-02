import express from "express";
import { getDashboardOverview } from "../controllers/dashboardOverviewController.js";

const router = express.Router();

router.get("/overview", getDashboardOverview);

export default router;
