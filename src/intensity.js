import { canonicalURL } from './log.js';

const DEFAULTS = {
  recencyWeight: 35,
  corroborationWeight: 35,
  urgencyWeight: 20,
  impactWeight: 10,
  corroborationSimilarity: 0.32
};

const URGENT = [
  /\bbreaking\b/i, /\bemergency\b/i, /\bevacuat(?:e|ed|ion|ions)\b/i,
  /\bearthquake\b/i, /\btsunami\b/i, /\bcyclone\b/i, /\bhurricane\b/i,
  /\bwildfire\b/i, /\bexplosion\b/i, /\battack\b/i, /\bwar\b/i,
  /\bceasefire\b/i, /\boutbreak\b/i, /\bpandemic\b/i, /\bcrash\b/i,
  /\bshutdown\b/i, /\boutage\b/i, /\bresigns?\b/i, /\bresignation\b/i
];

const NOTABLE = [
  /\belection\b/i, /\bruling\b/i, /\bverdict\b/i, /\blaunch(?:es|ed)?\b/i,
  /\brecall\b/i, /\bban(?:ned|s)?\b/i, /\bstrike\b/i, /\bprotest\b/i,
  /\brecord\b/i, /\bbankrupt(?:cy)?\b/i, /\bmerger\b/i, /\bacquisition\b/i,
  /\bdiscovery\b/i, /\bbreakthrough\b/i, /\bchampion(?:ship|s)?\b/i
];

const IMPACT = [
  /\bnationwide\b/i, /\bglobal(?:ly)?\b/i, /\bmillions?\b/i, /\bbillions?\b/i,
  /\bdeaths?\b/i, /\bkilled\b/i, /\binjured\b/i, /\bmissing\b/i,
  /\bmarkets?\b/i, /\bgovernment\b/i, /\bpublic health\b/i,
  /\bworkers?\b/i, /\bconsumers?\b/i, /\bcountries\b/i
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const matches = (text, patterns) => patterns.filter(pattern => pattern.test(text)).length;
const STOP_WORDS = new Set(['a','an','and','are','as','at','be','by','for','from','has','in','is','it','new','of','on','says','that','the','to','with']);

function eventSimilarity(a, b) {
  const tokens = value => new Set(String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter(token => token.length > 2 && !STOP_WORDS.has(token)));
  const left=tokens(a),right=tokens(b),intersection=[...left].filter(token=>right.has(token)).length;
  if(intersection<2)return 0;
  return Math.max(intersection/Math.max(1,new Set([...left,...right]).size),intersection/Math.max(1,Math.min(left.size,right.size)));
}

function sameEvent(a, b, threshold) {
  try {
    if (canonicalURL(a.url) === canonicalURL(b.url)) return true;
  } catch {}
  return eventSimilarity(a.title, b.title) >= threshold;
}

export function intensityScore(candidate, pool, config, now = new Date()) {
  const settings = { ...DEFAULTS, ...config.intensity };
  const maxAgeMs = Math.max(1, config.maxAgeDays) * 86400000;
  const ageMs = Math.max(0, now - new Date(candidate.published));
  const recency = settings.recencyWeight * clamp(1 - ageMs / maxAgeMs, 0, 1);

  const related = pool.filter(item => sameEvent(candidate, item, settings.corroborationSimilarity));
  const independentSources = new Set(related.map(item => item.source).filter(Boolean)).size;
  const coverageRatio = independentSources <= 1 ? 0 : independentSources === 2 ? 0.55 : independentSources === 3 ? 0.8 : 1;
  const corroboration = settings.corroborationWeight * coverageRatio;

  // Headline terms are weighted more heavily than terms buried in article text.
  const headline = candidate.title || '';
  const context = `${headline} ${(candidate.text || '').slice(0, 600)}`;
  const urgencyPoints = matches(headline, URGENT) * 4 + matches(context, URGENT) * 2
    + matches(headline, NOTABLE) * 2 + matches(context, NOTABLE);
  const urgency = settings.urgencyWeight * clamp(urgencyPoints / 10, 0, 1);

  const impactTerms = matches(headline, IMPACT) * 2 + matches(context, IMPACT);
  const hasMeasuredScale = /(?:\b\d+(?:\.\d+)?%|[$€£₹]\s?\d|\b\d[\d,.]*\s*(?:people|residents|users|customers|workers|homes|countries|states|cities|deaths|injuries|injured|missing|acres|hectares|kilometres|kilometers|miles|million|billion|trillion)\b)/i.test(context);
  const impact = settings.impactWeight * clamp((impactTerms + (hasMeasuredScale ? 2 : 0)) / 8, 0, 1);

  const components = { recency, corroboration, urgency, impact };
  const score = Object.values(components).reduce((sum, value) => sum + value, 0);
  return {
    score: Math.round(score * 10) / 10,
    label: score >= 75 ? 'breaking' : score >= 55 ? 'high' : score >= 30 ? 'notable' : 'normal',
    independentSources,
    components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Math.round(value * 10) / 10]))
  };
}

export function selectByIntensity(candidates, pool, config, now = new Date()) {
  if (!candidates.length) throw new Error('No candidates available for intensity selection');
  return candidates
    .map(candidate => ({ ...candidate, intensity: intensityScore(candidate, pool, config, now) }))
    .sort((a, b) => b.intensity.score - a.intensity.score
      || new Date(b.published) - new Date(a.published)
      || canonicalURL(a.url).localeCompare(canonicalURL(b.url)))[0];
}
