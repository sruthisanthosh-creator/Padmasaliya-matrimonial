-- =====================================================================
--  PADMASALIYA MATRIMONIAL — v7
--  Run this ONCE in: Supabase Dashboard -> SQL Editor -> New Query -> Run
--  Needs v1 through v6 to have run already.
--
--  WHAT THIS CHANGES
--   1. The admin panel sees every field a profile holds, including the
--      photo and the jathagam.
--   2. Deleting your own profile now archives it instead of destroying it.
--      It leaves the member site completely — search, shortlists, interests,
--      everything — but the owner can still see it in the admin panel.
--   3. A password on top of the admin login. The unlock is kept in the
--      DATABASE with a two-hour expiry, not in the browser, so it is a real
--      lock: without the password every admin_* call refuses, no matter
--      what the browser has been told.
-- =====================================================================


-- =====================================================================
--  SECTION 1 — ADMIN PASSWORD
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists admin_secrets (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  password_hash  text not null,
  unlocked_until timestamptz,
  failed_count   int not null default 0,
  locked_until   timestamptz,
  updated_at     timestamptz default now()
);
alter table admin_secrets enable row level security;
-- No browser policy at all. The hash is only ever touched inside the
-- functions below, so it can never be selected out over the API.


-- Where the panel starts: is a password set, is this admin unlocked, are
-- they locked out after too many wrong tries. Deliberately does NOT need
-- the unlock itself, or you could never get in.
create or replace function public.admin_lock_state()
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_s   admin_secrets;
begin
  if v_uid is null or not public.is_admin(v_uid) then
    return jsonb_build_object('admin', false);
  end if;
  select * into v_s from admin_secrets where user_id = v_uid;
  return jsonb_build_object(
    'admin', true,
    'has_password', v_s.user_id is not null,
    'unlocked', coalesce(v_s.unlocked_until > now(), false),
    'unlocked_until', v_s.unlocked_until,
    'locked_out', coalesce(v_s.locked_until > now(), false),
    'locked_until', v_s.locked_until
  );
end $fn$;


