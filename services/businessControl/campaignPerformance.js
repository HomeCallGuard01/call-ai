// Business control dashboard (2026-09-27) — Advertising & attribution.
//
// Builds on the EXISTING first-party, cookie-free acquisition capture
// (public.acquisition_events, migration 032; /go and registration) and
// the attribution design in docs/architecture/FINANCIAL_DATA_ARCHITECTURE.md
// §8–9 / ADR-0017. It replaces nothing and adds no tracking.
//
// The chain we eventually want is
//   campaign spend → visits/clicks → signup → paid customer → revenue → CAC
// Today only the first links exist:
//   - visits and registrations carry utm_source/medium/campaign;
//   - checkout_started / paid_conversion carry a household but NO UTM;
//   - no household → campaign link exists (customer_acquisition is
//     designed for migration 049, not built);
//   - advertising spend has no source until the ledger (048) and manual
//     costs (050) exist.
// So paying customers, revenue and CAC per campaign are reported as NOT
// CONNECTED — a click never counts as a purchase.
'use strict';

const NONE = '(none)';

const SEARCH_HOSTS = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex)\./;
const SOCIAL_HOSTS = /(^|\.)(facebook|fb|instagram|tiktok|t\.co|twitter|x|linkedin|youtube|reddit|pinterest|threads)\./;
const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'paid_social', 'paid_search', 'display']);

function clean(v) {
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
}

// Same normalisation as customer_acquisition.campaign_ref and
// financial_entries.campaign_ref (FINANCIAL_DATA_ARCHITECTURE.md §9.4),
// so spend and customers will join on one key.
function normaliseCampaignRef(source, medium, campaign) {
  const s = clean(source);
  const m = clean(medium);
  const c = clean(campaign);
  if (!s && !m && !c) return null;
  return `${s || NONE}/${m || NONE}/${c || NONE}`;
}

// §8.2 channel rules, applied to one event. Raw fields are never altered.
function deriveChannel(event) {
  const medium = clean(event.utm_medium);
  const source = clean(event.utm_source);
  if (medium && PAID_MEDIUMS.has(medium)) {
    if (medium === 'paid_search' || medium === 'cpc' || medium === 'ppc') return 'paid_search';
    if (medium === 'paid_social') return 'paid_social';
    return 'paid_other';
  }
  if (medium === 'community') return 'community';
  if (medium === 'organic_social') return 'organic_social';
  if (medium === 'pr') return 'pr';
  if (medium === 'referral' || medium === 'qr') return 'referral';
  if (medium === 'email') return 'email';
  if (source || medium || clean(event.utm_campaign)) return 'other_tagged';
  const host = clean(event.referrer_host);
  if (!host) return 'direct_or_unknown';
  if (SEARCH_HOSTS.test(host)) return 'organic_search';
  if (SOCIAL_HOSTS.test(host)) return 'organic_social';
  return 'referral';
}

