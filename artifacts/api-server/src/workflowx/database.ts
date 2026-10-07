import mongoose from "mongoose";
import { HttpError } from "./errors";

let connection: Promise<typeof mongoose> | null = null;

export async function ensureMongoConnection(): Promise<void> {
  if (mongoose.connection.readyState === 1) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new HttpError(503, "MongoDB Atlas is not configured for this server.");
  }

  if (!connection) {
    connection = mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: 8000,
        bufferCommands: false,
      })
      .catch(() => {
        connection = null;
        throw new HttpError(
          503,
          "MongoDB Atlas is unavailable. Check the connection string and Atlas network access.",
        );
      });
  }

  await connection;
}
