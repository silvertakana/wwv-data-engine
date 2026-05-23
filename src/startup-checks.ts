export async function checkJwksReachable(jwksUrl: string): Promise<void> {
  const r = await fetch(jwksUrl);
  if (!r.ok) throw new Error(`JWKS endpoint returned ${r.status}`);
}
