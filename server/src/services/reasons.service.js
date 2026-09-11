/**
 * reasons.service — the "why are you seeing this person" line.
 *
 * Match reasons are computed from data the viewer is already allowed to see,
 * which is what keeps them safe to display. Two privacy rules are load-bearing:
 *
 *  - **Never invent precision.** "📍 Same city" and "📍 2 km away" come from
 *    the same bucketed distance the rest of the app shows. A reason must never
 *    become a side channel that narrows down someone's exact position.
 *  - **Never reveal a private signal.** Reasons only restate facts already on
 *    the card (shared interests, city, intent, verification). Nothing derived
 *    from another user's private settings, viewing history, or likes leaks in.
 *
 * Reasons are ordered by how much they actually say about compatibility, then
 * truncated — three short, specific chips read better and mean more than a
 * wall of weak signals.
 */

const MAX_REASONS = 3;

/** Human label per dating intent, matching the client's `intentLabel`. */
const INTENT_LABEL = {
  long_term: 'a long-term relationship',
  short_term: 'something casual',
  friends: 'new friends',
  figuring_out: 'still figuring it out'
};

/**
 * Build the reason list for one person, as seen by one viewer.
 *
 * @param {object} person  a decorated person (sharedInterests, city, intent…)
 * @param {object} viewer  the viewer's own profile fields
 * @returns {Array<{icon: string, text: string, kind: string, weight: number}>}
 */
export function matchReasons(person, viewer = {}) {
  const out = [];

  // 1. Shared interests — the strongest signal we have, and the most concrete
  //    thing two strangers can open a conversation with.
  const shared = Array.isArray(person.sharedInterests) ? person.sharedInterests : [];
  if (shared.length === 1) {
    out.push({
      kind: 'interests',
      icon: '❤️',
      text: `You both like ${shared[0].label}`,
      weight: 100
    });
  } else if (shared.length > 1) {
    out.push({
      kind: 'interests',
      icon: '❤️',
      text: `${shared.length} shared interests`,
      weight: 100 + shared.length
    });
  }

  // 2. Same city. Only when both sides actually published a city — never
  //    inferred from coordinates, which would leak location precision.
  const sameCity =
    person.city && viewer.city && person.city.trim().toLowerCase() === viewer.city.trim().toLowerCase();
  if (sameCity) {
    out.push({ kind: 'city', icon: '📍', text: `Same city — ${person.city}`, weight: 90 });
  } else if (person.distanceShort && person.distanceKm !== null && person.distanceKm !== undefined) {
    // Already-bucketed distance string; we never recompute a finer number.
    out.push({ kind: 'distance', icon: '📍', text: `${person.distanceShort} away`, weight: 60 });
  }

  // 3. Looking for the same thing — a mismatch here is the most common reason
  //    a match goes nowhere, so an alignment is worth surfacing.
  if (person.intent && viewer.intent && person.intent === viewer.intent) {
    out.push({
      kind: 'intent',
      icon: '🎯',
      text: `You are both looking for ${INTENT_LABEL[person.intent] || 'the same thing'}`,
      weight: 80
    });
  }

  // 4. Shared languages — genuinely useful in an international app, and a real
  //    differentiator from the "same city" monoculture.
  const mine = new Set((viewer.languages || []).map((l) => String(l).toLowerCase()));
  const theirs = (person.languages || []).map((l) => String(l));
  const bothSpeak = theirs.filter((l) => mine.has(l.toLowerCase()));
  if (bothSpeak.length) {
    out.push({
      kind: 'languages',
      icon: '💬',
      text: bothSpeak.length === 1 ? `You both speak ${bothSpeak[0]}` : `${bothSpeak.length} languages in common`,
      weight: 70
    });
  }

  // 5. Verification — a trust signal, worded so it never implies safety.
  if (person.isVerified) {
    out.push({ kind: 'verified', icon: '✓', text: 'Photo verified', weight: 40 });
  }

  // 6. Active now. Recency, not location — no exact timestamp exposed.
  if (person.isOnline) {
    out.push({ kind: 'online', icon: '🟢', text: 'Active now', weight: 30 });
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, MAX_REASONS);
}

/**
 * Attach reasons to a list of decorated people in one pass.
 * Pure function over data already fetched — adds no queries to a feed.
 */
export function withReasons(people, viewer) {
  return people.map((p) => ({ ...p, reasons: matchReasons(p, viewer) }));
}

/** The single strongest reason, for tight spaces like a deck card. */
export function topReason(person, viewer) {
  return matchReasons(person, viewer)[0] || null;
}
