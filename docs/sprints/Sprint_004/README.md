# Sprint 4 Review

## Objective

Connect Home Call Guard to a professional cloud backend.

## Scope

Set up Supabase as the project's cloud backend, secure the credentials
needed to reach it, and bring the contacts flow (table, CSV upload, RLS)
onto that backend.

## Work completed

✅ Created Supabase project
✅ Selected UK / West Europe region
✅ Implemented secure environment variables (.env)
✅ Protected secrets using .gitignore
✅ Connected Node.js to Supabase
✅ Successfully loaded environment variables
✅ Verified cloud connection using /test-db
✅ Created contacts table
✅ CSV upload working
✅ RLS configured
✅ Uploads write to Supabase
✅ Removed contacts.json dependency
✅ Added test endpoints
✅ Added upload debugging

## Decisions

- Supabase selected instead of GHL database
- Environment variables mandatory for all secrets
- Never commit API keys
- Cloud-first architecture

## Files changed

Not itemized in the original sprint notes — not reconstructed here to
avoid guessing at specifics that weren't recorded at the time.

## Database changes

- `contacts` table created
- Row Level Security configured on `contacts`

## Verification

Cloud connection verified using the `/test-db` endpoint.

## Outstanding tests

None recorded.

## Outcome

Sprint successful. Home Call Guard now has a secure cloud backend ready
for persistent customer data.

Lessons learned:

- Always read the first error, never guess.
- Verify infrastructure before building features.
- Solve one layer at a time.
- Good architecture makes future features easier.

Technical debt: none identified. Risks: none identified.

Known issue at close: dashboard was still static (not yet reading live
data).

## Next steps

Display live contacts on the dashboard.
