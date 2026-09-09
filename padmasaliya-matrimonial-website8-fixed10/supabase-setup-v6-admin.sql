-- =====================================================================
--  PADMASALIYA MATRIMONIAL — v6: the admin panel
--  Run this ONCE in: Supabase Dashboard -> SQL Editor -> New Query -> Run
--  Needs v1 through v5 to have run already.
--
--  WHAT THIS ADDS
--   * Every control the site owner needs, as database functions that check
--     is_admin() before they do anything. The admin page is only a screen —
--     if someone opened it without being an admin, every call would refuse.
--   * Demo profiles: parent_user_id becomes nullable and a is_demo flag
--     marks seeded rows, so test data needs no fake login accounts and can
--     be deleted in one statement when the real members arrive.
-- =====================================================================


-- =====================================================================
--  SECTION 1 — DEMO PROFILES NEED NO LOGIN ACCOUNT
-- =====================================================================

alter table parent_profiles alter column parent_user_id drop not null;
alter table parent_profiles add column if not exists is_demo boolean not null default false;

create index if not exists parent_profiles_demo_idx on parent_profiles (is_demo);

-- "<>" against NULL is NULL, which the WHERE clause reads as false — so a
-- demo row (parent_user_id NULL) would silently vanish from search. IS
-- DISTINCT FROM is the NULL-safe form.
create or replace function public.search_profiles(
  p_looking_for text    default null,
  p_gotram      text    default null,
  p_keyword     text    default null,
  p_profession  text    default null,
  p_place       text    default null,
  p_min_income  numeric default null,
  p_min_age     int     default null,
  p_max_age     int     default null,
  p_only_photo  boolean default false,
  p_limit       int     default 9,
  p_offset      int     default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid    uuid := public.assert_can_browse();
  v_full   boolean := public.is_premium(v_uid);
  v_result jsonb;
  v_lim    int := least(greatest(coalesce(p_limit, 9), 1), 48);
  v_off    int := greatest(coalesce(p_offset, 0), 0);
begin
  with f as (
    select p.id, p.created_at
      from parent_profiles p
     where p.parent_user_id is distinct from v_uid
       and p.status = 'published'
       and p.visible = true
       and p.deleted_at is null
       and p.is_complete
       and (p_looking_for is null or p.created_for = p_looking_for)
       and (p_gotram     is null or p.gotram = p_gotram)
       and (p_profession is null or p.profession ilike '%' || p_profession || '%')
       and (p_place      is null or p.native_place ilike '%' || p_place || '%'
                                 or p.work_location ilike '%' || p_place || '%')
       and (p_min_income is null or coalesce(p.income_lpa, 0) >= p_min_income)
       and (p_min_age    is null or extract(year from age(p.dob))::int >= p_min_age)
       and (p_max_age    is null or extract(year from age(p.dob))::int <= p_max_age)
       and (p_only_photo is not true or p.photo_path is not null)
       and (p_keyword is null or p_keyword = '' or (
              p.full_name     ilike '%' || p_keyword || '%'
           or p.profession    ilike '%' || p_keyword || '%'
           or p.education     ilike '%' || p_keyword || '%'
           or p.native_place  ilike '%' || p_keyword || '%'
           or p.work_location ilike '%' || p_keyword || '%'
           or p.gotram        ilike '%' || p_keyword || '%'))
       and not exists (select 1 from profile_reports r
                        where r.reporter_user_id = v_uid and r.reported_profile_id = p.id)
  ),
  pg as (select f.id from f order by f.created_at desc limit v_lim offset v_off)
  select jsonb_build_object(
    'total',   (select count(*) from f),
    'premium', v_full,
    'rows', coalesce((
      select jsonb_agg(
               public.redact_profile(p2, v_full) || jsonb_build_object(
                 'saved',       exists (select 1 from saved_profiles s
                                         where s.parent_user_id = v_uid and s.saved_profile_id = p2.id),
                 'recommended', exists (select 1 from recommendations rc
                                         where rc.parent_user_id = v_uid and rc.recommended_profile_id = p2.id),
                 'interest',    (select i.status from interests i
                                  where i.from_user_id = v_uid and i.to_profile_id = p2.id)
               )
               order by p2.created_at desc)
        from parent_profiles p2 where p2.id in (select pg.id from pg)
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end $fn$;

-- A demo profile has no owner, so interest cannot be sent to it. Say so
-- plainly instead of failing on a null.
create or replace function public.send_interest(p_to_profile uuid, p_message text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid   uuid := public.assert_can_browse();
  v_mine  parent_profiles;
  v_them  parent_profiles;
  v_cap   int;
  v_today int;
begin
  select * into v_mine from parent_profiles p where p.parent_user_id = v_uid;
  select * into v_them from parent_profiles p
   where p.id = p_to_profile and p.status = 'published'
     and p.visible = true and p.deleted_at is null;
  if v_them.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_them.parent_user_id is null then
    raise exception 'DEMO_PROFILE' using errcode = 'P0001';
  end if;
  if v_them.parent_user_id = v_uid then
    raise exception 'CANNOT_INTEREST_SELF' using errcode = 'P0001';
  end if;
  if exists (select 1 from interests i
              where i.from_user_id = v_uid and i.to_profile_id = v_them.id) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  v_cap := case when public.is_premium(v_uid) then 40 else 5 end;
  select count(*) into v_today from interests i
   where i.from_user_id = v_uid and i.created_at > now() - interval '24 hours';
  if v_today >= v_cap then
    raise exception 'DAILY_LIMIT' using errcode = 'P0001';
  end if;

  insert into interests (from_user_id, from_profile_id, to_user_id, to_profile_id, message)
  values (v_uid, v_mine.id, v_them.parent_user_id, v_them.id, nullif(btrim(p_message), ''))
  on conflict (from_user_id, to_profile_id) do nothing;

  insert into notifications (user_id, kind, title, body, link)
  values (v_them.parent_user_id, 'interest_received',
          'New interest received',
          coalesce(v_mine.full_name, 'A family') || ' (' ||
            coalesce(v_mine.gotram, 'Padmasaliya') || ') has shown interest in ' ||
            coalesce(v_them.full_name, 'your profile') || '.',
          'dashboard.html#received');

  return jsonb_build_object('ok', true, 'remaining', v_cap - v_today - 1);
end $fn$;


-- =====================================================================
--  SECTION 2 — THE GUARD
--  Every function below starts here. An admin page in the browser is just
--  a screen; this is what actually decides who may act.
-- =====================================================================

create or replace function public.assert_admin()
returns uuid
language plpgsql stable security definer set search_path = public as $fn$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if not public.is_admin(v_uid) then
    raise exception 'NOT_ADMIN' using errcode = '42501';
  end if;
  return v_uid;
end $fn$;


-- =====================================================================
--  SECTION 3 — THE DASHBOARD NUMBERS
-- =====================================================================

create or replace function public.admin_stats()
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  return jsonb_build_object(
    'profiles', jsonb_build_object(
      'total',      (select count(*) from parent_profiles),
      'published',  (select count(*) from parent_profiles where status = 'published' and is_complete),
      'draft',      (select count(*) from parent_profiles where status = 'draft'),
      'incomplete', (select count(*) from parent_profiles where not is_complete),
      'hidden',     (select count(*) from parent_profiles where visible = false),
      'demo',       (select count(*) from parent_profiles where is_demo),
      'sons',       (select count(*) from parent_profiles where created_for = 'son'),
      'daughters',  (select count(*) from parent_profiles where created_for = 'daughter'),
      'with_photo', (select count(*) from parent_profiles where photo_path is not null),
      'new_7d',     (select count(*) from parent_profiles where created_at > now() - interval '7 days')
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
    -- last 14 days of sign-ups, for the little chart
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
--  SECTION 4 — PROFILES: LIST, CREATE, EDIT, DELETE
-- =====================================================================

create or replace function public.admin_list_profiles(
  p_search text default null,
  p_status text default null,       -- 'published' | 'draft' | 'hidden' | 'incomplete' | 'demo'
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
       and (p_status is null or p_status = '' or
            (p_status = 'published'  and p.status = 'published' and p.visible and p.is_complete) or
            (p_status = 'draft'      and p.status = 'draft') or
            (p_status = 'hidden'     and p.visible = false) or
            (p_status = 'incomplete' and not p.is_complete) or
            (p_status = 'demo'       and p.is_demo))
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
               'is_demo', p.is_demo, 'has_photo', p.photo_path is not null,
               'has_jathagam', p.jathagam_path is not null,
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

-- One function for both create and edit: pass an id to edit, omit it to
-- create. Admin-created rows are demo rows — they have no login account
-- behind them, which is exactly what test data should be.
create or replace function public.admin_save_profile(p_id uuid, p_data jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid uuid := public.assert_admin();
  v_id  uuid;
begin
  if p_id is null then
    insert into parent_profiles (
      parent_user_id, is_demo, created_for, full_name, dob, height,
      city, state, country, native_place, gotram, nakshatra, rasi,
      horoscope_gunas, education, profession, annual_income, income_lpa,
      work_location, about, marital_status, interests, contact_phone,
      status, visible)
    values (
      null, true,
      coalesce(p_data->>'created_for', 'son'),
      p_data->>'full_name',
      nullif(p_data->>'dob','')::date,
      p_data->>'height',
      p_data->>'city', p_data->>'state', p_data->>'country',
      nullif(concat_ws(', ', nullif(p_data->>'city',''), nullif(p_data->>'state',''),
                             nullif(p_data->>'country','')), ''),
      p_data->>'gotram', p_data->>'nakshatra', p_data->>'rasi',
      p_data->>'horoscope_gunas', p_data->>'education', p_data->>'profession',
      p_data->>'annual_income',
      nullif(p_data->>'income_lpa','')::numeric,
      p_data->>'work_location', p_data->>'about', nullif(p_data->>'marital_status',''),
      coalesce((select array_agg(x) from jsonb_array_elements_text(
                 case when jsonb_typeof(p_data->'interests') = 'array'
                      then p_data->'interests' else '[]'::jsonb end) x), '{}'),
      p_data->>'contact_phone',
      coalesce(p_data->>'status', 'published'),
      coalesce((p_data->>'visible')::boolean, true))
    returning id into v_id;
  else
    update parent_profiles set
      created_for     = coalesce(p_data->>'created_for', created_for),
      full_name       = coalesce(p_data->>'full_name', full_name),
      dob             = coalesce(nullif(p_data->>'dob','')::date, dob),
      height          = coalesce(p_data->>'height', height),
      city            = coalesce(p_data->>'city', city),
      state           = coalesce(p_data->>'state', state),
      country         = coalesce(p_data->>'country', country),
      native_place    = coalesce(nullif(concat_ws(', ',
                          nullif(coalesce(p_data->>'city', city),''),
                          nullif(coalesce(p_data->>'state', state),''),
                          nullif(coalesce(p_data->>'country', country),'')), ''), native_place),
      gotram          = coalesce(p_data->>'gotram', gotram),
      nakshatra       = coalesce(p_data->>'nakshatra', nakshatra),
      rasi            = coalesce(p_data->>'rasi', rasi),
      horoscope_gunas = coalesce(p_data->>'horoscope_gunas', horoscope_gunas),
      education       = coalesce(p_data->>'education', education),
      profession      = coalesce(p_data->>'profession', profession),
      annual_income   = coalesce(p_data->>'annual_income', annual_income),
      income_lpa      = coalesce(nullif(p_data->>'income_lpa','')::numeric, income_lpa),
      work_location   = coalesce(p_data->>'work_location', work_location),
      about           = coalesce(p_data->>'about', about),
      marital_status  = coalesce(nullif(p_data->>'marital_status',''), marital_status),
      interests       = case when jsonb_typeof(p_data->'interests') = 'array'
                          then coalesce((select array_agg(x) from
                                 jsonb_array_elements_text(p_data->'interests') x), '{}')
                          else interests end,
      contact_phone   = coalesce(p_data->>'contact_phone', contact_phone),
      status          = coalesce(p_data->>'status', status),
      visible         = coalesce((p_data->>'visible')::boolean, visible)
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id);
end $fn$;

create or replace function public.admin_delete_profile(p_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  delete from parent_profiles where id = p_id;
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.admin_set_visible(p_id uuid, p_visible boolean)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  update parent_profiles set visible = p_visible where id = p_id;
  return jsonb_build_object('ok', true, 'visible', p_visible);
end $fn$;


-- =====================================================================
--  SECTION 5 — REPORTS
-- =====================================================================

create or replace function public.admin_list_reports(p_status text default 'open')
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'reason', r.reason, 'details', r.details,
             'status', r.status, 'created_at', r.created_at,
             'reporter_email', (select u.email from auth.users u where u.id = r.reporter_user_id),
             'profile_id', p.id, 'profile_name', p.full_name,
             'profile_gotram', p.gotram, 'profile_place', p.native_place,
             'profile_phone', p.contact_phone, 'profile_visible', p.visible,
             'other_reports', (select count(*) from profile_reports r2
                                where r2.reported_profile_id = p.id and r2.id <> r.id))
           order by r.created_at desc)
      from profile_reports r
      join parent_profiles p on p.id = r.reported_profile_id
     where p_status is null or p_status = '' or r.status = p_status
  ), '[]'::jsonb);
end $fn$;

-- One call decides both what happens to the report and what happens to the
-- profile it is about, so the two can never drift apart.
create or replace function public.admin_action_report(p_id uuid, p_action text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid uuid := public.assert_admin();
  v_r   profile_reports;
begin
  select * into v_r from profile_reports where id = p_id;
  if v_r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  if p_action = 'dismiss' then
    update profile_reports set status = 'dismissed' where id = p_id;
    -- nothing was wrong, so put the profile back if this report hid it
    update parent_profiles set visible = true
     where id = v_r.reported_profile_id
       and not exists (select 1 from profile_reports r2
                        where r2.reported_profile_id = v_r.reported_profile_id
                          and r2.status in ('open','reviewing') and r2.id <> p_id);
  elsif p_action = 'hide' then
    update profile_reports set status = 'actioned' where id = p_id;
    update parent_profiles set visible = false where id = v_r.reported_profile_id;
  elsif p_action = 'delete' then
    update profile_reports set status = 'actioned' where id = p_id;
    delete from parent_profiles where id = v_r.reported_profile_id;
  elsif p_action = 'reviewing' then
    update profile_reports set status = 'reviewing' where id = p_id;
  else
    raise exception 'BAD_ACTION' using errcode = 'P0001';
  end if;

  return jsonb_build_object('ok', true, 'action', p_action);
end $fn$;


-- =====================================================================
--  SECTION 6 — MEMBERS AND SUBSCRIPTIONS
-- =====================================================================

create or replace function public.admin_list_members(
  p_search text default null, p_filter text default null,
  p_limit int default 25, p_offset int default 0)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := public.assert_admin();
  v_lim int := least(greatest(coalesce(p_limit, 25), 1), 200);
  v_off int := greatest(coalesce(p_offset, 0), 0);
  v_out jsonb;
begin
  with f as (
    select u.id, u.email, u.phone, u.created_at, u.last_sign_in_at,
           t.tier, t.premium_until, t.granted_by
      from auth.users u
      left join user_tiers t on t.user_id = u.id
     where (p_search is null or p_search = ''
            or u.email ilike '%' || p_search || '%'
            or coalesce(u.phone,'') like '%' || p_search || '%')
       and (p_filter is null or p_filter = ''
            or (p_filter = 'premium' and t.tier = 'premium'
                and (t.premium_until is null or t.premium_until > now()))
            or (p_filter = 'free' and (t.tier is null or t.tier = 'free'
                or (t.premium_until is not null and t.premium_until <= now())))
            or (p_filter = 'admin' and exists (select 1 from app_admins a where a.user_id = u.id))
            or (p_filter = 'noprofile' and not exists
                 (select 1 from parent_profiles p where p.parent_user_id = u.id)))
  )
  select jsonb_build_object(
    'total', (select count(*) from f),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', f.id, 'email', f.email, 'phone', f.phone,
               'joined', f.created_at, 'last_sign_in', f.last_sign_in_at,
               'tier', coalesce(f.tier, 'free'),
               'premium_until', f.premium_until,
               'premium_active', (f.tier = 'premium'
                   and (f.premium_until is null or f.premium_until > now())),
               'granted_by', f.granted_by,
               'is_admin', exists (select 1 from app_admins a where a.user_id = f.id),
               'profile_id', (select p.id from parent_profiles p where p.parent_user_id = f.id),
               'profile_name', (select p.full_name from parent_profiles p where p.parent_user_id = f.id))
             order by f.created_at desc)
        from (select * from f order by created_at desc limit v_lim offset v_off) f
    ), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $fn$;

create or replace function public.admin_set_premium(p_user_id uuid, p_months int default 12)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid uuid := public.assert_admin();
  v_new timestamptz;
begin
  if p_months is null or p_months < 1 or p_months > 60 then
    raise exception 'BAD_MONTHS' using errcode = 'P0001';
  end if;
  v_new := greatest(
    coalesce((select t.premium_until from user_tiers t where t.user_id = p_user_id), now()),
    now()) + make_interval(months => p_months);

  insert into user_tiers (user_id, tier, premium_until, granted_by, updated_at)
  values (p_user_id, 'premium', v_new, 'admin', now())
  on conflict (user_id) do update
    set tier = 'premium', premium_until = excluded.premium_until,
        granted_by = 'admin', updated_at = now();

  insert into notifications (user_id, kind, title, body, link)
  values (p_user_id, 'premium_on', 'Premium activated',
          'Full profiles, photos and contact details are open to you until ' ||
          to_char(v_new, 'DD Mon YYYY') || '.', 'dashboard.html');

  return jsonb_build_object('ok', true, 'premium_until', v_new);
end $fn$;

create or replace function public.admin_cancel_premium(p_user_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  update user_tiers set tier = 'free', premium_until = null,
                        granted_by = 'admin-cancelled', updated_at = now()
   where user_id = p_user_id;

  insert into notifications (user_id, kind, title, body, link)
  values (p_user_id, 'premium_off', 'Premium ended',
          'Your Premium has been cancelled. Name, gotram, place, age and photo stay open to you.',
          'dashboard.html#subscription');

  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.admin_set_admin(p_user_id uuid, p_is_admin boolean)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  -- an admin must not be able to lock the last one out, themselves included
  if not p_is_admin and (select count(*) from app_admins) <= 1 then
    raise exception 'LAST_ADMIN' using errcode = 'P0001';
  end if;
  if p_is_admin then
    insert into app_admins (user_id) values (p_user_id) on conflict do nothing;
  else
    delete from app_admins where user_id = p_user_id;
  end if;
  return jsonb_build_object('ok', true);
end $fn$;


-- =====================================================================
--  SECTION 7 — CODES AND WAITLIST
-- =====================================================================

create or replace function public.admin_list_codes(p_limit int default 100)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'code', c.code, 'months', c.months, 'max_uses', c.max_uses,
             'used_count', c.used_count, 'note', c.note,
             'expires_at', c.expires_at, 'created_at', c.created_at,
             'redeemed_by', (select jsonb_agg(u.email)
                               from premium_code_uses cu
                               join auth.users u on u.id = cu.user_id
                              where cu.code = c.code))
           order by c.created_at desc)
      from (select * from premium_codes order by created_at desc limit greatest(p_limit,1)) c
  ), '[]'::jsonb);
end $fn$;

create or replace function public.admin_create_codes(
  p_count int default 10, p_months int default 12, p_note text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid uuid := public.assert_admin();
  v_note text := coalesce(nullif(btrim(p_note), ''), to_char(now(), 'Mon YYYY'));
begin
  if p_count < 1 or p_count > 200 then
    raise exception 'BAD_COUNT' using errcode = 'P0001';
  end if;
  insert into premium_codes (code, months, note)
  select 'PADMA-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6)),
         p_months, v_note
    from generate_series(1, p_count)
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'codes', coalesce((
    select jsonb_agg(c.code) from premium_codes c
     where c.note = v_note and c.used_count = 0), '[]'::jsonb));
end $fn$;

create or replace function public.admin_list_waitlist(p_only_pending boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', w.id, 'contact', w.contact, 'role', w.role,
             'source', w.source, 'created_at', w.created_at,
             'notified_at', w.notified_at)
           order by w.created_at desc)
      from waitlist w
     where p_only_pending is not true or w.notified_at is null
  ), '[]'::jsonb);
