alter table public.households
  add column if not exists twilio_provisioning_status text not null default 'pending'
    check (twilio_provisioning_status in ('pending', 'active', 'failed')),
  add column if not exists twilio_provisioning_attempts integer not null default 0
    check (twilio_provisioning_attempts >= 0),
  add column if not exists twilio_provisioning_last_error text,
  add column if not exists twilio_provisioning_updated_at timestamptz;
