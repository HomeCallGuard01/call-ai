Security & Authentication Roadmap
Status: Post-MVP / Before Public Launch
Password Policy Review
Priority: High
Review the password policy before opening Home Call Guard to the public.
Items to evaluate:
Minimum password length (recommend 12+ characters).
Encourage long passphrases over overly complex rules.
Require a minimum level of entropy/strength.
Password strength meter.
Reject common or compromised passwords (Have I Been Pwned API).
Prevent passwords identical to the email address or company name.
Password Generator
Priority: Medium
Offer users the option to generate a strong password automatically.
Requirements:
Cryptographically secure random generation.
Easy "Copy Password" button.
Compatible with password managers.
User must acknowledge they've stored it before continuing.
Password Visibility
Eye icon for Password.
Eye icon for Confirm Password.
Keyboard accessible.
Mobile friendly.
Password Managers
Verify compatibility with:
Apple Passwords
Google Password Manager
1Password
Bitwarden
Future Authentication
Evaluate:
Passkeys
Sign in with Apple
Google Login
Microsoft Login
Security Testing
Before launch complete:
SQL Injection
XSS
Brute-force login testing
Rate limiting
Session timeout
Account enumeration
Password reset abuse
Authentication penetration testing

Password strength policy (minimum length, passphrase support, special characters, breached-password screening, password manager compatibility)
Rate limiting and account lockout after repeated failed logins
Session timeout and "remember this device"
Multi-factor authentication (future premium feature)
Audit logging for authentication events (login, password reset, failed attempts)
These don't need building now, but having them documented shows clear product thinking and gives you a roadmap for future security improvements. Home Call Guard is already starting to look like a product that could withstand technical due diligence, which will matter if your long-term goal is acquisition.

Repository Hygiene
Priority: Medium
node_modules/ is already tracked in git (approximately 5,559 files), despite being listed in .gitignore. This predates the documentation reorganisation and Sprint 8 work and was not created by it. .gitignore only prevents new files from being tracked — it does not retroactively untrack what's already committed, which is why node_modules/.package-lock.json still shows as modified in git status.
Proposed fix, as its own isolated commit, not bundled with feature work:
git rm -r --cached node_modules/
git commit -m "Stop tracking node_modules/ (already gitignored, never should have been committed)"
--cached only removes it from git's index; the folder stays on disk and npm continues to work unchanged. Not executed yet — tracked here as a discrete repository-cleanup action.
