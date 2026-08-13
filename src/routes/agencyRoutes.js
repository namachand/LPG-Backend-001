import express from "express";
import { registerAgency } from "../controllers/agencyController.js";

const router = express.Router();

// Public endpoint for new agency registration (onboarding)
router.post("/register", registerAgency);

export default router;
