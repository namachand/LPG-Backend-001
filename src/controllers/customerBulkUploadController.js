import db from "../config/db.js";
import xlsx from "xlsx";
import fs from "fs";

export const bulkUploadCustomers = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No Excel file provided" });
  }

  const filePath = req.file.path;
  const connection = await db.getConnection();

  try {
    // 1. Read the Excel file
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    
    // Parse to JSON array
    const data = xlsx.utils.sheet_to_json(sheet);

    if (!data || data.length === 0) {
      return res.status(400).json({ message: "Excel file is empty or invalid" });
    }

    let successCount = 0;
    let failCount = 0;
    const errors = [];

    await connection.beginTransaction();

    for (const [index, row] of data.entries()) {
      try {
        const consumerId = row["Consumer ID"] || row["Consumer_ID"] || null;
        const consumerNumber = row["Consumer Number"] || row["Consumer_Number"] || null;
        const consumerName = row["Consumer Name"] || row["Consumer_Name"] || "Unknown Customer";
        
        const rawAddress = row["Address"] || "";
        const areaName = row["Area Name"] || row["Area_Name"] || "";
        const fullAddress = [rawAddress, areaName].filter(Boolean).join(", ");
        
        const productStr = row["Product"] || "";

        // 2. Insert into users table
        const [userResult] = await connection.execute(
          `
          INSERT INTO users (
            name, 
            role, 
            status, 
            consumer_id, 
            consumer_number
          ) VALUES (?, 'CUSTOMER', 'ACTIVE', ?, ?)
          `,
          [consumerName, consumerId, consumerNumber]
        );

        const newUserId = userResult.insertId;

        // 3. Insert into addresses table
        if (fullAddress) {
          await connection.execute(
            `
            INSERT INTO addresses (user_id, address, is_default)
            VALUES (?, ?, 1)
            `,
            [newUserId, fullAddress]
          );
        }

        // 4. (Optional) Check product and create connection record if we want to store product
        if (productStr) {
          await connection.execute(
            `
            INSERT INTO customer_new_connections (
              user_id, 
              product_details, 
              deposit_amount, 
              gst_amount, 
              status
            ) VALUES (?, ?, 0, 0, 'APPROVED')
            `,
            [newUserId, productStr]
          );
        }

        successCount++;
      } catch (rowError) {
        failCount++;
        errors.push(`Row ${index + 2}: ${rowError.message}`);
      }
    }

    await connection.commit();

    res.status(200).json({
      message: "Bulk upload completed",
      successCount,
      failCount,
      errors
    });

  } catch (error) {
    await connection.rollback();
    console.error("bulkUploadCustomers error:", error);
    res.status(500).json({ message: "Internal server error during bulk upload", error: error.message, stack: error.stack });
  } finally {
    connection.release();
    // Clean up uploaded file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
};
