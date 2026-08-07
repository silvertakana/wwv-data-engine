/**
 * Engine seeder names → list of UI plugin ids that consume that data.
 *
 * Since the canonical plugin id is now the seeder's self-declared `name`
 * (ADR-0002, see seeder-loader.ts), the common case is already covered:
 * community seeders declare kebab-case names that match their UI plugin
 * ids ("cyber-attacks", "gps-jamming", ...). This map only matters when
 * the declared name diverges from the id a subscriber uses:
 *
 *   wwv-plugin-conflict-zones            id "conflict-zones"   seeder name "conflict-events"
 *   wwv-plugin-wildfire                  id "wildfire"         seeder name "wildfires" (older deployments)
 *   wwv-plugin-international-sanctions   id "international-sanctions"  seeder name "sanctions" (older deployments)
 *
 * Older production/cloud deployments also ran seeders whose declared
 * names kept camelCase / snake_case / plural conventions
 * ("cyberAttacks", "cyber_attacks", "gpsjam", "sanctions", ...). Those
 * entries are kept so a subscriber asking under the UI plugin id is
 * still served while such deployments exist.
 *
 * Maintainers adding a seeder whose UI plugin uses a different id should
 * add an entry here. Both the WebSocket broadcaster (`websocket.ts`) and
 * the REST snapshot route (`/api/:id` in `server.ts`) use this map, so
 * an entry covers both paths.
 */
export const SEEDER_ALIASES: Record<string, string[]> = {
  // The conflict-events seeder is consumed by two UI plugins under
  // different ids: wwv-plugin-conflict-events ("conflict-events") and
  // the older wwv-plugin-conflict-zones ("conflict-zones").
  'conflict-events': ['conflict-zones'],

  // camelCase variants (older cloud-deployed seeder names)
  cyberAttacks: ['cyber-attacks'],
  civilUnrest: ['civil-unrest'],

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
