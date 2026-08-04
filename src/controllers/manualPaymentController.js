export const initiateManualPayment = async (req, res) => {
  try {
    const { amount, driverId, method, paymentApp } = req.body;

    // Generate a mock order ID
    const order_id = `MANUAL_ORDER_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    return res.status(200).json({
      success: true,
      message: "Manual payment initiated successfully",
      order_id,
      amount,
      currency: "INR",
      paymentApp,
    });
  } catch (error) {
    console.error("Manual Payment initiate error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to initiate manual payment",
      error: error.message,
    });
  }
};

export const verifyManualPayment = async (req, res) => {
  try {
    const { order_id, status } = req.body;

    if (!order_id || !status) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: order_id, or status",
      });
    }

    if (status !== 'SUCCESS') {
      return res.status(400).json({
        success: false,
        message: "Payment status is not SUCCESS",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Payment verified successfully",
    });
  } catch (error) {
    console.error("Manual Payment verify error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to verify payment",
      error: error.message,
    });
  }
};
