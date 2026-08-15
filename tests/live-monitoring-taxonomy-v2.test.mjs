// Regression coverage for the 2026-08-16 evidence-based taxonomy update
// (NCSC, gov.uk/HMRC, Take Five to Stop Fraud, UK Finance, Action Fraud,
// Met Police, FCA, HSBC/Which?/Cifas — see the research review this is
// built from). Covers:
//   1. New standalone red lines: physical_collection_request,
//      gift_card_payment_request, cryptocurrency_payment_request,
//      verification_call_interception, stay_connected_during_money_transfer
//   2. Broadened financial_redirection paraphrase coverage
//   3. authority_threat: progressive-only alone, RED LINE only combined
//      with another critical signal
//   4. Identity-only stays Level 1 (context only), never critical
//   5. Protective exclusions (independently-sourced verification advice)
//   6. A genuine multi-stage conversation moving through the 0-25 /
//      26-59 / 60+ progressive bands, and a separate case proving a
//      red-line terminates regardless of the numerical score at that
//      moment
//
// Run with: node tests/live-monitoring-taxonomy-v2.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractCriticalSignals } = require('../services/liveMonitoring/scoring/criticalSignals.js');
const { scoreTranscript } = require('../services/liveMonitoring/scoring/scorer.js');
const { THRESHOLDS } = require('../services/liveMonitoring/scoring/thresholds.js');
const { createCallMonitor } = require('../services/liveMonitoring/riskMonitor.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function hasSignal(text, id) {
  return extractCriticalSignals(text).criticalSignals.some(s => s.id === id);
}

function makeFakeSmsClient() {
  const calls = [];
  return { calls, messages: { create: async (p) => { calls.push(p); return { sid: 'SM_test' }; } } };
}

