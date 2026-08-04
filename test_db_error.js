import db from "./src/config/db.js";

async function testInsert() {
  try {
    const [result] = await db.query(
      `INSERT INTO agencies (
        name, 
        gst_number, 
        phone, 
        contact_email, 
        address, 
        state, 
        district, 
        pin_code, 
        subscription_plan, 
        agreed_to_terms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "Test Agency",
        "27ABCDE1234F1Z5",
        "9876543210",
        "test@agency.com",
        "Shop 12",
        "Maharashtra",
        "Pune",
        "411001",
        "Recommended - 6 Months",
        true
      ]
    );
    console.log("Success:", result);
  } catch (error) {
    console.error("Exact DB Error:", error);
  } finally {
    process.exit();
  }
}

testInsert();
