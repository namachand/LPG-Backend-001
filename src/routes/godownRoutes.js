import express from "express";
import {
    getGodownDashboardData,
    getStockDetailByType,
    getStockInLoads,
    getStockInLoadDetail,
    approveStockInLoad,
    getDriverLists,
    getCylinderProducts,
    getStockOutLoads,
    createStockOutLoad,
    getStockOutLoadDetail,
    approveStockOutLoad,
    getDefectiveLoads,
    createDefectiveLoad,
    getDeliveryDrivers,
    getDriverDayWiseSummary,
    createDriverAllocation,
    getReturnsToday,
    approveReturnByCondition,
    getTransferEmptyReturns,
    approveTransferEmptyReturn,
    cancelStockOutLoad,
    getCommercialDriverBookings,
    approveCommercialDriverBooking
} from "../controllers/godownController.js";

const router = express.Router();

router.get("/dashboard", getGodownDashboardData);
router.get("/stock-detail/:type", getStockDetailByType);

router.get("/stock-in-loads", getStockInLoads);
router.get("/stock-in-loads/:loadId", getStockInLoadDetail);
router.put("/stock-in-loads/:loadId/approve", approveStockInLoad);
router.get("/drivers", getDriverLists);
router.get("/products", getCylinderProducts);

router.get("/stock-out-loads", getStockOutLoads);
router.post("/stock-out-loads", createStockOutLoad);
router.get("/stock-out-loads/:loadId", getStockOutLoadDetail);
router.put("/stock-out-loads/:loadId/approve", approveStockOutLoad);
router.get("/defective-loads", getDefectiveLoads);
router.post("/defective-loads", createDefectiveLoad);
router.get("/delivery-drivers", getDeliveryDrivers);
router.get("/drivers/:driverId/day-wise-summary", getDriverDayWiseSummary);
router.post("/driver-allocation", createDriverAllocation);
router.get("/returns-today", getReturnsToday);
router.put("/returns-today/approve", approveReturnByCondition);
router.get("/transfer-empty-returns", getTransferEmptyReturns);
router.put("/transfer-empty-returns/approve", approveTransferEmptyReturn);
router.put("/stock-out-loads/:loadId/cancel", cancelStockOutLoad);
router.get("/commercial-bookings", getCommercialDriverBookings);
router.put("/commercial-bookings/:bookingId/approve", approveCommercialDriverBooking);

export default router;