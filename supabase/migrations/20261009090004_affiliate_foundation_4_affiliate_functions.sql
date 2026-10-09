-- Affiliate program foundation, part 4 of 5 (see part 1 for the overview).

set local lock_timeout = '10s';

-- ── affiliate-facing functions ────────────────────────────────────────────
create function affiliate_private.current_affiliate()
returns public.affiliate
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.affiliate;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  select * into a from public.affiliate where auth_user_id = auth.uid();
  if a.id is null then
    raise exception 'You have not joined the affiliate program yet' using errcode = 'P0002';
  end if;
  return a;
end;
$$;

create function public.affiliate_link_url(p_code text, p_slug text)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'https://20fit.id/r/' || p_code || '/' || p_slug;
$$;

-- Join: accept the current terms, get an automatic code.
create function public.affiliate_join(p_terms_version text)
returns public.affiliate
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.affiliate_settings;
  a public.affiliate;
  base text;
  candidate text;
  tries int := 0;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  select * into a from public.affiliate where auth_user_id = auth.uid();
  if a.id is not null then
    return a;
  end if;
  select * into s from public.affiliate_settings where id = 1;
  if s.program_status <> 'active' then
    raise exception 'The affiliate program is paused; new affiliates cannot join right now' using errcode = 'P0001';
  end if;
  if p_terms_version is distinct from s.terms_version then
    raise exception 'Please accept the current terms (%)', s.terms_version using errcode = 'P0001';
  end if;

  select left(upper(regexp_replace(split_part(trim(coalesce(
           (select full_name from public.my20fit_profile where auth_user_id = auth.uid() limit 1),
           (select full_name from public.profiles where id = auth.uid()), '')), ' ', 1), '[^A-Za-z0-9]', '', 'g')), 8)
    into base;
  if length(base) < 3 then
    base := 'FIT';
  end if;
  loop
    tries := tries + 1;
    candidate := case when tries <= 20
      then base || lpad(floor(random() * 100)::int::text, 2, '0')
      else upper(substr(md5(random()::text), 1, 8)) end;
    exit when not exists (select 1 from public.affiliate where code = candidate);
  end loop;

  insert into public.affiliate (auth_user_id, code, terms_version)
  values (auth.uid(), candidate, s.terms_version)
  returning * into a;
  perform affiliate_private.log('joined', 'affiliate', a.id::text, jsonb_build_object('code', a.code));
  return a;
end;
$$;

-- Accept new terms after they change (needed before the next claim).
create function public.affiliate_accept_terms(p_terms_version text)
returns public.affiliate
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.affiliate := affiliate_private.current_affiliate();
  v text;
begin
  select terms_version into v from public.affiliate_settings where id = 1;
  if p_terms_version is distinct from v then
    raise exception 'Please accept the current terms (%)', v using errcode = 'P0001';
  end if;
  update public.affiliate set terms_version = v, terms_accepted_at = now(), updated_at = now()
  where id = a.id returning * into a;
  perform affiliate_private.log('accepted_terms', 'affiliate', a.id::text, jsonb_build_object('terms_version', v));
  return a;
end;
$$;

-- The code can be changed once (PRD: unique, 4–12 letters and digits).
create function public.affiliate_change_code(p_code text)
returns public.affiliate
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.affiliate := affiliate_private.current_affiliate();
  c text := upper(trim(coalesce(p_code, '')));
begin
  if a.code_changed_at is not null then
    raise exception 'The code can only be changed once' using errcode = 'P0001';
  end if;
  if c !~ '^[A-Z0-9]{4,12}$' then
    raise exception 'Use 4–12 letters and digits' using errcode = '22023';
  end if;
  if exists (select 1 from public.affiliate where code = c and id <> a.id) then
    raise exception 'That code is already taken' using errcode = '23505';
  end if;
  update public.affiliate set code = c, code_changed_at = now(), updated_at = now()
  where id = a.id returning * into a;
  perform affiliate_private.log('changed_code', 'affiliate', a.id::text, jsonb_build_object('code', c));
  return a;
end;
$$;