end $fn$;

create or replace function public.admin_mark_waitlist_notified()
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid uuid := public.assert_admin();
  v_n   int;
begin
  update waitlist set notified_at = now() where notified_at is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'marked', v_n);
end $fn$;

create or replace function public.admin_list_deletions(p_limit int default 50)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'reason', d.reason, 'details', d.details, 'created_at', d.created_at)
           order by d.created_at desc)
      from (select * from profile_deletion_feedback
             order by created_at desc limit greatest(p_limit,1)) d
  ), '[]'::jsonb);
end $fn$;


-- =====================================================================
--  SECTION 8 — 20 DEMO PROFILES FOR TESTING
--  These have no login account behind them (parent_user_id is null) and
--  carry is_demo = true, so when the real members arrive you can clear the
--  lot with one line:
--      delete from parent_profiles where is_demo;
-- =====================================================================

insert into parent_profiles (
  parent_user_id, is_demo, created_for, full_name, dob, height,
  city, state, country, native_place, gotram, nakshatra, rasi, horoscope_gunas,
  education, profession, annual_income, income_lpa, work_location,
  about, marital_status, interests, contact_phone, status, visible)
select null, true, v.created_for, v.full_name, v.dob::date, v.height,
       v.city, v.state, 'India', v.city || ', ' || v.state,
       v.gotram, v.nakshatra, v.rasi, v.gunas,
       v.education, v.profession, '₹' || v.lpa || ' LPA', v.lpa, v.work_location,
       v.about, 'never_married', v.interests, v.phone, 'published', true
