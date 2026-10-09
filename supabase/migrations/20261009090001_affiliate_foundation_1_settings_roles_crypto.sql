-- Affiliate program foundation (PRD "20FIT Affiliate Program", phase 1).
--
-- Affiliates share one link per product (20fit.id/r/CODE/product). The app
-- records link opens and keeps, per buyer and product, the last link opened
-- (affiliate_link_context). At checkout the app passes that link to the
-- order; when the order is paid, the order table's trigger calls
-- affiliate_private.record_paid(), which creates the commission. Commission
-- rows, link context and status changes are only ever written by these
-- server functions, never by clients.
--
-- Not in this migration (needs the app team): affiliate_link_id on the order
-- tables and their paid/refund triggers. See docs/affiliate-integration.md.

set local lock_timeout = '10s';

-- ── private schema: helpers that must not be callable over the API ─────────
create schema if not exists affiliate_private;
revoke all on schema affiliate_private from public, anon, authenticated;

-- ── admin roles (PRD: Growth, Finance, Super admin) ───────────────────────
alter table public.affiliate_admins
  add column role text not null default 'super'
  check (role in ('growth', 'finance', 'super'));

create function public.affiliate_admin_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.affiliate_admins
  where email = lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

revoke execute on function public.affiliate_admin_role() from public, anon;
grant execute on function public.affiliate_admin_role() to authenticated;

create function affiliate_private.require_role(allowed text[])
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r text := public.affiliate_admin_role();
begin
  if r is null or not (r = any (allowed)) then
    raise exception 'This needs one of these admin roles: %', array_to_string(allowed, ', ')
      using errcode = '42501';
  end if;
  return r;
end;
$$;

-- ── settings: the rest of the PRD's program settings ──────────────────────
alter table public.affiliate_settings
  add column program_status text not null default 'active' check (program_status in ('active', 'paused')),
  add column program_paused_at timestamptz,
  add column terms_version text not null default 'v1' check (length(trim(terms_version)) > 0),
  add column terms_url text,
  add column terms_summary text,
  -- PRD "Satu buka link" (recommended, awaiting confirmation): one link open
  -- counts for one purchase of that product.
  add column one_purchase_per_open boolean not null default true,
  -- PPh 21 withholding shown on claims. To be confirmed by finance.
  add column tax_rate_npwp numeric(6, 4) not null default 0.025 check (tax_rate_npwp between 0 and 1),
  add column tax_rate_no_npwp numeric(6, 4) not null default 0.03 check (tax_rate_no_npwp between 0 and 1),
  add column fraud_device_accounts integer not null default 3 check (fraud_device_accounts >= 2),
  add column fraud_device_window_hours integer not null default 24 check (fraud_device_window_hours > 0),
  add column fraud_spike_multiplier numeric(6, 2) not null default 5 check (fraud_spike_multiplier > 1),
  add column fraud_refund_ratio numeric(4, 3) not null default 0.3 check (fraud_refund_ratio between 0 and 1),
  add column landing_content jsonb not null default '{}'::jsonb check (jsonb_typeof(landing_content) = 'object');

-- The public only sees what the website shows; admins read everything
-- through affiliate_admin_get_settings().
-- (The existing "Anyone can read affiliate settings" policy stays; column
-- grants decide what anon and authenticated can see.)
revoke select on public.affiliate_settings from anon, authenticated;
grant select (id, commission_rate, min_withdrawal, pending_days, monthly_potential, sales_targets,
              calculator_products, program_status, terms_version, terms_url, terms_summary,
              landing_content, tax_rate_npwp, tax_rate_no_npwp)
  on public.affiliate_settings to anon, authenticated;

-- Audit every changed column, whatever columns exist.
create or replace function public.affiliate_settings_audit_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  field text;
  who text := coalesce(auth.jwt() ->> 'email', current_user);
begin
  for field in
    select key from jsonb_each(to_jsonb(new))
    where key not in ('id', 'updated_at', 'updated_by', 'program_paused_at')
  loop
    if to_jsonb(old) -> field is distinct from to_jsonb(new) -> field then
      insert into public.affiliate_settings_audit
        (changed_by_user, changed_by, field, old_value, new_value)
      values (auth.uid(), who, field, to_jsonb(old) -> field, to_jsonb(new) -> field);
    end if;
  end loop;
  if new.program_status = 'paused' and old.program_status <> 'paused' then
    new.program_paused_at := now();
  elsif new.program_status = 'active' then
    new.program_paused_at := null;
  end if;
  new.updated_at := now();
  new.updated_by := who;
  return new;
end;
$$;

-- Partial update. Rate, payout and program-state settings are Super admin
-- only; the rest Growth or Super. Only keys whose value changes are checked,
-- so a form that posts every field still works for Growth.
create or replace function public.affiliate_update_settings(patch jsonb)
returns public.affiliate_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  financial constant text[] := array['commission_rate', 'min_withdrawal', 'pending_days', 'tax_rate_npwp',
    'tax_rate_no_npwp', 'program_status', 'one_purchase_per_open'];
  general constant text[] := array['monthly_potential', 'sales_targets', 'calculator_products', 'terms_version',
    'terms_url', 'terms_summary', 'fraud_device_accounts', 'fraud_device_window_hours',
    'fraud_spike_multiplier', 'fraud_refund_ratio', 'landing_content'];
  role text := public.affiliate_admin_role();
  cur public.affiliate_settings;
  nxt public.affiliate_settings;
  k text;
  item jsonb;
