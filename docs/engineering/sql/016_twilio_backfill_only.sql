update public.households
  set twilio_provisioning_status = 'active',
      twilio_provisioning_updated_at = now()
  where twilio_number is not null
    and twilio_provisioning_status = 'pending';
