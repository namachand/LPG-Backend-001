import express from "express";
import { updateUserSettings, getUserSettings } from "../controllers/userController.js";

const router = express.Router();

router.get("/:id/settings", getUserSettings);
router.put("/:id/settings", updateUserSettings);

export default router;