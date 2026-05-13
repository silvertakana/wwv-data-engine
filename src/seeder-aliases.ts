/**
 * Engine seeder names → list of UI plugin ids that consume that data.
 *
 * Without this, a UI plugin whose `id` differs from the seeder name
 * silently never receives data — the subscribe/REST lookups and the
 * Redis key just don't match strings. Plugins repackaged at different
 * times in the project's history use different casing conventions
 * (snake_case, camelCase, kebab-case), so a single seeder commonly
 * needs to be served under multiple ids.
 *
 * Concrete examples observed in production deployments:
 *
 *   wwv-plugin-cyber-attacks         id "cyber-attacks"          seeder is "cyberAttacks" (cloud) or "cyber_attacks" (some forks)
 *   wwv-plugin-wildfire              id "wildfire"               seeder is "wildfires"
 *   wwv-plugin-conflict-zones        id "conflict-zones"         seeder is "conflictEvents"
 *   wwv-plugin-gps-jamming           id "gps-jamming"            seeder is "gpsjam" (cloud) or "gps_jamming" (some forks)
 *   wwv-plugin-international-sanctions  id "international-sanctions"  seeder is "sanctions"
 *
 * Maintainers adding a new seeder whose UI plugin uses a different
 * casing should add an entry here. Both the WebSocket broadcaster
 * (`websocket.ts`) and the REST snapshot route (`/api/:id` in
 * `server.ts`) use this map, so an entry covers both paths.
 */
export const SEEDER_ALIASES: Record<string, string[]> = {
    // camelCase variants (cloud-deployed seeder names)
    cyberAttacks: ['cyber-attacks'],
    civilUnrest: ['civil-unrest'],
    conflictEvents: ['conflict-events', 'conflict-zones'],

    // snake_case variants (legacy / fork seeder names)
    cyber_attacks: ['cyber-attacks'],
    civil_unrest: ['civil-unrest'],
    gps_jamming: ['gps-jamming'],
    surveillance_satellites: ['surveillance-satellites'],

    // singular / plural / abbreviation mismatches
    wildfires: ['wildfire'],
    gpsjam: ['gps-jamming'],
    sanctions: ['international-sanctions'],
};

/**
 * Reverse-lookup: given an id that a subscriber/REST client used,
 * return the canonical seeder name to use for Redis snapshot lookup.
 * If the id is itself a canonical seeder name (or there's no alias
 * registered for it), return it unchanged.
 */
export function canonicalSeederFor(requestedId: string): string {
    const aliased = Object.entries(SEEDER_ALIASES).find(([, aliases]) =>
        aliases.includes(requestedId),
    );
    return aliased ? aliased[0] : requestedId;
}
