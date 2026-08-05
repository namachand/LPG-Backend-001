import express from "express";
import { initiateManualPayment, verifyManualPayment } from "../controllers/manualPaymentController.js";

const router = express.Router();

router.post("/manual-payment/initiate", initiateManualPayment);
router.post("/manual-payment/verify", verifyManualPayment);

export default router;