async function run() {
  // ============================================================
  // 1. New standalone red lines
  // ============================================================

  // --- physical_collection_request ---
  check(hasSignal('Someone will come round to collect your card.', 'physical_collection_request'), 'physical_collection_request: "Someone will come round to collect your card."');
  check(hasSignal("Have your card ready, a courier's on the way.", 'physical_collection_request'), 'physical_collection_request: "Have your card ready, a courier\'s on the way."');
  check(hasSignal('Post the card to this address.', 'physical_collection_request'), 'physical_collection_request: "Post the card to this address."');
  check(hasSignal('Wait for someone to collect your cash.', 'physical_collection_request'), 'physical_collection_request: "Wait for someone to collect your cash."');
  check(
    !hasSignal('The parcel courier will drop it at your door.', 'physical_collection_request'),
    'physical_collection_request: an ordinary parcel delivery, no card/cash context, must NOT match'
  );
  check(
    !hasSignal('Someone will come round for a cup of tea later.', 'physical_collection_request'),
    'physical_collection_request: an ordinary social visit must NOT match'
  );

  // --- gift_card_payment_request ---
  check(hasSignal('Pay using Google Play gift cards.', 'gift_card_payment_request'), 'gift_card_payment_request: "Pay using Google Play gift cards."');
  check(hasSignal('Buy some iTunes cards and read me the codes.', 'gift_card_payment_request'), 'gift_card_payment_request: "Buy some iTunes cards and read me the codes."');
  check(hasSignal('Can you purchase some Amazon vouchers for this?', 'gift_card_payment_request'), 'gift_card_payment_request: "purchase some Amazon vouchers"');
  check(
    !hasSignal('I got you a gift card for your birthday, hope you like it.', 'gift_card_payment_request'),
    'gift_card_payment_request: an ordinary birthday gift-card mention must NOT match'
  );

  // --- cryptocurrency_payment_request ---
  check(hasSignal('Send it as Bitcoin.', 'cryptocurrency_payment_request'), 'cryptocurrency_payment_request: "Send it as Bitcoin."');
  check(hasSignal('Please pay via cryptocurrency instead.', 'cryptocurrency_payment_request'), 'cryptocurrency_payment_request: "pay via cryptocurrency"');
  check(
    !hasSignal('Bitcoin has been in the news a lot lately.', 'cryptocurrency_payment_request'),
    'cryptocurrency_payment_request: an ordinary mention of Bitcoin as a topic must NOT match'
  );

  // --- verification_call_interception ---
  check(
    hasSignal("I'll stay on the line while you call your bank to verify me.", 'verification_call_interception'),
    'verification_call_interception: "I\'ll stay on the line while you call your bank to verify me."'
  );
  check(
    hasSignal('Stay on the line while you call 159.', 'verification_call_interception'),
    'verification_call_interception: "Stay on the line while you call 159."'
  );
  check(
    hasSignal('Keep me on the line while you call the police.', 'verification_call_interception'),
    'verification_call_interception: "Keep me on the line while you call the police."'
  );
  check(
    !hasSignal('Stay on the line while I check your appointment.', 'verification_call_interception'),
    'verification_call_interception: "Stay on the line while I check your appointment." must NOT match (legitimate hold)'
  );
  check(
    !hasSignal('Stay on the line while I transfer you to another department.', 'verification_call_interception'),
    'verification_call_interception: "Stay on the line while I transfer you to another department." must NOT match (legitimate transfer)'
  );

  // --- stay_connected_during_money_transfer ---
  check(
    hasSignal("Don't hang up while you transfer the money.", 'stay_connected_during_money_transfer'),
    'stay_connected_during_money_transfer: "Don\'t hang up while you transfer the money."'
  );
  check(
    !hasSignal('Stay on the line while I transfer you to another department.', 'stay_connected_during_money_transfer'),
    'stay_connected_during_money_transfer: "...while I transfer you..." (call transfer, not money) must NOT match'
  );
  check(
    !hasSignal('Please transfer the money to Dave for the shared bill.', 'stay_connected_during_money_transfer'),
    'stay_connected_during_money_transfer: an ordinary money-transfer request with no isolation clause must NOT match'
  );

  // ============================================================
  // 2. Broadened financial_redirection
  // ============================================================
  check(hasSignal('Please move it into a safe account.', 'financial_redirection'), 'financial_redirection: "move it into a safe account"');
  check(hasSignal('Transfer your savings somewhere secure.', 'financial_redirection'), 'financial_redirection: "transfer your savings somewhere secure"');
  check(hasSignal('Put the funds into another account.', 'financial_redirection'), 'financial_redirection: "put the funds into another account"');
  check(hasSignal('We need you to transfer your money to a safe account.', 'financial_redirection'), 'financial_redirection: original literal phrasing still matches');
  check(
    !hasSignal('Your standing order moves to a new account next month.', 'financial_redirection'),
    'financial_redirection: "moves" (not the base verb "move") in an unrelated context must NOT match'
  );

  // ============================================================
  // 3. authority_threat: progressive-only alone, RED LINE combined
  // ============================================================
  {
    const alone = scoreTranscript("There's a warrant out for your arrest.", null);
    check(
      alone.riskIndicators.some(r => r.id === 'authority_threat'),
      'authority_threat: fires progressively on "There\'s a warrant out for your arrest."'
    );
    const criticalAlone = extractCriticalSignals("There's a warrant out for your arrest.");
    check(criticalAlone.hasCriticalSignal === false, 'authority_threat ALONE is not a red line — Level 3, not Level 4');
  }
  check(
    hasSignal('You will be arrested unless you transfer your money to a safe account.', 'authority_threat') &&
    extractCriticalSignals('You will be arrested unless you transfer your money to a safe account.').hasCriticalSignal === true,
    'authority_threat COMBINED with financial_redirection triggers a RED LINE'
  );
  check(
    extractCriticalSignals('Bailiffs will be sent unless you give me your PIN number now.').hasCriticalSignal === true,
    'authority_threat COMBINED with credential_or_otp_request triggers a RED LINE'
  );
  check(
    extractCriticalSignals("You'll be prosecuted — don't tell your family about this call.").hasCriticalSignal === true,
    'authority_threat COMBINED with isolation_from_family triggers a RED LINE'
  );

  // ============================================================
  // 4. Identity remains context only
  // ============================================================
  for (const line of ["I'm calling from Barclays.", 'This is HMRC.', "I'm from the police.", "I'm calling from BT about your broadband."]) {
    const result = extractCriticalSignals(line);
    check(result.hasCriticalSignal === false, `identity alone stays Level 1 (no critical signal): "${line}"`);
  }

  // ============================================================
  // 5. Protective exclusions
  // ============================================================
  check(
    extractCriticalSignals('Hang up and independently call the number on the back of your bank card.').hasCriticalSignal === false,
    'protective: "Hang up and independently call the number on the back of your bank card." stays safe'
  );
  check(
    extractCriticalSignals('Hang up and independently call 159.').hasCriticalSignal === false,
    'protective: "Hang up and independently call 159." stays safe'
  );
  check(
    hasSignal("Call this number I'm giving you to prove I'm from the bank.", 'directed_verification_callback'),
    'red line: "Call this number I\'m giving you to prove I\'m from the bank." (caller-supplied number)'
  );

  // ============================================================
  // 6. Progressive conversation moving through the risk bands
  // ============================================================

  // --- 0-25: low risk, stays low across a benign call ---
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({ callSid: 'CA-band-low', householdId: 'h-low', smsClient, toNumber: '+447700900001', fromNumber: '+441615700779' });
    const lines = [
      "Hi, it's Dave from next door.",
      'Just wondering if you still have my ladder.',
      'No worries if not, I can pop round later.',
    ];
    let last;
    for (const line of lines) last = await monitor.handleTranscribedChunk(line);
    check(last.riskScore <= THRESHOLDS.SAFE_MAX, `band 0-25: benign conversation stays at/below SAFE_MAX (scored ${last.riskScore})`);
    check(monitor.hasSentWarning() === false, 'band 0-25: no warning ever sent');
  }

  // --- 26-59: suspicious/developing risk, below the warning threshold ---
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({ callSid: 'CA-band-mid', householdId: 'h-mid', smsClient, toNumber: '+447700900002', fromNumber: '+441615700779' });
    const lines = [
      "Hello, I'm calling from your bank.",
      'We need to sort this out today.',
      "There's a processing fee involved.",
    ];
    let last;
    for (const line of lines) last = await monitor.handleTranscribedChunk(line);
    check(
      last.riskScore > THRESHOLDS.SAFE_MAX && last.riskScore < THRESHOLDS.LIVE_MONITORING_WARN_MIN,
      `band 26-59: developing suspicion stays between SAFE_MAX and the warning threshold (scored ${last.riskScore})`
    );
    check(monitor.hasSentWarning() === false, 'band 26-59: no warning sent yet, correctly still "developing"');
  }

  // --- 60+: high risk, customer warning fires ---
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({ callSid: 'CA-band-high', householdId: 'h-high', smsClient, toNumber: '+447700900003', fromNumber: '+441615700779' });
    const lines = [
      "Hello, I'm calling from your bank.",
      'We need to sort this out today.',
      'Please confirm your one time passcode now.',
    ];
    let last;
    for (const line of lines) last = await monitor.handleTranscribedChunk(line);
    check(last.riskScore >= THRESHOLDS.LIVE_MONITORING_WARN_MIN, `band 60+: escalates past the warning threshold (scored ${last.riskScore})`);
    check(monitor.hasSentWarning() === true, 'band 60+: warning sent');
  }

  // --- red line terminates regardless of the numerical score at that moment ---
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({ callSid: 'CA-red-line-low-score', householdId: 'h-redline', smsClient, toNumber: '+447700900004', fromNumber: '+441615700779' });

    // Opens with pure identity (score 0), then goes straight to a red
    // line with almost no progressive build-up at all.
    const first = await monitor.handleTranscribedChunk("Hi, I'm calling from your bank.");
    check(first.riskScore === 0, 'red-line-at-low-score: opening identity line scores 0');
    check(first.criticalTriggeredThisCall === false, 'red-line-at-low-score: no critical trigger yet');

    const second = await monitor.handleTranscribedChunk('Someone will come round to collect your card.');
    check(second.criticalTriggeredThisCall === true, 'red-line-at-low-score: RED LINE triggers on the very next line');
    check(
      second.riskScore < THRESHOLDS.LIVE_MONITORING_WARN_MIN,
      `red-line-at-low-score: progressive score at termination is only ${second.riskScore} — well below the 60 warning threshold, proving termination is independent of the numerical score`
    );
    check(second.criticalSignalIds.includes('physical_collection_request'), 'red-line-at-low-score: correct critical signal ID recorded');
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll live-monitoring taxonomy-v2 checks passed.');
  }
}

run();
