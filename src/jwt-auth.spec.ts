import { describe, it, expect, afterEach } from 'vitest';
import { ticketIssuer, extractClaims, DEFAULT_ISSUER } from './jwt-auth';

describe('ticketIssuer', () => {
  afterEach(() => {
    delete process.env.JWT_ISSUER;
  });

  it('defaults to the marketplace issuer when JWT_ISSUER is unset', () => {
    delete process.env.JWT_ISSUER;
    expect(ticketIssuer()).toBe(DEFAULT_ISSUER);
  });

  it('honours JWT_ISSUER so an engine can trust its own marketplace', () => {
    process.env.JWT_ISSUER = 'https://marketplace.example.test';
    expect(ticketIssuer()).toBe('https://marketplace.example.test');
  });

  it('ignores a blank JWT_ISSUER rather than trusting an empty issuer', () => {
    process.env.JWT_ISSUER = '   ';
    expect(ticketIssuer()).toBe(DEFAULT_ISSUER);
  });
});

describe('extractClaims', () => {
  const base = { sub: 'user-1', exp: 2_000_000_000 };

  it('returns the required claims', () => {
    const claims = extractClaims(base);
    expect(claims.sub).toBe('user-1');
    expect(claims.exp).toBe(2_000_000_000);
  });

  it('rejects a payload with no subject', () => {
    expect(() => extractClaims({ exp: 2_000_000_000 })).toThrow(/sub/);
  });

  it('rejects a payload with no expiry', () => {
    expect(() => extractClaims({ sub: 'user-1' })).toThrow(/exp/);
  });

  it('carries tier, scope and jti through when they are present', () => {
    const claims = extractClaims({
      ...base,
      tier: 'demo',
      scope: 'plugins:read:earthquakes',
      jti: 'ticket-1',
    });
    expect(claims.tier).toBe('demo');
    expect(claims.scope).toBe('plugins:read:earthquakes');
    expect(claims.jti).toBe('ticket-1');
  });

  it('drops optional claims that are not strings instead of trusting them', () => {
    const claims = extractClaims({ ...base, scope: 42, tier: { name: 'demo' } });
    expect(claims.scope).toBeUndefined();
    expect(claims.tier).toBeUndefined();
  });
});
