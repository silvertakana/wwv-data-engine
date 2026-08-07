import { describe, it, expect } from 'vitest';
import { SEEDER_ALIASES, canonicalSeederFor } from './seeder-aliases';

describe('SEEDER_ALIASES', () => {
  it('maps the conflict-events seeder to the older conflict-zones plugin id', () => {
    expect(SEEDER_ALIASES['conflict-events']).toContain('conflict-zones');
  });

  it('keeps entries for legacy camelCase / snake_case / plural seeder names', () => {
    expect(SEEDER_ALIASES['cyberAttacks']).toEqual(['cyber-attacks']);
    expect(SEEDER_ALIASES['cyber_attacks']).toEqual(['cyber-attacks']);
    expect(SEEDER_ALIASES['wildfires']).toEqual(['wildfire']);
    expect(SEEDER_ALIASES['sanctions']).toEqual(['international-sanctions']);
    expect(SEEDER_ALIASES['gpsjam']).toEqual(['gps-jamming']);
  });

  it('every alias value is a kebab-case UI plugin id', () => {
    for (const aliases of Object.values(SEEDER_ALIASES)) {
      for (const alias of aliases) {
        expect(alias).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }
    }
  });
});

describe('canonicalSeederFor', () => {
  it('resolves an aliased plugin id to the canonical seeder name', () => {
    expect(canonicalSeederFor('conflict-zones')).toBe('conflict-events');
    expect(canonicalSeederFor('cyber-attacks')).toBe('cyberAttacks');
    expect(canonicalSeederFor('wildfire')).toBe('wildfires');
    expect(canonicalSeederFor('international-sanctions')).toBe('sanctions');
    // Multiple seeder names alias gps-jamming (snake_case entry wins first).
    expect(canonicalSeederFor('gps-jamming')).toBe('gps_jamming');
  });

  it('returns the id unchanged when no alias is registered', () => {
    expect(canonicalSeederFor('earthquakes')).toBe('earthquakes');
    expect(canonicalSeederFor('satellite')).toBe('satellite');
  });

  it('returns the id unchanged when it is already a canonical seeder name', () => {
    expect(canonicalSeederFor('conflict-events')).toBe('conflict-events');
  });
});
