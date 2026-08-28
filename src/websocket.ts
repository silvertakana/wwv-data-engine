import type { WebSocket } from 'ws';
import { getLiveSnapshot } from './redis';
import { getRegisteredPluginIds } from './scheduler';
import { canonicalSeederFor, SEEDER_ALIASES } from './seeder-aliases';
import { verifyEngineToken } from './jwt-auth';
import type { SeederHealth } from './seeder-health';

export type WebSocketAuthMessage = {
  type: 'auth';
  v: number;
  token: string;
};

// Track active connections and their subscriptions
const connections = new Set<WebSocket>();
const subscriptions = new Map<WebSocket, Set<string>>();

// Subscribe-path validation limits. pluginIds are seeder/plugin ids in
// kebab-case; anything else (path traversal, camelCase dir names, oversized
// blobs) is a protocol violation and closes the connection.
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PLUGIN_ID_MAX_LENGTH = 64;
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 50;

// Application close codes used on the subscribe path (4000-4999 range):
// 4400 - invalid pluginId (missing, malformed, or too long)
// 4401 - per-connection subscription cap exceeded
export const WS_CLOSE_INVALID_PLUGIN_ID = 4400;
export const WS_CLOSE_SUBSCRIPTION_LIMIT = 4401;

export function isValidPluginId(pluginId: unknown): pluginId is string {
  return (
    typeof pluginId === 'string' &&
    pluginId.length > 0 &&
    pluginId.length <= PLUGIN_ID_MAX_LENGTH &&
    PLUGIN_ID_PATTERN.test(pluginId)
  );
}

// Set WWV_SKIP_WS_AUTH=true to allow unauthenticated /stream connections.
// Intentionally permitted in production while app-side auth is not yet implemented.
const SKIP_WS_AUTH = process.env.WWV_SKIP_WS_AUTH === 'true';

