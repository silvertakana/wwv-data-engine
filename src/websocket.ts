import type { WebSocket } from 'ws';
import { getLiveSnapshot } from './redis';
import { getRegisteredPluginIds } from './scheduler';
import { canonicalSeederFor, SEEDER_ALIASES } from './seeder-aliases';
import { verifyEngineToken } from './jwt-auth';

export type WebSocketAuthMessage = {
  type: 'auth';
  v: number;
  token: string;
};

// Track active connections and their subscriptions
const connections = new Set<WebSocket>();
const subscriptions = new Map<WebSocket, Set<string>>();

// Set WWV_SKIP_WS_AUTH=true to allow unauthenticated /stream connections.
// Intentionally permitted in production while app-side auth is not yet implemented.
const SKIP_WS_AUTH = process.env.WWV_SKIP_WS_AUTH === 'true';

export function handleConnection(connection: WebSocket, request: any) {
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
      } catch (err: any) {
        // Important: err might contain sensitive data in stack trace, do not log full error
        console.error('[WS] Auth failed:', err.message);
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
          } catch (err: any) {
            console.warn(`[WS] Auth verification failed: ${err.message}`);
          }
          return;
        }
        // Re-authentication attempts on the same socket (normal mode) are
        // forbidden and result in immediate closure.
        connection.close(4003, 'Re-auth forbidden');
        return;
      }

      if (data.action === 'subscribe' && data.pluginId) {
        subscriptions.get(connection)?.add(data.pluginId);
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
      if (data.action === 'unsubscribe' && data.pluginId) {
        subscriptions.get(connection)?.delete(data.pluginId);
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

export function broadcastPluginData(pluginId: string, payload: any) {
  // Fan out under every id a subscriber could be using: the seeder's
  // canonical name plus any UI-plugin aliases registered above.
  const ids = [pluginId, ...(SEEDER_ALIASES[pluginId] ?? [])];

  for (const connection of connections) {
    const subs = subscriptions.get(connection);
    if (!subs) continue;
    for (const id of ids) {
      if (subs.has(id)) {
        // Send the message under the id the *subscriber* asked for,
        // so plugin-side `mapWebsocketPayload` sees a `pluginId` that
        // matches the plugin's own configured id.
        connection.send(JSON.stringify({ type: 'data', pluginId: id, payload }));
        break; // one subscriber ≠ multiple deliveries of the same payload
      }
    }
  }
}

(globalThis as any).broadcastPluginData = broadcastPluginData;
