import express from "express";
import { googleLogin, phoneLogin } from "../controllers/authController.js";

const router = express.Router();

router.post("/google", googleLogin);
router.post("/phone", phoneLogin);

export default router;