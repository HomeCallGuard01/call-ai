// Resolve an accounting fact to an HCG household + permanent HCG account
// number (households.account_number, migration 062 — DRAFT; until it is
// applied every Stripe transaction is blocked with missing_account, which is
// the honest state).
//
// Order: explicit household id in Stripe metadata → Stripe customer id →
// RevenueCat app_user_id (= Supabase auth user id, mobile/lib/purchases.ts).
'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createSupabaseResolver(supabase) {
  let accountColumn = true;
  async function lookup(column, value) {
    const cols = accountColumn ? 'id, account_number' : 'id';
    let { data, error } = await supabase.from('households').select(cols).eq(column, value).limit(1);
    if (error && accountColumn && /account_number/.test(error.message || '')) {
      accountColumn = false; // 062 not applied in this database
      ({ data, error } = await supabase.from('households').select('id').eq(column, value).limit(1));
    }
    if (error) throw new Error(`household lookup failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : null;
    return row ? { householdId: row.id, accountNumber: row.account_number || null } : null;
  }
  return {
    async resolve(fact) {
      if (fact.householdHint && UUID.test(fact.householdHint)) {
        const r = await lookup('id', fact.householdHint);
        if (r) return r;
      }
      if (fact.stripeCustomerId) {
        const r = await lookup('stripe_customer_id', fact.stripeCustomerId);
        if (r) return r;
      }
      if (fact.authUserId && UUID.test(fact.authUserId)) {
        const r = await lookup('auth_user_id', fact.authUserId);
        if (r) return r;
      }
      return null;
    },
  };
}

module.exports = { createSupabaseResolver };
