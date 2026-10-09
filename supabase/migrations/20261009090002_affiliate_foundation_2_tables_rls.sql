-- Affiliate program foundation, part 2 of 5 (see part 1 for the overview).

set local lock_timeout = '10s';

-- ── tables ────────────────────────────────────────────────────────────────
create table public.affiliate (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users (id) on delete restrict,
  code text not null unique check (code ~ '^[A-Z0-9]{4,12}$'),
  code_changed_at timestamptz,
  status text not null default 'active' check (status in ('active', 'suspended')),
  joined_at timestamptz not null default now(),
  terms_version text not null,
  terms_accepted_at timestamptz not null default now(),
  notes text,
  updated_at timestamptz not null default now()
);

create table public.affiliate_payout_profile (
  affiliate_id uuid primary key references public.affiliate (id) on delete cascade,
  ktp_name text not null check (length(trim(ktp_name)) > 0),
  nik_enc bytea not null,
  nik_last4 text not null,
  npwp_enc bytea,
  bank_name text not null check (length(trim(bank_name)) > 0),
  account_no_enc bytea not null,
  account_last4 text not null,
  account_no_hash text not null,
  account_holder text not null check (length(trim(account_holder)) > 0),
  updated_at timestamptz not null default now()
);
create index affiliate_payout_profile_account_hash_idx on public.affiliate_payout_profile (account_no_hash);

-- product_ref convention: '<catalog table>:<key>', e.g.
-- 'booking_products:open-arena' or 'gym_membership_plans:<plan id>'. Order
-- triggers build the same string from the order row.
create table public.affiliate_product (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 60),
  name text not null check (length(trim(name)) > 0),
  unit text not null check (length(trim(unit)) > 0),
  product_ref text not null unique check (product_ref ~ '^[a-z0-9_]+:.+$'),
  is_active boolean not null default false,
  rate numeric(6, 4) check (rate > 0 and rate < 1), -- per-product override; hidden in v1
  effective_from timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.affiliate_link (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliate (id) on delete cascade,
  product_id uuid not null references public.affiliate_product (id),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  unique (affiliate_id, product_id)
);
create index affiliate_link_product_idx on public.affiliate_link (product_id);

create table public.affiliate_link_open (
  id bigint generated always as identity primary key,
  link_id uuid not null references public.affiliate_link (id) on delete cascade,
  auth_user_id uuid,
  anon_device_id text check (length(anon_device_id) <= 200),
  platform text not null default 'unknown' check (platform in ('ios', 'android', 'web', 'unknown')),
  source text not null check (source in ('app_link', 'install_referrer', 'clipboard', 'landing')),
  opened_at timestamptz not null default now()
);
create index affiliate_link_open_link_idx on public.affiliate_link_open (link_id, opened_at desc);
create index affiliate_link_open_device_idx on public.affiliate_link_open (anon_device_id, opened_at desc)
  where anon_device_id is not null;

create table public.affiliate_link_context (
  auth_user_id uuid not null,
  product_id uuid not null references public.affiliate_product (id),
  link_id uuid not null references public.affiliate_link (id) on delete cascade,
  opened_at timestamptz not null default now(),
  consumed_order_ref text,
  primary key (auth_user_id, product_id)
);

create table public.affiliate_commission (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliate (id),
  link_id uuid not null references public.affiliate_link (id),
  product_id uuid references public.affiliate_product (id),
  buyer_auth_user_id uuid,
  source_table text not null,
  source_id text not null,
  item_ref text not null default '',
  base_amount bigint not null check (base_amount >= 0),
  rate_at_time numeric(6, 4) not null,
  amount bigint not null check (amount >= 0),
  status text not null check (status in ('held', 'available', 'claimed', 'paid', 'cancelled')),
  paid_at_source timestamptz not null,
  available_at timestamptz not null,
  released_at timestamptz,
  under_review boolean not null default false,
  claim_id uuid,
  cancel_reason text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_table, source_id, item_ref)
);
create index affiliate_commission_affiliate_idx on public.affiliate_commission (affiliate_id, status);
create index affiliate_commission_link_idx on public.affiliate_commission (link_id, created_at desc);
create index affiliate_commission_release_idx on public.affiliate_commission (available_at) where status = 'held';

create table public.affiliate_claim (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliate (id),
  amount_gross bigint not null check (amount_gross >= 0),
  adjustment_amount bigint not null default 0 check (adjustment_amount <= 0),
  tax_rate numeric(6, 4) not null,
  tax_amount bigint not null check (tax_amount >= 0),
  amount_net bigint not null check (amount_net > 0),
  status text not null default 'submitted' check (status in ('submitted', 'processing', 'paid', 'rejected')),
  payout_snapshot jsonb not null,   -- masked: bank, last 4 digits, holder
  payout_snapshot_enc bytea not null, -- full details for finance
  terms_version text not null,
  estimated_transfer_date date,
  transfer_ref text,
  proof_url text,
  reject_reason text,
  processed_by text,
  submitted_at timestamptz not null default now(),
  processing_at timestamptz,
  paid_at timestamptz,
  rejected_at timestamptz,
  check (status <> 'paid' or (transfer_ref is not null and proof_url is not null)),
  check (status <> 'rejected' or reject_reason is not null)
);
-- One active claim (Diajukan or Diproses) per affiliate.
create unique index affiliate_claim_one_active_idx on public.affiliate_claim (affiliate_id)
  where status in ('submitted', 'processing');