export function handleConnection(connection: WebSocket, _request: unknown) {
  let isAuthenticated = SKIP_WS_AUTH;
  // authPending is set synchronously before the async verifyEngineToken call.
  // A second message arriving while verification is in-flight sees this flag
  // and is rejected immediately, closing the race window.
  let authPending = false;
  let jwtExpTimeout: NodeJS.Timeout | null = null;
  // Tracks whether authentication was established via the SKIP_WS_AUTH bypass
  // (no real JWT verification). When true, subsequent auth messages are accepted
  // for post-welcome JWT verification but the connection is never closed on failure.
  let authBypassed = SKIP_WS_AUTH;

  // Pre-authenticate immediately when auth is bypassed
  if (SKIP_WS_AUTH) {
    connections.add(connection);
    subscriptions.set(connection, new Set());
    connection.send(JSON.stringify({
      type: 'welcome',
      engine: 'wwv-data-engine',
      plugins: getRegisteredPluginIds(),
    }));
  }

  const authTimeout = SKIP_WS_AUTH ? null : setTimeout(() => {
    if (!isAuthenticated) {
      connection.close(4003, 'Auth timeout');
    }
  }, 3000);

  // Heartbeat setup
  let isAlive = true;
  connection.on('pong', () => { isAlive = true; });

  const heartbeat = setInterval(() => {
    if (!isAlive) {
      clearInterval(heartbeat);
      connection.terminate();
      return;
    }
    isAlive = false;
    connection.ping();
  }, 30000);

  connection.on('message', async (message: string) => {
    if (!isAuthenticated) {
      if (authPending) {
        connection.close(4003, 'Auth already in progress');
        return;
      }
      authPending = true;
      try {
        const data = JSON.parse(message) as WebSocketAuthMessage;
        if (data.type !== 'auth' || data.v !== 1) {
          connection.close(4003, 'Invalid auth message');
          return;
        }

        // Verify ticket (signature, iss, aud, exp) via jose — see jwt-auth.ts.
        // REDACT LOGS: never log data.token or the decoded payload.
        const decoded = await verifyEngineToken(data.token);


        isAuthenticated = true;
        if (authTimeout) clearTimeout(authTimeout);

        // Enforce Max TTL timeout for socket
        const expMs = decoded.exp * 1000;
        const now = Date.now();
        const timeUntilExp = expMs - now;

        jwtExpTimeout = setTimeout(() => {
          connection.close(4001, 'Token expired');
        }, Math.max(timeUntilExp, 0));

        // Add to active connections
        connections.add(connection);
        subscriptions.set(connection, new Set());

        // Send welcome message
        connection.send(JSON.stringify({
          type: 'welcome',
          engine: 'wwv-data-engine',
          plugins: getRegisteredPluginIds(),
        }));
      } catch (err: unknown) {
        // Important: err might contain sensitive data in stack trace, do not log full error
        console.error('[WS] Auth failed:', err instanceof Error ? err.message : String(err));
        connection.close(4003, 'Auth failed');
      }
      return;
    }

    // Already authenticated
    try {
      const data = JSON.parse(message);
      
      // When auth was bypassed via SKIP_WS_AUTH, accept auth messages for
      // post-welcome JWT verification. Verify the JWT but never close the
      // connection on failure — the client had immediate access via bypass.
      if (data.type === 'auth') {
        if (authBypassed) {
          try {
            const decoded = await verifyEngineToken(data.token);
            authBypassed = false;
            console.log(`[WS] Auth verified post-welcome for userId: ${decoded.sub}`);
            const expMs = decoded.exp * 1000;
            const now = Date.now();
            const timeUntilExp = expMs - now;
            jwtExpTimeout = setTimeout(() => {
              connection.close(4001, 'Token expired');
            }, Math.max(timeUntilExp, 0));
          } catch (err: unknown) {
            console.warn(`[WS] Auth verification failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }
        // Re-authentication attempts on the same socket (normal mode) are
        // forbidden and result in immediate closure.
        connection.close(4003, 'Re-auth forbidden');
        return;
      }

      if (data.action === 'subscribe') {
        // Validate the pluginId shape before admitting it to the
        // subscription set — reachable unauthenticated under
        // WWV_SKIP_WS_AUTH=true, so it must not accept arbitrary input.
        if (!isValidPluginId(data.pluginId)) {
          connection.close(WS_CLOSE_INVALID_PLUGIN_ID, 'Invalid pluginId');
          return;
        }
        const subs = subscriptions.get(connection);
        if (subs && subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
          connection.close(WS_CLOSE_SUBSCRIPTION_LIMIT, 'Subscription limit exceeded');
          return;
        }
        subs?.add(data.pluginId);
        // Push the most recent cached snapshot to the client immediately
        // upon subscribing. Look up the snapshot under the seeder's own
        // name even if the subscriber asked under a UI-plugin alias, then
        // fall back to the raw id if the alias-resolved lookup missed.
        const seederName = canonicalSeederFor(data.pluginId);
        let latestSnapshot = await getLiveSnapshot(seederName);
        if (!latestSnapshot && seederName !== data.pluginId) {
          latestSnapshot = await getLiveSnapshot(data.pluginId);
        }
        if (latestSnapshot && connections.has(connection)) {
          connection.send(JSON.stringify({
            type: 'data',
            pluginId: data.pluginId,
            payload: latestSnapshot,
          }));
        }
      }
      if (data.action === 'unsubscribe') {
        // Unsubscribe cannot grow the subscription set, so an invalid id is
        // a no-op rather than a close. Only valid ids can be present in the
        // set in the first place (subscribe validates before adding).
        if (isValidPluginId(data.pluginId)) {
          subscriptions.get(connection)?.delete(data.pluginId);
        }
      }
    } catch (e) {
      console.error('[WS] Invalid message error/fetch error', e);
    }
  });

  connection.on('close', () => {
    if (authTimeout) clearTimeout(authTimeout);
    if (jwtExpTimeout) clearTimeout(jwtExpTimeout);
    clearInterval(heartbeat);
    connections.delete(connection);
    subscriptions.delete(connection);
  });
}

// Maximum buffered bytes a connection may hold before a fan-out skips it.
// Beyond this, a backpressure-stalled client would otherwise accumulate
// unbounded outbound data; skipping keeps the broadcast moving to healthy
// subscribers (the connection is not terminated, just passed over this batch).
const MAX_BUFFERED_AMOUNT = 1_000_000;

type FrameBuilder = (id: string) => string;

// Fan a single payload out to every connection subscribed to one of the given
// ids, serializing the frame ONCE per id (shared verbatim by every subscriber
// of that id). Sends are hardened: any throw terminates and evicts the broken
// socket rather than failing the whole broadcast.
function fanOutToSubscribers(ids: string[], buildFrame: FrameBuilder): void {
  const frameById = new Map<string, string>();
  for (const id of ids) frameById.set(id, buildFrame(id));

  for (const connection of connections) {
    // Skip backpressure-stalled connections for this batch.
    if (connection.bufferedAmount > MAX_BUFFERED_AMOUNT) continue;

    const subs = subscriptions.get(connection);
    if (!subs) continue;
    for (const id of ids) {
      if (subs.has(id)) {
        try {
          // Send the message under the id the *subscriber* asked for,
          // so plugin-side `mapWebsocketPayload` sees a `pluginId` that
          // matches the plugin's own configured id.
          connection.send(frameById.get(id) as string);
        } catch {
          try {
            connection.terminate();
          } catch {
            // terminating a dead socket can also throw; nothing to do
          }
          connections.delete(connection);
          subscriptions.delete(connection);
        }
        break; // one subscriber ≠ multiple deliveries of the same payload
      }
    }
  }
}

export function broadcastPluginData(pluginId: string, payload: unknown) {
  // Fan out under every id a subscriber could be using: the seeder's
  // canonical name plus any UI-plugin aliases registered above.
  const ids = [pluginId, ...(SEEDER_ALIASES[pluginId] ?? [])];
  fanOutToSubscribers(ids, (id) =>
    JSON.stringify({ type: 'data', pluginId: id, payload }),
  );
}

/**
 * type:'status' frame payload. `health` is the wire-contract seeder-health
 * payload (see seeder-health.ts); additive — clients that only know
 * status/lastGood keep working.
 */
export type SeederStatus = {
  status: string;
  lastGood: string | null;
  health?: SeederHealth;
};

export function broadcastSeederStatus(pluginId: string, status: SeederStatus) {
  const ids = [pluginId, ...(SEEDER_ALIASES[pluginId] ?? [])];
  fanOutToSubscribers(ids, (id) =>
    JSON.stringify({ type: 'status', pluginId: id, ...status }),
  );
}

Object.assign(globalThis, { broadcastPluginData, broadcastSeederStatus });
