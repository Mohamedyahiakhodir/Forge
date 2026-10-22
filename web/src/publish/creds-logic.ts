// Pure parsing/validation for the "files and fingerprints" step (no DOM, no bridge) so it can be tested in Node.

export type Pasted =
  | { kind: 'google-services'; json: any }
  | { kind: 'client-id'; value: string }
  | { kind: 'sha1'; value: string }
  | { kind: 'sha256'; value: string }
  | { kind: 'unknown' };

const CLIENT_ID = /^\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com$/i;

/** Hex string of N bytes (any separators) -> "AA:BB:..." or null. */
export function normalizeFingerprint(text: string, bytes: number): string | null {
  const hex = text.replace(/^(sha-?1|sha-?256)\s*[:=]?\s*/i, '').replace(/[\s:]/g, '');
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== bytes * 2) return null;
  return hex.toUpperCase().match(/../g)!.join(':');
}

export function isClientId(s: string): boolean { return CLIENT_ID.test(s.trim()); }

export function classify(raw: string): Pasted {
  const text = raw.trim();
  if (!text) return { kind: 'unknown' };
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text);
      if (json && typeof json === 'object' && json.project_info && Array.isArray(json.client)) return { kind: 'google-services', json };
    } catch { /* not JSON */ }
    return { kind: 'unknown' };
  }
  if (isClientId(text)) return { kind: 'client-id', value: text };
  const s1 = normalizeFingerprint(text, 20);
  if (s1) return { kind: 'sha1', value: s1 };
  const s256 = normalizeFingerprint(text, 32);
  if (s256) return { kind: 'sha256', value: s256 };
  return { kind: 'unknown' };
}

export interface GsInspection {
  projectId: string;
  packages: string[];
  matchesPackage: boolean;
  webClientId: string;
  registeredSha1: string[]; // "AA:BB:..." for the matching Android client
}

export function inspectGoogleServices(json: any, packageId: string): GsInspection {
  const clients: any[] = Array.isArray(json?.client) ? json.client : [];
  const packages = clients.map((c) => String(c?.client_info?.android_client_info?.package_name ?? '')).filter(Boolean);
  const mine = clients.find((c) => c?.client_info?.android_client_info?.package_name === packageId);
  const oauth: any[] = (mine ?? clients[0])?.oauth_client ?? [];
  const web = oauth.find((o) => o?.client_type === 3)?.client_id ?? '';
  const registered = oauth
    .filter((o) => o?.client_type === 1 && o?.android_info?.package_name === packageId && o?.android_info?.certificate_hash)
    .map((o) => normalizeFingerprint(String(o.android_info.certificate_hash), 20))
    .filter((x): x is string => !!x);
  return {
    projectId: String(json?.project_info?.project_id ?? ''),
    packages,
    matchesPackage: !!mine,
    webClientId: String(web),
    registeredSha1: registered,
  };
}
