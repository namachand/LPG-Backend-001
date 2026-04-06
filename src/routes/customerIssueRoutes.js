import express from "express";
import { getCustomerIssuesDashboard } from "../controllers/customerIssueController.js";

const router = express.Router();

router.get("/dashboard", getCustomerIssuesDashboard);

export default router;