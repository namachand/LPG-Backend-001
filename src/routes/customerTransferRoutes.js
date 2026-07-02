import express from "express";
import {
  createCustomerTransfer,
  getRecentCustomerTransfers,
  lookupTransferCustomer,
} from "../controllers/customerTransferController.js";

const router = express.Router();

router.get("/lookup", lookupTransferCustomer);
router.get("/recent", getRecentCustomerTransfers);
router.post("/", createCustomerTransfer);

export default router;
