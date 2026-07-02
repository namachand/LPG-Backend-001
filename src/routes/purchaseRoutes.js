import express from "express";
import {
  attachPurchaseLoadInvoice,
  cancelPurchaseLoad,
  createPurchaseLoad,
  getActivePurchaseTrip,
  getPurchaseBootstrap,
  getPurchaseDashboard,
  getPurchaseExpenses,
  getPurchaseLoadDetail,
  getPurchaseLoads,
  getPurchaseTrips,
  startPurchaseTrip,
  submitPurchaseTrip,
  updatePurchaseLoad,
} from "../controllers/purchaseController.js";

const router = express.Router();

router.get("/bootstrap", getPurchaseBootstrap);
router.get("/dashboard", getPurchaseDashboard);
router.get("/trips", getPurchaseTrips);
router.get("/trips/active", getActivePurchaseTrip);
router.post("/trips/start", startPurchaseTrip);
router.put("/trips/:tripId/submit", submitPurchaseTrip);
router.get("/loads", getPurchaseLoads);
router.get("/loads/:loadId", getPurchaseLoadDetail);
router.post("/loads", createPurchaseLoad);
router.put("/loads/:loadId", updatePurchaseLoad);
router.put("/loads/:loadId/invoice", attachPurchaseLoadInvoice);
router.put("/loads/:loadId/cancel", cancelPurchaseLoad);
router.get("/expenses", getPurchaseExpenses);

export default router;