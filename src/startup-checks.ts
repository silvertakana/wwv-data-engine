export async function checkJwksReachable(jwksUrl: string): Promise<void> {
  const r = await fetch(jwksUrl);
  if (!r.ok) throw new Error(`JWKS endpoint returned ${r.status}`);
}

export interface OriginEnv {
  NODE_ENV?: string;
  ALLOWED_ORIGINS?: string;
}

// UF-01 in docs/05-SECURITY.md: with no allowlist configured the engine accepts
// WebSocket upgrades from any origin. Production should not be silent about
// that, so it is surfaced at boot rather than found in a later review.
export function originAllowlistWarning(env: OriginEnv = process.env): string | null {
  if (env.NODE_ENV !== 'production') return null;
  const configured = (env.ALLOWED_ORIGINS ?? '').trim();
  if (!configured) {
    return '[Server] WARNING: ALLOWED_ORIGINS is not set - the engine accepts WebSocket connections from any origin. Set it to the origins that should connect.';
  }
  const origins = configured.split(',').map((entry) => entry.trim());
  if (origins.includes('*')) {
    return '[Server] WARNING: ALLOWED_ORIGINS contains a wildcard - the engine accepts connections from any origin. List explicit origins instead.';
  }
  return null;
}
