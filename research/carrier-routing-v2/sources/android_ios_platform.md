# R1 (Android) / R2 (iPhone) desk research — 2026-10-03

Labels: **PUBLISHED** = stated in official doc/AOSP source opened today. **INFERRED** = follows from that source but not stated/tested. **UNKNOWN** = no official source found.
No device tests run. AOSP = `refs/heads/main` as of 2026-10-03 (OEM builds may differ).

## ANDROID

### 1. CallScreeningService (current main; no Android 16/17 changes found)
- **PUBLISHED** CallResponse.Builder setters: `setDisallowCall`, `setRejectCall` ("disconnected as if the user had manually rejected it… should only be set to true if the call is disallowed"), `setSilenceCall` (only when not disallowed), `setSkipCallLog`, `setSkipNotification`, `setShouldScreenCallViaAudioProcessing` (@SystemApi, CAPTURE_AUDIO_OUTPUT, "only honored if… same uid as the system dialer"), `setCallComposerAttachmentsToShow` (no effect unless the service is the system dialer package). No @FlaggedApi or new setters on main. [CSS.java]
- **PUBLISHED, new vs prior notes** `setSkipCallLog`: "Only the carrier and system call screening apps can use this parameter; this parameter is ignored otherwise." Telecom's `packageTypeShouldAdd()` forces call-log entry for non-carrier packages. **So every HCG-rejected call stays in the user's call log as BLOCKED_TYPE** (`BLOCK_REASON_CALL_SCREENING_SERVICE`). `setSkipNotification` is honoured. [CSS.java, CallScreeningServiceFilter.java]
- **PUBLISHED** No package-type restriction on reject: for `shouldDisallowCall`, the filter sets `setShouldReject(response.shouldRejectCall())` for USER_CHOSEN as for others. CallsManager then calls `incomingCall.reject(false, null)`, with no reason argument. That confirms the plain decline path. [CallScreeningServiceFilter.java, CallsManager.java]
- **PUBLISHED** Disallow + no reject: CallsManager logs it and shows a notification but does not call reject. **INFERRED:** the leg is then left unanswered at the network, so **CFNRy (**61*)** rather than CFB is the network fallback. This is a possible plan B if a vendor maps decline to 603 (no CFB). It adds ring-out delay and is untested.
- **PUBLISHED** 5 s: "must respond… within 5 seconds… After this time, the framework will unbind… and ignore its response". The device doesn't ring until response or timeout, so the timeout fails open. `CALL_SCREENING_FILTER_TIMEOUT = 5000`. If binding fails, the prior stage result is kept (fail-open).
- **PUBLISHED** Calls passed to the screener: SCHEME_TEL only; "only calls which are not in the user's contacts are passed… unless… READ_CONTACTS". Calls with RESTRICTED/UNKNOWN/UNAVAILABLE/PAYPHONE presentation "are not provided". (Main has no version qualifier.) The Details are limited to direction, **getCallerNumberVerificationStatus**, connect/creation time and handle.
  - **INFERRED (sharpening):** without READ_CONTACTS, contacts ring natively and are never seen. That is a free "trusted" path. **Withheld/unknown-CLI calls are never screened, so they ring natively and can't be diverted to HCG.** This is a structural R1 gap for scammers who withhold CLI. UK STIR/SHAKEN isn't deployed, so expect `VERIFICATION_STATUS_NOT_VERIFIED`; don't rely on it. That status point is INFERRED and not UK-documented.
- **INFERRED (logical):** screening is Telecom-side, on a call the modem has already received. With network CFU active, the INVITE never reaches the handset, so screening can't act. Under R1, CFU must be OFF.
- **PUBLISHED** Filter order (CallsManager.setUpCallFilterGraph): DirectToVoicemail + BlockChecker (system block list) → carrier screening app → **either** the user-chosen ROLE_CALL_SCREENING app **or** the default dialer's screening service, never both. See §4.

