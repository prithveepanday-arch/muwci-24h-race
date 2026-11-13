"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { pinMatches, validateSnapshot } = require("./race-core");

initializeApp();

const adminPin = defineSecret("RACE_ADMIN_PIN");

exports.raceAdmin = onCall({
  region: "us-central1",
  secrets: [adminPin],
  memory: "256MiB",
  timeoutSeconds: 30,
  maxInstances: 10,
  invoker: "public",
  cors: [
    "https://muwci-24h-race.web.app",
    "https://muwci-24h-race.firebaseapp.com",
    /http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/,
  ],
}, async (request) => {
  const data = request.data || {};
  if (!pinMatches(data.pin, adminPin.value())) {
    throw new HttpsError("permission-denied", "Incorrect admin password.");
  }

  if (data.action === "verify") return { verified: true };
  if (data.action !== "save") throw new HttpsError("invalid-argument", "Unknown admin action.");
  if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 0) {
    throw new HttpsError("invalid-argument", "Invalid race revision.");
  }

  try {
    validateSnapshot(data.snapshot);
  } catch (error) {
    throw new HttpsError("invalid-argument", error.message);
  }

  const db = getFirestore();
  const raceRef = db.doc("raceSnapshots/main");
  const saveResult = await db.runTransaction(async (transaction) => {
    const current = await transaction.get(raceRef);
    const currentRevision = current.exists ? (current.data().revision || 0) : 0;
    if (currentRevision !== data.expectedRevision) {
      return { saved: false, conflict: true, revision: currentRevision };
    }
    const revision = currentRevision + 1;
    transaction.set(raceRef, {
      schemaVersion: 1,
      race: data.snapshot.race,
      teamsJson: JSON.stringify(data.snapshot.teams),
      announcementsJson: JSON.stringify(data.snapshot.announcements),
      revision,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: "server-pin",
    });
    return { saved: true, conflict: false, revision };
  });

  return saveResult;
});
