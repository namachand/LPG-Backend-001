import express from "express";
import { getSalesDashboard, createSale } from "../controllers/salesController.js";

const router = express.Router();

router.get("/dashboard", getSalesDashboard);
router.post("/", createSale);



export default router;