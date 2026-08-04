import db from "../config/db.js";

export const registerAgency = async (req, res) => {
  try {
    const {
      agencyName,
      gstNumber,
      phoneNumber,
      emailId,
      address,
      state,
      district,
      pinCode,
      subscriptionPlan,
      agreedToTerms
    } = req.body;

    if (!agencyName || !gstNumber || !phoneNumber || !emailId || !address || !state || !district || !pinCode) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields.",
      });
    }

    if (!agreedToTerms) {
      return res.status(400).json({
        success: false,
        message: "You must agree to the Terms & Conditions and Privacy Policy.",
      });
    }

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
        agencyName,
        gstNumber,
        phoneNumber,
        emailId,
        address,
        state,
        district,
        pinCode,
        subscriptionPlan || null,
        agreedToTerms ? true : false
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Agency registered successfully",
      agencyId: result.insertId,
    });
  } catch (error) {
    console.error("registerAgency error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to register agency",
      error: error.message,
    });
  }
};
