/**
 * Encrypted file-based credential store with multi-account support.
 *
 * File format (v2):
 *   { version: 2, activeId: string | null, accounts: StoredAccount[] }
 *
 * Backward compat: if the on-disk file is the original v1 format ({ encrypted: ... }),
 * it is migrated on first load (decrypted, wrapped in a single account, marked active).
 *
 * @see .omo/plans/zcode-proxy.md Task 14
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import type { Credential } from "./types.js";

const STORE_DIR = join(homedir(), ".zcode-proxy");
const STORE_FILE = join(STORE_DIR, "credentials.json");
const ENV_SECRET = "ZCODE_PROXY_CREDENTIAL_SECRET";

/** One stored account record (without encryption — encryption wraps the whole file). */
export interface StoredAccount {
  /** Stable unique id (16 hex chars). */
  id: string;
  /** Human-readable label, e.g. "Z.AI · 2024-06-22 14:30". */
  label: string;
  /** Creation timestamp (ms). */
  createdAt: number;
  /** The credential payload. */
  credential: Credential;
}

interface StoreV2 {
  version: 2;
  activeId: string | null;
  accounts: StoredAccount[];
}

// ---------------------------------------------------------------------------
// Encryption (AES-256-GCM via Node.js crypto — compatible with all platforms)
// ---------------------------------------------------------------------------

/**
 * Derive a 256-bit encryption key from a machine-specific seed using SHA-256.
 * Same key derivation as before, but uses Node's crypto instead of WebCrypto
 * to avoid OperationError on Windows compiled binaries.
 */
function getEncryptionKeyBuffer(): Buffer {
  const seed = process.env[ENV_SECRET] ?? `${homedir()}-${process.platform}-${process.arch}`;
  return createHash("sha256").update(seed).digest();
}

/**
 * Encrypt plaintext using AES-256-GCM (Node.js crypto).
 * Output format: base64( IV[16] + AUTH_TAG[16] + CIPHERTEXT )
 */
