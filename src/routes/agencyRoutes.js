import express from "express";
import { registerAgency } from "../controllers/agencyController.js";

const router = express.Router();

// POST /api/agencies/register
router.post("/register", registerAgency);

export default router;
