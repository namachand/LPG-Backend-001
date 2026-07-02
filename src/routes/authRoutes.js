import express from "express";
import {
	googleLogin,
	identifyAuthMethod,
	loginWithPassword,
	phoneLogin,
	requestOtpLogin,
	verifyOtpLogin,
} from "../controllers/authController.js";

const router = express.Router();

router.post("/google", googleLogin);
router.post("/phone", phoneLogin);
router.post("/identify", identifyAuthMethod);
router.post("/login/password", loginWithPassword);
router.post("/login/otp/request", requestOtpLogin);
router.post("/login/otp/verify", verifyOtpLogin);

export default router;