import express from "express";
import {
  assignComplaintToDeliveryBoy,
  createCustomerComplaint,
  getComplaintCustomers,
  getComplaintIssueTypes,
  getCustomerComplaints,
  updateComplaintStatus,
} from "../controllers/customerComplaintController.js";

const router = express.Router();

router.get("/issue-types", getComplaintIssueTypes);
router.get("/customers", getComplaintCustomers);
router.get("/complaints", getCustomerComplaints);
router.post("/complaints", createCustomerComplaint);
router.patch("/complaints/:id/assign-delivery", assignComplaintToDeliveryBoy);
router.patch("/complaints/:id/status", updateComplaintStatus);

export default router;