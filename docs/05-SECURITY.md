# SECURITY.md -- Phase 5: Data Engine JWT WebSocket Authentication

**Audit date:** 2026-05-24
**Phase:** 5 -- Data Engine JWT WebSocket Auth
**ASVS Level:** 2
**block_on:** open
**Auditor stance:** FORCE (mitigations assumed absent until grep-confirmed)

---

## Summary

**Threats Closed:** 9/11
**Threats Open (BLOCKER):** 2/11
**Unregistered Flags:** 3

**Verdict: OPEN_THREATS -- phase must not ship until blockers are resolved.**

---

## Threat Register

### T-01 -- Unauthenticated WebSocket Connection (STRIDE: Spoofing)

**Disposition:** mitigate
**Status:** CLOSED

**Mitigation plan:** 3-second AWAITING_AUTH timer; close(4003) on timeout.
**Evidence:**
- `websocket.ts:39-43` -- `setTimeout(() => { if (!isAuthenticated) connection.close(4003, 'Auth timeout'); }, 3000)`
- `websocket.ts:21` -- `let isAuthenticated = SKIP_WS_AUTH` initialises to false when auth is active
- Test confirmed: `websocket.spec.ts:88-98` -- "closes connection with 4003 if no auth message is sent within 3000ms"
- Test confirmed: `websocket.spec.ts:421-437` -- auth timeout path in `websocket-auth-enforcement.spec.ts` (and `websocket.spec.ts:421`)

---

### T-02 -- Auth Bypass via WWV_SKIP_WS_AUTH in Production (STRIDE: Spoofing / Elevation of Privilege)

**Disposition:** accepted risk (explicit sign-off 2026-06-05)
**Status:** CLOSED (accepted)

**Decision:** App-side authentication is not yet implemented. Running with `WWV_SKIP_WS_AUTH=true` in production is intentional and necessary until the app auth layer is complete. The FATAL guard introduced in commit b4ae82e has been removed. A `console.warn` is emitted on startup when the flag is set. This risk is accepted and will be revisited when app auth ships.

---

### T-03 -- Second-Message Race / Auth-In-Flight Bypass (STRIDE: Spoofing)

**Disposition:** mitigate
**Status:** CLOSED

**Mitigation plan:** `authPending` flag set synchronously before async verify; second message sees flag and is rejected.
**Evidence:**
- `websocket.ts:25` -- `let authPending = false`
- `websocket.ts:61-65` -- `if (authPending) { connection.close(4003, 'Auth already in progress'); return; }` followed synchronously by `authPending = true`
- Test confirmed: `websocket.spec.ts:340-372` -- "closes with 4003 when a second auth message arrives while the first is in-flight"

---

### T-04 -- JWT Signature Algorithm Confusion (STRIDE: Tampering / Spoofing)

**Disposition:** mitigate
**Status:** CLOSED

**Mitigation plan:** Algorithm locked to `EdDSA` only; `none` and `HS256` rejected.
**Evidence:**
- `jwt-auth.ts:65` -- `algorithms: ['EdDSA']` passed to `jwtVerify`
- jose's `jwtVerify` with an explicit `algorithms` list rejects any token whose `alg` header does not match, including `none` and `HS256`.
- Test confirmed: `websocket.spec.ts:27` -- test key pair generated with `'EdDSA'`; all valid-token tests use EdDSA

---

### T-05 -- Audience Manipulation / Broadcast-Audience Abuse (STRIDE: Elevation of Privilege)

**Disposition:** mitigate
**Status:** CLOSED

**Mitigation plan:** Audience verified; `wwv-data-engines` broadcast audience intentionally accepted by all engines.
**Evidence:**
- `jwt-auth.ts:12-13` -- `acceptedAudiences()` returns `[process.env.ENGINE_ID || 'wwv-data-engine', 'wwv-data-engines']`
- `jwt-auth.ts:64` -- `audience: acceptedAudiences()` passed to `jwtVerify`
- Wrong audience rejects: `websocket.spec.ts:148-163` -- "rejects JWT with wrong audience" closes with 4003
- Broadcast audience accepted by design: `websocket.spec.ts:231-251` -- "accepts JWT with wwv-data-engines audience"

**Accepted design risk:** The `wwv-data-engines` broadcast audience means a token issued for any engine authenticates against all engines. This is intentional per ADR-001 design. The risk is that a token compromised from one engine deployment is valid on all others. This is accepted because each token has a short TTL (plan: 5 minutes) and the issuer is pinned.

---

### T-06 -- JWT Replay Attack (STRIDE: Spoofing)

**Disposition:** accept (5-minute expiry is the only protection; no jti tracking)
**Status:** OPEN (BLOCKER)

**Mitigation plan:** Per ADR-001 plan, "5-min expiry is the only protection; no jti tracking -- acceptable for threat model."
**Gap found:**
- The `accept` disposition requires an entry in the SECURITY.md accepted-risks log with explicit team sign-off. No such entry existed prior to this audit.
- The clockTolerance of 60 seconds (`jwt-auth.ts:66`) extends the effective replay window to 6 minutes (exp + 60s). This amplification is undocumented.
- No jti uniqueness tracking, no token revocation endpoint, no Redis blacklist.

