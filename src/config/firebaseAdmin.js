import admin from "firebase-admin";
import fs from "fs";

let initialized = false;

const loadServiceAccount = () => {
  // Prefer the service account JSON from an env var (recommended for hosting,
  // e.g. Railway variable FIREBASE_SERVICE_ACCOUNT); fall back to the local key
  // file for development.
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  return JSON.parse(fs.readFileSync(new URL("./serviceAccountKey.json", import.meta.url)));
};

// Lazily initialize Firebase Admin only when it is actually needed (Google /
// phone login). This lets the server boot on hosts without Firebase credentials
// configured, since those login flows are optional and unused by the dashboards.
export const getFirebaseAdmin = () => {
  if (!initialized) {
    admin.initializeApp({
      credential: admin.credential.cert(loadServiceAccount()),
    });
    initialized = true;
  }
  return admin;
};

export default admin;
