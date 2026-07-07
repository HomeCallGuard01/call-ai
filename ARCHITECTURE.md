# Home Call Guard Architecture

## Purpose

This document explains how the Home Call Guard system works.

---

## System Overview

Home Call Guard protects customers from scam and nuisance calls.

The product has seven main parts:

1. Website
2. Stripe
3. Backend
4. Database
5. Twilio
6. AI screening
7. Dashboard and reports

---

## Customer Flow

Website visitor clicks Start Protection.

Stripe handles payment.

Stripe sends payment confirmation to backend.

Backend creates a user.

User completes onboarding.

User adds trusted contacts.

User enables call protection.

Twilio screens unknown calls.

AI scores suspicious calls.

Dashboard shows protection activity.

Weekly report reminds customer of value.

---

## Data Flow

Customer
↓
Website
↓
Stripe Checkout
↓
Stripe Webhook
↓
Node Backend
↓
Database
↓
Onboarding Dashboard
↓
Twilio Call Screening
↓
AI Risk Scoring
↓
Call Log
↓
Weekly Report

---

## Recommended Folder Structure

call-ai/

server.js

routes/
- stripe.js
- onboarding.js
- calls.js
- dashboard.js

services/
- stripeService.js
- twilioService.js
- aiService.js
- emailService.js

database/
- users.js
- contacts.js
- calls.js
- reports.js

public/
- index.html
- success.html
- onboarding.html
- dashboard.html

---

## Security Principles

- Never expose Stripe secret key in frontend.
- Never expose Twilio auth token in frontend.
- Use environment variables.
- Use webhooks for payment confirmation.
- Do not rely only on browser redirects.
- Store customer data in a database, not JSON files.
- Keep sandbox and live environments separate.

---

## MVP Decisions

- Use Stripe Checkout, not custom payment forms.
- Use Supabase for database.
- Use Twilio for call routing.
- Hide technical numbers from users.
- Build web dashboard before mobile app.
- Start UK-only.
- Start with one product: £4.99/month.