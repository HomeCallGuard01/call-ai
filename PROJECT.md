# Home Call Guard

## Vision

Protect people from scam and nuisance calls using intelligent AI call screening.

---

## Current Version

v0.4 - Stripe onboarding build

---

## Current Branch

onboarding-stripe-build

---

## Sprint 1 - Complete

- GitHub repository created
- Working backup branch created
- Development branch created
- Stripe Sandbox created
- Home Call Guard £4.99/month product created
- VS Code development environment configured

---

## Sprint 2A - Architecture Blueprint

### Goal

Design the system before adding more code.

### Customer Journey

Website
↓
Start Protection
↓
Stripe Checkout
↓
Payment Successful
↓
Customer Account Created
↓
Add Mobile Number
↓
Add Trusted Contacts
↓
Enable Protection
↓
Run Test Call
↓
Dashboard Active

---

## Architecture v1

### Frontend

- Landing page
- Stripe checkout button
- Onboarding screens
- Customer dashboard
- Admin dashboard later

### Backend

- Node.js
- Express
- Routes split by feature

### Payments

- Stripe subscriptions
- £4.99/month
- Stripe customer linked to Home Call Guard user

### Database

Supabase recommended.

Tables required:

- users
- trusted_contacts
- calls
- weekly_reports
- subscriptions

### Calls

Twilio handles call routing and screening.

Customer does not see Twilio wording.

### AI

OpenAI reviews unknown caller transcript and returns:

- risk score
- category
- decision
- explanation

### Dashboard

Dashboard should answer:

"Am I protected?"

Key cards:

- Protection status
- Calls screened
- Calls blocked
- Trusted contacts
- Last screened call

---

## Sprint 2B - Next

Build Stripe Checkout integration.

Expected result:

Customer clicks Start Protection, pays £4.99/month, then lands on onboarding page.

---

## Rule

Do not develop directly on main.

Always commit working milestones to GitHub.