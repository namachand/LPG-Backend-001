import express from "express";
import {
  getCashSettlementDashboard,
  upsertSettlement,
} from "../controllers/settlementController.js";

const router = express.Router();

router.get("/dashboard", getCashSettlementDashboard);
router.post("/", upsertSettlement);

export default router;