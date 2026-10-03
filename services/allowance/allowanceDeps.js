// allowanceDeps.js — the production data dependencies for the customer
// allowance read model and the warning sender: Financial Fortress reads
// (056) plus the 062 credit, live-session and delivery tables. One place,
// so every surface reads identically.
'use strict';

const financialSafetyDb = require('../../database/financialSafety');
const customerAllowanceDb = require('../../database/customerAllowance');
const { getActiveEntitlement, getSubscriptionByHouseholdId } = require('../../database/billing');
const { getCustomerAllowance } = require('./customerAllowance');

const allowanceReadDeps = {
  ...financialSafetyDb,
  listAllowanceCredits: customerAllowanceDb.listAllowanceCredits,
  countLiveMonitoringSessions: customerAllowanceDb.countLiveMonitoringSessions,
  // Used only when ALLOWANCE_SOURCE=fortress.
  getFortressHouseholdStatus: customerAllowanceDb.getFortressHouseholdStatus,
};

async function getHouseholdById(id) {
  const { supabaseAdmin } = require('../supabaseClients');
  if (!supabaseAdmin) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  const { data, error } = await supabaseAdmin.from('households').select('id, email').eq('id', id).maybeSingle();
  if (error) throw new Error(`getHouseholdById failed: ${error.message || error}`);
  return data;
}

// Re-reads the household's CURRENT allowance before a warning is sent, so
// a stale or superseded warning is suppressed rather than delivered.
async function getCurrentAllowance(household) {
  const entitlement = await getActiveEntitlement(household.id);
  if (!entitlement) return null;
  const subscription = entitlement.source === 'stripe' ? await getSubscriptionByHouseholdId(household.id) : null;
  return getCustomerAllowance({ household, entitlement, subscription, platform: 'unknown', deps: allowanceReadDeps });
}

const allowanceNoticeWorkerDeps = {
  claimNoticeBatch: customerAllowanceDb.claimNoticeBatch,
  completeNoticeDelivery: customerAllowanceDb.completeNoticeDelivery,
  getHouseholdById,
  getCurrentAllowance,
};

module.exports = { allowanceReadDeps, allowanceNoticeWorkerDeps };
