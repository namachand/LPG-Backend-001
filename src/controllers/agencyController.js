import db from "../config/db.js";

export const registerAgency = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      agency_name,
      gst_number,
      phone_number,
      email_id,
      address,
      state,
      district,
      pin_code,
      subscription_plan,
      terms_accepted,
    } = req.body;

    // 1. Basic validation
    if (
      !agency_name ||
      !gst_number ||
      !phone_number ||
      !email_id ||
      !address ||
      !state ||
      !district ||
      !pin_code
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide all required fields.",
      });
    }

    if (!terms_accepted) {
      return res.status(400).json({
        success: false,
        message: "You must accept the Terms & Conditions.",
      });
    }

    await connection.beginTransaction();

    // 2. Check if agency email or phone already exists in users table
    const [existingUsers] = await connection.execute(
      "SELECT id FROM users WHERE email = ? OR phone = ?",
      [email_id, phone_number]
    );

    if (existingUsers.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: "An account with this email or phone number already exists.",
      });
    }

    // 3. Insert Agency
    const [agencyResult] = await connection.execute(
      `
      INSERT INTO agencies (
        agency_name, gst_number, phone_number, email_id, address, 
        state, district, pin_code, subscription_plan, terms_accepted, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
      `,
      [
        agency_name,
        gst_number,
        phone_number,
        email_id,
        address,
        state,
        district,
        pin_code,
        subscription_plan || null,
        terms_accepted ? 1 : 0,
      ]
    );

    const agencyId = agencyResult.insertId;

    // 4. Create an OWNER user for this new agency
    // The owner can log in using OTP via the phone number or email provided.
    await connection.execute(
      `
      INSERT INTO users (name, company_name, email, phone, role, status, agency_id)
      VALUES (?, ?, ?, ?, 'OWNER', 'ACTIVE', ?)
      `,
      [
        agency_name, // Defaulting owner name to agency name initially
        agency_name,
        email_id,
        phone_number,
        agencyId,
      ]
    );

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Agency registered successfully! You can now log in.",
      agency_id: agencyId,
    });

  } catch (error) {
    await connection.rollback();
    console.error("Error registering agency:", error);
    return res.status(500).json({
      success: false,
      message: "Server Error during agency registration.",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
