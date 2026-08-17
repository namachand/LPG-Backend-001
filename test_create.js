import dotenv from "dotenv";
dotenv.config();

async function test() {
  console.log("Starting test...");
  
  const { default: db } = await import("./src/config/db.js");
  const { createEmptyCylinderLoad } = await import("./src/controllers/emptyCylinderLoadController.js");

  const req = {
    user: { id: 25573 },
    body: {
      assigned_by: 25573,
      purchase_manager_id: 25642,
      vehicle_number: null,
      erv_number: null,
      items: [
          {
              product_id: 4,
              quantity: 0,
              defective_quantity: 1
          },
          {
              product_id: 5,
              quantity: 1,
              defective_quantity: 1
          }
      ]
    }
  };

  const res = {
    status: function (code) {
      console.log("Response status:", code);
      return this;
    },
    json: function (data) {
      console.log("Response JSON:", JSON.stringify(data, null, 2));
      return this;
    }
  };

  try {
    await createEmptyCylinderLoad(req, res);
    console.log("Test finished.");
  } catch (error) {
    console.error("Test threw error:", error);
  }
  
  process.exit(0);
}

test();
