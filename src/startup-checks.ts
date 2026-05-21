export async function checkJwksReachable(jwksUrl: string): Promise<void> {
  await fetch(jwksUrl);
}
