import express from "express";
import {
  getCustomerDashboardDetails,
  searchCustomersDashboard,
} from "../controllers/customerDashboardController.js";

const router = express.Router();

router.get("/customers", searchCustomersDashboard);
router.get("/customers/:id", getCustomerDashboardDetails);

export default router;
