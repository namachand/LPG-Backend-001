import db from "../config/db.js";
import xlsx from "xlsx";
import fs from "fs";

export const bulkUploadCustomers = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No Excel file provided" });
  }

  const filePath = req.file.path;

  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet);

    if (!data || data.length === 0) {
      return res.status(400).json({ message: "Excel file is empty or invalid" });
    }

    let successCount = 0;
    let failCount = 0;
    const errors = [];

    // Process in batches of 500 using TRUE bulk inserts for extreme performance
    const batchSize = 500;
    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);
      
      const userValues = [];
      const consumerNumbers = [];
      const rowDataMap = {}; // map consumerNumber -> row details
      
      for (const row of batch) {
        const consumerId = row["Consumer ID"] || row["Consumer_ID"] || null;
        let consumerNumber = row["Consumer Number"] || row["Consumer_Number"] || null;
        
        if (!consumerNumber) {
           // Fallback to a unique random string if the Excel cell is empty, so we can map it back
           consumerNumber = "TEMP_" + Math.random().toString(36).substring(2, 10);
        }
        
        const consumerName = row["Consumer Name"] || row["Consumer_Name"] || "Unknown Customer";
        
        userValues.push([consumerName, 'CUSTOMER', 'ACTIVE', consumerId, consumerNumber]);
        consumerNumbers.push(consumerNumber);
        
        rowDataMap[consumerNumber] = {
           rawAddress: row["Address"] || "",
           areaName: row["Area Name"] || row["Area_Name"] || "",
           productStr: row["Product"] || ""
        };
      }
      
      if (userValues.length > 0) {
        try {
          // 1. Bulk insert users
          await db.query(
            `INSERT INTO users (name, role, status, consumer_id, consumer_number) VALUES ?`,
            [userValues]
          );
          
          // 2. Fetch inserted user IDs to map to addresses and connections
          const [users] = await db.query(
            `SELECT id, consumer_number FROM users WHERE consumer_number IN (?)`,
            [consumerNumbers]
          );
          
          const addressValues = [];
          const connectionValues = [];
          
          for (const user of users) {
             const rowDetails = rowDataMap[user.consumer_number];
             if (rowDetails) {
                const fullAddress = [rowDetails.rawAddress, rowDetails.areaName].filter(Boolean).join(", ");
                if (fullAddress) {
                   addressValues.push([user.id, fullAddress, 1]);
                }
                if (rowDetails.productStr) {
                   connectionValues.push([user.id, rowDetails.productStr, 0, 0, 'APPROVED']);
                }
             }
          }
          
          // 3. Bulk insert addresses
          if (addressValues.length > 0) {
             await db.query(
               `INSERT INTO addresses (user_id, address, is_default) VALUES ?`,
               [addressValues]
             );
          }
          
          // 4. Bulk insert connections
          if (connectionValues.length > 0) {
             await db.query(
               `INSERT INTO customer_new_connections (user_id, product_details, deposit_amount, gst_amount, status) VALUES ?`,
               [connectionValues]
             );
          }
          
          successCount += batch.length;
        } catch (error) {
          failCount += batch.length;
          errors.push(`Batch starting at row ${i + 2} failed: ${error.message}`);
        }
      }
    }

    res.status(200).json({
      message: "Bulk upload completed",
      successCount,
      failCount,
      errors
    });

  } catch (error) {
    console.error("bulkUploadCustomers error:", error);
    res.status(500).json({ message: "Internal server error during bulk upload", error: error.message, stack: error.stack });
  } finally {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
};
