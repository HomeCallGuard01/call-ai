// releaseInfo.js — the Production Release panel (2026-09 dashboard
// build). Backend commit/deployment info is read from Railway's own
// auto-injected environment variables where Railway provides them
// (RAILWAY_GIT_COMMIT_SHA, RAILWAY_GIT_BRANCH, RAILWAY_DEPLOYMENT_ID,
// RAILWAY_ENVIRONMENT_NAME — a documented Railway platform feature,
// requiring no manual configuration) — reported as UNCONFIRMED rather
// than guessed if they're absent, since this app cannot independently
// verify them without Railway API access.
//
// Mobile app version has no live-queryable source from this backend at
// all — there is no API call the server can make to ask "what's on Play
// Store/App Store right now." The two values below are the last
// confirmed-via-EAS-build-record figures from this project's own build
// history (2026-09-03 investigation), stored as static configuration
// with their own confirmation date — never presented as a live check.
'use strict';

function getBackendReleaseInfo(env = process.env) {
  return {
    gitCommitSha: env.RAILWAY_GIT_COMMIT_SHA || null,
    gitCommitShaConfirmed: Boolean(env.RAILWAY_GIT_COMMIT_SHA),
    gitBranch: env.RAILWAY_GIT_BRANCH || null,
    deploymentId: env.RAILWAY_DEPLOYMENT_ID || null,
    environmentName: env.RAILWAY_ENVIRONMENT_NAME || (env.NODE_ENV === 'production' ? 'production (NODE_ENV only, Railway name UNCONFIRMED)' : 'UNCONFIRMED'),
    note: env.RAILWAY_GIT_COMMIT_SHA
      ? 'Read directly from Railway\'s own auto-injected deployment variables.'
      : 'RAILWAY_GIT_COMMIT_SHA is not present in this process\'s environment — UNCONFIRMED, not guessed.',
  };
}

// Static, dated reference values — see this file's own header. Override
// via env vars the moment a newer build is confirmed; never silently
// re-derived from anything live.
function getMobileReleaseInfo(env = process.env) {
  return {
    android: {
      versionCode: env.BUSINESS_ANDROID_VERSION_CODE || '4',
      appVersion: env.BUSINESS_ANDROID_APP_VERSION || '1.0.0',
      easBuildId: env.BUSINESS_ANDROID_EAS_BUILD_ID || 'd28a1f84-a8c8-4d37-a0aa-bf3134828eba',
      sourceCommit: env.BUSINESS_ANDROID_SOURCE_COMMIT || '878b767 (EAS-recorded)',
      confirmedAt: env.BUSINESS_ANDROID_CONFIRMED_AT || '2026-09-03 (EAS build record)',
      confidence: 'EAS build record confirmed; exact source-tree content vs 6e8f199 fix UNCONFIRMED (see 2026-09-03 verification report)',
    },
    ios: {
      appVersion: env.BUSINESS_IOS_APP_VERSION || '1.0.0',
      buildNumber: env.BUSINESS_IOS_BUILD_NUMBER || '8',
      easBuildId: env.BUSINESS_IOS_EAS_BUILD_ID || 'e02738ed-eb4d-45c2-b0c6-58b501b32be8',
      sourceCommit: env.BUSINESS_IOS_SOURCE_COMMIT || 'af2e85f1',
      confirmedAt: env.BUSINESS_IOS_CONFIRMED_AT || '2026-09-03 (EAS build record)',
      confidence: 'EAS build record only; Apple review/submission status UNCONFIRMED — no App Store Connect access from this environment',
    },
  };
}

module.exports = { getBackendReleaseInfo, getMobileReleaseInfo };
