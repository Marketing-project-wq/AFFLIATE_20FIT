-- Affiliate program foundation, part 3 of 5 (see part 1 for the overview).

set local lock_timeout = '10s';

-- ── fraud flags ───────────────────────────────────────────────────────────
-- A flag keeps the affiliate's unreleased commissions Tertahan until an
-- admin reviews it.
create function affiliate_private.raise_flag(p_affiliate uuid, p_link uuid, p_type text, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.affiliate_flag (affiliate_id, link_id, type, detail)
  values (p_affiliate, p_link, p_type, p_detail)
  on conflict do nothing;
  update public.affiliate_commission set under_review = true, updated_at = now()
  where affiliate_id = p_affiliate and status = 'held' and not under_review;
end;
$$;

-- ── commission engine (called by order triggers; not exposed) ─────────────
create function affiliate_private.record_paid(
  p_source_table text, p_source_id text, p_item_ref text, p_product_ref text, p_buyer uuid,
  p_link_id uuid, p_base_amount bigint, p_paid_at timestamptz, p_channel text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.affiliate_settings;
  l public.affiliate_link;
  a public.affiliate;
  p public.affiliate_product;
  existing uuid;
  reason text;
  rate numeric;
  owner_email text;
  owner_phone text;
  buyer_email text;
  buyer_phone text;
  new_id uuid;
  recent int;
  baseline numeric;
begin
  if p_link_id is null or coalesce(p_channel, '') <> 'app' then
    return null;
  end if;
  select id into existing from public.affiliate_commission
  where source_table = p_source_table and source_id = p_source_id and item_ref = coalesce(p_item_ref, '');
  if existing is not null then
    return existing; -- idempotent: one order item never makes two commissions
  end if;

  select * into s from public.affiliate_settings where id = 1;
  select * into l from public.affiliate_link where id = p_link_id;
  if l.id is null then
    return null;
  end if;
  select * into a from public.affiliate where id = l.affiliate_id;
  select * into p from public.affiliate_product where product_ref = p_product_ref;

  if p.id is null or p.id <> l.product_id then
    reason := 'product_mismatch';
  elsif not p.is_active then
    reason := 'product_inactive';
  elsif a.status <> 'active' then
    reason := 'affiliate_inactive';
  elsif l.status <> 'active' then
    reason := 'link_inactive';
  elsif s.program_status = 'paused' and p_paid_at >= coalesce(s.program_paused_at, '-infinity') then
    reason := 'program_paused';
  end if;

  if reason is null then
    select email, phone into owner_email, owner_phone from auth.users where id = a.auth_user_id;
    select email, phone into buyer_email, buyer_phone from auth.users where id = p_buyer;
    if p_buyer = a.auth_user_id
       or (owner_email is not null and lower(owner_email) = lower(buyer_email))
       or (nullif(owner_phone, '') is not null and owner_phone = buyer_phone)
       or exists (
         select 1 from public.affiliate_payout_profile bp
         join public.affiliate ba on ba.id = bp.affiliate_id and ba.auth_user_id = p_buyer
         join public.affiliate_payout_profile op on op.affiliate_id = a.id
         where bp.account_no_hash = op.account_no_hash) then
      reason := 'self_purchase';
    end if;
  end if;

  rate := case when p.rate is not null and (p.effective_from is null or p.effective_from <= p_paid_at)
               then p.rate else s.commission_rate end;

  insert into public.affiliate_commission (
    affiliate_id, link_id, product_id, buyer_auth_user_id, source_table, source_id, item_ref,
    base_amount, rate_at_time, amount, status, paid_at_source, available_at, cancel_reason, cancelled_at)
  values (
    a.id, l.id, p.id, p_buyer, p_source_table, p_source_id, coalesce(p_item_ref, ''),
    greatest(p_base_amount, 0), rate, floor(greatest(p_base_amount, 0) * rate),
    case when reason is null then 'held' else 'cancelled' end,
    p_paid_at, p_paid_at + make_interval(days => s.pending_days), reason,
    case when reason is not null then now() end)
  returning id into new_id;

  if reason is not null then
    return new_id;
  end if;

  if s.one_purchase_per_open then
    update public.affiliate_link_context set consumed_order_ref = p_source_table || ':' || p_source_id
    where auth_user_id = p_buyer and product_id = l.product_id and link_id = l.id;
  end if;

  -- Spike: today's transactions on this link far above its 30-day daily average.
  select count(*) into recent from public.affiliate_commission
  where link_id = l.id and created_at > now() - interval '24 hours';
  select count(*) / 30.0 into baseline from public.affiliate_commission
  where link_id = l.id and created_at between now() - interval '31 days' and now() - interval '24 hours';
  if recent >= 5 and recent > greatest(baseline, 1) * s.fraud_spike_multiplier then
    perform affiliate_private.raise_flag(a.id, l.id, 'link_spike',
      jsonb_build_object('last_24h', recent, 'daily_avg_30d', round(baseline, 2)));
  end if;

  update public.affiliate_commission set under_review = true
  where id = new_id and exists (select 1 from public.affiliate_flag where affiliate_id = a.id and status = 'open');
  return new_id;
end;
$$;

-- Refunds: within the hold the commission is cancelled; once claimed or
-- paid, a negative adjustment comes off the next claim.
create function affiliate_private.record_refund(p_source_table text, p_source_id text, p_item_ref text default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.affiliate_commission;
  s public.affiliate_settings;
  n int := 0;
  total int;
  refunded int;
begin
  select * into s from public.affiliate_settings where id = 1;
  for c in
    select * from public.affiliate_commission
    where source_table = p_source_table and source_id = p_source_id
      and (p_item_ref is null or item_ref = p_item_ref) and status <> 'cancelled'
    for update
  loop
    if c.status in ('held', 'available') then
      update public.affiliate_commission
      set status = 'cancelled', cancel_reason = 'refund', cancelled_at = now(), updated_at = now()
      where id = c.id;
    elsif c.amount > 0 then
      insert into public.affiliate_adjustment (affiliate_id, amount, reason, related_commission_id, created_by)
      values (c.affiliate_id, -c.amount, 'Refund setelah komisi diklaim/dibayar', c.id, 'system')
      on conflict do nothing;
    end if;
    n := n + 1;

    select count(*), count(*) filter (where cancel_reason = 'refund')
      into total, refunded
    from public.affiliate_commission
    where affiliate_id = c.affiliate_id and created_at > now() - interval '90 days';
    if total >= 5 and refunded::numeric / total >= s.fraud_refund_ratio then
      perform affiliate_private.raise_flag(c.affiliate_id, null, 'high_refund_ratio',
        jsonb_build_object('commissions_90d', total, 'refunded_90d', refunded));
    end if;
  end loop;
  return n;
end;
$$;

-- Daily: Tertahan -> Tersedia once the hold is over and nothing is under review.
create function affiliate_private.release_due()
returns int
language sql
security definer
set search_path = ''
as $$
  with released as (
    update public.affiliate_commission
    set status = 'available', released_at = now(), updated_at = now()
    where status = 'held' and available_at <= now() and not under_review
    returning 1
  )
  select count(*)::int from released;
$$;

select cron.schedule('affiliate-release-due', '5 17 * * *', 'select affiliate_private.release_due()');