alter table public.affiliate_commission
  add constraint affiliate_commission_claim_fk foreign key (claim_id) references public.affiliate_claim (id);

create table public.affiliate_adjustment (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliate (id),
  amount bigint not null check (amount < 0),
  reason text not null check (length(trim(reason)) > 0),
  related_commission_id uuid references public.affiliate_commission (id),
  applied_claim_id uuid references public.affiliate_claim (id),
  created_by text not null,
  created_at timestamptz not null default now()
);
create unique index affiliate_adjustment_refund_once_idx on public.affiliate_adjustment (related_commission_id)
  where related_commission_id is not null;

create table public.affiliate_flag (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliate (id),
  link_id uuid references public.affiliate_link (id),
  type text not null check (type in ('device_many_accounts', 'link_spike', 'high_refund_ratio', 'shared_payout_account', 'manual')),
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'cleared', 'confirmed')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index affiliate_flag_one_open_idx on public.affiliate_flag
  (affiliate_id, coalesce(link_id, '00000000-0000-0000-0000-000000000000'::uuid), type) where status = 'open';

-- ── row level security: affiliates read only their own rows ──────────────
alter table public.affiliate enable row level security;
alter table public.affiliate_payout_profile enable row level security;
alter table public.affiliate_product enable row level security;
alter table public.affiliate_link enable row level security;
alter table public.affiliate_link_open enable row level security;
alter table public.affiliate_link_context enable row level security;
alter table public.affiliate_commission enable row level security;
alter table public.affiliate_claim enable row level security;
alter table public.affiliate_adjustment enable row level security;
alter table public.affiliate_flag enable row level security;
alter table public.affiliate_audit_log enable row level security;

create function affiliate_private.my_affiliate_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.affiliate where auth_user_id = auth.uid();
$$;
grant usage on schema affiliate_private to authenticated;
grant execute on function affiliate_private.my_affiliate_id() to authenticated;
-- Policies call it for every role, including anon (where it is false):
-- Postgres checks EXECUTE even when OR short-circuits.
grant execute on function public.affiliate_is_admin() to anon, authenticated;

create policy "Affiliates read their own row" on public.affiliate for select to authenticated
  using (auth_user_id = auth.uid() or public.affiliate_is_admin());
create policy "Anyone reads active catalog products" on public.affiliate_product for select to anon, authenticated
  using (is_active or public.affiliate_is_admin());
create policy "Affiliates read their own links" on public.affiliate_link for select to authenticated
  using (affiliate_id = affiliate_private.my_affiliate_id() or public.affiliate_is_admin());
create policy "Buyers read their own link context" on public.affiliate_link_context for select to authenticated
  using (auth_user_id = auth.uid());
create policy "Affiliates read their own claims" on public.affiliate_claim for select to authenticated
  using (affiliate_id = affiliate_private.my_affiliate_id() or public.affiliate_is_admin());
create policy "Affiliates read their own adjustments" on public.affiliate_adjustment for select to authenticated
  using (affiliate_id = affiliate_private.my_affiliate_id() or public.affiliate_is_admin());
-- Commissions hold the buyer's id and amount, which affiliates never see:
-- they read them through affiliate_my_commissions(). Admins read directly.
create policy "Admins read commissions" on public.affiliate_commission for select to authenticated
  using (public.affiliate_is_admin());
create policy "Admins read link opens" on public.affiliate_link_open for select to authenticated
  using (public.affiliate_is_admin());
create policy "Admins read flags" on public.affiliate_flag for select to authenticated
  using (public.affiliate_is_admin());
create policy "Admins read the affiliate audit log" on public.affiliate_audit_log for select to authenticated
  using (public.affiliate_is_admin());
-- affiliate_payout_profile: no policy; masked reads via functions only.
-- No insert/update/delete policies anywhere: writes go through functions.
revoke insert, update, delete on public.affiliate, public.affiliate_payout_profile, public.affiliate_product,
  public.affiliate_link, public.affiliate_link_open, public.affiliate_link_context, public.affiliate_commission,
  public.affiliate_claim, public.affiliate_adjustment, public.affiliate_flag, public.affiliate_audit_log
  from anon, authenticated;
-- Claims keep encrypted payout details; affiliates read the masked copy.
-- (A column revoke does nothing while the table-level grant exists.)
revoke select on public.affiliate_claim from anon, authenticated;
grant select (id, affiliate_id, amount_gross, adjustment_amount, tax_rate, tax_amount, amount_net, status,
              payout_snapshot, terms_version, estimated_transfer_date, transfer_ref, proof_url, reject_reason,
              processed_by, submitted_at, processing_at, paid_at, rejected_at)
  on public.affiliate_claim to authenticated;