create or replace function public.admin_set_password(
  p_new text, p_current text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions as $fn$
declare
  v_uid uuid := auth.uid();
  v_s   admin_secrets;
begin
  if v_uid is null or not public.is_admin(v_uid) then
    raise exception 'NOT_ADMIN' using errcode = '42501';
  end if;
  if p_new is null or length(p_new) < 8 then
    raise exception 'PASSWORD_TOO_SHORT' using errcode = 'P0001';
  end if;

  select * into v_s from admin_secrets where user_id = v_uid;

  -- Changing an existing password needs the old one. Setting the first one
  -- does not — the email login already proved who they are.
  if v_s.user_id is not null then
    if p_current is null or v_s.password_hash <> crypt(p_current, v_s.password_hash) then
      raise exception 'WRONG_PASSWORD' using errcode = 'P0001';
    end if;
  end if;

  insert into admin_secrets (user_id, password_hash, unlocked_until, failed_count, locked_until, updated_at)
  values (v_uid, crypt(p_new, gen_salt('bf')), now() + interval '2 hours', 0, null, now())
  on conflict (user_id) do update
    set password_hash = excluded.password_hash,
        unlocked_until = excluded.unlocked_until,
        failed_count = 0, locked_until = null, updated_at = now();

  return jsonb_build_object('ok', true);
end $fn$;


create or replace function public.admin_unlock(p_password text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions as $fn$
declare
  v_uid uuid := auth.uid();
  v_s   admin_secrets;
begin
  if v_uid is null or not public.is_admin(v_uid) then
    raise exception 'NOT_ADMIN' using errcode = '42501';
  end if;
  select * into v_s from admin_secrets where user_id = v_uid;
  if v_s.user_id is null then
    raise exception 'NO_PASSWORD_SET' using errcode = 'P0001';
  end if;
  if v_s.locked_until is not null and v_s.locked_until > now() then
    raise exception 'LOCKED_OUT' using errcode = 'P0001';
  end if;

  if v_s.password_hash <> crypt(coalesce(p_password, ''), v_s.password_hash) then
    -- Five wrong tries buys a fifteen minute wait. Guessing is not a
    -- practical way in, and the owner is never far from the SQL editor.
    update admin_secrets
       set failed_count = failed_count + 1,
           locked_until = case when failed_count + 1 >= 5
                               then now() + interval '15 minutes' end
     where user_id = v_uid;
    raise exception 'WRONG_PASSWORD' using errcode = 'P0001';
  end if;

  update admin_secrets
     set unlocked_until = now() + interval '2 hours',
         failed_count = 0, locked_until = null
   where user_id = v_uid;

  return jsonb_build_object('ok', true, 'unlocked_until', now() + interval '2 hours');
end $fn$;


create or replace function public.admin_lock()
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare v_uid uuid := auth.uid();
begin
  update admin_secrets set unlocked_until = null where user_id = v_uid;
  return jsonb_build_object('ok', true);
end $fn$;


-- THE GUARD, now with the second lock. Nothing else changes — every
-- admin_* function already calls this, so they are all covered at once.
create or replace function public.assert_admin()
returns uuid
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_s   admin_secrets;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if not public.is_admin(v_uid) then
    raise exception 'NOT_ADMIN' using errcode = '42501';
  end if;

  select * into v_s from admin_secrets where user_id = v_uid;
  -- No password set yet: the panel will ask them to choose one. Until then
  -- the email login is the only gate, exactly as it was before v7.
  if v_s.user_id is null then return v_uid; end if;

  if v_s.unlocked_until is null or v_s.unlocked_until <= now() then
    raise exception 'ADMIN_LOCKED' using errcode = '42501';
  end if;
  return v_uid;
end $fn$;


-- =====================================================================
--  SECTION 2 — DELETING A PROFILE ARCHIVES IT
--  The member site loses it completely. The owner keeps it.
-- =====================================================================

alter table parent_profiles add column if not exists deleted_reason  text;
alter table parent_profiles add column if not exists deleted_details text;

create index if not exists parent_profiles_deleted_idx on parent_profiles (deleted_at);

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

  -- Archive rather than destroy. Everything that reads a profile already
  -- filters on deleted_at is null, so from every member's point of view it
  -- is gone: out of search, out of shortlists, out of interest lists.
  update parent_profiles
     set deleted_at = now(),
         deleted_reason = btrim(p_reason),
         deleted_details = nullif(btrim(p_details), ''),
         visible = false,
         status = 'draft'
   where parent_user_id = v_uid and deleted_at is null;

  -- Nobody should keep a shortlist entry pointing at a profile that asked
  -- to be removed.
  delete from saved_profiles
   where saved_profile_id in (select id from parent_profiles
                               where parent_user_id = v_uid);
  delete from recommendations
   where recommended_profile_id in (select id from parent_profiles
                                     where parent_user_id = v_uid);

  return jsonb_build_object('ok', true);
end $fn$;


-- An archived profile must not surface through an interest either.
create or replace function public.my_received_interests(p_limit int default 30, p_offset int default 0)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_pre boolean;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  v_pre := public.is_premium(v_uid);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'interest_id', i.id, 'status', i.status, 'message', i.message,
             'created_at',  i.created_at,
             'profile',     public.redact_profile(p, v_pre or i.status = 'accepted'))
           order by i.created_at desc)
      from interests i
      join parent_profiles p on p.id = i.from_profile_id
     where i.to_user_id = v_uid
       and p.deleted_at is null
     limit greatest(p_limit, 1) offset greatest(p_offset, 0)
  ), '[]'::jsonb);
end $fn$;

create or replace function public.my_sent_interests(p_limit int default 30)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_pre boolean;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  v_pre := public.is_premium(v_uid);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'interest_id', i.id, 'status', i.status, 'created_at', i.created_at,
             'profile',     public.redact_profile(p, v_pre or i.status = 'accepted'))
           order by i.created_at desc)
      from interests i
      join parent_profiles p on p.id = i.to_profile_id
     where i.from_user_id = v_uid
       and p.deleted_at is null
     limit greatest(p_limit, 1)
  ), '[]'::jsonb);
end $fn$;


-- =====================================================================
--  SECTION 3 — THE ADMIN SEES EVERYTHING
-- =====================================================================