begin
  if role is null then
    raise exception 'Only affiliate admins can change these settings' using errcode = '42501';
  end if;
  if jsonb_typeof(patch) is distinct from 'object' then
    raise exception 'patch must be a JSON object' using errcode = '22023';
  end if;

  select * into cur from public.affiliate_settings where id = 1 for update;
  nxt := jsonb_populate_record(cur, patch);

  for k in select jsonb_object_keys(patch) loop
    if not (k = any (financial) or k = any (general)) then
      raise exception 'Unknown setting: %', k using errcode = '22023';
    end if;
    if to_jsonb(cur) -> k is not distinct from to_jsonb(nxt) -> k then
      continue;
    end if;
    if k = any (financial) and role <> 'super' then
      raise exception 'Only a Super admin can change %', k using errcode = '42501';
    end if;
    if k = any (general) and role not in ('growth', 'super') then
      raise exception 'Only Growth or Super admins can change %', k using errcode = '42501';
    end if;
  end loop;

  if jsonb_typeof(to_jsonb(nxt.sales_targets)) <> 'array' then
    raise exception 'sales_targets must be a list' using errcode = '22023';
  end if;
  for item in select * from jsonb_array_elements(nxt.sales_targets) loop
    if jsonb_typeof(item -> 'category') <> 'string' or length(trim(item ->> 'category')) = 0
       or jsonb_typeof(item -> 'target') <> 'number' or (item ->> 'target')::numeric < 0 then
      raise exception 'Each sales target needs a category and a target of 0 or more' using errcode = '22023';
    end if;
  end loop;
  if jsonb_typeof(to_jsonb(nxt.calculator_products)) <> 'array' then
    raise exception 'calculator_products must be a list' using errcode = '22023';
  end if;
  for item in select * from jsonb_array_elements(nxt.calculator_products) loop
    if jsonb_typeof(item -> 'label') <> 'string' or length(trim(item ->> 'label')) = 0
       or coalesce(item ->> 'table', '') not in
          ('booking_products', 'gym_day_pass_config', 'gym_membership_plans', 'clinic_services')
       or jsonb_typeof(coalesce(item -> 'match', '{}'::jsonb)) <> 'object' then
      raise exception 'Each calculator product needs a label, a supported table and a match object'
        using errcode = '22023';
    end if;
  end loop;

  update public.affiliate_settings set
    commission_rate = nxt.commission_rate,
    min_withdrawal = nxt.min_withdrawal,
    pending_days = nxt.pending_days,
    monthly_potential = nxt.monthly_potential,
    sales_targets = nxt.sales_targets,
    calculator_products = nxt.calculator_products,
    program_status = nxt.program_status,
    terms_version = nxt.terms_version,
    terms_url = nxt.terms_url,
    terms_summary = nxt.terms_summary,
    one_purchase_per_open = nxt.one_purchase_per_open,
    tax_rate_npwp = nxt.tax_rate_npwp,
    tax_rate_no_npwp = nxt.tax_rate_no_npwp,
    fraud_device_accounts = nxt.fraud_device_accounts,
    fraud_device_window_hours = nxt.fraud_device_window_hours,
    fraud_spike_multiplier = nxt.fraud_spike_multiplier,
    fraud_refund_ratio = nxt.fraud_refund_ratio,
    landing_content = nxt.landing_content
  where id = 1
  returning * into nxt;
  return nxt;
end;
$$;

create function public.affiliate_admin_get_settings()
returns public.affiliate_settings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.affiliate_settings;
begin
  perform affiliate_private.require_role(array['growth', 'finance', 'super']);
  select * into s from public.affiliate_settings where id = 1;
  return s;
end;
$$;

-- ── audit log for affiliate/admin actions and personal-data access ───────
create table public.affiliate_audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  entity text not null,
  entity_id text,
  detail jsonb not null default '{}'::jsonb
);
create index affiliate_audit_log_at_idx on public.affiliate_audit_log (at desc);
create index affiliate_audit_log_entity_idx on public.affiliate_audit_log (entity, entity_id);

create function affiliate_private.log(action text, entity text, entity_id text, detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.affiliate_audit_log (actor, action, entity, entity_id, detail)
  values (coalesce(auth.jwt() ->> 'email', auth.uid()::text, current_user), action, entity, entity_id, detail);
$$;

-- ── personal-data encryption (key in Supabase Vault) ──────────────────────
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'affiliate_pii_key',
  'Encrypts affiliate payout data (NIK, NPWP, bank account numbers)')
where not exists (select 1 from vault.secrets where name = 'affiliate_pii_key');

create function affiliate_private.pii_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'affiliate_pii_key';
$$;

create function affiliate_private.encrypt(v text)
returns bytea
language sql
security definer
set search_path = ''
as $$
  select case when v is null then null else extensions.pgp_sym_encrypt(v, affiliate_private.pii_key()) end;
$$;

create function affiliate_private.decrypt(v bytea)
returns text
language sql
security definer
set search_path = ''
as $$
  select case when v is null then null else extensions.pgp_sym_decrypt(v, affiliate_private.pii_key()) end;
$$;

-- Keyed hash, to spot the same bank account on different affiliates
-- without decrypting.
create function affiliate_private.account_hash(account_no text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(extensions.hmac(regexp_replace(account_no, '\D', '', 'g'), affiliate_private.pii_key(), 'sha256'), 'hex');
$$;

-- "Rina" -> "R**a" style, for showing buyers to affiliates.
create function affiliate_private.mask_name(full_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when n is null or n = '' then 'Pembeli'
    when length(n) <= 2 then left(n, 1) || '*'
    else left(n, 1) || '****' || right(n, 1)
  end
  from (select split_part(trim(coalesce(full_name, '')), ' ', 1) as n) s;
$$;

create function affiliate_private.buyer_name(buyer uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select affiliate_private.mask_name(coalesce(
    (select full_name from public.my20fit_profile where auth_user_id = buyer limit 1),
    (select full_name from public.profiles where id = buyer)));
$$;
