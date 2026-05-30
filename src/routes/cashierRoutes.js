import express from "express";
import {
  getCashierDashboard,
  getCashierDriverCollections,
  verifyDriverCollections,
  getLastClosingBalance,
  getClosingSummary,
  startCashierDay,
  closeCashierDay,
  recordOfficeSale,
  recordOfficeExpense,
  getTodayOfficeSales,
  getTodayOfficeExpenses,
  recordCashierReceipt,
  getTodaysCashFlow,
  recordOtherPayment,
  getOtherPayments,
  getOtherPaymentsSummary,
  findCustomerForCashierApp
} from "../controllers/cashierController.js";

const router = express.Router();

router.get("/dashboard", getCashierDashboard);
router.get("/driver-collections", getCashierDriverCollections);
router.post("/driver-collections/:driverId/verify", verifyDriverCollections);
router.get("/opening/last-closing", getLastClosingBalance);
router.get("/closing/summary", getClosingSummary);
router.post("/opening", startCashierDay);
router.post("/closing", closeCashierDay);
router.post("/office-sale", recordOfficeSale);
router.post("/office-expense", recordOfficeExpense);
router.post("/other-payments", recordOtherPayment);
router.get("/other-payments", getOtherPayments);
router.get("/other-payments/summary", getOtherPaymentsSummary);
router.get("/office-sales/today", getTodayOfficeSales);
router.get("/office-expenses/today", getTodayOfficeExpenses);
router.post("/receipt", recordCashierReceipt);
router.get("/cash-flow/today", getTodaysCashFlow);
router.get("/customers/find", findCustomerForCashierApp);


export default router;
