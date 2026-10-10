# Test A: your checklist (Motorola + iPhone, about 45 minutes)

**Not started.** We begin only when you message "both phones ready, start Test A".

**Rules for the session:**
- Carrier voicemail only. No HCG or Twilio numbers, and nothing chargeable.
- At most 10 calls.
- Stop the moment anything unexpected happens.
- Everything is put back exactly as it was at the end.

**What we are finding out:** when the test app *silences* a stranger's call, does Lebara still send it to voicemail after the normal ring time? (Contacts should ring as usual.)

---

## Before we start
- [ ] Motorola charged, unlocked, connected to the Mac by USB.
- [ ] iPhone charged; you'll use it to make the calls.
- [ ] Note: during the test the Motorola will **not** get Home Call Guard protection. Put back at the end.

## Step 1: Record the Motorola's current settings (nothing changes)

On the Motorola's Phone app, dial each code and press Call. Screenshot each result.

| Dial | What it shows | Write down |
|---|---|---|
| `*#21#` | "Always forward" | on or off, and **the full number if on** (that is HCG; needed to restore) |
| `*#61#` | "Forward when not answered" | the **voicemail number** and **seconds** |
| `*#43#` | Call waiting | on or off |

Also note:
- [ ] Settings › Apps › Default apps › **Caller ID & spam app**: what is selected?
- [ ] Is the iPhone saved in the Motorola's Contacts?

➡ **Stop here if `*#61#` is not a voicemail number.** There is nothing to test.

## Step 2: Prepare (I guide you; I run the Mac commands)

1. **Only if always-forward was on:** dial `#21#`, then `*#21#`. It must now say *off*. Dial `*#61#` again; it must be unchanged.
2. Turn on USB debugging (I'll talk you through it), and accept the Mac's prompt on the phone.
3. I check the test app's fingerprint and install it on the Motorola.
4. Open **HCG Divert Probe** → tap **"Make this the call-screening app"** → accept. It should say **"Screening role held: YES"**.
5. Make sure the iPhone is **not** saved in the Motorola's Contacts.

## Step 3: The calls (iPhone → Motorola; never leave a message, hang up at the voicemail greeting)

For each call, tell me **how many seconds** until the voicemail greeting, and **what you heard** on the iPhone.

| # | On the Motorola | Call from the iPhone | Expected |
|---|---|---|---|
| 1 | App set to **OBSERVE** | Call, don't answer | Motorola **rings**; voicemail after the usual time |
| 2 | App set to **SILENCE** | Call, don't touch the Motorola | Motorola **does not ring**; iPhone hears ringing, then **voicemail after the usual time** |
| 3 | (same) | Call again | Same as call 2 |
| 4 | (same) | Call again | Same as call 2 |
| 5 | Save the iPhone **as a contact** | Call; answer on the Motorola, then hang up | Motorola **rings normally** |
| 6 | Delete the contact again; I stop the app from the Mac | Call, don't touch | Voicemail after the usual time (it may ring); **never busy or cut off** |

✅ **Calls 2–4 decide it.** Voicemail at the usual time means **PASS**. Busy, "not available" or cut off early means **FAIL**.

**Stop immediately and tell me if:**
- the **Home Call Guard app** rings on any phone;
- a contact's call doesn't ring;
- you hear any message about charges or "invalid code";
- or anything else looks wrong.

## Step 4: Put everything back (always, even after a stop)

1. I uninstall the test app from the Mac and confirm it's gone.
2. **Caller ID & spam app**: set back to what you wrote in Step 1.
3. Contacts: the iPhone saved or not, exactly as before.
4. Turn USB debugging off.
5. **Only if always-forward was on:** dial `**21*` + the number you wrote down + `#`, then `*#21#`. It must show that number again (Home Call Guard protection restored).
6. Dial `*#21#` and `*#61#`. Both must match Step 1. Screenshot.
7. One last call from the iPhone: the Motorola behaves exactly as it did before the test.

**Done.** I write up the result (no phone numbers in the report) and tell you whether Test B is worth running.
