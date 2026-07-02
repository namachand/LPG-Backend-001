import express from "express";
import {
  addIocOtp,
  getIocOtpSummary,
  listIocOtps,
  markIocOtpSent,
} from "../controllers/iocOtpController.js";

const router = express.Router();

router.get("/summary", getIocOtpSummary);
router.get("/", listIocOtps);
router.post("/", addIocOtp);
router.patch("/:id/mark-sent", markIocOtpSent);

export default router;
