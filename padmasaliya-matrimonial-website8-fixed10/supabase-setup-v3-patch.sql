-- =====================================================================
--  PADMASALIYA MATRIMONIAL — v3 patch
--  Run this ONCE in: Supabase Dashboard -> SQL Editor -> New Query -> Run
--  Only needed if you have ALREADY run supabase-setup-v2.sql.
--  (A fresh project can just run v1 then v2 — v2 now contains all of this.)
--
--  WHAT THIS ADDS
--   * Deleting your own profile now asks why, and the reason is kept so the
--     committee can see why families are leaving. The profile itself still
--     goes completely.
-- =====================================================================

-- Why people leave. Kept after the profile is gone, so it has no foreign key
-- back to it — only the reason, and who said it.
create table if not exists profile_deletion_feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete set null,
  reason     text not null,
  details    text,
  created_at timestamptz default now()
);
alter table profile_deletion_feedback enable row level security;

drop policy if exists "Admins read deletion feedback" on profile_deletion_feedback;
create policy "Admins read deletion feedback" on profile_deletion_feedback for select
  to authenticated using (public.is_admin());
-- No insert policy: the row is only ever written by delete_my_profile().

-- The old no-argument version has to go first, otherwise PostgREST sees two
-- functions with the same name and cannot decide which one to call.
drop function if exists public.delete_my_profile();

create or replace function public.delete_my_profile(
  p_reason text default null, p_details text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;

  insert into profile_deletion_feedback (user_id, reason, details)
  values (v_uid, btrim(p_reason), nullif(btrim(p_details), ''));

  delete from parent_profiles where parent_user_id = v_uid;

  return jsonb_build_object('ok', true);
end $fn$;

-- =====================================================================
--  To read why people have left (admins only):
--
--    select reason, details, created_at
--      from profile_deletion_feedback
--     order by created_at desc;
--
--    select reason, count(*) from profile_deletion_feedback group by reason;
-- =====================================================================
