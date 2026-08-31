// Every place a locked-odds market can land on a dedicated hub, in one list.
//
// Built to close a real gap: the admin Create Market form had two free-text
// inputs ("Sport tag", "Hub tag") with a hint written for BBN and nothing at
// all for the four hubs added alongside it (basketball, tennis, esports,
// fight). An admin had to type "basketball" and "NBA" from memory with no
// guidance and no validation — a typo, or the wrong bracket format, produces
// a market that saves successfully and then shows up nowhere, because the
// hub pages match on the exact string. That exact failure mode — something
// that looks configured and silently does nothing — is the pattern this
// whole branch has been finding and fixing all week, and this form was the
// one place still inviting it by hand.
//
// Sourced from the SAME config the hub pages themselves read
// (lib/leagues.ts, lib/sportHubs.ts, lib/bbnTags.ts), not retyped — so a hub
// added or renamed there is picked up here automatically instead of the two
// lists quietly drifting apart.
import { LEAGUES, LEAGUE_IDS } from '@/lib/leagues';
import { SPORT_HUBS, SPORT_HUB_IDS } from '@/lib/sportHubs';
import { BBN_TAGS, BBN_TAG_IDS, BBN_SPORT } from '@/lib/bbnTags';

export type LockedOddsHubOption = {
  /** Unique key for the picker. Not stored anywhere. */
  id: string;
  /** e.g. "Football", "Basketball", "Big Brother Naija" — the <SelectGroup>. */
  groupLabel: string;
  /** e.g. "Premier League", "NBA", "Eviction Watch". */
  label: string;
  category: string;
  sport: string;
  /** null = tag the sport only, no specific competition/hub-section. */
  leagueCode: string | null;
};

export function lockedOddsHubOptions(): LockedOddsHubOption[] {
  const out: LockedOddsHubOption[] = [];

  // Football — /league/[pl|pd|cl]. LEAGUES.code is the display form ("[PL]");
  // the stored column is bracket-free (MarketList strips brackets before
  // comparing), so it is stripped here too.
  for (const id of LEAGUE_IDS) {
    const lg = LEAGUES[id];
    out.push({
      id: `football:${id}`, groupLabel: 'Football', label: lg.label,
      category: 'sports', sport: 'football', leagueCode: lg.code.replace(/[[\]]/g, ''),
    });
  }
  out.push({
    id: 'football:general', groupLabel: 'Football', label: 'General (no specific league)',
    category: 'sports', sport: 'football', leagueCode: null,
  });

  // The four generic sport hubs — /basketball, /tennis, /esports, /fight.
  for (const hubId of SPORT_HUB_IDS) {
    const hub = SPORT_HUBS[hubId];
    for (const c of hub.competitions ?? []) {
      out.push({
        id: `${hubId}:${c.id}`, groupLabel: hub.label, label: c.label,
        category: 'sports', sport: hub.sport, leagueCode: c.code,
      });
    }
    out.push({
      id: `${hubId}:general`, groupLabel: hub.label,
      label: (hub.competitions?.length ?? 0) > 0 ? 'General (no specific competition)' : hub.label,
      category: 'sports', sport: hub.sport, leagueCode: null,
    });
  }

  // BBN — /bbn. category MUST be 'entertainment', not 'sports': that is the
  // one rule a free-text field could never enforce, and getting it wrong is
  // exactly what makes a market invisible on the hub while it still looks
  // fine everywhere else.
  for (const tagId of BBN_TAG_IDS) {
    const t = BBN_TAGS[tagId];
    out.push({
      id: `bbn:${tagId}`, groupLabel: 'Big Brother Naija', label: t.label,
      category: 'entertainment', sport: BBN_SPORT, leagueCode: t.code,
    });
  }
  out.push({
    id: 'bbn:general', groupLabel: 'Big Brother Naija', label: 'General (no specific tag)',
    category: 'entertainment', sport: BBN_SPORT, leagueCode: null,
  });

  return out;
}

export function getLockedOddsHubOption(id: string | null | undefined): LockedOddsHubOption | null {
  if (!id) return null;
  return lockedOddsHubOptions().find(o => o.id === id) ?? null;
}

/** lockedOddsHubOptions(), grouped for a <SelectGroup> list — one pass, no
    per-render reduce in the component, and no risk of an inline generic
    silently typed as `any`. */
export function groupedLockedOddsHubOptions(): { groupLabel: string; options: LockedOddsHubOption[] }[] {
  const groups: { groupLabel: string; options: LockedOddsHubOption[] }[] = [];
  const byLabel = new Map<string, LockedOddsHubOption[]>();
  for (const o of lockedOddsHubOptions()) {
    let bucket = byLabel.get(o.groupLabel);
    if (!bucket) {
      bucket = [];
      byLabel.set(o.groupLabel, bucket);
      groups.push({ groupLabel: o.groupLabel, options: bucket });
    }
    bucket.push(o);
  }
  return groups;
}
