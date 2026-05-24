import { createApp } from "./app.js";
import { connectToDatabase } from "./config/db.js";
import { env } from "./config/env.js";

async function startServer() {
  await connectToDatabase();

  const app = createApp();
  app.listen(env.port, () => {
    console.log(`EKHO backend listening on port ${env.port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start EKHO backend.");
  console.error(error);
  process.exit(1);
});
