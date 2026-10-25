import { interpolate, type Messages } from "@/lib/i18n";

/**
 * Turns an audit event into words for the activity feed: a localized action phrase, and the
 * free-text summary with machine tokens (EXPECTED → CONFIRMED, MEDIUM, SKIP…) translated through
 * the enum dictionaries. Raw action keys never reach the screen.
 */

const cache = new WeakMap<object, Map<string, string>>();

function enumLabels(m: Messages) {
  let map = cache.get(m.enums);
  if (map) return map;
  map = new Map();
  for (const group of Object.values(m.enums as Record<string, unknown>)) {
    if (!group || typeof group !== "object") continue;
    for (const [k, v] of Object.entries(group as Record<string, unknown>)) {
      if (typeof v === "string" && /^[A-Z][A-Z_]+$/.test(k) && !map.has(k)) map.set(k, v);
    }
  }
  cache.set(m.enums, map);
  return map;
}

/** Machine-written summaries we know the shape of; anything else keeps its human text. */
function localizeSummary(action: string, summary: string, m: Messages, rtl: boolean) {
  const a = m.audit;
  let match: RegExpMatchArray | null;
  if (action === "import.validated" && (match = summary.match(/^(\d+) rows$/))) return interpolate(a.rows, { n: match[1] });
  if (action === "import.commit" && (match = summary.match(/^(\d+) committed, (\d+) skipped$/))) return interpolate(a.committed, { committed: match[1], skipped: match[2] });
  const labels = enumLabels(m);
  const out = summary.replace(/\b[A-Z][A-Z_]{2,}\b/g, (token) => labels.get(token) ?? token);
  // "from → to" reads right-to-left in Arabic, so the arrow turns with it
  return rtl ? out.replace(/→/g, "←") : out;
}

export function describeAudit(e: { action: string; summary: string | null; actorName: string | null }, m: Messages, locale: "ar" | "en") {
  const a = m.audit;
  const actions = a.action as Record<string, string>;
  const entities = a.entity as Record<string, string>;
  const prefix = e.action.split(".")[0];
  const title = actions[e.action] ?? interpolate(a.updated, { entity: entities[prefix] ?? a.activity });
  const actor = !e.actorName || e.actorName === "Opera" || e.actorName === "Operra" /* earlier system name */ || e.actorName === "system" ? a.system : e.actorName;
  return { title, actor, detail: e.summary ? localizeSummary(e.action, e.summary, m, locale === "ar") : null };
}