### 2. Programmatic call forwarding
- **PUBLISHED** `TelephonyManager.setCallForwarding` and `setCallWaitingEnabled` are `@SystemApi @hide` with `MODIFY_PHONE_STATE`. `getCallForwarding` is `@SystemApi` with `READ_PRIVILEGED_PHONE_STATE`. `CallForwardingInfo` (REASON_BUSY=1 etc.) is `@SystemApi`. `handlePinMmi` is @SystemApi. `TelecomManager.handleMmi` needs MODIFY_PHONE_STATE and "the system dialer". **A Play app can't use any of these and can't read CF state.**
- **PUBLISHED, useful:** the `TelecomManager.placeCall` doc says "Call Forwarding MMI codes can only be dialed by applications that are… default dialer or system dialer… If [placed by another app], the dialer will be launched with a UI showing the MMI code already populated so that the user can confirm." The supported UX is therefore: HCG pre-fills `**67*<HCG>#` (and `##21#`) and the user taps once.
- **INFERRED, do not rely on it:** `sendUssdRequest` needs only CALL_PHONE. In AOSP, PhoneInterfaceManager → GsmCdmaPhone/ImsPhone.handleUssdRequest → `dialInternal` → `GsmMmiCode.processCode()`, with no filter that restricts it to USSD. An SS code like `**67*…#` therefore appears to be executed silently. That's a loophole that bypasses the placeCall confirmation. Behaviour and callback results are unverified. It's gated by carrier config (`isUssdApiAllowed`) and likely varies by OEM. It's also a Play-policy and deception risk, so treat it as off-limits unless Google confirms.

### 3. Google Play policy
- **PUBLISHED** (SMS/Call Log policy): apps must be the default SMS/Phone/Assistant handler before requesting Call Log or SMS permissions. The exception list includes **"Caller ID, spam detection, and/or spam blocking"**, which permits READ_CALL_LOG and PROCESS_OUTGOING_CALLS via the Permissions Declaration Form. The page doesn't mention ROLE_CALL_SCREENING. READ_CONTACTS isn't in this restricted group; it's an ordinary runtime permission.
- **UNKNOWN:** I found no Play policy text that restricts CallScreeningService rejecting calls or "auto-reject" apps. I also found no specific Play policy for the call-screening role. R1 shouldn't need READ_CALL_LOG.

### 4. Screening role vs Google Phone spam filtering
- **PUBLISHED (AOSP):** if a user-chosen screening app is set and it isn't the default dialer, the default dialer's CallScreeningService **is not bound**. HCG replaces Google Phone's screening-service stage, and the carrier stage still runs first.
- **UNKNOWN:** Google Phone's "Filter spam calls" or automatic Call Screen may run in its InCallService/dialer layer, not the screening stage, after the call is allowed. If so, it could still screen or answer a "trusted" call that HCG allowed. Google's help page says only that "Filter spam calls" is absent on devices with automatic Call Screen. It says nothing about third-party role interaction. A device test is needed.

### 5. Samsung One UI
- **PUBLISHED (samsung.com):** the Samsung Phone app has its own "Caller ID and spam protection" with "Block spam and scam calls". **UNKNOWN:** I found no official Samsung doc on third-party ROLE_CALL_SCREENING support or known issues. Telecom is AOSP, so the role should work. Whether Samsung's own blocking runs as the dialer screening stage (and is displaced) or elsewhere is untested.

## iOS

### 6. iOS 27 is current (iPhone User Guide defaults to iOS 27; LiveAssistance APIs are "iOS 27.1 beta")
- **PUBLISHED** Settings > Apps > Phone > Screen Unknown Callers: **Never / Ask Reason for Calling / Silence**. Silence: "Calls from unsaved numbers will be silenced, sent to voicemail, and appear in the Recents list." The Call Screening description says it "automatically answers calls from unknown numbers". Other options are an Unknown Callers list filter, a carrier-flagged Spam filter (silenced to voicemail), and "Mark as Known" in the Unknown Callers list (a manual, user-only action).
- **PUBLISHED** (HT 111106, published 17 Sep 2026): "If you're roaming, phone calls are not screened, regardless of settings." So **R2 protection switches off while roaming**. "If you call the emergency services, call screening turns off for 24 hours."
- **PUBLISHED** Call Screening and Live Voicemail list English (United Kingdom) as available.
- **UNKNOWN:** the official definition of "known". The current guide says only "unsaved numbers". Recent outgoing and Siri Suggestions come from older/secondary sources and aren't re-confirmed.
- **UNKNOWN:** whether "Silence → voicemail" makes the iPhone signal decline/busy (which triggers CFB) or just not alert (CFNRy). **INFERRED risk:** if Live Voicemail is on, silenced calls are probably answered on-device, and **Ask Reason answers on-device by design**. Either way the network never sees busy or no-reply, so HCG never gets the call. R2 must specify Silence + Live Voicemail OFF, and that needs a device test.
- **PUBLISHED:** no API reads these settings. CallKit's latest update note is June 2025 (translation). LiveCommunicationKit's June 2025 note adds the default **dialer** app: outgoing cellular via `StartCellularConversationAction`, EU-only testing, and history access. LiveAssistance (iOS 27.1 beta) is for FaceTime only. Call Directory and Live Caller ID Lookup (PIR, Apple relay, Apple endpoint validation) can identify or **block listed numbers** only. **No API rejects, diverts or answers an incoming cellular call based on an allowlist.** Network-side behaviour for blocked numbers isn't documented (UNKNOWN). Blocklists can't express "everyone except trusted".