from (values
 ('daughter','Anjali Devi',        '1999-04-12','5ft 4in','Salem','Tamil Nadu','Markandeya','Rohini','Vrishabha (Taurus)','8.5','M.Sc Biotechnology','Research Associate',12,'Bengaluru','A quiet, temple-going family from Salem. We are looking for a family that values education.',array['Music','Cooking','Temple visits'],'9840012001'),
 ('son',     'Karthik Raman',      '1996-08-03','5ft 9in','Coimbatore','Tamil Nadu','Padmarishi','Ashwini','Mesha (Aries)','7.5','B.E Mechanical','Design Engineer',14,'Coimbatore','Only son. The family runs a small textile unit.',array['Cricket','Photography','Travel'],'9840012002'),
 ('daughter','Meera Sundaram',     '2000-01-22','5ft 3in','Guntur','Andhra Pradesh','Kashyapa','Pushya','Karka (Cancer)','9','B.Com','Bank Officer',8,'Guntur','Working close to home. Prefer a family in Andhra or Telangana.',array['Classical dance','Reading'],'9840012003'),
 ('son',     'Vignesh Kumar',      '1994-11-17','5ft 11in','Chennai','Tamil Nadu','Vasishta','Magha','Simha (Leo)','6.5','B.Tech IT','Software Engineer',22,'Chennai','Settled in Chennai. Family originally from Kanchipuram.',array['Movies','Fitness','Chess'],'9840012004'),
 ('daughter','Lakshmi Narayanan',  '1998-06-30','5ft 5in','Erode','Tamil Nadu','Bharadwaja','Chitra','Kanya (Virgo)','8','M.A English','Lecturer',9,'Erode','Teaching family. Looking for someone settled and simple.',array['Reading','Writing','Gardening'],'9840012005'),
 ('son',     'Ashwin Prasad',      '1995-02-14','5ft 8in','Hyderabad','Telangana','Gautama','Swati','Tula (Libra)','7','MBA Finance','Marketing Manager',18,'Hyderabad','Family settled in Hyderabad for two generations.',array['Travel','Badminton','Music'],'9840012006'),
 ('daughter','Divya Prasad',       '1997-09-08','5ft 2in','Madurai','Tamil Nadu','Atri','Anuradha','Vrischika (Scorpio)','8.5','B.Sc Nursing','Nurse',7,'Madurai','Working at a government hospital. Family is close-knit.',array['Cooking','Temple visits','Volunteering'],'9840012007'),
 ('son',     'Ramesh Babu',        '1993-05-25','5ft 10in','Visakhapatnam','Andhra Pradesh','Vishwamitra','Mula','Dhanu (Sagittarius)','7.5','B.Com','Business',20,'Visakhapatnam','Runs a family wholesale business.',array['Cricket','Farming'],'9840012008'),
 ('daughter','Sowmya Iyer',        '2001-03-19','5ft 4in','Trichy','Tamil Nadu','Jamadagni','Revati','Meena (Pisces)','9.5','B.E Computer Science','Software Engineer',11,'Chennai','Recently started working. Family in Trichy.',array['Carnatic music','Painting','Travel'],'9840012009'),
 ('son',     'Sanjay Krishnan',    '1992-12-05','6ft 0in','Bengaluru','Karnataka','Agastya','Uttara Ashadha','Makara (Capricorn)','6','M.Tech','Senior Engineer',35,'Bengaluru','Settled in Bengaluru. Parents in Mysuru.',array['Trekking','Photography','Chess'],'9840012010'),
 ('daughter','Priya Venkatesh',    '1999-07-11','5ft 6in','Kochi','Kerala','Sandilya','Hasta','Kanya (Virgo)','8','MBBS','Doctor',15,'Kochi','Doing her residency. Family is in Kochi.',array['Reading','Yoga','Music'],'9840012011'),
 ('son',     'Arjun Padmanabhan',  '1996-10-28','5ft 9in','Coimbatore','Tamil Nadu','Kaundinya','Krittika','Vrishabha (Taurus)','7','B.Pharm','Pharmacist',10,'Coimbatore','Family runs a medical shop for 30 years.',array['Cricket','Cooking'],'9840012012'),
 ('daughter','Kavya Ramesh',       '1998-02-09','5ft 3in','Warangal','Telangana','Angirasa','Bharani','Mesha (Aries)','8.5','M.Com','Accountant',9,'Hyderabad','Working in Hyderabad, family in Warangal.',array['Cooking','Movies','Temple visits'],'9840012013'),
 ('son',     'Manoj Sekar',        '1994-04-02','5ft 7in','Tiruppur','Tamil Nadu','Harita','Jyeshtha','Vrischika (Scorpio)','7.5','Diploma Textile','Textile Business',16,'Tiruppur','Third generation in the textile trade.',array['Cricket','Travel','Farming'],'9840012014'),
 ('daughter','Nithya Balaji',      '2000-08-16','5ft 5in','Thanjavur','Tamil Nadu','Kaushika','Shravana','Makara (Capricorn)','9','B.Ed','Teacher',6,'Thanjavur','Teaching at a school near home.',array['Classical dance','Reading','Gardening'],'9840012015'),
 ('son',     'Hari Prasad',        '1995-06-21','5ft 10in','Nellore','Andhra Pradesh','Maudgalya','Punarvasu','Mithuna (Gemini)','8','B.Tech Civil','Civil Engineer',13,'Chennai','Working in Chennai, family in Nellore.',array['Photography','Fitness'],'9840012016'),
 ('daughter','Deepa Srinivasan',   '1997-11-30','5ft 4in','Mysuru','Karnataka','Parashara','Ardra','Mithuna (Gemini)','7','MCA','Software Engineer',17,'Bengaluru','Family in Mysuru, working in Bengaluru.',array['Music','Trekking','Movies'],'9840012017'),
 ('son',     'Gopal Krishnan',     '1991-09-14','5ft 8in','Kumbakonam','Tamil Nadu','Shaunaka','Ashlesha','Karka (Cancer)','6.5','B.A','Government Employee',9,'Kumbakonam','Working in the revenue department.',array['Temple visits','Reading','Chess'],'9840012018'),
 ('daughter','Shruthi Mohan',      '1999-12-03','5ft 6in','Thrissur','Kerala','Srivatsa','Dhanishta','Makara (Capricorn)','8.5','B.Des','Designer',12,'Bengaluru','Working in design, family in Thrissur.',array['Painting','Photography','Travel'],'9840012019'),
 ('son',     'Naveen Chandran',    '1993-07-07','5ft 11in','Vijayawada','Andhra Pradesh','Vadhula','Purva Phalguni','Simha (Leo)','7.5','CA','Chartered Accountant',26,'Hyderabad','Practising CA. Family in Vijayawada.',array['Cricket','Reading','Fitness'],'9840012020')
) as v(created_for, full_name, dob, height, city, state, gotram, nakshatra, rasi, gunas,
       education, profession, lpa, work_location, about, interests, phone)
where not exists (select 1 from parent_profiles p where p.is_demo and p.contact_phone = v.phone);


-- =====================================================================
--  Done.
--
--  Make yourself an admin if you have not already:
--    insert into app_admins (user_id)
--    select id from auth.users where email = 'you@example.com'
--    on conflict do nothing;
--
--  Then open admin.html on the live site.
--
--  To clear the test data when real members arrive:
--    delete from parent_profiles where is_demo;
-- =====================================================================
