import "dotenv/config";
import app from "./app.js";

// Railway (and most hosts) inject the port to bind to via PORT.
const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
