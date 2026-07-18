Document: Engineering Principles
Version: 1.1
Last Updated: 2026-07-14
Status: Active
Owner: Andrew Deane
Related Sprint(s): N/A — general principles, not tied to a specific sprint

---

# Home Call Guard Engineering Principles

These principles guide every technical and business decision.

---

# 1. Customer First

The customer never sees unnecessary technical complexity.

We explain outcomes, not implementation.

Example:

Good

"Protection Active"

Bad

"Calls diverted to Twilio."

---

# 2. Security by Design

Security is designed in from day one.

Never added later.

---

# 3. Simplicity Wins

If two solutions solve the same problem,

choose the simpler one.

---

# 4. Build for Scale

Always assume:

Today
100 users

Tomorrow
100,000 users

---

# 5. Every Decision Has a Reason

Important technical decisions are documented.

No guessing.

No "because someone said so."

---

# 6. Everything Can Be Rebuilt

Never become emotionally attached to code.

Better architecture always wins.

---

# 7. Fast but Safe

Move quickly.

Never recklessly.

---

# 8. Data is an Asset

Customer data is protected.

Company knowledge is documented.

---

# 9. Software is a Product

We are not building code.

We are building a company.

---

# 10. Leave It Better

Every session should improve the software.

Never leave technical debt behind.

This is our "rulebook" for ourselves and any AI agents.
Examples:
No hard-coded secrets.
Environment variables only.
One responsibility per route.
Prefer complete file replacements over snippets.
Every sprint removes technical debt.
All user data stored in Supabase.
All features documented before production.
Keep functions small and readable.
Comment business logic, not obvious JavaScript.
This keeps future code consistent.

---

## Engineering Principle 006

One Sprint = One Goal.

Finish the sprint.

Document the sprint.

Commit the sprint.

Only then begin the next sprint.

---

## Engineering Principle 007

Prefer replacing complete files or complete functions rather than editing multiple small snippets.

This reduces integration errors and provides consistent code reviews.

---

## Engineering Principle 008

Every sprint should remove technical debt where practical.

The codebase should become simpler over time, not more complicated.