### 7. UK CMA interoperability channel
- **PUBLISHED:** the CMA accepted Apple's final commitments on 1 Apr 2026, effective that day. The channel is a web questionnaire for developers whose Apple Developer account is **registered in the UK**. Apple "will endeavour" to say within **4 weeks** whether a request is eligible, and to answer status queries within 2 weeks. Eligible scope is "equivalent system and hardware functionality used by Apple services". Apple's Phone app Call Screening and Silence decline or answer cellular calls, which is arguably in scope (INFERRED). Apple makes no commitment to build anything or to a timeframe, and it could charge a fee. An annual UK transparency report is due each summer. developer.apple.com/support/interoperability-requests is live for non-EU developers (Feedback Assistant form). The CMA case page has no later interoperability update (latest: NFC call for evidence on 30 Jun 2026, steering responses on 14 Aug 2026).

## Sources opened (2026-10-03)
- https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/telecomm/java/android/telecom/CallScreeningService.java
- https://android.googlesource.com/platform/packages/services/Telecomm/+/refs/heads/main/src/com/android/server/telecom/callfiltering/CallScreeningServiceFilter.java
- https://android.googlesource.com/platform/packages/services/Telecomm/+/refs/heads/main/src/com/android/server/telecom/CallsManager.java
- https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/telecomm/java/android/telecom/TelecomManager.java
- https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/telecomm/java/android/telecom/Call.java
- https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/telephony/java/android/telephony/TelephonyManager.java
- https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/telephony/java/android/telephony/CallForwardingInfo.java
- https://android.googlesource.com/platform/frameworks/opt/telephony/+/refs/heads/main/src/java/com/android/internal/telephony/GsmCdmaPhone.java
- https://android.googlesource.com/platform/frameworks/opt/telephony/+/refs/heads/main/src/java/com/android/internal/telephony/imsphone/ImsPhone.java
- https://android.googlesource.com/platform/frameworks/opt/telephony/+/refs/heads/main/src/java/com/android/internal/telephony/gsm/GsmMmiCode.java
- https://android.googlesource.com/platform/packages/services/Telephony/+/refs/heads/main/src/com/android/phone/PhoneInterfaceManager.java
- https://developer.android.com/about/versions/16/behavior-changes-all, …/16/behavior-changes-16, …/17/behavior-changes-all, …/17/behavior-changes-17 (no telecom/screening/MMI mentions)
- https://developer.android.com/reference/android/telecom/CallScreeningService(.CallResponse.Builder) (fetch truncated, so AOSP source was used instead)
- https://support.google.com/googleplay/android-developer/answer/10208820 ; https://support.google.com/googleplay/android-developer/answer/9047303
- https://support.google.com/phoneapp/answer/3459196
- https://www.samsung.com/ca/support/mobile-devices/manage-call-settings-on-your-galaxy-phone (search snippet only)
- https://support.apple.com/en-gb/111106
- https://support.apple.com/en-gb/guide/iphone/welcome/ios ; https://support.apple.com/en-gb/guide/iphone/iphe4b3f7823/ios
- https://www.apple.com/ios/feature-availability/
- https://developer.apple.com/documentation/callkit , /updates/callkit , /callkit/identifying-and-blocking-calls
- https://developer.apple.com/documentation/livecommunicationkit , /updates/livecommunicationkit , /livecommunicationkit/liveassistance , /liveassistanceextension , /preparing-your-app-to-be-the-default-dialer-app
- https://developer.apple.com/documentation/identitylookup , /identitylookup/getting-up-to-date-calling-and-blocking-information-for-your-app , /livecalleridlookupextensioncontext
- https://developer.apple.com/support/interoperability-requests
- https://www.gov.uk/cma-cases/apples-mobile-platform
- https://www.apple.com/legal/dmcca/dmcca-commitments.pdf
