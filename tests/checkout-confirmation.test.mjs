// Unit tests for the post-payment confirmation state machine in
// upload.html — added for the payment-completion-flow rebuild
// (docs/PROJECT_STATUS.md). Root cause of the incident this closes: no
// Stripe webhook endpoint was ever registered against production, so the
// dashboard stayed on "Not protected yet" indefinitely after a real,
// successful payment, while the payment button remained visible and could
// send a paying customer through checkout a second time.
//
// Two things are extracted from the real page markup (between
// TEST-EXTRACT markers) and executed standalone, no browser or DOM
// library required:
//   - shouldContinuePolling: the pure timing check that bounds the
//     reconciliation poll to a limited period (covers "delayed webhook").
//   - setStatus: the single function that controls which elements are
//     visible in each dashboard state, run against a minimal fake
//     document. This is what actually proves the core safety property —
//     that the subscribe button is never shown outside the "unsubscribed"
//     state, covering "duplicate-click/revisit" and "already-active
//     subscriber" behaviour at the state-machine level.
//
// Run with: node tests/checkout-confirmation.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'upload.html'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function extractBetween(source, name) {
  const startMarker = `// TEST-EXTRACT-START: ${name}`;
  const endMarker = `// TEST-EXTRACT-END: ${name}`;
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    return null;
  }
  return source.slice(startIdx + startMarker.length, endIdx);
}

// --- shouldContinuePolling: bounded reconciliation window ---

const pollingSource = extractBetween(html, 'shouldContinuePolling');

if (!pollingSource) {
  console.error('✗ could not find shouldContinuePolling markers in upload.html — test cannot run');
  failures++;
} else {
  const shouldContinuePolling = new Function(`${pollingSource}\nreturn shouldContinuePolling;`)();

  check(
    shouldContinuePolling(1000, 2000) === true,
    'polling continues while now is still before the deadline (webhook merely delayed, not yet timed out)'
  );

  check(
    shouldContinuePolling(2000, 2000) === false,
    'polling stops exactly at the deadline'
  );

  check(
    shouldContinuePolling(5000, 2000) === false,
    'polling stops once well past the deadline (webhook never arrived within the bounded window)'
  );
}

// --- setStatus: the actual visibility state machine ---

const statusSource = extractBetween(html, 'setStatus');

function makeFakeDocument() {
  const elements = {};
  function element(id) {
    if (!elements[id]) {
      elements[id] = { id, hidden: true, textContent: '', dataset: {} };
    }
    return elements[id];
  }
  return {
    elements,
    getElementById: element,
  };
}

if (!statusSource) {
  console.error('✗ could not find setStatus markers in upload.html — test cannot run');
  failures++;
} else {
  const fakeDocument = makeFakeDocument();
  global.document = fakeDocument;
  const setStatus = new Function(`${statusSource}\nreturn setStatus;`)();

  function elementsVisibility(state) {
    setStatus(state);
    return {
      subscribeForm: !fakeDocument.elements.subscribeForm.hidden,
      confirmingSpinner: !fakeDocument.elements.confirmingSpinner.hidden,
      successActions: !fakeDocument.elements.successActions.hidden,
      delayedActions: !fakeDocument.elements.delayedActions.hidden,
      protectedContent: !fakeDocument.elements.protectedContent.hidden,
    };
  }

  const unsubscribed = elementsVisibility('unsubscribed');
  check(unsubscribed.subscribeForm === true, 'unsubscribed: the payment button IS shown (the only state it should ever appear in)');

  for (const state of ['confirming', 'success', 'activation_delayed', 'protected', 'loading', 'unknown']) {
    const visibility = elementsVisibility(state);
    check(
      visibility.subscribeForm === false,
      `${state}: the payment button is NOT shown — a customer in this state can never be sent through checkout again`
    );
  }

  const confirming = elementsVisibility('confirming');
  check(confirming.confirmingSpinner === true, 'confirming: the spinner/progress indicator is shown');

  const success = elementsVisibility('success');
  check(success.successActions === true, 'success: the "Continue to setup" action is shown');
  check(success.confirmingSpinner === false, 'success: the spinner is no longer shown once activation is confirmed');
  check(
    fakeDocument.elements.statusTitle.textContent === 'Payment successful',
    'success state shows the exact required heading "Payment successful"'
  );

  const delayed = elementsVisibility('activation_delayed');
  check(delayed.delayedActions === true, 'activation_delayed: the safe retry/check-status action is shown');
  check(delayed.confirmingSpinner === false, 'activation_delayed: the spinner stops once the bounded wait has timed out');
  check(
    fakeDocument.elements.statusSub.textContent ===
      'We received your payment but activation is taking longer than expected. Please refresh in a moment or contact support.',
    'activation_delayed state shows the exact required fallback message'
  );

  const protectedState = elementsVisibility('protected');
  check(protectedState.protectedContent === true, 'protected: the normal dashboard content is shown');

  delete global.document;
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
