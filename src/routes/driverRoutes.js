import express from "express";
import { getDriverDashboard } from "../controllers/driverController.js";
import { createDriver } from "../controllers/driverController.js";

const router = express.Router();

router.get("/dashboard", getDriverDashboard);
router.post("/", createDriver);


export default router;