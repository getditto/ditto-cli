/**
 * Ditto SDK support bundles (SDK 5.2+): `EXECUTE FUNCTION
 * system_request_support_bundle()` builds a .tar on the device (device logs,
 * config snapshot with secrets redacted, runtime telemetry) and returns an
 * attachment token for it; `system:support_bundles` lists the bundles kept.
 * Works offline. The SDK admits 3 requests per 10 minutes per store by
 * default (`support_bundle_request_rate`), so a rejected request falls back
 * to the newest bundle already on the device.
 */

export interface AttachmentToken {
  id: string;
  len: number | bigint;
  metadata: Record<string, string>;
}

/** The slice of a session this module needs (DittoSession, or a test fake). */
export interface BundleSession {
  execute(statement: string): Promise<{ items: { value: unknown }[] }>;
  saveAttachment(token: AttachmentToken, filePath: string): Promise<void>;
}

export interface SavedBundle {
  path: string;
  bytes: number;
  createdAt: string;
  reason: string;
  /** Set when a new bundle couldn't be made and an existing one was saved instead. */
  reusedBecause?: string;
}

interface BundleRow {
  _id?: { created_at?: string; pk?: string };
  reason?: string;
  file?: AttachmentToken;
}

const NEWEST = "SELECT * FROM system:support_bundles ORDER BY _id.created_at DESC LIMIT 1";

/** DQL object literal from plain strings (keys and values limited to safe characters). */
function metadataLiteral(metadata: Record<string, string>): string {
  const safe = (s: string) => s.replace(/[^\w.:@/ -]/g, "").slice(0, 100);
  const pairs = Object.entries(metadata).map(([k, v]) => `'${safe(k)}': '${safe(v)}'`);
  return `{'metadata': {${pairs.join(", ")}}}`;
}

function asRow(value: unknown): BundleRow {
  return (value ?? {}) as BundleRow;
}

/** Strip the SDK's "Query failed: `…`. For more information…" wrapper. */
export function bundleErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const inner = /Query failed: `([\s\S]*?)`\./.exec(msg)?.[1] ?? msg;
  return inner.replace(
    /^Support bundle request failure: (failed to request support bundle: )?/,
    "",
  );
}

/**
 * Request a new support bundle and save it to `filePath`. If the SDK rejects
 * the request (rate limit, one already in progress), save the newest
 * existing bundle instead; if there is none, the error is thrown.
 */
export async function saveSupportBundle(
  session: BundleSession,
  filePath: string,
  metadata: Record<string, string> = {},
): Promise<SavedBundle> {
  let row: BundleRow;
  let reusedBecause: string | undefined;
  try {
    const r = await session.execute(
      `EXECUTE FUNCTION system_request_support_bundle(${metadataLiteral(metadata)})`,
    );
    row = asRow(r.items[0]?.value);
  } catch (err) {
    reusedBecause = bundleErrorMessage(err);
    const existing = await session.execute(NEWEST).catch(() => ({ items: [] }));
    if (existing.items.length === 0) throw new Error(reusedBecause);
    row = asRow(existing.items[0]?.value);
  }
  if (!row.file?.id) throw new Error("the SDK returned no support bundle file");
  await session.saveAttachment(row.file, filePath);
  return {
    path: filePath,
    bytes: Number(row.file.len),
    createdAt: row._id?.created_at ?? "unknown",
    reason: row.reason ?? "unknown",
    ...(reusedBecause ? { reusedBecause } : {}),
  };
}

/** The bundles kept on the device, newest first. */
export async function listSupportBundles(
  session: Pick<BundleSession, "execute">,
): Promise<{ created_at: string; reason: string; bytes: number }[]> {
  const r = await session.execute(
    "SELECT * FROM system:support_bundles ORDER BY _id.created_at DESC",
  );
  return r.items.map((i) => {
    const row = asRow(i.value);
    return {
      created_at: row._id?.created_at ?? "unknown",
      reason: row.reason ?? "unknown",
      bytes: Number(row.file?.len ?? 0),
    };
  });
}
