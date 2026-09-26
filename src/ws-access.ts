// Per-connection access decisions, kept out of websocket.ts so the wiring there
// stays readable and these rules stay unit-testable without a socket.

// Application close codes on the access path (4000-4999 range):
// 4402 - inbound message rate exceeded
// 4403 - subscription outside the ticket's scope
export const WS_CLOSE_RATE_LIMIT = 4402;
export const WS_CLOSE_NOT_IN_SCOPE = 4403;

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

export interface RateLimiter {
  allow(): boolean;
}

// Fixed-window limiter: cheap, per connection, and it bounds the work a single
// socket can ask the engine to do. The window resets on the first message after
// it has elapsed rather than on a timer, so an idle connection costs nothing.
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? (() => Date.now());
  let windowStart = now();
  let used = 0;
  return {
    allow(): boolean {
      const at = now();
      if (at - windowStart >= options.windowMs) {
        windowStart = at;
        used = 0;
      }
      used += 1;
      return used <= options.limit;
    },
  };
}

const RATE_LIMIT_DEFAULT = 60;
const RATE_LIMIT_WINDOW_MS_DEFAULT = 10_000;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function messageRateLimitConfig(): RateLimiterOptions {
  return {
    limit: positiveInt(process.env.WS_MESSAGE_RATE_LIMIT, RATE_LIMIT_DEFAULT),
    windowMs: positiveInt(process.env.WS_MESSAGE_RATE_LIMIT_WINDOW_MS, RATE_LIMIT_WINDOW_MS_DEFAULT),
  };
}

const READ_ANY = 'plugins:read';
const READ_PREFIX = 'plugins:read:';

// A ticket with no scope is accepted for any channel: tickets minted before the
// scope claim existed, and connections admitted by the auth bypass, carry none.
// An explicitly empty scope grants nothing — that is a deliberate difference,
// because an empty claim is a statement rather than an absence.
export function isSubscriptionAllowed(scope: string | undefined, pluginId: string): boolean {
  if (scope === undefined) return true;
  const tokens = scope.split(/\s+/).filter(Boolean);
  if (tokens.includes(READ_ANY)) return true;
  return tokens.includes(READ_PREFIX + pluginId);
}
