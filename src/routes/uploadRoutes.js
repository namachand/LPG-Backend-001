import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
import { bulkUploadCustomers } from "../controllers/customerBulkUploadController.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const odometerUploadsDir = path.join(__dirname, "../../uploads/odometers");
const documentUploadsDir = path.join(__dirname, "../../uploads/supporting-documents");

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
    if (!file.mimetype.startsWith("image/") && file.mimetype !== "application/pdf") {
      return cb(new Error("Only image or PDF files are allowed"));
    }
    cb(null, true);
  },
});

// POST /api/upload/odometer  → returns { url: "/uploads/odometers/<filename>" }
router.post("/odometer", odometerUpload.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No image file provided" });
  }
  const url = `/uploads/odometers/${req.file.filename}`;
  res.json({ url });
});

// POST /api/upload/supporting-document  → returns { url: "/uploads/supporting-documents/<filename>" }
router.post("/supporting-document", supportingDocumentUpload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file provided" });
  }
  const url = `/uploads/supporting-documents/${req.file.filename}`;
  res.json({ url });
});

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

export default router;
