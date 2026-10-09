-- Affiliate program foundation, part 5 of 5 (see part 1 for the overview).

set local lock_timeout = '10s';

-- ── admin functions ───────────────────────────────────────────────────────
create function public.affiliate_admin_upsert_product(
  p_slug text, p_name text, p_unit text, p_product_ref text, p_is_active boolean)
returns public.affiliate_product
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.affiliate_product;
begin
  perform affiliate_private.require_role(array['growth', 'super']);
  insert into public.affiliate_product (slug, name, unit, product_ref, is_active)
  values (lower(trim(p_slug)), trim(p_name), trim(p_unit), trim(p_product_ref), coalesce(p_is_active, false))
  on conflict (product_ref) do update set slug = excluded.slug, name = excluded.name, unit = excluded.unit,
    is_active = excluded.is_active, updated_at = now()
  returning * into p;
  perform affiliate_private.log('upserted_product', 'product', p.id::text, to_jsonb(p));
  return p;
end;
$$;

create function public.affiliate_admin_set_product_active(p_product_id uuid, p_is_active boolean)
returns public.affiliate_product
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.affiliate_product;
begin
  perform affiliate_private.require_role(array['growth', 'super']);
  update public.affiliate_product set is_active = p_is_active, updated_at = now()
  where id = p_product_id returning * into p;
  if p.id is null then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  perform affiliate_private.log(case when p_is_active then 'activated_product' else 'deactivated_product' end,
    'product', p.id::text, jsonb_build_object('slug', p.slug));
  return p;
end;
$$;

create function public.affiliate_admin_set_affiliate_status(p_affiliate_id uuid, p_status text, p_note text default null)
returns public.affiliate
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.affiliate;
begin
  perform affiliate_private.require_role(array['growth', 'super']);
  update public.affiliate set status = p_status,
    notes = coalesce(nullif(trim(p_note), ''), notes), updated_at = now()
  where id = p_affiliate_id returning * into a;
  if a.id is null then
    raise exception 'Affiliate not found' using errcode = 'P0002';
  end if;
  perform affiliate_private.log('set_affiliate_status', 'affiliate', a.id::text,
    jsonb_build_object('status', p_status, 'note', p_note));
  return a;
end;
$$;

create function public.affiliate_admin_change_code(p_affiliate_id uuid, p_code text)
returns public.affiliate
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.affiliate;
  c text := upper(trim(coalesce(p_code, '')));
begin
  perform affiliate_private.require_role(array['growth', 'super']);
  if c !~ '^[A-Z0-9]{4,12}$' then
    raise exception 'Use 4–12 letters and digits' using errcode = '22023';
  end if;
  update public.affiliate set code = c, updated_at = now() where id = p_affiliate_id returning * into a;
  if a.id is null then
    raise exception 'Affiliate not found' using errcode = 'P0002';
  end if;
  perform affiliate_private.log('admin_changed_code', 'affiliate', a.id::text, jsonb_build_object('code', c));
  return a;
end;
$$;

create function public.affiliate_admin_set_link_status(p_link_id uuid, p_status text)
returns public.affiliate_link
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.affiliate_link;
begin
  perform affiliate_private.require_role(array['growth', 'super']);
  update public.affiliate_link set status = p_status where id = p_link_id returning * into l;
  if l.id is null then
    raise exception 'Link not found' using errcode = 'P0002';
  end if;
  perform affiliate_private.log('set_link_status', 'link', l.id::text, jsonb_build_object('status', p_status));
  return l;
end;
$$;

