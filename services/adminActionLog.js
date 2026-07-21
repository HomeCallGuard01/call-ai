// In-memory record of admin actions taken through the Operations
// Dashboard (e.g. a manual provisioning retry) — deliberately not a
// database table: Sprint 11's requirement is no schema changes, and a
// full audit log is a larger feature than "show recent admin actions" on
// its own calls for. Scoped honestly: resets on every server restart, and
// the UI labels it as such rather than implying more persistence than
// this actually has.
const MAX_ENTRIES = 20;

let actions = [];

function recordAdminAction(action) {
  actions.unshift({ ...action, at: new Date().toISOString() });
  actions = actions.slice(0, MAX_ENTRIES);
}

function getRecentAdminActions() {
  return actions;
}

module.exports = { recordAdminAction, getRecentAdminActions };
