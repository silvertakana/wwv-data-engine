// ADR-001B: tickets are Ed25519 JWTs issued by the Marketplace. The issuer is
// part of the signature, so it must match whatever the minting Marketplace set
// — a self-hosted Marketplace therefore needs its own issuer here, alongside
// the JWKS_URL that already points at it.
export const DEFAULT_ISSUER = 'https://marketplace.worldwideview.dev';

// Read per call, not at module load: the engine boots before some deployments
// finish injecting env, and tests set this after import.
export function ticketIssuer(): string {
  const configured = process.env.JWT_ISSUER?.trim();
  return configured ? configured : DEFAULT_ISSUER;
}

export interface EngineTokenClaims {
  sub: string;
  exp: number;
  /** Plan tier the ticket was minted for. Advisory; access is decided by scope. */
  tier?: string;
  /** Space-separated permission tokens, e.g. 'plugins:read' or 'plugins:read:earthquakes'. */
  scope?: string;
  /** Ticket id, minted by the Marketplace. Not yet tracked for replay defence. */
  jti?: string;
}

// ENGINE_ID tightens the audience to a specific engine; 'wwv-data-engines' is
// the broadcast audience every engine accepts.
function acceptedAudiences(): string[] {
  return [process.env.ENGINE_ID || 'wwv-data-engine', 'wwv-data-engines'];
}

// jose is ESM-only and the engine is CommonJS, so it is imported dynamically (a
// require() of an ESM package is not portable, and a static type import would
// need a resolution-mode attribute). These structural types cover the surface
// used here.
type JwksResolver = unknown;
interface JoseModule {
  createRemoteJWKSet(url: URL): JwksResolver;
  jwtVerify(
    token: string,
    key: JwksResolver,
    options: {
      issuer?: string;
      audience?: string | string[];
      algorithms?: string[];
      clockTolerance?: number;
    },
  ): Promise<{ payload: Record<string, unknown> }>;
}

let josePromise: Promise<JoseModule> | null = null;
function loadJose(): Promise<JoseModule> {
  if (!josePromise) {
    josePromise = import('jose') as unknown as Promise<JoseModule>;
  }
  return josePromise;
}

// Built lazily on first verify so JWKS_URL can be set after import (tests) and
// is never required when WS auth is bypassed. createRemoteJWKSet handles remote
// fetch, caching, kid selection, and re-fetch on unknown kid.
let keyResolver: JwksResolver | null = null;

async function getKeyResolver(): Promise<JwksResolver> {
  if (keyResolver === null) {
    const url = process.env.JWKS_URL;
    if (!url) throw new Error('[jwt] JWKS_URL env var is required');
    const { createRemoteJWKSet } = await loadJose();
    keyResolver = createRemoteJWKSet(new URL(url));
  }
  return keyResolver;
}

// A verified signature proves the token was minted by the Marketplace; it does
// not prove the claims are shaped the way this engine expects. Required claims
// must be present and correctly typed, and optional claims are carried only when
// they are strings — a malformed claim is dropped rather than trusted.
export function extractClaims(payload: Record<string, unknown>): EngineTokenClaims {
  if (typeof payload.sub !== 'string') {
    throw new Error('Token missing required claim: sub');
  }
  if (typeof payload.exp !== 'number') {
    throw new Error('Token missing required claim: exp');
  }
  const claims: EngineTokenClaims = { sub: payload.sub, exp: payload.exp };
  if (typeof payload.tier === 'string') claims.tier = payload.tier;
  if (typeof payload.scope === 'string') claims.scope = payload.scope;
  if (typeof payload.jti === 'string') claims.jti = payload.jti;
  return claims;
}

export async function verifyEngineToken(token: string): Promise<EngineTokenClaims> {
  const { jwtVerify } = await loadJose();
  const resolver = await getKeyResolver();
  try {
    const { payload } = await jwtVerify(token, resolver, {
      issuer: ticketIssuer(),
      audience: acceptedAudiences(),
      algorithms: ['EdDSA'],
      clockTolerance: 30,
    });
    return extractClaims(payload);
  } catch (err: unknown) {
    // Reset the cached resolver on network failures so the next connection
    // attempt re-initialises it — allows recovery when JWKS comes back up
    // without requiring an engine restart.
    const msg = err instanceof Error ? err.message : String(err);
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    if (msg.includes('fetch') || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
      console.error('[jwt] JWKS fetch failed — resetting resolver for retry:', msg);
      keyResolver = null;
    }
    throw err;
  }
}
