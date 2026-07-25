import express from "express";
import { getDriverDashboard } from "../controllers/driverController.js";
import { createDriver, getDriverDeliveriesApp, markSaleAsDelivered, createDriverSale, getDriverCollectionSummary, 
    settleDriverCollectionsByMethod, getDriverInHandSummary, returnInHandToGodown, getDriverCollectionHistory,
getDriverEmptyCylindersToday, getDriverEmptyCylindersHistory, approveTodayEmptyCylinderReturns, getDriverProfileHistory,
searchProductsForDriverApp, findCustomerForDriverApp, getAllocatedCylinders, getDriverDeliveryDetails, createInHandRequest,
createEmptyCylinderReturnRequest, getAllocatedBatchDetail, getAvailableBatchesForDriver, findBookingCustomer,
createBookingCustomer, createDriverBooking, getDriverBookings, cancelDriverBooking, getDriverReturnableEmptyProducts, createDriverReturn} from "../controllers/driverController.js";

const router = express.Router();

router.get("/dashboard", getDriverDashboard);
router.post("/", createDriver);
router.get("/:driverId/app-deliveries", getDriverDeliveriesApp);
router.put("/sale/:saleId/deliver", markSaleAsDelivered);
router.put("/sales/deliver", markSaleAsDelivered);
router.post("/sales", createDriverSale);
router.post("/returns", createDriverReturn);
router.get("/:driverId/collection-summary", getDriverCollectionSummary);
router.put("/:driverId/settle-collections", settleDriverCollectionsByMethod);
router.get("/:driverId/in-hand-summary", getDriverInHandSummary);
router.put("/:driverId/return-in-hand", returnInHandToGodown);
router.get("/:driverId/collection-history", getDriverCollectionHistory);
router.get("/:driverId/empty-cylinders/today", getDriverEmptyCylindersToday);
router.get("/:driverId/empty-cylinders/history", getDriverEmptyCylindersHistory);
router.get("/:driverId/empty-cylinders/returnable-products", getDriverReturnableEmptyProducts);
router.put("/:driverId/empty-cylinders/approve-today", approveTodayEmptyCylinderReturns);
router.get("/:driverId/profile-history", getDriverProfileHistory);
router.get("/products/search", searchProductsForDriverApp);
router.get("/customers/find", findCustomerForDriverApp);
router.get('/:driverId/allocated-cylinders', getAllocatedCylinders);
router.get("/deliveries/:saleId/details", getDriverDeliveryDetails);
router.post("/in-hand/request", createInHandRequest);
router.post("/empty-cylinders/return-request", createEmptyCylinderReturnRequest);
router.get("/:driverId/allocated-batches/:allocationSalesItemId",getAllocatedBatchDetail);
router.get("/:driverId/available-batches",getAvailableBatchesForDriver);
router.get("/bookings/customer", findBookingCustomer);
router.post("/bookings/customer", createBookingCustomer);
router.post("/bookings", createDriverBooking);
router.get("/:driverId/bookings", getDriverBookings);
router.put("/bookings/:saleId/cancel", cancelDriverBooking);

export default router;