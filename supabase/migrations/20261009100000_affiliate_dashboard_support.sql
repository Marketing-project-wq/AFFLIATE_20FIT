-- What the affiliate dashboard (/dashboard) needs on top of the foundation:
--   1. affiliate_my_summary() also returns the PPh 21 rates (affiliates can't
--      read those settings columns), the hold period, the program status and
--      when the affiliate joined / accepted the terms.
--   2. Claims get a short sequential number (shown as CLM-0001).
--   3. Proof of transfer lives in a private Storage bucket, readable only by
--      the affiliate it belongs to (and affiliate admins); claim_paid takes
--      the object path instead of a URL.

-- ── 1. summary ──────────────────────────────────────────────────────────
create or replace function public.affiliate_my_summary()
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
  active_claim public.affiliate_claim;
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
  select * into active_claim from public.affiliate_claim
  where affiliate_id = a.id and status in ('submitted', 'processing');
  has_profile := exists (select 1 from public.affiliate_payout_profile where affiliate_id = a.id);

  blocker := case
    when a.status <> 'active' then 'affiliate_inactive'
    when active_claim.id is not null then 'claim_in_progress'
    when available < s.min_withdrawal then 'below_minimum'
    when available + adjustments <= 0 then 'adjustments_exceed_balance'
    when a.terms_version is distinct from s.terms_version then 'terms_outdated'
    when not has_profile then 'payout_profile_missing'
  end;

  return jsonb_build_object(
    'code', a.code, 'status', a.status, 'code_changeable', a.code_changed_at is null,
    'joined_at', a.joined_at, 'terms_version', a.terms_version, 'terms_accepted_at', a.terms_accepted_at,
    'current_terms_version', s.terms_version, 'program_status', s.program_status,
    'held', held, 'available', available, 'claimed', claimed, 'paid', paid,
    'pending_adjustments', adjustments, 'min_claim', s.min_withdrawal,
    'to_minimum', greatest(s.min_withdrawal - available, 0), 'pending_days', s.pending_days,
    'tax_rate_npwp', s.tax_rate_npwp, 'tax_rate_no_npwp', s.tax_rate_no_npwp,
    'active_claim_id', active_claim.id, 'active_claim_no', active_claim.claim_no,
    'has_payout_profile', has_profile,
    'can_claim', blocker is null or blocker = 'payout_profile_missing' or blocker = 'terms_outdated',
    'claim_blocker', blocker);
end;
$$;

-- ── 2. claim number ─────────────────────────────────────────────────────
alter table public.affiliate_claim add column if not exists claim_no bigint generated always as identity;
create unique index if not exists affiliate_claim_claim_no_idx on public.affiliate_claim (claim_no);
grant select (claim_no) on public.affiliate_claim to authenticated;

-- ── 3. proof of transfer ────────────────────────────────────────────────
-- Objects are stored as <affiliate_id>/<anything>, e.g.
-- 6f1c…/clm-0001.pdf. The dashboard asks Storage for a short-lived signed
-- URL with the affiliate's own token, which this policy allows only for
-- their own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('affiliate-proofs', 'affiliate-proofs', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

create policy "Affiliates read their own proofs of transfer" on storage.objects
  for select to authenticated
  using (bucket_id = 'affiliate-proofs'
         and ((storage.foldername(name))[1] = (affiliate_private.my_affiliate_id())::text
              or public.affiliate_is_admin()));

create policy "Finance uploads proofs of transfer" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'affiliate-proofs' and public.affiliate_admin_role() in ('finance', 'super'));

create policy "Finance replaces proofs of transfer" on storage.objects
  for update to authenticated
  using (bucket_id = 'affiliate-proofs' and public.affiliate_admin_role() in ('finance', 'super'));

-- storage.objects already has a permissive "Allow All" INSERT policy (from
-- another project, any bucket, anon included). Permissive policies are
-- OR-ed, so these restrictive ones are what actually keep everyone but
-- Finance out of this bucket; other buckets are unaffected.
-- anon gets its own policies without the role check: Postgres checks
-- EXECUTE on every function in a policy even when the OR short-circuits,
-- and anon can't run affiliate_admin_role(), which would break anon uploads
-- to the other buckets.
create policy "Only finance writes affiliate proofs" on storage.objects
  as restrictive for insert to authenticated
  with check (bucket_id <> 'affiliate-proofs' or public.affiliate_admin_role() in ('finance', 'super'));
create policy "Anon never writes affiliate proofs" on storage.objects
  as restrictive for insert to anon
  with check (bucket_id <> 'affiliate-proofs');

create policy "Only finance changes affiliate proofs" on storage.objects
  as restrictive for update to authenticated
  using (bucket_id <> 'affiliate-proofs' or public.affiliate_admin_role() in ('finance', 'super'));
create policy "Anon never changes affiliate proofs" on storage.objects
  as restrictive for update to anon
  using (bucket_id <> 'affiliate-proofs');

create policy "Only finance deletes affiliate proofs" on storage.objects
  as restrictive for delete to authenticated
  using (bucket_id <> 'affiliate-proofs' or public.affiliate_admin_role() in ('finance', 'super'));
create policy "Anon never deletes affiliate proofs" on storage.objects
  as restrictive for delete to anon
  using (bucket_id <> 'affiliate-proofs');

create or replace function public.affiliate_admin_claim_paid(p_claim_id uuid, p_transfer_ref text, p_proof_url text)
returns public.affiliate_claim
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.affiliate_claim;
  proof text := trim(coalesce(p_proof_url, ''));
begin
  perform affiliate_private.require_role(array['finance', 'super']);
  if length(trim(coalesce(p_transfer_ref, ''))) = 0 or length(proof) = 0 then
    raise exception 'A reference number and proof of transfer are required' using errcode = '22023';
  end if;
  select * into c from public.affiliate_claim where id = p_claim_id;
  -- The proof is an object in the private affiliate-proofs bucket, in the
  -- affiliate's own folder, so only they (and admins) can open it.
  if c.id is null or split_part(proof, '/', 1) <> c.affiliate_id::text
     or not exists (select 1 from storage.objects where bucket_id = 'affiliate-proofs' and name = proof) then
    raise exception 'Upload the proof to affiliate-proofs/%/ first and pass its path', c.affiliate_id using errcode = '22023';
  end if;
  update public.affiliate_claim set status = 'paid', paid_at = now(), transfer_ref = trim(p_transfer_ref),
    proof_url = proof, processed_by = coalesce(auth.jwt() ->> 'email', current_user)
  where id = p_claim_id and status in ('submitted', 'processing') returning * into c;
  if c.id is null then
    raise exception 'Only Diajukan or Diproses claims can be marked Dibayar' using errcode = 'P0001';
  end if;
  update public.affiliate_commission set status = 'paid', updated_at = now() where claim_id = c.id and status = 'claimed';
  perform affiliate_private.log('claim_paid', 'claim', c.id::text, jsonb_build_object('transfer_ref', c.transfer_ref, 'proof', proof));
  return c;
end;
$$;
