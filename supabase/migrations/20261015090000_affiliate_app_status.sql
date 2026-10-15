-- Signing up as an affiliate on affiliate.20fit.id needs the 20FIT app:
-- the caller must have used the app (iOS or Android) signed in with this
-- account. The signals are the app's own: a signed-in app event
-- (my20fit_app_events) or a push token registered by the app
-- (my20fit_device_tokens). Neither table is readable by users, so this
-- function answers for the caller's own account only, with a yes/no and the
-- platform, nothing else. Both lookups use the tables' auth_user_id indexes.

create or replace function public.affiliate_app_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'installed',
      exists (select 1 from public.my20fit_app_events e where e.auth_user_id = auth.uid() and e.platform in ('ios', 'android'))
      or exists (select 1 from public.my20fit_device_tokens t where t.auth_user_id = auth.uid()),
    'platform', coalesce(
      (select e.platform from public.my20fit_app_events e
        where e.auth_user_id = auth.uid() and e.platform in ('ios', 'android') order by e.created_at desc limit 1),
      (select t.platform from public.my20fit_device_tokens t
        where t.auth_user_id = auth.uid() order by t.last_seen_at desc nulls last limit 1))) end;
$$;

revoke execute on function public.affiliate_app_status() from public, anon;
grant execute on function public.affiliate_app_status() to authenticated;
