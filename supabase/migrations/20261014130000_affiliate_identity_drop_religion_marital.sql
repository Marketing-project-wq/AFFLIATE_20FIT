-- The sign-up no longer asks for religion (agama) or marital status
-- (status perkawinan). The columns stay (deprecated, nullable) so nothing
-- already saved is lost; affiliate_identity_save no longer requires them.

alter table public.my20fit_affiliate_identity
  alter column religion drop not null,
  alter column marital_status drop not null;

comment on column public.my20fit_affiliate_identity.religion is 'Deprecated: no longer collected (2026-10-14).';
comment on column public.my20fit_affiliate_identity.marital_status is 'Deprecated: no longer collected (2026-10-14).';

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
    'kecamatan', 'kabupaten', 'provinsi', 'citizenship',
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
    kelurahan, kecamatan, kabupaten, provinsi, citizenship,
    domicile_address, domicile_city, domicile_province, domicile_postal_code)
  values (
    uid, affiliate_private.encrypt(nik), right(nik, 4), encode(extensions.digest(nik, 'sha256'), 'hex'),
    btrim(p->>'full_name'), btrim(p->>'birth_place'), bd, p->>'gender', btrim(p->>'address'), btrim(p->>'rt_rw'),
    btrim(p->>'kelurahan'), btrim(p->>'kecamatan'), btrim(p->>'kabupaten'), btrim(p->>'provinsi'),
    p->>'citizenship',
    btrim(p->>'domicile_address'), btrim(p->>'domicile_city'),
    btrim(p->>'domicile_province'), nullif(btrim(coalesce(p->>'domicile_postal_code', '')), ''));

  perform affiliate_private.log('saved_identity', 'affiliate_identity', uid::text, '{}'::jsonb);
  return public.affiliate_identity_me();
end;
$$;
