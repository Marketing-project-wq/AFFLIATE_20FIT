-- KTP details of an affiliate in the 20FIT app's program, collected when
-- they join on affiliate.20fit.id (or later, for affiliates who joined in
-- the app). Everything on the KTP except blood type, plus where they live
-- now (domisili).
--
-- The KTP part is saved once and can't be changed by the affiliate (the
-- 20FIT affiliate team corrects mistakes); only the domisili can change.
-- The table has no grants for anon/authenticated: everything goes through
-- the three functions below, which work on the caller's own row only. The
-- NIK is stored encrypted (affiliate_private.encrypt, same key as payout
-- details) and only its last four digits are ever returned.

create table public.my20fit_affiliate_identity (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  nik_enc bytea not null,
  nik_last4 text not null,
  nik_hash text not null,
  full_name text not null,
  birth_place text not null,
  birth_date date not null,
  gender text not null check (gender in ('L', 'P')),
  address text not null,
  rt_rw text not null,
  kelurahan text not null,
  kecamatan text not null,
  kabupaten text not null,
  provinsi text not null,
  religion text not null,
  marital_status text not null,
  occupation text not null,
  citizenship text not null check (citizenship in ('WNI', 'WNA')),
  valid_until text not null,
  domicile_address text not null,
  domicile_city text not null,
  domicile_province text not null,
  domicile_postal_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index my20fit_affiliate_identity_nik_hash on public.my20fit_affiliate_identity (nik_hash);

alter table public.my20fit_affiliate_identity enable row level security;
revoke all on public.my20fit_affiliate_identity from anon, authenticated;

-- The caller's own details, NIK masked; null when not saved yet.
create or replace function public.affiliate_identity_me()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'nik', '************' || i.nik_last4, 'full_name', i.full_name, 'birth_place', i.birth_place,
    'birth_date', i.birth_date, 'gender', i.gender, 'address', i.address, 'rt_rw', i.rt_rw,
    'kelurahan', i.kelurahan, 'kecamatan', i.kecamatan, 'kabupaten', i.kabupaten, 'provinsi', i.provinsi,
    'religion', i.religion, 'marital_status', i.marital_status, 'occupation', i.occupation,
    'citizenship', i.citizenship, 'valid_until', i.valid_until,
    'domicile_address', i.domicile_address, 'domicile_city', i.domicile_city,
    'domicile_province', i.domicile_province, 'domicile_postal_code', i.domicile_postal_code,
    'saved_at', i.created_at)
  from public.my20fit_affiliate_identity i
  where i.auth_user_id = auth.uid();
$$;

-- Saves the caller's KTP details and domisili, once.
create or replace function public.affiliate_identity_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  nik text := regexp_replace(coalesce(p->>'nik', ''), '\D', '', 'g');
  bd date;
  req text;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if exists (select 1 from public.my20fit_affiliate_identity where auth_user_id = uid) then
    raise exception 'KTP details are already saved and can''t be changed' using errcode = '22023';
  end if;
  if length(nik) <> 16 then
    raise exception 'NIK must be 16 digits' using errcode = '22023';
  end if;
  foreach req in array array['full_name', 'birth_place', 'birth_date', 'gender', 'address', 'rt_rw', 'kelurahan',
    'kecamatan', 'kabupaten', 'provinsi', 'religion', 'marital_status', 'occupation', 'citizenship', 'valid_until',
    'domicile_address', 'domicile_city', 'domicile_province'] loop
    if coalesce(btrim(p->>req), '') = '' then
      raise exception 'Missing KTP field: %', req using errcode = '22023';
    end if;
  end loop;
  begin
    bd := (p->>'birth_date')::date;
  exception when others then
    raise exception 'Invalid birth date' using errcode = '22023';
  end;
  if bd < date '1900-01-01' or bd > current_date then
    raise exception 'Invalid birth date' using errcode = '22023';
  end if;
  if p->>'gender' not in ('L', 'P') then
    raise exception 'Invalid gender' using errcode = '22023';
  end if;
  if p->>'citizenship' not in ('WNI', 'WNA') then
    raise exception 'Invalid citizenship' using errcode = '22023';
  end if;

  insert into public.my20fit_affiliate_identity (
    auth_user_id, nik_enc, nik_last4, nik_hash, full_name, birth_place, birth_date, gender, address, rt_rw,
    kelurahan, kecamatan, kabupaten, provinsi, religion, marital_status, occupation, citizenship, valid_until,
    domicile_address, domicile_city, domicile_province, domicile_postal_code)
  values (
    uid, affiliate_private.encrypt(nik), right(nik, 4), encode(extensions.digest(nik, 'sha256'), 'hex'),
    btrim(p->>'full_name'), btrim(p->>'birth_place'), bd, p->>'gender', btrim(p->>'address'), btrim(p->>'rt_rw'),
    btrim(p->>'kelurahan'), btrim(p->>'kecamatan'), btrim(p->>'kabupaten'), btrim(p->>'provinsi'),
    btrim(p->>'religion'), btrim(p->>'marital_status'), btrim(p->>'occupation'), p->>'citizenship',
    btrim(p->>'valid_until'), btrim(p->>'domicile_address'), btrim(p->>'domicile_city'),
    btrim(p->>'domicile_province'), nullif(btrim(coalesce(p->>'domicile_postal_code', '')), ''));

  perform affiliate_private.log('saved_identity', 'affiliate_identity', uid::text, '{}'::jsonb);
  return public.affiliate_identity_me();
end;
$$;

-- Changes the caller's domisili; the KTP part stays as saved.
create or replace function public.affiliate_identity_update_domicile(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if coalesce(btrim(p->>'domicile_address'), '') = '' or coalesce(btrim(p->>'domicile_city'), '') = ''
     or coalesce(btrim(p->>'domicile_province'), '') = '' then
    raise exception 'Missing KTP field: domicile' using errcode = '22023';
  end if;
  update public.my20fit_affiliate_identity set
    domicile_address = btrim(p->>'domicile_address'), domicile_city = btrim(p->>'domicile_city'),
    domicile_province = btrim(p->>'domicile_province'),
    domicile_postal_code = nullif(btrim(coalesce(p->>'domicile_postal_code', '')), ''), updated_at = now()
  where auth_user_id = uid;
  if not found then
    raise exception 'KTP details are not saved yet' using errcode = '22023';
  end if;
  perform affiliate_private.log('updated_domicile', 'affiliate_identity', uid::text, '{}'::jsonb);
  return public.affiliate_identity_me();
end;
$$;

revoke execute on function public.affiliate_identity_me() from public, anon;
revoke execute on function public.affiliate_identity_save(jsonb) from public, anon;
revoke execute on function public.affiliate_identity_update_domicile(jsonb) from public, anon;
grant execute on function public.affiliate_identity_me() to authenticated;
grant execute on function public.affiliate_identity_save(jsonb) to authenticated;
grant execute on function public.affiliate_identity_update_domicile(jsonb) to authenticated;
