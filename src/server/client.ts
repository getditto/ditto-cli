import type { ApiVersion } from "./config.js";

/**
 * Minimal client for the Ditto Server (Big Peer) HTTP RPC API — the API the
 * portal's DQL editor talks to. Endpoint inventory from the public docs
 * (docs.ditto.live/cloud/http-api) and the portal's own client
 * (cloud-services/portal/core/src/api/rpcClient.ts).
 *
 * fetch is injectable for tests; nothing here touches the network by default
 * beyond the one request per method call.
 */

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | FormData;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /** Present on real fetch Responses; needed for binary downloads. */
  arrayBuffer?(): Promise<ArrayBuffer>;
}>;

/** The server answered, but the request failed (bad DQL, auth, …). */
export class PortalApiError extends Error {
  readonly status: number;
  readonly exitCode: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PortalApiError";
    this.status = status;
    // 401/403 → auth/config family (3, like token errors). Everything else the
    // server actively rejected → query/API error (1).
    this.exitCode = status === 401 || status === 403 ? 3 : 1;
  }
}

/** No answer at all: DNS, refused, TLS. Treated as platform (exit 3). */
export class PortalConnectionError extends Error {
  readonly exitCode = 3;
  constructor(message: string) {
    super(message);
    this.name = "PortalConnectionError";
  }
}

/**
 * The request's own timeout fired. NOT a connection error (exit 3): the server
 * was reached and a mutation may still commit — the user must not assume
 * failure. Query/API class (exit 1) with an honest message.
 */
export class PortalTimeoutError extends Error {
  readonly exitCode = 1;
  constructor(baseUrl: string, timeoutMs: number) {
    super(
      `No response within ${Math.round(timeoutMs / 1000)}s from ${baseUrl} — ` +
        "the server may still be running the statement (raise with --timeout)",
    );
    this.name = "PortalTimeoutError";
  }
}

export interface PortalClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  /** Per-request timeout (default 30s, matching the portal's token exchange bound). */
  timeoutMs?: number;
}

export interface ExecuteResponse {
  transactionId?: number;
  queryType?: string;
  items?: unknown[];
  mutatedDocumentIds?: unknown[];
  error?: { description?: string };
  warnings?: { description: string; _id?: unknown }[];
  totalWarningsCount?: number;
}

export interface RemoteExecutePeerResult {
  peer?: unknown;
  items?: unknown[];
  elapsedMilliseconds?: unknown;
  error?: { description?: string };
  warnings?: unknown[];
  totalWarningsCount?: unknown;
}

export interface RemoteExecuteResponse {
  result?: RemoteExecutePeerResult[];
  error?: { description?: string };
}

export interface RoleDoc {
  _id: { name: string; version: string };
  roles_version?: string;
  description?: string;
  collection_permissions?: unknown;
  grant_remote_query?: boolean;
}

export interface PortalUser {
  userId: string;
  roles?: string[];
  identityVersion?: string;
}

export interface WebhookSecret {
  secret: string;
  notBefore: string;
  notAfter: string;
  rotated?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class PortalClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: PortalClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Redact the key if it ever leaks into a server/transport message (long keys only — short ones mangle English words). */
  private redact(message: string): string {
    if (this.apiKey.length < 8) return message;
    return message.split(this.apiKey).join("***");
  }

  /** Best-effort reason from a fetch failure: undici puts it in `cause` ("fetch failed" alone is useless); ECONNREFUSED on multi-address hosts yields an AggregateError with an empty message — dig one level. */
  private static failureReason(err: unknown): string {
    const e = err as Error & { cause?: unknown };
    const cause = e.cause as (Error & { errors?: Error[]; code?: string }) | undefined;
    return cause?.message || cause?.errors?.[0]?.message || cause?.code || e.message;
  }

  /** Our AbortSignal is the only abort source — an AbortError/TimeoutError IS the timeout. */
  private static isTimeout(err: unknown): boolean {
    const name = (err as Error).name;
    return name === "TimeoutError" || name === "AbortError";
  }

  /** A 2xx body can still carry a DQL-style error envelope — check before trusting data. */
  private static assertNoErrorBody(status: number, data: unknown): void {
    const desc = (data as { error?: { description?: unknown } } | undefined)?.error?.description;
    if (typeof desc === "string" && desc) throw new PortalApiError(status, desc);
  }