-- Archived rows are included, flagged, and filterable. Photo and jathagam
-- paths come through so the panel can show them.
create or replace function public.admin_list_profiles(
  p_search text default null,
  p_status text default null,   -- published | draft | hidden | incomplete | demo | deleted
  p_limit  int  default 25,
  p_offset int  default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := public.assert_admin();
  v_lim int := least(greatest(coalesce(p_limit, 25), 1), 200);
  v_off int := greatest(coalesce(p_offset, 0), 0);
  v_out jsonb;
begin
  with f as (
    select p.* from parent_profiles p
     where (p_search is null or p_search = '' or (
              p.full_name    ilike '%' || p_search || '%'
           or p.gotram       ilike '%' || p_search || '%'
           or p.native_place ilike '%' || p_search || '%'
           or p.profession   ilike '%' || p_search || '%'
           or p.contact_phone like '%' || p_search || '%'))
       -- an archived profile only shows under its own filter, so the
       -- everyday list is not cluttered with removed families
       and (p_status = 'deleted' or p.deleted_at is null)
       and (p_status is null or p_status = '' or
            (p_status = 'published'  and p.status = 'published' and p.visible and p.is_complete) or
            (p_status = 'draft'      and p.status = 'draft') or
            (p_status = 'hidden'     and p.visible = false) or
            (p_status = 'incomplete' and not p.is_complete) or
            (p_status = 'demo'       and p.is_demo) or
            (p_status = 'deleted'    and p.deleted_at is not null))
  ),
  pg as (select f.id from f order by f.created_at desc limit v_lim offset v_off)
  select jsonb_build_object(
    'total', (select count(*) from f),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'full_name', p.full_name, 'created_for', p.created_for,
               'gotram', p.gotram, 'native_place', p.native_place,
               'city', p.city, 'state', p.state, 'country', p.country,
               'dob', p.dob,
               'age', case when p.dob is null then null else extract(year from age(p.dob))::int end,
               'height', p.height, 'nakshatra', p.nakshatra, 'rasi', p.rasi,
               'horoscope_gunas', p.horoscope_gunas, 'education', p.education,
               'profession', p.profession, 'annual_income', p.annual_income,
               'income_lpa', p.income_lpa, 'work_location', p.work_location,
               'about', p.about, 'marital_status', p.marital_status,
               'interests', to_jsonb(p.interests),
               'contact_phone', p.contact_phone,
               'status', p.status, 'visible', p.visible, 'is_complete', p.is_complete,
               'is_demo', p.is_demo,
               'photo_path', p.photo_path, 'jathagam_path', p.jathagam_path,
               'has_photo', p.photo_path is not null,
               'has_jathagam', p.jathagam_path is not null,
               'deleted_at', p.deleted_at,
               'deleted_reason', p.deleted_reason,
               'deleted_details', p.deleted_details,
               'created_at', p.created_at, 'updated_at', p.updated_at,
               'owner_email', (select u.email from auth.users u where u.id = p.parent_user_id),
               'reports', (select count(*) from profile_reports r
                            where r.reported_profile_id = p.id and r.status = 'open'))
             order by p.created_at desc)
        from parent_profiles p where p.id in (select pg.id from pg)
    ), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $fn$;


