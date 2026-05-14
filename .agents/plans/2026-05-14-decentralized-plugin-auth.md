# Decentralized Plugin Authentication - Data Engine Phase

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. 

**Goal:** Enforce first-message auth before ANY connection logic runs, and validate origins.
**Repository:** `C:\dev\wwv-data-engine`
**Tech Stack:** Fastify, `@fastify/jwt`, `get-jwks`, `zod`.

## Global Directives
1. **Strict Types:** Import `WebSocketAuthMessage` from `@worldwideview/wwv-plugin-sdk/src/auth-contracts.ts`.
2. **TDD Mandatory:** Write failing tests (`vitest`) before implementing features.

---

## Task 4.1: WebSocket Origin Validation & Auth Gating
**Files:**
- Modify: `src/websocket.ts`
- Create: `src/auth.ts`

- [ ] **Step 1: Write failing tests** for:
  - Validating `Origin`, `Host`, TLS state (`x-forwarded-proto`), and expected tenant/plugin metadata before calling/inside `/stream` websocket route.
  - Sockets closing with code `4003` if no auth message within 3000ms.
  - JWT verification exactly checking `iss`, `aud`, `exp`, `nbf`, `alg` (EdDSA).
  - Rejection of tokens with wrong audience, expired, future nbf, unknown issuer, or unacceptable alg.
  - Ensuring unauthenticated sockets are NOT added to connections, get NO welcome message.
  - Re-authentication attempts on the same socket are forbidden and result in immediate closure.
  - Server logs successfully redact the JWT payload from capture.
  - Sockets forcefully disconnecting when their validated JWT expires (preventing infinite sessions).
- [ ] **Step 2: Implement Connection Validation**: Validate `Origin`, `Host`, TLS state, and expected tenant/plugin metadata inside/before the `/stream` handler.
- [ ] **Step 3: Implement JWT validation** using `get-jwks` and `@fastify/jwt` with a 60s leeway for `nbf`/`exp` to handle clock drift. Ensure log redaction is active for all incoming JWTs.
- [ ] **Step 4: Refactor `src/websocket.ts`**: Move all connection registration, welcome messages, and subscriptions *behind* the authentication barrier. Forbid multiple auth attempts on the same socket.
- [ ] **Step 5: Enforce Max TTL**: Set a timeout to forcefully close the WebSocket connection precisely at the JWT `exp` timestamp, requiring the client to reconnect with a fresh ticket.

---

## Pre-Mortem Mitigations (Context)
- **Infinite Session Bug:** MUST explicitly disconnect WebSockets when JWT `exp` timestamp is reached.
- **Multiple Auth Logging:** MUST forbid re-auth and redact payload from logs.
- **Missing Tenant Validation:** MUST validate expected tenant/plugin metadata upon connection.
