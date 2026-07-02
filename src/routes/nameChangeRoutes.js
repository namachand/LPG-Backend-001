import express from "express";
import {
  approveNameChangeRequest,
  createNameChangeRequest,
  getRecentNameChangeRequests,
  lookupNameChangeCustomer,
} from "../controllers/nameChangeController.js";

const router = express.Router();

router.get("/lookup", lookupNameChangeCustomer);
router.get("/recent", getRecentNameChangeRequests);
router.post("/", createNameChangeRequest);
router.patch("/:id/approve", approveNameChangeRequest);

export default router;
