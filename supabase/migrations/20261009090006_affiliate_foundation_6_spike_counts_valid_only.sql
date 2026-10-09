-- Affiliate program foundation, part 6: the link-spike check counted
-- cancelled commissions (self-purchases, product mismatches), so an
-- affiliate could be flagged for transactions that never count. Only
-- commissions that still count are compared now.

set local lock_timeout = '10s';

create or replace function affiliate_private.record_paid(
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
  where link_id = l.id and status <> 'cancelled' and created_at > now() - interval '24 hours';
  select count(*) / 30.0 into baseline from public.affiliate_commission
  where link_id = l.id and status <> 'cancelled'
    and created_at between now() - interval '31 days' and now() - interval '24 hours';
  if recent >= 5 and recent > greatest(baseline, 1) * s.fraud_spike_multiplier then
    perform affiliate_private.raise_flag(a.id, l.id, 'link_spike',
      jsonb_build_object('last_24h', recent, 'daily_avg_30d', round(baseline, 2)));
  end if;

  update public.affiliate_commission set under_review = true
  where id = new_id and exists (select 1 from public.affiliate_flag where affiliate_id = a.id and status = 'open');
  return new_id;
end;
$$;

revoke execute on function affiliate_private.record_paid(text, text, text, text, uuid, uuid, bigint, timestamptz, text) from public, anon, authenticated;
