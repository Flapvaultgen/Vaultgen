/**
 * Token metadata upload for Flap launches.
 *
 * Per https://docs.flap.sh/flap/developers/token-launcher-developers/launch-token-through-portal:
 * token metadata lives on IPFS and MUST be pinned through Flap's upload API
 * (https://funcs.flap.sh/api/upload) — their indexer/terminals fetch through
 * their own gateway, so third-party pinning won't show up on flap.sh.
 *
 * The API is a GraphQL multipart upload:
 *   mutation Create($file: Upload!, $meta: MetadataInput!) { create(file: $file, meta: $meta) }
 * and returns the IPFS CID that goes into the `meta` field of
 * newTokenV6WithVault. The resulting pinned JSON looks like:
 *   { buy, sell, creator, description, image: <image CID>, telegram, twitter, website }
 */

export const FLAP_UPLOAD_API_DEFAULT = "https://funcs.flap.sh/api/upload";

const CREATE_MUTATION = `
mutation Create($file: Upload!, $meta: MetadataInput!) {
  create(file: $file, meta: $meta)
}
`;

export type TokenMetaInput = {
  /** Token image — required by the upload API (it is the GraphQL Upload). */
  imageFile: File;
  description: string;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  /** Launcher wallet address (goes into the pinned JSON's creator field). */
  creator: string;
};

export function flapUploadApiUrl(): string {
  const fromEnv = (import.meta.env.VITE_FLAP_UPLOAD_API ?? "").trim();
  return fromEnv || FLAP_UPLOAD_API_DEFAULT;
}

/** Uploads image + metadata JSON to Flap's IPFS pinning API; returns the meta CID. */
export async function uploadTokenMeta(input: TokenMetaInput): Promise<string> {
  const form = new FormData();
  form.append(
    "operations",
    JSON.stringify({
      query: CREATE_MUTATION,
      variables: {
        file: null,
        meta: {
          website: input.website?.trim() || null,
          twitter: input.twitter?.trim() || null,
          telegram: input.telegram?.trim() || null,
          description: input.description.trim(),
          creator: input.creator,
        },
      },
    })
  );
  form.append("map", JSON.stringify({ "0": ["variables.file"] }));
  form.append("0", input.imageFile, input.imageFile.name || "image.png");

  let res: Response;
  try {
    res = await fetch(flapUploadApiUrl(), { method: "POST", body: form });
  } catch {
    throw new Error(
      "Could not reach Flap's metadata upload API (funcs.flap.sh) — check your connection, or launch without metadata."
    );
  }
  if (!res.ok) {
    throw new Error(`Flap metadata upload failed (${res.status} ${res.statusText}).`);
  }
  const body = (await res.json().catch(() => null)) as
    | { data?: { create?: unknown }; errors?: Array<{ message?: string }> }
    | null;
  const cid = body?.data?.create;
  if (typeof cid !== "string" || cid.length === 0) {
    const reason = body?.errors?.[0]?.message;
    throw new Error(`Flap metadata upload did not return a CID${reason ? `: ${reason}` : "."}`);
  }
  return cid;
}

/** Basic sanity check for an IPFS CID (v0 Qm… or v1 base32 baf…). */
export function looksLikeCid(value: string): boolean {
  return /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(value) || /^baf[a-z2-7]{20,}$/.test(value);
}
