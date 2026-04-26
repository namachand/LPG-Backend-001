import express from "express";
import { getDriverDashboard } from "../controllers/driverController.js";
import { createDriver, getDriverDeliveriesApp, markSaleAsDelivered, createDriverSale, getDriverCollectionSummary, 
    settleDriverCollectionsByMethod, getDriverInHandSummary, returnInHandToGodown, getDriverCollectionHistory,
getDriverEmptyCylindersToday, getDriverEmptyCylindersHistory, approveTodayEmptyCylinderReturns, getDriverProfileHistory,
searchProductsForDriverApp, findCustomerForDriverApp} from "../controllers/driverController.js";

const router = express.Router();

router.get("/dashboard", getDriverDashboard);
router.post("/", createDriver);
router.get("/:driverId/app-deliveries", getDriverDeliveriesApp);
router.put("/sale/:saleId/deliver", markSaleAsDelivered);
router.put("/sales/deliver", markSaleAsDelivered);
router.post("/sales", createDriverSale);
router.get("/:driverId/collection-summary", getDriverCollectionSummary);
router.put("/:driverId/settle-collections", settleDriverCollectionsByMethod);
router.get("/:driverId/in-hand-summary", getDriverInHandSummary);
router.put("/:driverId/return-in-hand", returnInHandToGodown);
router.get("/:driverId/collection-history", getDriverCollectionHistory);
router.get("/:driverId/empty-cylinders/today", getDriverEmptyCylindersToday);
router.get("/:driverId/empty-cylinders/history", getDriverEmptyCylindersHistory);
router.put("/:driverId/empty-cylinders/approve-today", approveTodayEmptyCylinderReturns);
router.get("/:driverId/profile-history", getDriverProfileHistory);
router.get("/products/search", searchProductsForDriverApp);
router.get("/customers/find", findCustomerForDriverApp);

export default router;