// Pure — campaign table and chain status.
// `spendByCampaign`: null when no spend source exists (NOT CONNECTED),
// otherwise a map campaign_ref → { amountGbp, provenance }.
// `attributedCustomers`: null when customer_acquisition doesn't exist.
function computeCampaignPerformance({ events, spendByCampaign = null, attributedCustomers = null }) {
  const byKey = new Map();
  let unattributedCheckouts = 0;
  let unattributedPaidConversions = 0;

  for (const e of events || []) {
    if (e.event_type === 'checkout_started') { unattributedCheckouts += 1; continue; }
    if (e.event_type === 'paid_conversion') { unattributedPaidConversions += 1; continue; }
    const ref = normaliseCampaignRef(e.utm_source, e.utm_medium, e.utm_campaign);
    const channel = deriveChannel(e);
    const key = ref || `untagged:${channel}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        campaignRef: ref,
        label: ref || (channel === 'direct_or_unknown' ? 'Direct / unknown' : `Untagged — ${channel.replace(/_/g, ' ')}`),
        channel,
        landingVisits: 0,
        registrationsSubmitted: 0,
        registrationsCompleted: 0,
      });
    }
    const row = byKey.get(key);
    if (e.event_type === 'landing_visit') row.landingVisits += 1;
    else if (e.event_type === 'registration_submitted') row.registrationsSubmitted += 1;
    else if (e.event_type === 'registration_completed') row.registrationsCompleted += 1;
  }

  const rows = [...byKey.values()].map((r) => {
    const spend = spendByCampaign && r.campaignRef ? spendByCampaign[r.campaignRef] || null : null;
    const paying = attributedCustomers && r.campaignRef ? attributedCustomers[r.campaignRef] || 0 : null;
    const cac = spend && spend.amountGbp !== null && paying ? Math.round((spend.amountGbp / paying) * 100) / 100 : null;
    return {
      ...r,
      spend: spendByCampaign ? spend : { amountGbp: null, provenance: 'NOT_CONNECTED' },
      payingCustomers: paying,
      cac,
    };
  });
  rows.sort((a, b) => b.landingVisits + b.registrationsCompleted - (a.landingVisits + a.registrationsCompleted));

  const chain = [
    { stage: 'Campaign spend', status: spendByCampaign ? 'CONNECTED' : 'NOT_CONNECTED', note: spendByCampaign ? 'From ledger advertising entries' : 'Needs ledger (048) + manual costs (050) or ad-platform import' },
    { stage: 'Visits (/go, homepage)', status: 'ACTUAL', note: 'Raw server-side page requests with UTMs — not unique visitors; bots not filtered' },
    { stage: 'Store clicks', status: 'NOT_CONNECTED', note: 'Store buttons are plain links today; /go/store redirect designed (§9.3), not built' },
    { stage: 'Signups', status: 'PARTIAL', note: 'Web registration events carry UTMs but are not linked to the household created; app signups carry none' },
    { stage: 'Paying customers by campaign', status: attributedCustomers ? 'CONNECTED' : 'NOT_CONNECTED', note: 'Needs customer_acquisition (migration 049)' },
    { stage: 'Revenue / contribution by campaign', status: 'NOT_CONNECTED', note: 'Needs customer_acquisition + ledger revenue by household' },
    { stage: 'CAC', status: spendByCampaign && attributedCustomers ? 'CONNECTED' : 'NOT_CONNECTED', note: 'Spend ÷ attributed new paying customers — shown only when both exist' },
  ];

  return {
    rows,
    unattributed: {
      checkoutsStarted: unattributedCheckouts,
      paidConversions: unattributedPaidConversions,
      note: 'Checkout and payment events record the household but no campaign, so they cannot be credited to any campaign.',
    },
    chain,
  };
}

// Pure — a tracked /go link using the published convention (§9.2).
function buildTrackedGoLink(baseUrl, { source, medium, campaign, content, term }) {
  const params = new URLSearchParams();
  const put = (k, v) => { const c = clean(v); if (c) params.set(k, c.replace(/\s+/g, '-')); };
  put('utm_source', source);
  put('utm_medium', medium);
  put('utm_campaign', campaign);
  put('utm_content', content);
  put('utm_term', term);
  const qs = params.toString();
  return `${String(baseUrl || '').replace(/\/+$/, '')}/go${qs ? '?' + qs : ''}`;
}

function resolveSupabaseAdmin() {
  try {
    return require('../supabaseClients').supabaseAdmin;
  } catch (err) {
    return null;
  }
}

// Observational, live-events-only in this deployable: advertising spend
// (ledger, 048) and household attribution (customer_acquisition, 049) are
// not read at all, so spend, paying customers and CAC per campaign are
// always NOT CONNECTED here. Wiring them is a separate change once those
// migrations exist.
async function getCampaignPerformance(now = new Date(), days = 90) {
  const supabaseAdmin = resolveSupabaseAdmin();
  if (!supabaseAdmin) return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };
  const since = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();

  const eventsRes = await supabaseAdmin
    .from('acquisition_events')
    .select('event_type, utm_source, utm_medium, utm_campaign, referrer_host, created_at')
    .gte('created_at', since)
    .limit(10000);
  if (eventsRes.error) return { available: false, reason: eventsRes.error.message };

  return {
    available: true,
    generatedAt: now.toISOString(),
    windowDays: days,
    ledgerConnected: false,
    attributionConnected: false,
    ...computeCampaignPerformance({ events: eventsRes.data || [], spendByCampaign: null, attributedCustomers: null }),
  };
}

module.exports = {
  normaliseCampaignRef,
  deriveChannel,
  computeCampaignPerformance,
  buildTrackedGoLink,
  getCampaignPerformance,
};
