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

/** No answer at all: DNS, refused, TLS, timeout. Treated as platform (exit 3). */
export class PortalConnectionError extends Error {
  readonly exitCode = 3;
  constructor(message: string) {
    super(message);
    this.name = "PortalConnectionError";
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
    if (e.name === "TimeoutError" || e.name === "AbortError") return "timed out";
    const cause = e.cause as (Error & { errors?: Error[]; code?: string }) | undefined;
    return cause?.message || cause?.errors?.[0]?.message || cause?.code || e.message;
  }

  /** A 2xx body can still carry a DQL-style error envelope — check before trusting data. */
  private static assertNoErrorBody(status: number, data: unknown): void {
    const desc = (data as { error?: { description?: unknown } } | undefined)?.error?.description;
    if (typeof desc === "string" && desc) throw new PortalApiError(status, desc);
  }

  private async request(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      form?: FormData;
      query?: Record<string, string | number | undefined>;
      txnId?: number;
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

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new PortalConnectionError(
        this.redact(`Cannot reach ${this.baseUrl} — ${PortalClient.failureReason(err)}`),
      );
    }

    // The body read can ALSO fail (mid-body timeout, connection reset while
    // streaming) — same mapping, it's still a connection problem.
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
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
        text.trim() ??
        "";
      throw new PortalApiError(
        res.status,
        this.redact(`HTTP ${res.status} from Ditto Server${message ? `: ${message}` : ""}`),
      );
    }
    return { status: res.status, data, text };
  }

  // ---- DQL ---------------------------------------------------------------

  /** POST /api/{v4,v5}/store/execute — the primary DQL endpoint. */
  async execute(
    statement: string,
    args?: Record<string, unknown>,
    opts: { version?: ApiVersion; txnId?: number } = {},
  ): Promise<ExecuteResponse> {
    const { data } = await this.request("POST", `/api/${opts.version ?? "v5"}/store/execute`, {
      body: { statement, ...(args ? { args } : {}) },
      txnId: opts.txnId,
    });
    return (data ?? {}) as ExecuteResponse;
  }

  /** POST /api/v5/sync/remote_execute — run a DQL statement on connected peers (needs SYNC CONTEXT). */
  async remoteExecute(
    statement: string,
    args?: Record<string, unknown>,
  ): Promise<RemoteExecuteResponse> {
    const { data } = await this.request("POST", "/api/v5/sync/remote_execute", {
      body: { statement, ...(args ? { args } : {}) },
    });
    return (data ?? {}) as RemoteExecuteResponse;
  }

  // ---- Attachments (v4) ----------------------------------------------------

  /** POST /api/v4/attachments/upload — multipart; returns {id, len}. */
  async uploadAttachment(form: FormData): Promise<{ id?: string; len?: number }> {
    const { status, data } = await this.request("POST", "/api/v4/attachments/upload", { form });
    PortalClient.assertNoErrorBody(status, data);
    return (data ?? {}) as { id?: string; len?: number };
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

  /** GET /api/v4/auth/roles — both known wire shapes returned raw; `cursor` continues a paged listing. */
  async listRoles(opts: { cursor?: string } = {}): Promise<unknown> {
    const { status, data } = await this.request("GET", "/api/v4/auth/roles", {
      query: { cursor: opts.cursor },
    });
    PortalClient.assertNoErrorBody(status, data);
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
    return (data ?? {}) as { users?: PortalUser[]; hasMore?: boolean; cursor?: string };
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

  /** GET /api/v4/auth/webhook/secret?provider= — returns [] when none exist. */
  async listWebhookSecrets(provider: string): Promise<WebhookSecret[]> {
    const { status, data } = await this.request("GET", "/api/v4/auth/webhook/secret", {
      query: { provider },
    });
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
