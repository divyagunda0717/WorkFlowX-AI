import jwt, { type JwtPayload } from "jsonwebtoken";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { HttpError } from "./errors";

export interface AuthenticatedRequest extends Request {
  userId: string;
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
  if (!secret) {
    throw new HttpError(503, "JWT authentication is not configured.");
  }
  return secret;
}

export function createAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, jwtSecret(), { expiresIn: "7d" });
}

export const requireAuth: RequestHandler = (
  request: Request,
  response: Response,
  next: NextFunction,
) => {
  const header = request.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    response.status(401).json({ error: "Sign in to continue." });
    return;
  }

  let secret: string;
  try {
    secret = jwtSecret();
  } catch (error) {
    next(error);
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as JwtPayload;
    if (!payload.sub) {
      response.status(401).json({ error: "Your session is invalid. Sign in again." });
      return;
    }
    (request as AuthenticatedRequest).userId = payload.sub;
    next();
  } catch {
    response.status(401).json({ error: "Your session has expired. Sign in again." });
  }
};

export function getAuthenticatedUserId(request: Request): string {
  return (request as AuthenticatedRequest).userId;
}