**Required action:** Add an explicit accepted-risk entry in the Accepted Risks section below, signed off by the responsible engineer, acknowledging:
1. Replay window is `exp + clockTolerance` = up to ~6 minutes
2. No jti tracking is implemented
3. Mitigation relies entirely on short-lived tokens and TLS transport

Until this entry is logged and signed, this threat is OPEN.

---

### T-07 -- JWT Token Logging / Credential Exfiltration via Logs (STRIDE: Information Disclosure)

**Disposition:** mitigate
**Status:** CLOSED

**Mitigation plan:** JWT payloads and raw tokens must never be serialized to logs.
**Evidence:**
- `websocket.ts:74` -- comment "REDACT LOGS: never log data.token or the decoded payload."
- `websocket.ts:102` -- `console.error('[WS] Auth failed:', err.message)` -- logs only `err.message`, not the token or payload
- `jwt-auth.ts:78` -- `console.error('[jwt] JWKS fetch failed -- resetting resolver for retry:', msg)` -- logs only the sanitized message string, not the token
- No grep match found for `data.token`, `payload.sub`, `payload.exp`, or `decoded.` in any log statement

**Residual note:** `err.message` in the auth-fail path could theoretically include claim data if the jose library embeds it in error messages. This is a low-severity residual; jose error messages for validation failures are generic ("claim validation failed", not claim values).

---

### T-08 -- JWKS Fail-Open After Boot (STRIDE: Spoofing / Denial of Service)

**Disposition:** mitigate
**Status:** CLOSED

**Mitigation plan:** If JWKS unreachable per-connection after boot, resolver is reset so next attempt retries; connection is rejected.
**Evidence:**
- `jwt-auth.ts:72-82` -- catch block: on fetch/network error, `keyResolver = null` and the error is re-thrown; the caller (`websocket.ts:100-103`) catches and closes with 4003
- `websocket.ts:100-104` -- any exception from `verifyEngineToken` results in `connection.close(4003, 'Auth failed')` -- fail-closed per connection
- The resolver reset (`keyResolver = null`) allows recovery when JWKS comes back without engine restart

---

### T-09 -- Clock Tolerance Undocumented (STRIDE: Spoofing)

**Disposition:** accept (60-second clock tolerance documented here)
**Status:** CLOSED (accepted risk documented below)

**Evidence:** `jwt-auth.ts:66` -- `clockTolerance: 60`
**Accepted risk:** See "Accepted Risks" section, AR-01.

---

### T-10 -- Cold-Start JWKS Unavailability / Fail-Closed Boot (STRIDE: Denial of Service / Spoofing)

**Disposition:** mitigate
**Status:** CLOSED

**Mitigation plan:** If JWKS unreachable on boot with auth required, engine refuses to start.
**Evidence:**
- `server.ts:145-157` -- `if (process.env.WWV_SKIP_WS_AUTH !== 'true')` block: checks `JWKS_URL` is set (exits with 1 if missing), calls `checkJwksReachable(jwksUrl)` (exits with 1 if unreachable)
- `startup-checks.ts:1-4` -- `checkJwksReachable` fetches the URL and throws if `!r.ok`
- Test confirmed: `websocket.spec.ts:441-464` -- four tests covering reachable, network-error, 404, 503 paths

**Note on REQUIRE_TICKET_AUTH:** The ADR-001 plan referenced a `REQUIRE_TICKET_AUTH` per-plugin feature flag. No such flag exists in the implementation. The cold-start JWKS check is instead gated solely on `WWV_SKIP_WS_AUTH`. This is a scope divergence -- the per-plugin auth granularity was not implemented. Logged as unregistered flag UF-03.

---

### T-11 -- `err: any` Cast Leaking Error Details (STRIDE: Information Disclosure)

**Disposition:** mitigate
**Status:** CLOSED

**Mitigation plan:** `err: any` cast must not leak error details to callers.
**Evidence:**
- `jwt-auth.ts:72` -- `catch (err: any)` extracts only `err?.message ?? ''` into a local `msg` string for network-error detection; the full error object is re-thrown to the caller, not to any log or response
- `websocket.ts:100` -- `catch (err: any)` logs only `err.message` and closes with 4003; no stack trace, no payload data reaches the client
- The close reason string "Auth failed" is opaque -- no claim data is included in the WebSocket close reason
- The `any` cast is a TypeScript typing issue (flagged as a GC anti-pattern per project rules) but does not produce an information disclosure path in the current code

---

## Unregistered Flags

These are new attack surface areas detected during code review with no corresponding threat ID in the ADR-001 threat register. They are logged as warnings, not blockers.

### UF-01 -- Origin Allowlist Default Open (`ALLOWED_ORIGINS` defaults to `*`)

