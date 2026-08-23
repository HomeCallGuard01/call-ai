Document: Branded Supabase Signup Confirmation Email — Ready to Paste
Status: DRAFT — ready for Andrew to paste into the Supabase Dashboard. Not applied anywhere (no Management API access from here to do this directly).
Last Updated: 2026-08-23
Owner: Andrew Deane

---

# Where to paste this

**Supabase Dashboard → your production project (`psbzynxplxfbyrbdidmn`) → Authentication → Email Templates → "Confirm signup"**

Replace the default template's HTML with the block below. Supabase's own template variable `{{ .ConfirmationURL }}` is used exactly where the default template uses it — no other config changes needed. Repeat for the staging project (`tigwgmayeuisrxjjykqd`) if you want staging signups branded too (not required for launch).

# Why this design

Matches the existing site's actual dark palette and logo exactly (`public/confirmed.html`, `public/dashboard.html`) — same background (`#0b1220`), card (`#111a2e`), accent green (`#00ff99`), body text (`#cbd5e1`), muted text (`#64748b`/`#94a3b8`). No new colours introduced, no marketing content added — just the existing brand applied to what is currently Supabase's generic default email.

# The template

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#0b1220; font-family:Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b1220; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:420px;" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding-bottom:16px;">
              <img src="https://www.homecallguard.co.uk/logo.png" alt="Home Call Guard" style="height:90px;">
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-bottom:8px;">
              <h1 style="margin:0; font-size:22px; color:#00ff99; font-family:Arial, Helvetica, sans-serif;">
                Confirm your email
              </h1>
            </td>
          </tr>
          <tr>
            <td style="background-color:#111a2e; border-radius:10px; padding:28px 24px; text-align:center;">
              <p style="margin:0 0 20px 0; color:#cbd5e1; font-size:15px; line-height:1.5;">
                Thanks for signing up for Home Call Guard. Confirm your email address to activate your account and start protecting your phone from scam calls.
              </p>
              <a href="{{ .ConfirmationURL }}"
                 style="display:inline-block; width:100%; max-width:280px; box-sizing:border-box; padding:14px 0; font-size:16px; font-weight:bold; border-radius:8px; background-color:#00ff99; color:#000000; text-decoration:none;">
                Confirm my email
              </a>
              <p style="margin:20px 0 0 0; color:#64748b; font-size:12px; line-height:1.5;">
                Button not working? Copy and paste this link into your browser:<br>
                <a href="{{ .ConfirmationURL }}" style="color:#94a3b8; word-break:break-all;">{{ .ConfirmationURL }}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="margin:0; color:#64748b; font-size:12px;">
                Didn't request this? You can safely ignore this email.
              </p>
              <p style="margin:8px 0 0 0; color:#64748b; font-size:12px;">
                Need help? <a href="mailto:support@homecallguard.co.uk" style="color:#94a3b8;">support@homecallguard.co.uk</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

# Notes

- Mobile-friendly by construction: single-column table layout, no fixed widths beyond the 420px max container, button is full-width up to 280px so it's easy to tap on a phone screen.
- Uses `https://www.homecallguard.co.uk/logo.png` (absolute URL) since email clients don't resolve relative paths the way a browser does.
- Subject line isn't set by this HTML — Supabase's template editor has a separate "Subject" field; suggest keeping it simple, e.g. "Confirm your Home Call Guard account."
- **Test after applying**: sign up with a fresh email, confirm the link still lands on `/confirmed.html` and correctly establishes/resumes the session via `/confirm-session` exactly as it does today with the default template — the button is just a styled version of the same `{{ .ConfirmationURL }}` link, so the underlying confirmation flow is unchanged.
