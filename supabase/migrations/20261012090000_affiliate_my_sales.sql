-- Sales page of the affiliate dashboard (/dashboard/sales): one function
-- returns everything the page shows, all from public.affiliate_commission
-- (one row = one purchase made in the app through one of the affiliate's
-- links), for the signed-in affiliate only.
--
--   summary  valid = available + claimed + paid, pending = held (still in
--            the hold period), cancelled kept apart; total = valid + pending
--   weekly   last p_weeks weeks (Monday start), Asia/Jakarta
--   monthly  last p_months months, Asia/Jakarta
--   products non-cancelled purchases per product, most bought first
--
-- Amounts are the affiliate's commission ("pendapatan"); what the buyer paid
-- is not returned. A purchase is dated by when it was paid.

create or replace function public.affiliate_my_sales(p_weeks int default 12, p_months int default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.affiliate := affiliate_private.current_affiliate();
  weeks int := least(greatest(coalesce(p_weeks, 12), 1), 52);
  months int := least(greatest(coalesce(p_months, 12), 1), 24);
  local_now timestamp := now() at time zone 'Asia/Jakarta';
  result jsonb;
begin
  with c as (
    select cm.status, cm.amount, coalesce(p.name, 'Produk') as product,
           (coalesce(cm.paid_at_source, cm.created_at) at time zone 'Asia/Jakarta') as at_local
    from public.affiliate_commission cm
    left join public.affiliate_product p on p.id = cm.product_id
    where cm.affiliate_id = a.id
  ),
  live as (select * from c where status <> 'cancelled'),
  w as (
    select gs::date as start, (gs + interval '6 days')::date as finish
    from generate_series(date_trunc('week', local_now) - make_interval(weeks => weeks - 1), date_trunc('week', local_now), interval '1 week') gs
  ),
  m as (
    select gs::date as start, (gs + interval '1 month' - interval '1 day')::date as finish
    from generate_series(date_trunc('month', local_now) - make_interval(months => months - 1), date_trunc('month', local_now), interval '1 month') gs
  )
  select jsonb_build_object(
    'summary', (select jsonb_build_object(
        'total', count(*) filter (where status <> 'cancelled'),
        'valid', count(*) filter (where status in ('available', 'claimed', 'paid')),
        'pending', count(*) filter (where status = 'held'),
        'cancelled', count(*) filter (where status = 'cancelled'),
        'commission_total', coalesce(sum(amount) filter (where status <> 'cancelled'), 0),
        'commission_valid', coalesce(sum(amount) filter (where status in ('available', 'claimed', 'paid')), 0),
        'commission_pending', coalesce(sum(amount) filter (where status = 'held'), 0))
      from c),
    'weekly', (select coalesce(jsonb_agg(jsonb_build_object('start', w.start, 'end', w.finish,
        'transactions', (select count(*) from live where live.at_local >= w.start and live.at_local < w.finish + 1),
        'commission', (select coalesce(sum(amount), 0) from live where live.at_local >= w.start and live.at_local < w.finish + 1))
        order by w.start), '[]'::jsonb) from w),
    'monthly', (select coalesce(jsonb_agg(jsonb_build_object('start', m.start, 'end', m.finish,
        'transactions', (select count(*) from live where live.at_local >= m.start and live.at_local < m.finish + 1),
        'commission', (select coalesce(sum(amount), 0) from live where live.at_local >= m.start and live.at_local < m.finish + 1))
        order by m.start), '[]'::jsonb) from m),
    'products', (select coalesce(jsonb_agg(jsonb_build_object('product', product, 'transactions', n, 'commission', total)
        order by n desc, total desc, product), '[]'::jsonb)
      from (select product, count(*) as n, sum(amount) as total from live group by product) x),
    'weeks', weeks, 'months', months, 'timezone', 'Asia/Jakarta')
  into result;
  return result;
end;
$$;

revoke execute on function public.affiliate_my_sales(int, int) from public, anon;
grant execute on function public.affiliate_my_sales(int, int) to authenticated;
