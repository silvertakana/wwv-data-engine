import geoip from 'geoip-lite';

export interface GeoLocation {
  lat: number;
  lon: number;
  country: string;
  city: string;
}

/**
 * Geolocate an IPv4 address using the local geoip-lite database.
 * Returns null for private/unresolvable IPs.
 */
export function geolocateIp(ip: string): GeoLocation | null {
  const lookup = geoip.lookup(ip);
  if (!lookup || !lookup.ll) return null;

  return {
    lat: lookup.ll[0],
    lon: lookup.ll[1],
    country: lookup.country || 'Unknown',
    city: lookup.city || 'Unknown',
  };
}