-- Hold (or release the hold on) all of an affiliate's unreleased commissions.
create function public.affiliate_admin_hold_commissions(p_affiliate_id uuid, p_hold boolean, p_reason text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  perform affiliate_private.require_role(array['growth', 'finance', 'super']);
  if p_hold then
    -- Released (Tersedia) commissions go back to Tertahan too.
    update public.affiliate_commission set status = 'held', under_review = true, updated_at = now()
    where affiliate_id = p_affiliate_id and status in ('held', 'available');
  else
    update public.affiliate_commission set under_review = false, updated_at = now()
    where affiliate_id = p_affiliate_id and status = 'held' and under_review;
  end if;
  get diagnostics n = row_count;
  perform affiliate_private.log(case when p_hold then 'held_commissions' else 'released_hold' end,
    'affiliate', p_affiliate_id::text, jsonb_build_object('reason', p_reason));
  return n;
end;
$$;

create function public.affiliate_admin_cancel_commission(p_commission_id uuid, p_reason text)
returns public.affiliate_commission
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.affiliate_commission;
begin
  perform affiliate_private.require_role(array['finance', 'super']);
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  update public.affiliate_commission set status = 'cancelled', cancel_reason = trim(p_reason),
    cancelled_at = now(), updated_at = now()
  where id = p_commission_id and status in ('held', 'available') returning * into c;
  if c.id is null then
    raise exception 'Only Tertahan or Tersedia commissions can be cancelled' using errcode = 'P0001';
  end if;
  perform affiliate_private.log('cancelled_commission', 'commission', c.id::text, jsonb_build_object('reason', p_reason));
  return c;
end;
$$;

create function public.affiliate_admin_add_adjustment(p_affiliate_id uuid, p_amount bigint, p_reason text,
                                                      p_related_commission_id uuid default null)
returns public.affiliate_adjustment
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.affiliate_adjustment;
begin
  perform affiliate_private.require_role(array['finance', 'super']);
  insert into public.affiliate_adjustment (affiliate_id, amount, reason, related_commission_id, created_by)
  values (p_affiliate_id, -abs(p_amount), trim(p_reason), p_related_commission_id,
          coalesce(auth.jwt() ->> 'email', current_user))
  returning * into j;
  perform affiliate_private.log('added_adjustment', 'affiliate', p_affiliate_id::text,
    jsonb_build_object('amount', j.amount, 'reason', p_reason));
  return j;
end;
$$;

create function public.affiliate_admin_review_flag(p_flag_id uuid, p_status text)
returns public.affiliate_flag
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.affiliate_flag;
begin
  perform affiliate_private.require_role(array['growth', 'super']);
  if p_status not in ('cleared', 'confirmed') then
    raise exception 'Status must be cleared or confirmed' using errcode = '22023';
  end if;
  update public.affiliate_flag set status = p_status, reviewed_by = coalesce(auth.jwt() ->> 'email', current_user),
    reviewed_at = now()
  where id = p_flag_id and status = 'open' returning * into f;
  if f.id is null then
    raise exception 'Open flag not found' using errcode = 'P0002';
  end if;
  -- Cleared and nothing else open: the held commissions can release again.
  if p_status = 'cleared' and not exists (
       select 1 from public.affiliate_flag where affiliate_id = f.affiliate_id and status = 'open') then
    update public.affiliate_commission set under_review = false, updated_at = now()
    where affiliate_id = f.affiliate_id and status = 'held' and under_review;
  end if;
  perform affiliate_private.log('reviewed_flag', 'flag', f.id::text, jsonb_build_object('status', p_status, 'type', f.type));
  return f;
end;
$$;

create function public.affiliate_admin_claim_processing(p_claim_id uuid, p_estimated_transfer_date date default null)
returns public.affiliate_claim
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.affiliate_claim;
begin
  perform affiliate_private.require_role(array['finance', 'super']);
  update public.affiliate_claim set status = 'processing', processing_at = now(),
    estimated_transfer_date = p_estimated_transfer_date, processed_by = coalesce(auth.jwt() ->> 'email', current_user)
  where id = p_claim_id and status = 'submitted' returning * into c;
  if c.id is null then
    raise exception 'Only Diajukan claims can move to Diproses' using errcode = 'P0001';
  end if;
  perform affiliate_private.log('claim_processing', 'claim', c.id::text, '{}'::jsonb);
  return c;
end;
$$;

create function public.affiliate_admin_claim_paid(p_claim_id uuid, p_transfer_ref text, p_proof_url text)
returns public.affiliate_claim
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.affiliate_claim;
begin
  perform affiliate_private.require_role(array['finance', 'super']);
  if length(trim(coalesce(p_transfer_ref, ''))) = 0 or length(trim(coalesce(p_proof_url, ''))) = 0 then
    raise exception 'A reference number and proof of transfer are required' using errcode = '22023';
  end if;
  update public.affiliate_claim set status = 'paid', paid_at = now(), transfer_ref = trim(p_transfer_ref),
    proof_url = trim(p_proof_url), processed_by = coalesce(auth.jwt() ->> 'email', current_user)
  where id = p_claim_id and status in ('submitted', 'processing') returning * into c;
  if c.id is null then
    raise exception 'Only Diajukan or Diproses claims can be marked Dibayar' using errcode = 'P0001';
  end if;
  update public.affiliate_commission set status = 'paid', updated_at = now() where claim_id = c.id and status = 'claimed';
  perform affiliate_private.log('claim_paid', 'claim', c.id::text, jsonb_build_object('transfer_ref', c.transfer_ref));
  return c;
end;
$$;

create function public.affiliate_admin_claim_reject(p_claim_id uuid, p_reason text)
returns public.affiliate_claim
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.affiliate_claim;
begin
  perform affiliate_private.require_role(array['finance', 'super']);
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  update public.affiliate_claim set status = 'rejected', rejected_at = now(), reject_reason = trim(p_reason),
    processed_by = coalesce(auth.jwt() ->> 'email', current_user)
  where id = p_claim_id and status in ('submitted', 'processing') returning * into c;
  if c.id is null then
    raise exception 'Only Diajukan or Diproses claims can be rejected' using errcode = 'P0001';
  end if;
  -- Back to Tersedia; adjustments wait for the next claim.
  update public.affiliate_commission set status = 'available', claim_id = null, updated_at = now()
  where claim_id = c.id and status = 'claimed';
  update public.affiliate_adjustment set applied_claim_id = null where applied_claim_id = c.id;
  perform affiliate_private.log('claim_rejected', 'claim', c.id::text, jsonb_build_object('reason', p_reason));
  return c;
end;
$$;

-- Finance only: full payout details. Every read is logged.
create function public.affiliate_admin_payout_profile(p_affiliate_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pp public.affiliate_payout_profile;
begin
  perform affiliate_private.require_role(array['finance', 'super']);
  select * into pp from public.affiliate_payout_profile where affiliate_id = p_affiliate_id;
  if pp.affiliate_id is null then
    return null;
  end if;
  perform affiliate_private.log('viewed_payout_profile', 'affiliate', p_affiliate_id::text, '{}'::jsonb);
  return jsonb_build_object('ktp_name', pp.ktp_name, 'nik', affiliate_private.decrypt(pp.nik_enc),
    'npwp', affiliate_private.decrypt(pp.npwp_enc), 'bank_name', pp.bank_name,
    'account_no', affiliate_private.decrypt(pp.account_no_enc), 'account_holder', pp.account_holder);
end;
$$;

create function public.affiliate_admin_claim_payout(p_claim_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  enc bytea;
begin
  perform affiliate_private.require_role(array['finance', 'super']);
  select payout_snapshot_enc into enc from public.affiliate_claim where id = p_claim_id;
  if enc is null then
    return null;
  end if;
  perform affiliate_private.log('viewed_claim_payout', 'claim', p_claim_id::text, '{}'::jsonb);
  return affiliate_private.decrypt(enc)::jsonb;
end;
$$;

-- ── grants ────────────────────────────────────────────────────────────────
-- Functions default to EXECUTE for PUBLIC; close everything, then open the
-- API surface explicitly.
revoke execute on all functions in schema affiliate_private from public, anon, authenticated;
grant execute on function affiliate_private.my_affiliate_id() to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'affiliate_join(text)', 'affiliate_accept_terms(text)', 'affiliate_change_code(text)',
    'affiliate_get_link(text)', 'affiliate_attach_device(text)', 'affiliate_checkout_link(text)',
    'affiliate_save_payout_profile(text,text,text,text,text,text)', 'affiliate_my_payout_profile()',
    'affiliate_my_summary()', 'affiliate_my_links(integer)', 'affiliate_my_commissions(uuid)',
    'affiliate_my_link_daily(uuid,integer)', 'affiliate_claim_preview()', 'affiliate_submit_claim()',
    'affiliate_admin_get_settings()', 'affiliate_admin_upsert_product(text,text,text,text,boolean)',
    'affiliate_admin_set_product_active(uuid,boolean)', 'affiliate_admin_set_affiliate_status(uuid,text,text)',
    'affiliate_admin_change_code(uuid,text)', 'affiliate_admin_set_link_status(uuid,text)',
    'affiliate_admin_hold_commissions(uuid,boolean,text)', 'affiliate_admin_cancel_commission(uuid,text)',
    'affiliate_admin_add_adjustment(uuid,bigint,text,uuid)', 'affiliate_admin_review_flag(uuid,text)',
    'affiliate_admin_claim_processing(uuid,date)', 'affiliate_admin_claim_paid(uuid,text,text)',
    'affiliate_admin_claim_reject(uuid,text)', 'affiliate_admin_payout_profile(uuid)',
    'affiliate_admin_claim_payout(uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;
-- The app records opens before sign-in too.
revoke execute on function public.affiliate_open_link(text, text, text, text, text) from public;
grant execute on function public.affiliate_open_link(text, text, text, text, text) to anon, authenticated;
grant execute on function public.affiliate_link_url(text, text) to anon, authenticated;

-- ── catalog seed: the products the landing page advertises ────────────────
-- Activate or add more from the admin; this only sets a starting point.
insert into public.affiliate_product (slug, name, unit, product_ref, is_active)
select v.slug, v.name, v.unit, v.ref, true
from (
  select 'open-arena' slug, 'Open Arena' name, 'Open Arena' unit, 'booking_products:open-arena' ref
  union all select 'hyrox-class', 'HYROX Class', 'Arena', 'booking_products:hyrox-class'
  union all select 'sport-massage-60', 'Sport Massage 60 Min', 'Recovery Center', 'booking_products:sport-massage-60'
  union all select 'bundle-5x-arena-recovery', 'Bundle: 5x Arena + Recovery', 'Bundle', 'booking_products:bundle-5arena-recovery'
  union all select 'rent-arena', 'Rent Arena', 'Arena', 'booking_products:rent-arena'
  union all select 'gym-day-pass', 'Gym Day Pass', 'Gym',
    'gym_day_pass_config:' || (select id::text from public.gym_day_pass_config where is_active order by price limit 1)
  union all select 'gym-membership-1-bulan', 'Gym Membership 1 Bulan', 'Gym',
    'gym_membership_plans:' || (select id::text from public.gym_membership_plans where duration_months = 1 and is_active limit 1)
  union all select 'physiotherapy', 'Physiotherapy', 'Sport Clinic',
    'clinic_services:' || (select id::text from public.clinic_services where code = '003' limit 1)
) v
where v.ref is not null; -- a missing catalog row leaves the ref null