-- Put an archived profile back, if it was removed by mistake.
create or replace function public.admin_restore_profile(p_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  update parent_profiles
     set deleted_at = null, deleted_reason = null, deleted_details = null,
         visible = true, status = 'published'
   where id = p_id;
  return jsonb_build_object('ok', true);
end $fn$;


-- The dashboard counts archived profiles separately from live ones.
create or replace function public.admin_stats()
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  return jsonb_build_object(
    'profiles', jsonb_build_object(
      'total',      (select count(*) from parent_profiles where deleted_at is null),
      'published',  (select count(*) from parent_profiles where status = 'published' and is_complete and deleted_at is null),
      'draft',      (select count(*) from parent_profiles where status = 'draft' and deleted_at is null),
      'incomplete', (select count(*) from parent_profiles where not is_complete and deleted_at is null),
      'hidden',     (select count(*) from parent_profiles where visible = false and deleted_at is null),
      'demo',       (select count(*) from parent_profiles where is_demo and deleted_at is null),
      'sons',       (select count(*) from parent_profiles where created_for = 'son' and deleted_at is null),
      'daughters',  (select count(*) from parent_profiles where created_for = 'daughter' and deleted_at is null),
      'with_photo', (select count(*) from parent_profiles where photo_path is not null and deleted_at is null),
      'new_7d',     (select count(*) from parent_profiles where created_at > now() - interval '7 days' and deleted_at is null),
      'archived',   (select count(*) from parent_profiles where deleted_at is not null)
    ),
    'members', jsonb_build_object(
      'total',      (select count(*) from auth.users),
      'confirmed',  (select count(*) from auth.users where email_confirmed_at is not null),
      'new_7d',     (select count(*) from auth.users where created_at > now() - interval '7 days'),
      'active_7d',  (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
      'active_30d', (select count(*) from auth.users where last_sign_in_at > now() - interval '30 days'),
      'never_signed_in', (select count(*) from auth.users where last_sign_in_at is null)
    ),
    'premium', jsonb_build_object(
      'active',    (select count(*) from user_tiers
                     where tier = 'premium' and (premium_until is null or premium_until > now())),
      'expired',   (select count(*) from user_tiers
                     where tier = 'premium' and premium_until is not null and premium_until <= now()),
      'expiring_30d', (select count(*) from user_tiers
                     where tier = 'premium' and premium_until between now() and now() + interval '30 days'),
      'codes_unused', (select count(*) from premium_codes where used_count < max_uses),
      'codes_redeemed', (select count(*) from premium_code_uses)
    ),
    'activity', jsonb_build_object(
      'interests',        (select count(*) from interests),
      'interests_7d',     (select count(*) from interests where created_at > now() - interval '7 days'),
      'accepted',         (select count(*) from interests where status = 'accepted'),
      'pending',          (select count(*) from interests where status = 'pending'),
      'saved',            (select count(*) from saved_profiles),
      'reports_open',     (select count(*) from profile_reports where status = 'open'),
      'waitlist',         (select count(*) from waitlist),
      'waitlist_pending', (select count(*) from waitlist where notified_at is null),
      'deletions',        (select count(*) from profile_deletion_feedback)
    ),
    'signups', coalesce((
      select jsonb_agg(jsonb_build_object('day', d::date, 'n',
               (select count(*) from auth.users u where u.created_at::date = d::date))
             order by d)
        from generate_series(current_date - 13, current_date, interval '1 day') d
    ), '[]'::jsonb),
    'profiles_by_day', coalesce((
      select jsonb_agg(jsonb_build_object('day', d::date, 'n',
               (select count(*) from parent_profiles p where p.created_at::date = d::date))
             order by d)
        from generate_series(current_date - 13, current_date, interval '1 day') d
    ), '[]'::jsonb)
  );
end $fn$;


-- =====================================================================
--  SECTION 4 — THE ADMIN CAN OPEN ANY PHOTO OR JATHAGAM
--  Members are unchanged: your own file, or any file if you can browse.
--  An admin is added to that list so the panel can show what it holds.
-- =====================================================================

drop policy if exists "Public read profile photos"        on storage.objects;
drop policy if exists "Own photo or premium reads all"    on storage.objects;
drop policy if exists "Own photo or any browsing member"  on storage.objects;
create policy "Own photo or any browsing member" on storage.objects for select
  to authenticated using (
    bucket_id = 'profile-photos'
    and ((storage.foldername(name))[1] = auth.uid()::text
         or public.can_browse()
         or public.is_admin())
  );


-- =====================================================================
--  Done.
--
--  Set the admin password from the panel itself the next time you open it,
--  or here:
--     select public.admin_set_password('your-new-password');
--
--  Forgotten it? Clear it and the panel will ask you to set a new one:
--     delete from admin_secrets
--      where user_id = (select id from auth.users
--                        where email = 'matrimonialpadmasaliyar@gmail.com');
--
--  Archived profiles (deleted by their owner, kept for you):
--     select full_name, deleted_at, deleted_reason from parent_profiles
--      where deleted_at is not null order by deleted_at desc;
-- =====================================================================