-- Get (or create) the affiliate's link for a product. The same product
-- always reuses the same link.
create function public.affiliate_get_link(p_product_slug text)
returns table (link_id uuid, url text, product_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.affiliate := affiliate_private.current_affiliate();
  p public.affiliate_product;
  l public.affiliate_link;
begin
  if a.status <> 'active' then
    raise exception 'Your affiliate account is not active' using errcode = 'P0001';
  end if;
  select * into p from public.affiliate_product where slug = p_product_slug and is_active;
  if p.id is null then
    raise exception 'That product is not in the affiliate catalog' using errcode = 'P0002';
  end if;
  select * into l from public.affiliate_link where affiliate_id = a.id and product_id = p.id;
  if l.id is null then
    if (select program_status from public.affiliate_settings where id = 1) <> 'active' then
      raise exception 'The affiliate program is paused; new links cannot be created' using errcode = 'P0001';
    end if;
    insert into public.affiliate_link (affiliate_id, product_id) values (a.id, p.id) returning * into l;
  elsif l.status <> 'active' then
    raise exception 'This link has been disabled' using errcode = 'P0001';
  end if;
  return query select l.id, public.affiliate_link_url(a.code, p.slug), p.name;
end;
$$;

-- Called by the app when a link is opened (app link, install referrer or
-- clipboard), signed in or not. Returns the link id, or null when the
-- code, link or product isn't valid (the app then just opens the product).
create function public.affiliate_open_link(
  p_code text, p_product_slug text, p_source text, p_platform text default 'unknown', p_anon_device_id text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.affiliate_settings;
  l public.affiliate_link;
  a public.affiliate;
  accounts int;
begin
  select l2.* into l
  from public.affiliate a2
  join public.affiliate_link l2 on l2.affiliate_id = a2.id
  join public.affiliate_product p on p.id = l2.product_id
  where a2.code = upper(trim(p_code)) and p.slug = p_product_slug
    and a2.status = 'active' and l2.status = 'active' and p.is_active;
  if l.id is null then
    return null;
  end if;

  insert into public.affiliate_link_open (link_id, auth_user_id, anon_device_id, platform, source)
  values (l.id, auth.uid(), nullif(trim(p_anon_device_id), ''), coalesce(p_platform, 'unknown'), p_source);

  if auth.uid() is not null then
    insert into public.affiliate_link_context (auth_user_id, product_id, link_id, opened_at, consumed_order_ref)
    values (auth.uid(), l.product_id, l.id, now(), null)
    on conflict (auth_user_id, product_id)
    do update set link_id = excluded.link_id, opened_at = excluded.opened_at, consumed_order_ref = null;
  end if;

  -- Many accounts opening links from one device in a short time.
  if nullif(trim(p_anon_device_id), '') is not null then
    select * into s from public.affiliate_settings where id = 1;
    select count(distinct o.auth_user_id) into accounts
    from public.affiliate_link_open o
    join public.affiliate_link ol on ol.id = o.link_id and ol.affiliate_id = l.affiliate_id
    where o.anon_device_id = trim(p_anon_device_id) and o.auth_user_id is not null
      and o.opened_at > now() - make_interval(hours => s.fraud_device_window_hours);
    if accounts >= s.fraud_device_accounts then
      perform affiliate_private.raise_flag(l.affiliate_id, l.id, 'device_many_accounts',
        jsonb_build_object('device', left(trim(p_anon_device_id), 12) || '…', 'accounts', accounts,
                           'window_hours', s.fraud_device_window_hours));
    end if;
  end if;
  return l.id;
end;
$$;

-- After sign-in or sign-up: move links opened on this device (before
-- login) to the account.
create function public.affiliate_attach_device(p_anon_device_id text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  update public.affiliate_link_open set auth_user_id = auth.uid()
  where anon_device_id = trim(p_anon_device_id) and auth_user_id is null;
  get diagnostics n = row_count;

  insert into public.affiliate_link_context (auth_user_id, product_id, link_id, opened_at, consumed_order_ref)
  select distinct on (l.product_id) auth.uid(), l.product_id, l.id, o.opened_at, null
  from public.affiliate_link_open o
  join public.affiliate_link l on l.id = o.link_id
  where o.anon_device_id = trim(p_anon_device_id) and o.auth_user_id = auth.uid()
  order by l.product_id, o.opened_at desc
  on conflict (auth_user_id, product_id) do update
    set link_id = excluded.link_id, opened_at = excluded.opened_at, consumed_order_ref = null
    where public.affiliate_link_context.opened_at < excluded.opened_at;
  return n;
end;
$$;

-- At checkout: the link to attach to the order for this product, if any.
create function public.affiliate_checkout_link(p_product_ref text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.link_id
  from public.affiliate_link_context c
  join public.affiliate_product p on p.id = c.product_id and p.product_ref = p_product_ref and p.is_active
  join public.affiliate_link l on l.id = c.link_id and l.status = 'active'
  join public.affiliate a on a.id = l.affiliate_id and a.status = 'active'
  where c.auth_user_id = auth.uid()
    and (c.consumed_order_ref is null
         or not (select one_purchase_per_open from public.affiliate_settings where id = 1));
$$;

create function public.affiliate_my_payout_profile()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ktp_name', pp.ktp_name,
    'nik', '************' || pp.nik_last4,
    'has_npwp', pp.npwp_enc is not null,
    'bank_name', pp.bank_name,
    'account_no', '••••' || pp.account_last4,
    'account_holder', pp.account_holder,
    'updated_at', pp.updated_at)
  from public.affiliate_payout_profile pp
  join public.affiliate a on a.id = pp.affiliate_id and a.auth_user_id = auth.uid();
$$;

create function public.affiliate_save_payout_profile(
  p_ktp_name text, p_nik text, p_npwp text, p_bank_name text, p_account_no text, p_account_holder text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.affiliate := affiliate_private.current_affiliate();
  nik text := regexp_replace(coalesce(p_nik, ''), '\D', '', 'g');
  npwp text := nullif(regexp_replace(coalesce(p_npwp, ''), '\D', '', 'g'), '');
  acct text := regexp_replace(coalesce(p_account_no, ''), '\D', '', 'g');
  h text;
  other record;
begin
  if length(nik) <> 16 then
    raise exception 'NIK must be 16 digits' using errcode = '22023';
  end if;
  if npwp is not null and length(npwp) not in (15, 16) then
    raise exception 'NPWP must be 15 or 16 digits' using errcode = '22023';
  end if;
  if length(acct) not between 5 and 20 then
    raise exception 'Enter a valid account number' using errcode = '22023';
  end if;
  h := affiliate_private.account_hash(acct);

  insert into public.affiliate_payout_profile
    (affiliate_id, ktp_name, nik_enc, nik_last4, npwp_enc, bank_name, account_no_enc, account_last4, account_no_hash, account_holder)
  values (a.id, trim(p_ktp_name), affiliate_private.encrypt(nik), right(nik, 4), affiliate_private.encrypt(npwp),
          trim(p_bank_name), affiliate_private.encrypt(acct), right(acct, 4), h, trim(p_account_holder))
  on conflict (affiliate_id) do update set
    ktp_name = excluded.ktp_name, nik_enc = excluded.nik_enc, nik_last4 = excluded.nik_last4,
    npwp_enc = excluded.npwp_enc, bank_name = excluded.bank_name, account_no_enc = excluded.account_no_enc,
    account_last4 = excluded.account_last4, account_no_hash = excluded.account_no_hash,
    account_holder = excluded.account_holder, updated_at = now();

  for other in select affiliate_id from public.affiliate_payout_profile where account_no_hash = h and affiliate_id <> a.id loop
    perform affiliate_private.raise_flag(a.id, null, 'shared_payout_account', jsonb_build_object('other_affiliate', other.affiliate_id));
    perform affiliate_private.raise_flag(other.affiliate_id, null, 'shared_payout_account', jsonb_build_object('other_affiliate', a.id));
  end loop;
  perform affiliate_private.log('saved_payout_profile', 'affiliate', a.id::text, '{}'::jsonb);
  return public.affiliate_my_payout_profile();
end;
$$;

-- Balances and whether a claim is possible right now.
create function public.affiliate_my_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.affiliate := affiliate_private.current_affiliate();
  s public.affiliate_settings;
  held bigint;
  available bigint;
  claimed bigint;
  paid bigint;
  adjustments bigint;
  active_claim uuid;
  has_profile boolean;
  blocker text;
begin
  select * into s from public.affiliate_settings where id = 1;
  select coalesce(sum(amount) filter (where status = 'held'), 0),
         coalesce(sum(amount) filter (where status = 'available'), 0),
         coalesce(sum(amount) filter (where status = 'claimed'), 0),
         coalesce(sum(amount) filter (where status = 'paid'), 0)
    into held, available, claimed, paid
  from public.affiliate_commission where affiliate_id = a.id;
  select coalesce(sum(amount), 0) into adjustments from public.affiliate_adjustment
  where affiliate_id = a.id and applied_claim_id is null;
  select id into active_claim from public.affiliate_claim
  where affiliate_id = a.id and status in ('submitted', 'processing');
  has_profile := exists (select 1 from public.affiliate_payout_profile where affiliate_id = a.id);

  blocker := case
    when a.status <> 'active' then 'affiliate_inactive'
    when active_claim is not null then 'claim_in_progress'
    when available < s.min_withdrawal then 'below_minimum'
    when available + adjustments <= 0 then 'adjustments_exceed_balance'
    when a.terms_version is distinct from s.terms_version then 'terms_outdated'
    when not has_profile then 'payout_profile_missing'
  end;

  return jsonb_build_object(
    'code', a.code, 'status', a.status, 'code_changeable', a.code_changed_at is null,
    'terms_version', a.terms_version, 'current_terms_version', s.terms_version,
    'held', held, 'available', available, 'claimed', claimed, 'paid', paid,
    'pending_adjustments', adjustments, 'min_claim', s.min_withdrawal,
    'to_minimum', greatest(s.min_withdrawal - available, 0),
    'active_claim_id', active_claim, 'has_payout_profile', has_profile,
    'can_claim', blocker is null or blocker = 'payout_profile_missing' or blocker = 'terms_outdated',
    'claim_blocker', blocker);
end;
$$;

-- Per link: opens in the app, buyers, transactions, commission. Sorted by
-- commission (PRD "Link saya").
create function public.affiliate_my_links(p_days int default null)
returns table (link_id uuid, product_name text, product_slug text, unit text, url text, status text,
               opens bigint, buyers bigint, transactions bigint, commission bigint, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with a as (select * from public.affiliate where auth_user_id = auth.uid()),
  since as (select case when p_days is null then '-infinity'::timestamptz else now() - make_interval(days => p_days) end as t)
  select l.id, p.name, p.slug, p.unit, public.affiliate_link_url(a.code, p.slug), l.status,
    (select count(*) from public.affiliate_link_open o where o.link_id = l.id and o.opened_at >= (select t from since)),
    (select count(distinct c.buyer_auth_user_id) from public.affiliate_commission c
      where c.link_id = l.id and c.status <> 'cancelled' and c.created_at >= (select t from since)),
    (select count(*) from public.affiliate_commission c
      where c.link_id = l.id and c.status <> 'cancelled' and c.created_at >= (select t from since)),
    (select coalesce(sum(c.amount), 0) from public.affiliate_commission c
      where c.link_id = l.id and c.status <> 'cancelled' and c.created_at >= (select t from since))::bigint,
    l.created_at
  from a
  join public.affiliate_link l on l.affiliate_id = a.id
  join public.affiliate_product p on p.id = l.product_id
  order by 10 desc, l.created_at desc;
$$;

-- Purchases through the affiliate's links: masked buyer, never the amount
-- the buyer paid.
create function public.affiliate_my_commissions(p_link_id uuid default null)
returns table (commission_id uuid, link_id uuid, product_name text, buyer text, created_at timestamptz,
               amount bigint, status text, available_at timestamptz, cancel_reason text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.link_id, p.name, affiliate_private.buyer_name(c.buyer_auth_user_id), c.created_at,
         c.amount, c.status, c.available_at, c.cancel_reason
  from public.affiliate_commission c
  join public.affiliate a on a.id = c.affiliate_id and a.auth_user_id = auth.uid()
  left join public.affiliate_product p on p.id = c.product_id
  where p_link_id is null or c.link_id = p_link_id
  order by c.created_at desc
  limit 500;
$$;

-- Daily opens and transactions for one link (PRD "Detail link").
create function public.affiliate_my_link_daily(p_link_id uuid, p_days int default 30)
returns table (day date, opens bigint, transactions bigint, commission bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with l as (
    select l.id from public.affiliate_link l
    join public.affiliate a on a.id = l.affiliate_id and a.auth_user_id = auth.uid()
    where l.id = p_link_id),
  days as (select generate_series((now() at time zone 'Asia/Jakarta')::date - (p_days - 1),
                                  (now() at time zone 'Asia/Jakarta')::date, interval '1 day')::date as day)
  select d.day,
    (select count(*) from public.affiliate_link_open o, l where o.link_id = l.id
       and (o.opened_at at time zone 'Asia/Jakarta')::date = d.day),
    (select count(*) from public.affiliate_commission c, l where c.link_id = l.id and c.status <> 'cancelled'
       and (c.created_at at time zone 'Asia/Jakarta')::date = d.day),
    (select coalesce(sum(c.amount), 0) from public.affiliate_commission c, l where c.link_id = l.id
       and c.status <> 'cancelled' and (c.created_at at time zone 'Asia/Jakarta')::date = d.day)::bigint
  from days d
  where exists (select 1 from l)
  order by d.day;
$$;

-- What a claim would pay out now (PRD "Alur klaim": ringkasan).
create function public.affiliate_claim_preview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.affiliate := affiliate_private.current_affiliate();
  s public.affiliate_settings;
  gross bigint;
  adjustments bigint;
  rate numeric;
  taxable bigint;
  tax bigint;
  has_npwp boolean;
begin
  select * into s from public.affiliate_settings where id = 1;
  select coalesce(sum(amount), 0) into gross from public.affiliate_commission
  where affiliate_id = a.id and status = 'available';
  select coalesce(sum(amount), 0) into adjustments from public.affiliate_adjustment
  where affiliate_id = a.id and applied_claim_id is null;
  select npwp_enc is not null into has_npwp from public.affiliate_payout_profile where affiliate_id = a.id;
  rate := case when has_npwp then s.tax_rate_npwp else s.tax_rate_no_npwp end;
  taxable := greatest(gross + adjustments, 0);
  tax := floor(taxable * rate);
  return jsonb_build_object(
    'gross', gross, 'adjustments', adjustments, 'tax_rate', rate, 'tax', tax,
    'net', taxable - tax, 'min_claim', s.min_withdrawal,
    'payout_profile', public.affiliate_my_payout_profile(),
    'summary', public.affiliate_my_summary());
end;
$$;

-- Submit a claim: locks every Tersedia commission and unapplied adjustment.
create function public.affiliate_submit_claim()
returns public.affiliate_claim
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.affiliate := affiliate_private.current_affiliate();
  s public.affiliate_settings;
  pp public.affiliate_payout_profile;
  gross bigint;
  adjustments bigint;
  rate numeric;
  taxable bigint;
  tax bigint;
  c public.affiliate_claim;
begin
  -- Serialise claims per affiliate.
  perform 1 from public.affiliate where id = a.id for update;
  select * into s from public.affiliate_settings where id = 1;
  if a.status <> 'active' then
    raise exception 'Your affiliate account is not active' using errcode = 'P0001';
  end if;
  if a.terms_version is distinct from s.terms_version then
    raise exception 'Please accept the updated terms before claiming' using errcode = 'P0001';
  end if;
  select * into pp from public.affiliate_payout_profile where affiliate_id = a.id;
  if pp.affiliate_id is null then
    raise exception 'Add your payout details first' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.affiliate_claim where affiliate_id = a.id and status in ('submitted', 'processing')) then
    raise exception 'You already have a claim in progress' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0) into gross from public.affiliate_commission
  where affiliate_id = a.id and status = 'available';
  if gross < s.min_withdrawal then
    raise exception 'Available balance is below the minimum of %', s.min_withdrawal using errcode = 'P0001';
  end if;
  select coalesce(sum(amount), 0) into adjustments from public.affiliate_adjustment
  where affiliate_id = a.id and applied_claim_id is null;
  taxable := gross + adjustments;
  if taxable <= 0 then
    raise exception 'Adjustments exceed the available balance' using errcode = 'P0001';
  end if;
  rate := case when pp.npwp_enc is not null then s.tax_rate_npwp else s.tax_rate_no_npwp end;
  tax := floor(taxable * rate);

  insert into public.affiliate_claim (affiliate_id, amount_gross, adjustment_amount, tax_rate, tax_amount, amount_net,
    payout_snapshot, payout_snapshot_enc, terms_version)
  values (a.id, gross, adjustments, rate, tax, taxable - tax,
    jsonb_build_object('bank_name', pp.bank_name, 'account_no', '••••' || pp.account_last4,
                       'account_holder', pp.account_holder, 'has_npwp', pp.npwp_enc is not null),
    affiliate_private.encrypt(jsonb_build_object(
      'ktp_name', pp.ktp_name, 'nik', affiliate_private.decrypt(pp.nik_enc),
      'npwp', affiliate_private.decrypt(pp.npwp_enc), 'bank_name', pp.bank_name,
      'account_no', affiliate_private.decrypt(pp.account_no_enc), 'account_holder', pp.account_holder)::text),
    a.terms_version)
  returning * into c;

  update public.affiliate_commission set status = 'claimed', claim_id = c.id, updated_at = now()
  where affiliate_id = a.id and status = 'available';
  update public.affiliate_adjustment set applied_claim_id = c.id
  where affiliate_id = a.id and applied_claim_id is null;
  perform affiliate_private.log('submitted_claim', 'claim', c.id::text, jsonb_build_object('net', c.amount_net));
  return c;
end;
$$;
