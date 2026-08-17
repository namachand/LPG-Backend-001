import express from "express";
import multer from "multer";
import { put } from "@vercel/blob";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
import { bulkUploadCustomers } from "../controllers/customerBulkUploadController.js";
import {
  startPurchaseTrip,
  submitPurchaseTrip,
  startEmptyCylinderTrip,
} from "../controllers/purchaseController.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const odometerUploadsDir = path.join(__dirname, "../../uploads/odometers");
const documentUploadsDir = path.join(
  __dirname,
  "../../uploads/supporting-documents",
);

// Ensure directory exists
if (!fs.existsSync(odometerUploadsDir)) {
  fs.mkdirSync(odometerUploadsDir, { recursive: true });
}

if (!fs.existsSync(documentUploadsDir)) {
  fs.mkdirSync(documentUploadsDir, { recursive: true });
}

const odometerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, odometerUploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `odometer_${Date.now()}${ext}`);
  },
});

const supportingDocumentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, documentUploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `document_${Date.now()}${ext}`);
  },
});

const odometerUpload = multer({
  storage: odometerStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
});

const supportingDocumentUpload = multer({
  storage: supportingDocumentStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      !file.mimetype.startsWith("image/") &&
      file.mimetype !== "application/pdf"
    ) {
      return cb(new Error("Only image or PDF files are allowed"));
    }
    cb(null, true);
  },
});

const imageMemoryStorage = multer.memoryStorage();
const imageUpload = multer({
  storage: imageMemoryStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error("Only JPG, JPEG, PNG, and WEBP files are allowed"));
    }
    cb(null, true);
  },
});

// POST /api/upload/odometer  → handles image uploads and optionally starts/ends a trip in one go
router.post(
  "/odometer",
  imageUpload.fields([
    { name: "image", maxCount: 1 },
    { name: "invoice", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      let odometerUrl = null;
      let invoiceUrl = null;

      // 1. Upload Odometer Image if present
      if (req.files && req.files["image"]) {
        const file = req.files["image"][0];
        const ext = path.extname(file.originalname) || ".jpg";
        const filename = `uploads/odometers/odometer_${Date.now()}_${Math.round(Math.random() * 1000)}${ext}`;

        const blob = await put(filename, file.buffer, {
          access: "private",
          token: process.env.BLOB_READ_WRITE_TOKEN,
          contentType: file.mimetype,
          addRandomSuffix: true,
        });
        odometerUrl = blob.url;
      }

      // 2. Upload Invoice Image if present
      if (req.files && req.files["invoice"]) {
        const file = req.files["invoice"][0];
        const ext = path.extname(file.originalname) || ".jpg";
        const filename = `uploads/supporting-documents/invoice_${Date.now()}_${Math.round(Math.random() * 1000)}${ext}`;

        const blob = await put(filename, file.buffer, {
          access: "private",
          token: process.env.BLOB_READ_WRITE_TOKEN,
          contentType: file.mimetype,
          addRandomSuffix: true,
        });
        invoiceUrl = blob.url;
      }

      const action = req.body.action; // "START" | "END" | null

      // --- HANDLE START TRIP ---
      if (action === "START") {
        req.body.odometerImageUrl = odometerUrl;
        return startPurchaseTrip(req, res);
      }

      // --- HANDLE START EMPTY TRIP ---
      if (action === "START_EMPTY") {
        req.body.odometerImageUrl = odometerUrl;
        return startEmptyCylinderTrip(req, res);
      }

      // --- HANDLE END TRIP ---
      if (action === "END") {
        if (!odometerUrl) {
          return res
            .status(400)
            .json({
              message: "Closing odometer photo is required to end the trip.",
            });
        }
        if (!req.body.tripId) {
          return res
            .status(400)
            .json({ message: "tripId is required to end the trip." });
        }

        req.body.endOdometerImageUrl = odometerUrl;
        req.body.endOdometerReading = req.body.odometerReading;
        if (invoiceUrl) {
          req.body.invoiceUrl = invoiceUrl;
        }

        // ADD THIS: Pass through the emptyLoadId if it exists
        if (req.body.emptyLoadId) {
          req.body.emptyLoadId = Number(req.body.emptyLoadId);
        }

        // submitPurchaseTrip reads tripId from req.params
        req.params.tripId = req.body.tripId;
        await submitPurchaseTrip(req, res);
        return;
      }

      // --- HANDLE RAW UPLOAD (Fallback) ---
      if (!odometerUrl && !invoiceUrl) {
        return res.status(400).json({ message: "No files provided" });
      }

      // If no action is provided, just return the uploaded URL(s) for backwards compatibility
      res.json({ url: odometerUrl, invoiceUrl: invoiceUrl });
    } catch (error) {
      console.error("Vercel Blob upload error for odometer:", error);
      res
        .status(500)
        .json({
          success: false,
          message: "Failed to upload files and process trip",
          error: error.message,
          stack: error.stack
        });
    }
  },
);

// POST /api/upload/supporting-document  → returns { url: "/uploads/supporting-documents/<filename>" }
router.post(
  "/supporting-document",
  supportingDocumentUpload.single("file"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "No file provided" });
    }
    const url = `/uploads/supporting-documents/${req.file.filename}`;
    res.json({ url });
  },
);

const excelUpload = multer({
  dest: os.tmpdir(),
  fileFilter: (_req, file, cb) => {
    if (
      !file.mimetype.includes("excel") &&
      !file.mimetype.includes("spreadsheetml") &&
      !file.originalname.match(/\.(xlsx|xls|csv)$/)
    ) {
      return cb(new Error("Only Excel files are allowed"));
    }
    cb(null, true);
  },
});

// POST /api/upload/bulk-customers → parses Excel and inserts into DB
router.post("/bulk-customers", excelUpload.single("file"), bulkUploadCustomers);

// POST /api/upload/image → uploads to Vercel Blob
router.post("/image", imageUpload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "No image file provided" });
    }

    const ext = path.extname(req.file.originalname) || ".jpg";
    const filename = `uploads/images/image_${Date.now()}_${Math.round(Math.random() * 1000)}${ext}`;

    const blob = await put(filename, req.file.buffer, {
      access: "public",
      token: process.env.BLOB_READ_WRITE_TOKEN,
      contentType: req.file.mimetype,
      addRandomSuffix: true,
    });

    res.json({
      success: true,
      url: blob.url,
      pathname: blob.pathname,
    });
  } catch (error) {
    console.error("Vercel Blob upload error:", error);
    res.status(500).json({ success: false, message: "Failed to upload image" });
  }
});

export default router;
