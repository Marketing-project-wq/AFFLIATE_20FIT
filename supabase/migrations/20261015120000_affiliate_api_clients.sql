-- API keys for other 20FIT systems (my.20fit.id, the my 20FIT app's
-- backend) to read affiliate data from affiliate.20fit.id's /api/v1.
--
-- One key per consumer, with a label, an environment and the scopes it may
-- use. Only the key's SHA-256 hash and a short prefix are stored; the key
-- itself is shown once, to the Super admin who creates it. Keys are created,
-- listed and revoked by Super admins only, and creating or revoking one is
-- written to affiliate_audit_log.
--
-- The table has no grants: keys are checked by the affiliate_api_* functions
-- below, which the site calls with its publishable key (no service role).
-- Each function checks the key and its scope and returns only the fields of
-- its scope. Bank details, KTP/NIK, addresses and buyers are never returned.

create table public.affiliate_api_clients (
  id uuid primary key default gen_random_uuid(),
  label text not null check (length(btrim(label)) between 2 and 80),
  environment text not null check (environment in ('staging', 'production')),
  scopes text[] not null check (cardinality(scopes) > 0
    and scopes <@ array['program:read', 'affiliates:read', 'stats:read', 'commissions:read']),
  key_prefix text not null unique,
  key_hash text not null unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by text
);

alter table public.affiliate_api_clients enable row level security;
revoke all on public.affiliate_api_clients from anon, authenticated;

-- The active key's id, or an error: invalid_api_key, or scope_not_allowed
-- when the key exists but lacks the scope. last_used_at is updated at most
-- once a minute per key.
create or replace function affiliate_private.api_client(p_key text, p_scope text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  cid uuid;
  cscopes text[];
begin
  if coalesce(p_key, '') !~ '^afk_(live|test)_[0-9a-f]{48}$' then
    raise exception 'invalid_api_key' using errcode = '28000';
  end if;
  select c.id, c.scopes into cid, cscopes from public.affiliate_api_clients c
  where c.key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex') and c.revoked_at is null;
  if cid is null then
    raise exception 'invalid_api_key' using errcode = '28000';
  end if;
  if not (p_scope = any (cscopes)) then
    raise exception 'scope_not_allowed' using errcode = '42501';
  end if;
  update public.affiliate_api_clients set last_used_at = now()
  where id = cid and (last_used_at is null or last_used_at < now() - interval '1 minute');
  return cid;
end;
$$;

-- ── admin: create, list, revoke (Super admin only) ──

create or replace function public.affiliate_api_key_create(p_label text, p_environment text, p_scopes text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k text;
  rec public.affiliate_api_clients;
begin
  if public.affiliate_admin_role() is distinct from 'super' then
    raise exception 'Only a Super admin can manage API keys' using errcode = '42501';
  end if;
  k := 'afk_' || case p_environment when 'production' then 'live' else 'test' end || '_'
    || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.affiliate_api_clients (label, environment, scopes, key_prefix, key_hash, created_by)
  values (btrim(p_label), p_environment, (select array_agg(distinct s order by s) from unnest(p_scopes) s),
    left(k, 17), encode(extensions.digest(k, 'sha256'), 'hex'), coalesce(auth.jwt() ->> 'email', auth.uid()::text))
  returning * into rec;
  perform affiliate_private.log('api_key_created', 'affiliate_api_client', rec.id::text,
    jsonb_build_object('label', rec.label, 'environment', rec.environment, 'scopes', rec.scopes, 'key_prefix', rec.key_prefix));
  -- The only time the key itself leaves the database.
  return jsonb_build_object('id', rec.id, 'label', rec.label, 'environment', rec.environment, 'scopes', rec.scopes,
    'key_prefix', rec.key_prefix, 'created_at', rec.created_at, 'key', k);
end;
$$;

create or replace function public.affiliate_api_key_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.affiliate_admin_role() is distinct from 'super' then
    raise exception 'Only a Super admin can manage API keys' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'environment', c.environment,
      'scopes', c.scopes, 'key_prefix', c.key_prefix, 'created_by', c.created_by, 'created_at', c.created_at,
      'last_used_at', c.last_used_at, 'revoked_at', c.revoked_at, 'revoked_by', c.revoked_by)
    order by c.revoked_at nulls first, c.created_at desc) from public.affiliate_api_clients c), '[]'::jsonb);
end;
$$;

