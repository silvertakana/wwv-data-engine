import type { WebSocket } from 'ws';
import { getLiveSnapshot } from './redis';
import { getRegisteredPluginIds } from './scheduler';

// Track active connections and their subscriptions
const connections = new Set<WebSocket>();
const subscriptions = new Map<WebSocket, Set<string>>();

/**
 * Engine seeder names → list of UI plugin ids that consume that data.
 * Used by `broadcastPluginData` to deliver under any alias a subscriber
 * might be using.
 *
 * Without this, a UI plugin whose `id` differs from the seeder name
 * silently never receives data — the subscribe message and the broadcast
 * message just don't match strings. Concrete examples observed:
 *
 *   `wwv-plugin-cyber-attacks`  has id "cyber-attacks", seeder is "cyber_attacks"
 *   `wwv-plugin-wildfire`       has id "wildfire",      seeder is "wildfires"
 *   `wwv-plugin-conflict-zones` has id "conflict-zones", seeder is "conflictEvents"
 *   `wwv-plugin-gps-jamming`    has id "gps-jamming",   seeder is "gps_jamming"
 *
 * Each case looks like a "seeder isn't broadcasting" or "plugin is broken"
 * problem until you trace it; the actual bug is just that snake_case /
 * camelCase / kebab-case conventions diverged between layers. Maintainers
 * adding a new seeder whose UI plugin uses a different casing should add
 * an entry here.
 */
const SEEDER_ALIASES: Record<string, string[]> = {
    cyber_attacks: ['cyber-attacks'],
    gps_jamming: ['gps-jamming'],
    civil_unrest: ['civil-unrest'],
    civilUnrest: ['civil-unrest'],
    surveillance_satellites: ['surveillance-satellites'],
    conflictEvents: ['conflict-events', 'conflict-zones'],
    wildfires: ['wildfire'],
};

export function handleConnection(connection: WebSocket, request: any) {
  // Option A (Secure Defaults): In a highly public plugin ecosystem, 
  // checking the token is optional/opt-in via env vars.
  const requireToken = process.env.REQUIRE_WS_TOKEN === 'true';
  const providedToken = request.query?.token;

  if (requireToken && providedToken !== process.env.API_SECRET) {
    connection.send(JSON.stringify({ error: 'Unauthorized: Invalid or missing token' }));
    connection.close(1008);
    return;
  }

  connections.add(connection);
  subscriptions.set(connection, new Set());

  // Heartbeat: send ping every 30s, close if no pong within 10s
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

  // Send welcome message with available plugins
  connection.send(JSON.stringify({
    type: 'welcome',
    engine: 'wwv-data-engine',
    plugins: getRegisteredPluginIds(),
  }));

  connection.on('message', async (message: string) => {
    try {
      const data = JSON.parse(message);
      if (data.action === 'subscribe' && data.pluginId) {
        subscriptions.get(connection)?.add(data.pluginId);

        // Push the most recent cached snapshot to the client immediately
        // upon subscribing. Look up the snapshot under the seeder's own
        // name even if the subscriber asked under a UI-plugin alias.
        const seederName =
          Object.entries(SEEDER_ALIASES).find(([, aliases]) =>
            aliases.includes(data.pluginId),
          )?.[0] ?? data.pluginId;
        const latestSnapshot = await getLiveSnapshot(seederName);
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

// Expose globally for seeders to access without needing to import websocket module
(globalThis as any).broadcastPluginData = broadcastPluginData;