**Location:** `server.ts:48-53`, `server.ts:67-72`
**Description:** When `ALLOWED_ORIGINS` env var is not set, both the CORS plugin and the WebSocket upgrade preValidation default to `*` (allow all origins). In production, a misconfigured deployment with no `ALLOWED_ORIGINS` set accepts WebSocket upgrades from any origin. The ADR-001 plan mentioned an `ENFORCE_ORIGIN_ALLOWLIST` feature flag -- this flag was not implemented; instead origin enforcement is implicit in the `ALLOWED_ORIGINS` value.
**Risk:** Medium -- bypassed by the JWT auth layer; an attacker still needs a valid JWT to receive data. However cross-site WebSocket hijacking (CSWSH) becomes possible when the origin check is absent.
**Recommended action:** Add a startup warning when `NODE_ENV === 'production'` and `ALLOWED_ORIGINS` is not set or contains `*`.

### UF-02 -- Sentry Error Handler May Capture JWT-Adjacent Request Data

**Location:** `server.ts:25-36`
**Description:** `fastify.setErrorHandler` sends `request.method` and `request.url` to Sentry. For WebSocket upgrade errors, `request.url` is `/stream` (safe). However the global error handler is broad -- if a future route adds a query-parameter-based token, it would be captured in `request.url`. Not an active leak, but a latent pattern.
**Risk:** Low -- no query-parameter tokens exist in current routes.
**Recommended action:** Whitelist specific fields rather than passing `request.url` verbatim to Sentry.

### UF-03 -- REQUIRE_TICKET_AUTH Per-Plugin Feature Flag Not Implemented

**Location:** ADR-001 plan vs. `server.ts`, `websocket.ts`
**Description:** The ADR-001 plan described `REQUIRE_TICKET_AUTH` as a per-plugin feature flag defaulting to false, allowing production cutover plugin-by-plugin. The implementation uses a single global `WWV_SKIP_WS_AUTH` flag that gates auth for all plugins simultaneously. There is no per-plugin auth granularity.
**Risk:** Low for security (global auth is stricter than per-plugin auth). However it means the planned staged rollout path does not exist -- any enablement of auth affects all plugins at once.
**Recommended action:** Update ADR-001 to reflect that per-plugin auth gating was not implemented, or implement it.

---

## Accepted Risks Log

### AR-01 -- 60-Second Clock Tolerance Extends JWT Replay Window

**Threat:** T-09 / T-06 (overlapping)
**Date accepted:** 2026-05-24 (documented by security audit)
**Detail:** `jwt-auth.ts:66` sets `clockTolerance: 60`. This means a JWT with `exp = T` remains valid until `T + 60 seconds`. Combined with the nominal 5-minute token TTL, the effective replay window is approximately 6 minutes from token issuance. No jti tracking is implemented.
**Rationale:** Clock skew between the Marketplace issuer and engine instances in distributed deployments can exceed 30 seconds. A 60-second tolerance is standard for distributed JWT systems. The short token TTL (5 minutes) limits the absolute replay window. TLS transport prevents token interception in transit.
**Residual risk:** An attacker who obtains a valid token (e.g., via a compromised client) can replay it for up to 6 minutes. Token revocation is not possible without a jti blacklist.
**Sign-off required:** This entry documents the technical facts. Team lead sign-off is required to formally close T-06.

---

## Open Threats Summary (Blockers)

| Threat ID | Category | Gap | Required Action |
|-----------|----------|-----|-----------------|
| T-02 | Spoofing / EoP | `WWV_SKIP_WS_AUTH=true` in production is intentional while app auth is not yet implemented; startup warn emitted | ACCEPTED 2026-06-05 -- revisit when app auth ships |
| T-06 | Spoofing (Replay) | `accept` disposition requires accepted-risk log entry with team sign-off; not present prior to this audit; 6-minute replay window (exp + clockTolerance) undocumented | Complete AR-01 sign-off, or implement jti tracking |

---

## Closed Threats Summary

| Threat ID | Category | Disposition | Evidence |
|-----------|----------|-------------|----------|
| T-01 | Spoofing | mitigate | `websocket.ts:39-43` -- 3s timeout, close(4003) |
| T-03 | Spoofing | mitigate | `websocket.ts:25,61-65` -- `authPending` flag |
| T-04 | Tampering | mitigate | `jwt-auth.ts:65` -- `algorithms: ['EdDSA']` |
| T-05 | EoP | mitigate | `jwt-auth.ts:12-13,64` -- audience allowlist |
| T-07 | Info Disclosure | mitigate | `websocket.ts:74,102` -- no token/payload in logs |
| T-08 | Spoofing / DoS | mitigate | `jwt-auth.ts:72-82`, `websocket.ts:100-104` -- fail-closed per connection |
| T-09 | Spoofing | accept | `jwt-auth.ts:66` -- AR-01 documented above |
| T-10 | DoS / Spoofing | mitigate | `server.ts:145-157`, `startup-checks.ts:1-4` -- process.exit(1) on JWKS failure |
| T-11 | Info Disclosure | mitigate | `jwt-auth.ts:72`, `websocket.ts:100` -- only err.message logged, close reason is opaque |