async function encrypt(plaintext: string): Promise<string> {
  const key = getEncryptionKeyBuffer();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt ciphertext. Tries the new Node.js crypto format first,
 * then falls back to the legacy WebCrypto format (IV[12] + encrypted+tag)
 * for stores created by older versions.
 */
async function decrypt(ciphertext: string): Promise<string> {
  const key = getEncryptionKeyBuffer();
  const data = Buffer.from(ciphertext, "base64");

  // --- Try new format: IV[16] + AUTH_TAG[16] + CIPHERTEXT ---
  if (data.length >= 32) {
    try {
      const iv = data.subarray(0, 16);
      const tag = data.subarray(16, 32);
      const encrypted = data.subarray(32);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return decipher.update(encrypted, undefined, "utf8") + decipher.final("utf8");
    } catch {
      // Not new format, try legacy below
    }
  }

  // --- Fallback: legacy WebCrypto format: IV[12] + (encrypted + tag appended) ---
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(key),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const iv = new Uint8Array(data.subarray(0, 12));
    const encrypted = new Uint8Array(data.subarray(12));
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      encrypted,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    // Legacy format also failed
  }

  throw new Error("Failed to decrypt credential store (tried both current and legacy formats)");
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

function genId(): string {
  return randomBytes(8).toString("hex");
}

function defaultLabel(cred: Credential, createdAt: number): string {
  const ts = new Date(createdAt).toISOString().slice(0, 16).replace("T", " ");
  return `${cred.provider} · ${ts}`;
}

/** Read raw store (migrates v1 if needed). Returns null if file doesn't exist. */
async function readStore(): Promise<StoreV2 | null> {
  if (!existsSync(STORE_FILE)) return null;
  const raw = readFileSync(STORE_FILE, "utf-8");
  const parsed = JSON.parse(raw);

  // Both v1 and v2 wrap the actual data in an `encrypted` blob.
  // Distinguish by the presence of `version: 2` at the top level.
  if (parsed && typeof parsed.encrypted === "string") {
    const json = await decrypt(parsed.encrypted);

    if (parsed.version === 2) {
      // v2: encrypted blob is the StoreV2 JSON
      return JSON.parse(json) as StoreV2;
    }

    // v1: encrypted blob is a single Credential — migrate to a single-account store
    const cred = JSON.parse(json) as Credential;
    const account: StoredAccount = {
      id: genId(),
      label: defaultLabel(cred, Date.now()),
      createdAt: Date.now(),
      credential: cred,
    };
    return { version: 2, activeId: account.id, accounts: [account] };
  }

  // Plaintext v2 (used in tests / debugging) — direct parse
  if (parsed && parsed.version === 2 && Array.isArray(parsed.accounts)) {
    return parsed as StoreV2;
  }

  return null;
}

async function writeStore(store: StoreV2): Promise<void> {
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  const json = JSON.stringify(store);
  const encrypted = await encrypt(json);
  writeFileSync(STORE_FILE, JSON.stringify({ version: 2, encrypted }), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Public API — backward-compatible single-credential functions
// ---------------------------------------------------------------------------

/**
 * Save a credential. If an account with the same `provider + apiKey` exists,
 * it's updated in place (preserving activeId); otherwise a new account is
 * created and marked active.
 */
export async function saveCredential(cred: Credential): Promise<void> {
  let store = await readStore();
  if (!store) store = { version: 2, activeId: null, accounts: [] };

  const existingIdx = store.accounts.findIndex(
    a => a.credential.provider === cred.provider && a.credential.apiKey === cred.apiKey,
  );

  if (existingIdx >= 0) {
    // Update existing — preserve id, createdAt; refresh label if it looks auto-generated
    const old = store.accounts[existingIdx];
    store.accounts[existingIdx] = {
      ...old,
      credential: cred,
      label: old.label.startsWith(`${cred.provider} · `) ? defaultLabel(cred, old.createdAt) : old.label,
    };
  } else {
    const account: StoredAccount = {
      id: genId(),
      label: defaultLabel(cred, Date.now()),
      createdAt: Date.now(),
      credential: cred,
    };
    store.accounts.push(account);
    store.activeId = account.id; // newly added becomes active
  }

  await writeStore(store);
}

/** Load the currently active credential. Returns null if none. */
export async function loadCredential(): Promise<Credential | null> {
  const store = await readStore();
  if (!store || !store.activeId) return null;
  const account = store.accounts.find(a => a.id === store.activeId);
  return account?.credential ?? null;
}

/** Clear ALL stored credentials (preserves old behavior — used by "Clear Credentials" button). */
export function clearCredential(): void {
  if (existsSync(STORE_FILE)) {
    unlinkSync(STORE_FILE);
  }
}

export function getStorePath(): string {
  return STORE_FILE;
}

// ---------------------------------------------------------------------------
// Public API — multi-account management
// ---------------------------------------------------------------------------

/** Mask a credential's API key for display: "abc12345...wxyz". */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "";
  if (apiKey.length <= 12) return apiKey;
  return apiKey.slice(0, 8) + "..." + apiKey.slice(-4);
}

/** List all stored accounts (without exposing secret material — apiKey is masked). */
export async function listAccounts(): Promise<{
  accounts: Array<Omit<StoredAccount, "credential"> & {
    provider: string;
    apiKeyMask: string;
    hasSecret: boolean;
    userId?: string;
    expiresAt?: number;
    hasJwt: boolean;
    plan: string;
  }>;
  activeId: string | null;
}> {
  const store = await readStore();
  if (!store) return { accounts: [], activeId: null };
  return {
    activeId: store.activeId,
    accounts: store.accounts.map(a => ({
      id: a.id,
      label: a.label,
      createdAt: a.createdAt,
      provider: a.credential.provider,
      apiKeyMask: maskApiKey(a.credential.apiKey),
      hasSecret: !!a.credential.secret,
      userId: a.credential.userId,
      expiresAt: a.credential.expiresAt,
      hasJwt: !!a.credential.jwt,
      plan: a.credential.plan || "coding-plan",
    })),
  };
}

/** Switch the active credential by account id. */
export async function switchAccount(id: string): Promise<boolean> {
  const store = await readStore();
  if (!store) return false;
  const found = store.accounts.find(a => a.id === id);
  if (!found) return false;
  store.activeId = id;
  await writeStore(store);
  return true;
}

/** Remove an account by id. If the active account is removed, falls back to the first remaining. */
export async function removeAccount(id: string): Promise<boolean> {
  const store = await readStore();
  if (!store) return false;
  const idx = store.accounts.findIndex(a => a.id === id);
  if (idx < 0) return false;
  store.accounts.splice(idx, 1);
  if (store.activeId === id) {
    store.activeId = store.accounts[0]?.id ?? null;
  }
  await writeStore(store);
  return true;
}

/** Update an account's human-readable label. */
export async function setAccountLabel(id: string, label: string): Promise<boolean> {
  const store = await readStore();
  if (!store) return false;
  const account = store.accounts.find(a => a.id === id);
  if (!account) return false;
  account.label = label.trim() || account.label;
  await writeStore(store);
  return true;
}

/** Update an account's plan. */
export async function setAccountPlan(id: string, plan: "coding-plan" | "start-plan"): Promise<boolean> {
  const store = await readStore();
  if (!store) return false;
  const account = store.accounts.find(a => a.id === id);
  if (!account) return false;
  account.credential.plan = plan;
  await writeStore(store);
  return true;
}

/** Export all accounts (excluding encryption — returns plain JSON for backup). */
export async function exportAccounts(): Promise<Array<Omit<StoredAccount, "credential"> & { credential: Credential }>> {
  const store = await readStore();
  if (!store) return [];
  return store.accounts;
}

/** Import accounts from a previously exported backup. Merges by id — existing accounts are updated, new ones are appended. */
export async function importAccounts(
  incoming: Array<Omit<StoredAccount, "credential"> & { credential: Credential }>,
): Promise<{ added: number; updated: number }> {
  let store = await readStore();
  if (!store) store = { version: 2, activeId: null, accounts: [] };

  let added = 0;
  let updated = 0;
  for (const acc of incoming) {
    const idx = store.accounts.findIndex(a => a.id === acc.id);
    if (idx >= 0) {
      store.accounts[idx] = acc;
      updated++;
    } else {
      store.accounts.push(acc);
      added++;
      if (!store.activeId) store.activeId = acc.id;
    }
  }
  await writeStore(store);
  return { added, updated };
}
