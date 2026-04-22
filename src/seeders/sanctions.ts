import sax from 'sax';
import { setLiveSnapshot } from '../redis';
import { registerSeeder } from '../scheduler';
import { fetchWithTimeout, CHROME_UA } from '../seed-utils';

const OFAC_SOURCES = [
  { label: 'SDN', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/sdn_advanced.xml' },
  { label: 'CONSOLIDATED', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/cons_advanced.xml' },
];

function local(name: string) {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

// ── SAX Parser adapted from WorldMonitor ──
async function fetchSource(source: typeof OFAC_SOURCES[0]) {
  console.log(`[Sanctions] Fetching OFAC ${source.label}...`);
  const t0 = Date.now();
  const response = await fetchWithTimeout(source.url, {
    headers: { 'User-Agent': CHROME_UA }
  }, 45_000);

  return new Promise<{ entries: any[] }>((resolve, reject) => {
    const parser = sax.parser(true, { trim: false, normalize: false });

    const areaCodes = new Map();
    const featureTypes = new Map();
    const legalBasis = new Map();
    const locations = new Map();
    const parties = new Map();
    const entries: any[] = [];
    let bytesReceived = 0;

    const stack: string[] = [];
    let text = '';

    let inAreaCodeValues = false;
    let inFeatureTypeValues = false;
    let inLegalBasisValues = false;
    let inLocations = false;
    let inDistinctParties = false;
    let inSanctionsEntries = false;

    let refId = '', refShortRef = '', refDescription = '';
    let locId = '';
    let locAreaCodeIds: string[] | null = null;
    let partyFixedRef = '';
    let profileId = '', profileSubTypeId = '';
    let aliases: any[] | null = null;
    let curAlias: any = null;
    let inDocumentedName = false;
    let namePartsBuf: string[] | null = null;
    let profileFeatures: any[] | null = null;
    let curFeature: any = null;

    let entryId = '', entryProfileId = '';

    function resolveLocation(locId: string) {
      if (!locAreaCodeIds) return { codes: [], names: [] };
      const ids = locAreaCodeIds;
      const mapped = ids.map((id) => areaCodes.get(id)).filter(Boolean);
      const pairs = [...new Map(mapped.map((item) => [item.code, item.name])).entries()]
        .filter(([code]) => code.length > 0);
      return { codes: pairs.map(([c]) => c), names: pairs.map(([, n]) => n) };
    }

    function finalizeParty() {
      const seen = new Map();
      for (const feat of profileFeatures ?? []) {
        if (!/location/i.test(featureTypes.get(feat.featureTypeId) || '')) continue;
        for (const lid of feat.locationIds) {
          const loc = locations.get(lid);
          if (!loc) continue;
          loc.codes.forEach((code: string, i: number) => { if (code && !seen.has(code)) seen.set(code, loc.names[i] ?? ''); });
        }
      }
      parties.set(profileId, { countryCodes: [...seen.keys()] });
    }

    function finalizeEntry() {
      const party = parties.get(entryProfileId);
      entries.push({ countryCodes: party?.countryCodes ?? [] });
    }

    parser.onopentag = (node: any) => {
      const name = local(node.name);
      const attrs = node.attributes as any;
      stack.push(name);
      text = '';

      switch (name) {
        case 'AreaCodeValues': inAreaCodeValues = true; break;
        case 'FeatureTypeValues': inFeatureTypeValues = true; break;
        case 'LegalBasisValues': inLegalBasisValues = true; break;
        case 'Locations': inLocations = true; break;
        case 'DistinctParties': inDistinctParties = true; break;
        case 'SanctionsEntries': inSanctionsEntries = true; break;

        case 'AreaCode': if (inAreaCodeValues) { refId = attrs.ID || ''; refDescription = attrs.Description || ''; } break;
        case 'FeatureType': if (inFeatureTypeValues) refId = attrs.ID || ''; break;
        case 'Location': if (inLocations) { locId = attrs.ID || ''; locAreaCodeIds = []; } break;
        case 'LocationAreaCode': if (locAreaCodeIds && attrs.AreaCodeID) locAreaCodeIds.push(attrs.AreaCodeID); break;

        case 'DistinctParty': if (inDistinctParties) { partyFixedRef = attrs.FixedRef || ''; aliases = []; profileFeatures = []; } break;
        case 'Profile': if (inDistinctParties) { profileId = attrs.ID || partyFixedRef; profileSubTypeId = attrs.PartySubTypeID || ''; } break;
        case 'Feature': if (inDistinctParties) curFeature = { featureTypeId: attrs.FeatureTypeID || '', locationIds: [] }; break;
        case 'VersionLocation': if (curFeature && attrs.LocationID) curFeature.locationIds.push(attrs.LocationID); break;

        case 'SanctionsEntry':
          if (inSanctionsEntries) { entryId = attrs.ID || ''; entryProfileId = attrs.ProfileID || ''; }
          break;
      }
    };

    parser.onclosetag = (rawName: string) => {
      const name = local(rawName);
      const t = text.trim();
      text = '';
      stack.pop();

      switch (name) {
        case 'AreaCodeValues': inAreaCodeValues = false; break;
        case 'FeatureTypeValues': inFeatureTypeValues = false; break;
        case 'Locations': inLocations = false; break;
        case 'DistinctParties': inDistinctParties = false; break;
        case 'SanctionsEntries': inSanctionsEntries = false; break;

        case 'AreaCode': if (inAreaCodeValues && refId) areaCodes.set(refId, { code: t, name: refDescription }); break;
        case 'FeatureType': if (inFeatureTypeValues && refId) featureTypes.set(refId, t); break;
        case 'Location':
          if (locAreaCodeIds !== null) {
            locations.set(locId, resolveLocation(locId));
            locId = ''; locAreaCodeIds = null;
          }
          break;
        case 'Feature': if (curFeature) { profileFeatures!.push(curFeature); curFeature = null; } break;
        case 'Profile':
          if (inDistinctParties && profileId) finalizeParty();
          profileId = ''; profileSubTypeId = ''; aliases = []; profileFeatures = [];
          break;
        case 'SanctionsEntry': finalizeEntry(); entryId = ''; entryProfileId = ''; break;
      }
    };

    parser.ontext = (chunk: string) => { text += chunk; };
    parser.oncdata = (chunk: string) => { text += chunk; };
    parser.onerror = (err: any) => { parser.resume(); };
    parser.onend = () => { resolve({ entries }); };

    if (!response.body) return reject(new Error('No response body'));
    
    // We treat response.body as an AsyncIterable (Node fetch extension)
    (async () => {
      try {
        for await (const chunk of (response.body as any)) {
          parser.write(Buffer.from(chunk).toString('utf-8'));
        }
        parser.close();
      } catch (err) {
        reject(err);
      }
    })();
  });
}

export async function fetchSanctionsData() {
    try {
        console.log('[Sanctions] Fetching OFAC feeds using SAX streaming...');
        
        let allEntries: any[] = [];
        for (const source of OFAC_SOURCES) {
            const result = await fetchSource(source);
            allEntries = allEntries.concat(result.entries);
        }

        // Aggregate by iso2 country codes
        const countryCounts: Record<string, number> = {};
        for (const entry of allEntries) {
            for (const code of entry.countryCodes) {
                if (code && code !== 'XX') {
                    countryCounts[code] = (countryCounts[code] || 0) + 1;
                }
            }
        }

        // Convert dict to GeoEntities
        const items = Object.entries(countryCounts).map(([code, count]) => {
            let level = 'low';
            if (count > 500) level = 'high';
            else if (count > 50) level = 'medium';

            return {
                id: `sanction-${code}`,
                countryCode: code,
                count: count,
                level,
                // Assign a placeholder coordinate, though frontend rendering will extract
                // 3D bounds from /borders.geojson using countryCode instead.
                latitude: 0,
                longitude: 0,
                timestamp: new Date().toISOString()
            };
        });

        const sanctionsObj = {
            id: 'sanctions-live',
            timestamp: new Date().toISOString(),
            items
        };

        // Cache for live polling (24 hr TTL)
        await setLiveSnapshot('sanctions', sanctionsObj, 86400);
        console.log(`[Sanctions] Published ${items.length} sanctioned countries.`);
    } catch (err) {
        console.error('[Sanctions] Error:', err);
    }
}

registerSeeder({
    name: "sanctions",
    cron: "0 * * * *", // run hourly
    fn: fetchSanctionsData
});
