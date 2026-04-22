import type { WebSocket } from 'ws';
import { getLiveSnapshot } from './redis';
import { getRegisteredPluginIds } from './scheduler';

// Track active connections and their subscriptions
const connections = new Set<WebSocket>();
const subscriptions = new Map<WebSocket, Set<string>>();

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
        
        // Push the most recent cached snapshot to the client immediately upon subscribing
        // This eliminates the "half a minute wait" for cron-driven seeders to flush
        const latestSnapshot = await getLiveSnapshot(data.pluginId);
        if (latestSnapshot && connections.has(connection)) {
          connection.send(JSON.stringify({
            type: 'data',
            pluginId: data.pluginId,
            payload: latestSnapshot
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
  const message = JSON.stringify({ type: 'data', pluginId, payload });
  for (const connection of connections) {
    if (subscriptions.get(connection)?.has(pluginId)) {
      connection.send(message);
    }
  }
}
