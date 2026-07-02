import express from "express";
import {
  createCustomerPenalty,
  getRecentCustomerPenalties,
  lookupPenaltyCustomer,
  markPenaltyAsPaid,
} from "../controllers/prPenaltyController.js";

const router = express.Router();

router.get("/lookup", lookupPenaltyCustomer);
router.get("/recent", getRecentCustomerPenalties);
router.post("/", createCustomerPenalty);
router.patch("/:id/mark-paid", markPenaltyAsPaid);

export default router;
