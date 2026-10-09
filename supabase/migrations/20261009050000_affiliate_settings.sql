-- Affiliate program settings that the public site reads and admins edit.
-- Every change is written to affiliate_settings_audit by a trigger, so edits
-- made outside the admin page (e.g. the SQL editor) are logged too.

create table public.affiliate_settings (
  id smallint primary key default 1 check (id = 1),
  commission_rate numeric(6, 4) not null default 0.025
    check (commission_rate > 0 and commission_rate < 1),
  min_withdrawal integer not null default 50000 check (min_withdrawal >= 0),
  pending_days integer not null default 7 check (pending_days between 0 and 365),
  monthly_potential bigint not null default 20000000 check (monthly_potential >= 0),
  -- [{ "category": text, "target": int }] shown under "Lihat target penjualan".
  sales_targets jsonb not null default '[
    {"category": "Open Arena", "target": 100},
    {"category": "HYROX Class", "target": 90},
    {"category": "Gym Day Pass & Membership", "target": 150},
    {"category": "Recovery Center", "target": 150},
    {"category": "Sport Clinic", "target": 40},
    {"category": "Bundle Package", "target": 80},
    {"category": "Rent Arena", "target": 20}
  ]'::jsonb,
  -- [{ "label": text, "table": text, "match": {column: value} }]: which
  -- booking-system row prices each calculator chip.
  calculator_products jsonb not null default '[
    {"label": "Open Arena", "table": "booking_products", "match": {"slug": "open-arena"}},
    {"label": "HYROX Class", "table": "booking_products", "match": {"slug": "hyrox-class"}},
    {"label": "Gym Day Pass", "table": "gym_day_pass_config", "match": {}},
    {"label": "Gym Membership", "table": "gym_membership_plans", "match": {"duration_months": 1}},
    {"label": "Sport Massage", "table": "booking_products", "match": {"slug": "sport-massage-60"}},
    {"label": "Physiotherapy", "table": "clinic_services", "match": {"code": "003"}},
    {"label": "Bundle Package", "table": "booking_products", "match": {"slug": "bundle-5arena-recovery"}},
    {"label": "Rent Arena", "table": "booking_products", "match": {"slug": "rent-arena"}}
  ]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into public.affiliate_settings (id) values (1);

create table public.affiliate_settings_audit (
  id bigint generated always as identity primary key,
  changed_at timestamptz not null default now(),
  changed_by_user uuid,
  changed_by text not null,
  field text not null,
  old_value jsonb,
  new_value jsonb
);

create index affiliate_settings_audit_changed_at_idx
  on public.affiliate_settings_audit (changed_at desc);

create table public.affiliate_admins (
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);

insert into public.affiliate_admins (email) values ('zidni@20fit.id');

alter table public.affiliate_settings enable row level security;
alter table public.affiliate_settings_audit enable row level security;
alter table public.affiliate_admins enable row level security;

create function public.affiliate_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.affiliate_admins
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke execute on function public.affiliate_is_admin() from public, anon;
grant execute on function public.affiliate_is_admin() to authenticated;

create policy "Anyone can read affiliate settings"
  on public.affiliate_settings for select
  to anon, authenticated
  using (true);

create policy "Affiliate admins can read the settings audit log"
  on public.affiliate_settings_audit for select
  to authenticated
  using (public.affiliate_is_admin());

-- Writes go through affiliate_update_settings(); no direct write policies.

create function public.affiliate_settings_audit_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  field text;
  who text := coalesce(auth.jwt() ->> 'email', current_user);
begin
  foreach field in array array[
    'commission_rate', 'min_withdrawal', 'pending_days', 'monthly_potential',
    'sales_targets', 'calculator_products'
  ] loop
    if to_jsonb(old) -> field is distinct from to_jsonb(new) -> field then
      insert into public.affiliate_settings_audit
        (changed_by_user, changed_by, field, old_value, new_value)
      values (auth.uid(), who, field, to_jsonb(old) -> field, to_jsonb(new) -> field);
    end if;
  end loop;
  new.updated_at := now();
  new.updated_by := who;
  return new;
end;
$$;

create trigger affiliate_settings_audit
  before update on public.affiliate_settings
  for each row execute function public.affiliate_settings_audit_trigger();

-- Partial update: only keys present in `patch` change. Returns the new row.
create function public.affiliate_update_settings(patch jsonb)
returns public.affiliate_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  result public.affiliate_settings;
begin
  if not public.affiliate_is_admin() then
    raise exception 'Only affiliate admins can change these settings'
      using errcode = '42501';
  end if;
  if jsonb_typeof(patch) is distinct from 'object' then
    raise exception 'patch must be a JSON object' using errcode = '22023';
  end if;

  if patch ? 'sales_targets' then
    if jsonb_typeof(patch -> 'sales_targets') <> 'array' then
      raise exception 'sales_targets must be a list' using errcode = '22023';
    end if;
    for item in select * from jsonb_array_elements(patch -> 'sales_targets') loop
      if jsonb_typeof(item -> 'category') <> 'string' or length(trim(item ->> 'category')) = 0
         or jsonb_typeof(item -> 'target') <> 'number' or (item ->> 'target')::numeric < 0 then
        raise exception 'Each sales target needs a category and a target of 0 or more'
          using errcode = '22023';
      end if;
    end loop;
  end if;

  if patch ? 'calculator_products' then
    if jsonb_typeof(patch -> 'calculator_products') <> 'array' then
      raise exception 'calculator_products must be a list' using errcode = '22023';
    end if;
    for item in select * from jsonb_array_elements(patch -> 'calculator_products') loop
      if jsonb_typeof(item -> 'label') <> 'string' or length(trim(item ->> 'label')) = 0
         or coalesce(item ->> 'table', '') not in
            ('booking_products', 'gym_day_pass_config', 'gym_membership_plans', 'clinic_services')
         or jsonb_typeof(coalesce(item -> 'match', '{}'::jsonb)) <> 'object' then
        raise exception 'Each calculator product needs a label, a supported table and a match object'
          using errcode = '22023';
      end if;
    end loop;
  end if;

  update public.affiliate_settings set
    commission_rate = coalesce((patch ->> 'commission_rate')::numeric, commission_rate),
    min_withdrawal = coalesce((patch ->> 'min_withdrawal')::integer, min_withdrawal),
    pending_days = coalesce((patch ->> 'pending_days')::integer, pending_days),
    monthly_potential = coalesce((patch ->> 'monthly_potential')::bigint, monthly_potential),
    sales_targets = coalesce(patch -> 'sales_targets', sales_targets),
    calculator_products = coalesce(patch -> 'calculator_products', calculator_products)
  where id = 1
  returning * into result;

  return result;
end;
$$;

revoke execute on function public.affiliate_update_settings(jsonb) from public, anon;
grant execute on function public.affiliate_update_settings(jsonb) to authenticated;
revoke execute on function public.affiliate_settings_audit_trigger() from public, anon, authenticated;
