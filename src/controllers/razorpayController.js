import Razorpay from "razorpay";
import crypto from "crypto";

export const createOrder = async (req, res) => {
  try {
    const { amount, currency = "INR", receipt } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Amount must be provided and must be at least 100 paise",
      });
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const options = {
      amount: parseInt(amount, 10),
      currency,
      receipt,
    };

    const order = await razorpay.orders.create(options);

    return res.status(200).json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (error) {
    console.error("Razorpay createOrder error:", error);
    // If it's an auth error from Razorpay (e.g. invalid keys), it might throw a 401 or similar.
    // Razorpay error objects usually contain a `statusCode`.
    const statusCode = error.statusCode || 500;
    if (statusCode === 401) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: Invalid Razorpay credentials",
      });
    }
    
    return res.status(500).json({
      success: false,
      message: "Server Error: Failed to create order",
      error: error.message || error,
    });
  }
};

export const verifyPayment = async (req, res) => {
  try {
    const { order_id, payment_id, razorpay_signature } = req.body;

    if (!order_id || !payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: order_id, payment_id, or razorpay_signature",
      });
    }

    const hmac = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
    hmac.update(order_id + "|" + payment_id);
    const generatedSignature = hmac.digest("hex");

    if (generatedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Payment signature mismatch",
      });
    }

    // Signatures match. In a real application, you would also mark the order as paid in the DB here.
    return res.status(200).json({
      success: true,
      message: "Payment verified successfully",
    });
  } catch (error) {
    console.error("Razorpay verifyPayment error:", error);
    return res.status(500).json({
      success: false,
      message: "Server Error: Failed to verify payment",
      error: error.message || error,
    });
  }
};
