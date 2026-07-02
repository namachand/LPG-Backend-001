import express from "express";
import {
  createCustomerConnection,
  getRecentCustomerConnections,
  searchConnectionProducts,
} from "../controllers/customerConnectionController.js";

const router = express.Router();

router.get("/products/search", searchConnectionProducts);
router.get("/recent", getRecentCustomerConnections);
router.post("/", createCustomerConnection);

export default router;