  /**
   * Fail closed on a 2xx whose body isn't the shape the endpoint contract
   * promises (SSO/captive-portal HTML page, proxy error page, shape drift).
   * The portal client does the same via its isDQLHTTPResponse/isGetRolesResponse
   * guards. Only called where the response MUST be a JSON object.
   */
  private static assertResponseShape(
    status: number,
    data: unknown,
    requirement: string,
    ok: (obj: Record<string, unknown>) => boolean,
  ): Record<string, unknown> {
    if (typeof data !== "object" || data === null || !ok(data as Record<string, unknown>)) {
      throw new PortalApiError(
        status,
        `Invalid response from Ditto Server (expected ${requirement}) — ` +
          "if this URL goes through a proxy/SSO, it may have answered instead",
      );
    }
    return data as Record<string, unknown>;
  }

  private async request(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      form?: FormData;
      query?: Record<string, string | number | undefined>;
      txnId?: number;
      /** Per-call timeout override (DQL statements legitimately run long). */
      timeoutMs?: number;
    } = {},
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  ): Promise<{ status: number; data: unknown; text: string }> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (opts.txnId !== undefined) headers["X-DITTO-TXN-ID"] = String(opts.txnId);
    let body: string | FormData | undefined;
    if (opts.form) {
      body = opts.form; // fetch sets the multipart boundary itself
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (PortalClient.isTimeout(err)) throw new PortalTimeoutError(this.baseUrl, timeoutMs);
      throw new PortalConnectionError(
        this.redact(`Cannot reach ${this.baseUrl} — ${PortalClient.failureReason(err)}`),
      );
    }

    // The body read can ALSO fail (mid-body timeout, connection reset while
    // streaming) — same mapping.
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (PortalClient.isTimeout(err)) throw new PortalTimeoutError(this.baseUrl, timeoutMs);
      throw new PortalConnectionError(
        this.redact(`Cannot reach ${this.baseUrl} — ${PortalClient.failureReason(err)}`),
      );
    }
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = undefined;
    }

    if (res.status < 200 || res.status >= 300) {
      const message =
        (data as { message?: string })?.message ??
        (data as { error?: { description?: string } })?.error?.description ??
        text.trim();
      throw new PortalApiError(
        res.status,
        this.redact(`HTTP ${res.status} from Ditto Server${message ? `: ${message}` : ""}`),
      );
    }
    return { status: res.status, data, text };
  }

  // ---- DQL ---------------------------------------------------------------

  /** POST /api/{v4,v5}/store/execute — the primary DQL endpoint. Fails closed on a non-DQL 2xx body. */
  async execute(
    statement: string,
    args?: Record<string, unknown>,
    opts: { version?: ApiVersion; txnId?: number; timeoutMs?: number } = {},
  ): Promise<ExecuteResponse> {
    const { status, data } = await this.request(
      "POST",
      `/api/${opts.version ?? "v5"}/store/execute`,
      {
        body: { statement, ...(args ? { args } : {}) },
        txnId: opts.txnId,
        timeoutMs: opts.timeoutMs,
      },
    );
    // A DQL response always carries at least one of these (portal: isDQLHTTPResponse).
    const obj = PortalClient.assertResponseShape(status, data, "a DQL execute response", (o) =>
      ["queryType", "items", "mutatedDocumentIds", "error", "warnings"].some((k) => k in o),
    );
    if (obj.items !== undefined && !Array.isArray(obj.items)) {
      throw new PortalApiError(
        status,
        "Invalid response from Ditto Server (items is not an array)",
      );
    }
    return obj as ExecuteResponse;
  }

  /** POST /api/v5/sync/remote_execute — run a DQL statement on connected peers (needs SYNC CONTEXT). */
  async remoteExecute(
    statement: string,
    args?: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<RemoteExecuteResponse> {
    const { status, data } = await this.request("POST", "/api/v5/sync/remote_execute", {
      body: { statement, ...(args ? { args } : {}) },
      timeoutMs: opts.timeoutMs,
    });
    const obj = PortalClient.assertResponseShape(
      status,
      data,
      "a remote_execute response (result array or error)",
      (o) => Array.isArray(o.result) || o.error !== undefined,
    );
    return obj as RemoteExecuteResponse;
  }

  // ---- Attachments (v4) ----------------------------------------------------

  /** POST /api/v4/attachments/upload — multipart; returns {id, len}. */
  async uploadAttachment(form: FormData): Promise<{ id?: string; len?: number }> {
    const { status, data } = await this.request("POST", "/api/v4/attachments/upload", { form });
    PortalClient.assertNoErrorBody(status, data);
    const obj = PortalClient.assertResponseShape(
      status,
      data,
      "an attachment upload response ({id, len})",
      (o) => typeof o.id === "string",
    );
    return obj as { id?: string; len?: number };
  }

  /** GET /api/v4/attachments/{id} — raw bytes (arrayBuffer path; never text-decode binary). */
  async getAttachment(id: string): Promise<Buffer> {
    const url = `${this.baseUrl}/api/v4/attachments/${encodeURIComponent(id)}`;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (PortalClient.isTimeout(err)) throw new PortalTimeoutError(this.baseUrl, this.timeoutMs);
      throw new PortalConnectionError(
        this.redact(`Cannot reach ${this.baseUrl} — ${PortalClient.failureReason(err)}`),
      );
    }
    let errText: string;
    let bytes: Buffer | undefined;
    try {
      if (res.status < 200 || res.status >= 300) {
        errText = await res.text();
      } else if (res.arrayBuffer) {
        bytes = Buffer.from(await res.arrayBuffer());
      } else {
        bytes = Buffer.from(await res.text(), "binary"); // test doubles without arrayBuffer
      }
    } catch (err) {
      if (PortalClient.isTimeout(err)) throw new PortalTimeoutError(this.baseUrl, this.timeoutMs);
      throw new PortalConnectionError(
        this.redact(`Cannot reach ${this.baseUrl} — ${PortalClient.failureReason(err)}`),
      );
    }
    if (res.status < 200 || res.status >= 300) {
      const text = errText!;
      let message = text.trim();
      try {
        message = (JSON.parse(text) as { message?: string })?.message ?? message;
      } catch {
        /* plain-text error body */
      }
      throw new PortalApiError(
        res.status,
        this.redact(`HTTP ${res.status} from Ditto Server${message ? `: ${message}` : ""}`),
      );
    }
    return bytes!;
  }

  // ---- RBAC: roles & users (v4, as used by the portal) ---------------------

  /** GET /api/v4/auth/roles — both known wire shapes share the `roles` key; `cursor` continues a paged listing. */
  async listRoles(opts: { cursor?: string } = {}): Promise<unknown> {
    const { status, data } = await this.request("GET", "/api/v4/auth/roles", {
      query: { cursor: opts.cursor },
    });
    PortalClient.assertNoErrorBody(status, data);
    // Portal parity: the reference throws on a roles-less envelope.
    PortalClient.assertResponseShape(status, data, "a roles response ({roles: …})", (o) =>
      Object.hasOwn(o, "roles"),
    );
    return data;
  }

  /** POST /api/v4/auth/roles — create OR REPLACE a role (server assigns the version). */
  async createRole(input: {
    name: string;
    description?: string;
    collectionPermissions?: unknown;
    grantRemoteQuery?: boolean;
  }): Promise<unknown> {
    const { status, data } = await this.request("POST", "/api/v4/auth/roles", {
      body: {
        name: input.name,
        doc: {
          roles_version: "v1-preview",
          description: input.description ?? "",
          // The portal always sends both (and POST replaces the role) — explicit
          // defaults make a bare `roles create` predictably "no permissions".
          collection_permissions: input.collectionPermissions ?? "none",
          grant_remote_query: input.grantRemoteQuery ?? false,
        },
      },
    });
    PortalClient.assertNoErrorBody(status, data);
    return data;
  }

  async deleteRole(name: string): Promise<void> {
    const { status, data } = await this.request(
      "DELETE",
      `/api/v4/auth/roles/${encodeURIComponent(name)}`,
    );
    PortalClient.assertNoErrorBody(status, data);
  }

  /** GET /api/v4/auth/users?userId&cursor&limit */
  async listUsers(
    opts: { userId?: string; cursor?: string; limit?: number } = {},
  ): Promise<{ users?: PortalUser[]; hasMore?: boolean; cursor?: string }> {
    const { status, data } = await this.request("GET", "/api/v4/auth/users", {
      query: { userId: opts.userId, cursor: opts.cursor, limit: opts.limit },
    });
    PortalClient.assertNoErrorBody(status, data);
    // Portal parity: normalizeUsersResponse throws on a malformed envelope.
    const obj = PortalClient.assertResponseShape(
      status,
      data,
      "a users response ({users: [...], hasMore: bool})",
      (o) => Array.isArray(o.users) && typeof o.hasMore === "boolean",
    );
    return obj as { users?: PortalUser[]; hasMore?: boolean; cursor?: string };
  }

  /** PATCH /api/v4/auth/users/{id} — replace the user's whole role set. */
  async setUserRoles(
    userId: string,
    roles: string[],
  ): Promise<{ identityVersion?: string; transactionId?: number }> {
    const { status, data } = await this.request(
      "PATCH",
      `/api/v4/auth/users/${encodeURIComponent(userId)}`,
      { body: { roles } },
    );
    PortalClient.assertNoErrorBody(status, data);
    return (data ?? {}) as { identityVersion?: string; transactionId?: number };
  }

  async deleteUser(userId: string): Promise<void> {
    const { status, data } = await this.request(
      "DELETE",
      `/api/v4/auth/users/${encodeURIComponent(userId)}`,
    );
    PortalClient.assertNoErrorBody(status, data);
  }

  // ---- Auth webhook secrets (v4, as used by the portal) ---------------------

  /** GET /api/v4/auth/webhook/secret?provider= — returns [] when none exist (incl. 404 deployments, matching the portal). */
  async listWebhookSecrets(provider: string): Promise<WebhookSecret[]> {
    let status: number;
    let data: unknown;
    try {
      ({ status, data } = await this.request("GET", "/api/v4/auth/webhook/secret", {
        query: { provider },
      }));
    } catch (err) {
      // The portal maps 404 → "no secrets" (rpcClient getWebhookSecrets).
      if (err instanceof PortalApiError && err.status === 404) return [];
      throw err;
    }
    PortalClient.assertNoErrorBody(status, data);
    // The backend's shape varies: {} when empty, {secret: [...]}, a bare array,
    // or a single secret object (portal client normalizes the same way).
    if (!data || typeof data !== "object") return [];
    if (Array.isArray(data)) return data as WebhookSecret[];
    const obj = data as Record<string, unknown>;
    if (Object.keys(obj).length === 0) return [];
    if (Array.isArray(obj.secret)) return obj.secret as WebhookSecret[];
    if (typeof obj.secret === "string") return [obj as unknown as WebhookSecret];
    return [];
  }

  /** POST /api/v4/auth/webhook/secret — generate a secret valid [now, notAfter]. */
  async createWebhookSecret(provider: string, notAfter: string): Promise<WebhookSecret> {
    const { status, data } = await this.request("POST", "/api/v4/auth/webhook/secret", {
      body: { provider, notBefore: new Date().toISOString(), notAfter },
    });
    PortalClient.assertNoErrorBody(status, data);
    return (data ?? {}) as WebhookSecret;
  }

  /** PATCH /api/v4/auth/webhook/secret — mark `rotate` rotated, issue a new secret. */
  async rotateWebhookSecret(
    provider: string,
    rotate: { secret: string; notBefore: string; notAfter: string },
    notAfter: string,
  ): Promise<WebhookSecret> {
    const { status, data } = await this.request("PATCH", "/api/v4/auth/webhook/secret", {
      body: { provider, rotate, new: { notBefore: new Date().toISOString(), notAfter } },
    });
    PortalClient.assertNoErrorBody(status, data);
    return (data ?? {}) as WebhookSecret;
  }

  /** DELETE /api/v4/auth/webhook/secret — the server wants exactly these four fields. */
  async deleteWebhookSecret(secret: WebhookSecret & { provider: string }): Promise<void> {
    const { status, data } = await this.request("DELETE", "/api/v4/auth/webhook/secret", {
      body: {
        provider: secret.provider,
        secret: secret.secret,
        notBefore: secret.notBefore,
        notAfter: secret.notAfter,
      },
    });
    PortalClient.assertNoErrorBody(status, data);
  }
}
