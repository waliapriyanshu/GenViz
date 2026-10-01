import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import "server-only";
import { isProduction } from "@/lib/config";
import { ConfigError } from "@/lib/errors";

const DEV_FALLBACK_SECRET =
  "genviz-local-development-secret-do-not-use-in-production";
let warned = false;

function secretFromEnv(name: string): string {
  const value = process.env[name];
  if (value && value.length >= 16) return value;
  if (isProduction()) {
    throw new ConfigError(
      `${name} must be set (at least 16 characters) in production.`,
    );
  }
  if (!warned) {
    console.warn(
      `[genviz] ${name} is not set; using an insecure development secret.`,
    );
    warned = true;
  }
  return DEV_FALLBACK_SECRET;
}

function encryptionKey(): Buffer {
  return createHash("sha256")
    .update(secretFromEnv("GENVIZ_ENCRYPTION_KEY"))
    .digest();
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext)
    throw new Error("Unsupported secret format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function sign(value: string): string {
  return createHmac("sha256", secretFromEnv("GENVIZ_SESSION_SECRET"))
    .update(value)
    .digest("base64url")
    .slice(0, 32);
}

export function verifySignature(value: string, signature: string): boolean {
  const expected = Buffer.from(sign(value));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** One-way hash for values we key on but should not store raw (e.g. IP addresses). */
export function hashIdentifier(value: string): string {
  return createHmac("sha256", secretFromEnv("GENVIZ_SESSION_SECRET"))
    .update(value)
    .digest("base64url")
    .slice(0, 24);
}

export function randomId(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}
