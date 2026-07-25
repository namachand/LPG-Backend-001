import express from "express";
import {
  acceptEmptyCylinderLoad,
  completeEmptyCylinderLoad,
  createEmptyCylinderLoad,
  getEmptyCylinderLoadDetail,
  getEmptyCylinderLoads,
  getPurchaseManagers,
  rejectEmptyCylinderLoad,
} from "../controllers/emptyCylinderLoadController.js";

const router = express.Router();

router.get("/purchase-managers", getPurchaseManagers);
router.get("/", getEmptyCylinderLoads);
router.post("/", createEmptyCylinderLoad);
router.get("/:loadId", getEmptyCylinderLoadDetail);
router.put("/:loadId/accept", acceptEmptyCylinderLoad);
router.put("/:loadId/reject", rejectEmptyCylinderLoad);
router.put("/:loadId/complete", completeEmptyCylinderLoad);

export default router;
