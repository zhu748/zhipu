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
import { randomBytes } from "node:crypto";
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
// Encryption (AES-GCM with machine-derived key, identical to v1)
// ---------------------------------------------------------------------------

function getEncryptionKey() {
  const hash = new Uint8Array(new ArrayBuffer(32));
  const encoder = new TextEncoder();

  const seed = process.env[ENV_SECRET] ?? `${homedir()}-${process.platform}-${process.arch}`;
  const seedBytes = encoder.encode(seed);
  for (let i = 0; i < seedBytes.length; i++) {
    hash[i % 32] ^= seedBytes[i];
  }
  return hash;
}

async function encrypt(plaintext: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    getEncryptionKey(),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return Buffer.from(combined).toString("base64");
}

async function decrypt(ciphertext: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    getEncryptionKey(),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  const combined = Buffer.from(ciphertext, "base64");
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );

  return new TextDecoder().decode(decrypted);
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
