/**
 * Auth manager — picks the right credential source based on mode.
 * @see .omo/plans/zcode-proxy.md Task 4
 */
import type { AuthMode, Credential } from "./types.js";
import { createApiKeyCredential } from "./apikey.js";
import type { ProviderId } from "../provider/types.js";
import { createMutex } from "../utils/fs.js";

/** Options for constructing an `AuthManager`. */
export interface AuthManagerOptions {
  mode: AuthMode;
  provider: ProviderId;
  /** Raw credential string for apikey mode (`{apiKey}` or `{apiKey}.{secret}`). */
  apiKey?: string;
  /**
   * Optional: returns all stored credentials (for multi-account credential
   * switching on repeated upstream failures). When omitted, credential
   * switching is effectively disabled (switchToNextCredential always returns null).
   */
  listAllCredentials?: () => Promise<Credential[]>;
}

/**
 * Resolves the upstream credential to inject into proxied requests.
 *
 * In `apikey` mode: returns a static credential parsed from the config string.
 * In `oauth` mode: throws "not implemented" until T9/T10 land.
 */
export class AuthManager {
  private mode: AuthMode;
  private provider: ProviderId;
  private cachedApiKeyCred: Credential | null = null;
  private oauthCred: Credential | null = null;
  private listAllCredentials?: () => Promise<Credential[]>;
  // vceshi0.0.8+: serializes credential mutations (setOAuthCredential /
  // switchToNextCredential) so concurrent callers can't race on `oauthCred`.
  // Without this, two concurrent switchToNextCredential calls would both
  // read the same snapshot, both pick the same candidate, and both write
  // `oauthCred = next` — wasting the switch.
  private credMutex = createMutex();
  // In-flight switch promise — concurrent callers awaiting switchToNextCredential
  // share the same promise so the underlying listAllCredentials + reassign
  // only runs once per concurrent burst.
  private inflightSwitch: Promise<Credential | null> | null = null;

  constructor(opts: AuthManagerOptions) {
    this.mode = opts.mode;
    this.provider = opts.provider;
    this.listAllCredentials = opts.listAllCredentials;
    if (opts.mode === "apikey" && opts.apiKey) {
      this.cachedApiKeyCred = createApiKeyCredential(this.provider, opts.apiKey);
    }
  }

  /** Returns the current credential, refreshing if necessary. */
  async getCredential(): Promise<Credential> {
    if (this.mode === "apikey") {
      if (this.cachedApiKeyCred) return this.cachedApiKeyCred;
      throw new Error("apikey mode configured but no credential was set");
    }

    // oauth mode
    if (this.oauthCred) {
      if (this.oauthCred.expiresAt && Date.now() >= this.oauthCred.expiresAt) {
        this.oauthCred = null;
        throw new Error("OAuth credential expired; re-authentication required (T9/T10 not yet implemented)");
      }
      return this.oauthCred;
    }
    throw new Error("OAuth credential not available — run login flow first (T9/T10 not yet implemented)");
  }

  /** Set the OAuth credential (used by T9/T10 OAuth flow). */
  setOAuthCredential(cred: Credential): void {
    // Synchronous setter — no I/O, no race. Wrap in credMutex is unnecessary
    // because JS is single-threaded and this method is sync; the only race
    // concern is with async switchToNextCredential, which itself acquires
    // credMutex before mutating `oauthCred`. A sync setter between two awaits
    // of credMutex.run(...) is safe — the assignment happens atomically.
    this.oauthCred = cred;
  }

  /**
   * Clear the in-memory OAuth credential (vceshi0.0.7+).
   *
   * Called by the dashboard's "Clear all credentials" handler so that running
   * requests stop using the just-deleted credential. Without this, the proxy
   * would keep serving from the stale in-memory credential until restart —
   * defeating the purpose of the clear action.
   */
  clearOAuthCredential(): void {
    this.oauthCred = null;
  }

  /**
   * Switch to a different stored credential, skipping the current credential
   * and any credentials in `excludeApiKeys` (credentials already tried and
   * failed in the same request). Returns the new credential, or null if no
   * alternative is available.
   *
   * Side effect: updates the in-memory active credential so subsequent
   * getCredential() calls return the new one. Does NOT persist the change to
   * the on-disk store — the caller is responsible for that (via switchAccount)
   * if it wants the dashboard to reflect the switch.
   */
  async switchToNextCredential(excludeApiKeys?: Set<string>): Promise<Credential | null> {
    if (!this.listAllCredentials) return null;
    // vceshi0.0.8+: in-flight deduplication. Two concurrent retry loops
    // hitting switchToNextCredential at nearly the same time would both call
    // listAllCredentials(), both see the same snapshot, both pick the same
    // candidate, and both assign `oauthCred = next` — the second assignment
    // is wasted, and worse, the `excludeApiKeys` set passed by caller A is
    // not visible to caller B so B may pick a credential A already tried.
    //
    // Dedup by sharing a single in-flight promise: the first caller runs the
    // real switch, subsequent concurrent callers await the same promise.
    // After the promise settles, the dedup slot is cleared so the NEXT
    // sequential switch attempt (after another retry failure) gets a fresh
    // pass with the updated `oauthCred` excluded.
    if (this.inflightSwitch) return this.inflightSwitch;
    this.inflightSwitch = (async () => {
      try {
        return await this.credMutex.run(() => this._doSwitch(excludeApiKeys));
      } finally {
        this.inflightSwitch = null;
      }
    })();
    return this.inflightSwitch;
  }

  private async _doSwitch(excludeApiKeys?: Set<string>): Promise<Credential | null> {
    let all: Credential[];
    try {
      all = await this.listAllCredentials!();
    } catch {
      return null;
    }
    if (all.length <= 1) return null;

    const current = this.cachedApiKeyCred ?? this.oauthCred;
    const currentKey = current?.apiKey;

    // Build the exclusion set: current credential + any explicitly excluded keys.
    // This prevents cycling back to a credential that already failed in this request.
    const excluded = new Set<string>(excludeApiKeys);
    if (currentKey) excluded.add(currentKey);

    const candidates = all.filter(c => !excluded.has(c.apiKey) && !c.disabled);
    if (candidates.length === 0) return null;

    // Pick the first candidate. A round-robin based on a stored index could be
    // added later, but for now first-available is deterministic and simple.
    const next = candidates[0];

    if (this.mode === "oauth") {
      this.oauthCred = next;
    } else {
      this.cachedApiKeyCred = next;
    }
    return next;
  }

  /** Current auth mode. */
  getMode(): AuthMode {
    return this.mode;
  }
}