create or replace function public.affiliate_api_key_revoke(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec public.affiliate_api_clients;
begin
  if public.affiliate_admin_role() is distinct from 'super' then
    raise exception 'Only a Super admin can manage API keys' using errcode = '42501';
  end if;
  update public.affiliate_api_clients
  set revoked_at = now(), revoked_by = coalesce(auth.jwt() ->> 'email', auth.uid()::text)
  where id = p_id and revoked_at is null
  returning * into rec;
  if rec.id is null then
    raise exception 'API key not found or already revoked' using errcode = '22023';
  end if;
  perform affiliate_private.log('api_key_revoked', 'affiliate_api_client', rec.id::text,
    jsonb_build_object('label', rec.label, 'environment', rec.environment, 'key_prefix', rec.key_prefix));
end;
$$;

-- ── data, by scope ──

-- program:read — the program's public terms.
create or replace function public.affiliate_api_program(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform affiliate_private.api_client(p_key, 'program:read');
  return (select jsonb_build_object('commission_rate', s.commission_rate, 'min_withdrawal', s.min_withdrawal,
      'pending_days', s.pending_days, 'program_status', s.program_status, 'terms_version', s.terms_version)
    from public.affiliate_settings s order by s.id limit 1);
end;
$$;

-- affiliates:read — code, name, status and join date, a page at a time.
create or replace function public.affiliate_api_affiliates(p_key text, p_limit integer default 100, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  off integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform affiliate_private.api_client(p_key, 'affiliates:read');
  return jsonb_build_object(
    'total', (select count(*) from public.my20fit_affiliates),
    'limit', lim, 'offset', off,
    'items', coalesce((select jsonb_agg(x.item order by x.joined_at, x.code) from (
      select a.joined_at, a.code, jsonb_build_object('code', a.code, 'name', p.full_name, 'status', a.status, 'joined_at', a.joined_at) item
      from public.my20fit_affiliates a
      left join public.my20fit_profile p on p.auth_user_id = a.auth_user_id
      order by a.joined_at, a.code limit lim offset off) x), '[]'::jsonb));
end;
$$;

-- stats:read — one affiliate's clicks, referrals, balances and commissions
-- per status.
create or replace function public.affiliate_api_affiliate_stats(p_key text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.my20fit_affiliates;
begin
  perform affiliate_private.api_client(p_key, 'stats:read');
  select * into a from public.my20fit_affiliates where code = upper(btrim(coalesce(p_code, '')));
  if a.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'code', a.code, 'status', a.status, 'joined_at', a.joined_at,
    'clicks', (select count(*) from public.my20fit_affiliate_clicks c where c.affiliate_id = a.id),
    'referrals', coalesce(a.friends_count, 0),
    'pending_balance', coalesce(a.pending_balance, 0),
    'available_balance', coalesce(a.available_balance, 0),
    'total_earned', coalesce(a.total_earned, 0),
    'commissions_by_status', coalesce((select jsonb_object_agg(x.status, jsonb_build_object('count', x.n, 'amount', x.amount))
      from (select c.status, count(*) n, sum(c.commission_amount) amount from public.my20fit_affiliate_commissions c
            where c.affiliate_id = a.id group by c.status) x), '{}'::jsonb));
end;
$$;

-- commissions:read — commissions created after `since`, oldest first (use
-- the last created_at as the next `since`). No buyer, order or order value.
create or replace function public.affiliate_api_commissions(p_key text, p_since timestamptz default null,
  p_limit integer default 100, p_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  perform affiliate_private.api_client(p_key, 'commissions:read');
  return jsonb_build_object('limit', lim, 'items', coalesce((select jsonb_agg(x.item order by x.created_at, x.id) from (
    select c.created_at, c.id, jsonb_build_object('id', c.id, 'affiliate_code', a.code, 'source_table', c.source_table,
      'commission_amount', c.commission_amount, 'status', c.status, 'order_paid_at', c.order_paid_at,
      'hold_until', c.hold_until, 'released_at', c.released_at, 'cancelled_at', c.cancelled_at, 'created_at', c.created_at) item
    from public.my20fit_affiliate_commissions c
    join public.my20fit_affiliates a on a.id = c.affiliate_id
    where (p_since is null or c.created_at > p_since)
      and (p_code is null or a.code = upper(btrim(p_code)))
    order by c.created_at, c.id limit lim) x), '[]'::jsonb));
end;
$$;

revoke execute on function affiliate_private.api_client(text, text) from public, anon, authenticated;
revoke execute on function public.affiliate_api_key_create(text, text, text[]) from public, anon;
revoke execute on function public.affiliate_api_key_list() from public, anon;
revoke execute on function public.affiliate_api_key_revoke(uuid) from public, anon;
grant execute on function public.affiliate_api_key_create(text, text, text[]) to authenticated;
grant execute on function public.affiliate_api_key_list() to authenticated;
grant execute on function public.affiliate_api_key_revoke(uuid) to authenticated;

-- The data functions are called by the site's server with the publishable
-- key only (role anon); each one checks the API key itself.
revoke execute on function public.affiliate_api_program(text) from public, authenticated;
revoke execute on function public.affiliate_api_affiliates(text, integer, integer) from public, authenticated;
revoke execute on function public.affiliate_api_affiliate_stats(text, text) from public, authenticated;
revoke execute on function public.affiliate_api_commissions(text, timestamptz, integer, text) from public, authenticated;
grant execute on function public.affiliate_api_program(text) to anon;
grant execute on function public.affiliate_api_affiliates(text, integer, integer) to anon;
grant execute on function public.affiliate_api_affiliate_stats(text, text) to anon;
grant execute on function public.affiliate_api_commissions(text, timestamptz, integer, text) to anon;
