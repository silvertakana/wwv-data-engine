// ADR-001B: tickets are Ed25519 JWTs issued by the Marketplace. The issuer is
// fixed regardless of where the Marketplace runs (it is hardcoded at signing).
const ISSUER = 'https://marketplace.worldwideview.dev';

export interface EngineTokenClaims {
  sub: string;
  exp: number;
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
  ): Promise<{ payload: { sub?: unknown; exp?: unknown } }>;
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

export async function verifyEngineToken(token: string): Promise<EngineTokenClaims> {
  const { jwtVerify } = await loadJose();
  const resolver = await getKeyResolver();
  try {
    const { payload } = await jwtVerify(token, resolver, {
      issuer: ISSUER,
      audience: acceptedAudiences(),
      algorithms: ['EdDSA'],
      clockTolerance: 30,
    });
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') {
      throw new Error('Token missing required claims (sub, exp)');
    }
    return payload as EngineTokenClaims;
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
