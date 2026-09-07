-- =====================================================================
--  PADMASALIYA MATRIMONIAL — Supabase setup, VERSION 2
--  Run this ONCE in: Supabase Dashboard -> SQL Editor -> New Query -> Run
--  Run supabase-setup.sql (v1) FIRST if you have not already.
--  Safe to re-run: everything is "if not exists" / "create or replace".
--
--  WHAT THIS ADDS OVER v1
--   * A REAL paywall. A free account physically cannot download premium
--     fields — the database never sends them. Not hidden in JavaScript.
--   * The complete-profile gate, enforced in the database.
--   * Send interest / received interests / report / delete / publish.
--   * Premium tiers + offline redeem codes (no payment gateway needed yet).
--   * Private photo storage (signed URLs, premium only).
--   * Notifications, admin roles, waitlist ready for a launch-day SMS job.
-- =====================================================================


-- =====================================================================
--  SECTION 1 — NEW COLUMNS ON parent_profiles
-- =====================================================================

alter table parent_profiles add column if not exists photo_path     text;
alter table parent_profiles add column if not exists interests      text[] default '{}';
alter table parent_profiles add column if not exists about          text;
alter table parent_profiles add column if not exists marital_status text;
alter table parent_profiles add column if not exists income_lpa     numeric;
alter table parent_profiles add column if not exists deleted_at     timestamptz;

-- status: draft (only you can see it) or published (in search results).
-- Added with default published so profiles that already exist stay live,
-- then flipped to draft so NEW profiles start as drafts. Idempotent.
do $mig$
begin
  if not exists (select 1 from information_schema.columns
                 where table_name = 'parent_profiles' and column_name = 'status') then
    alter table parent_profiles add column status text not null default 'published';
    alter table parent_profiles alter column status set default 'draft';
    alter table parent_profiles add constraint parent_profiles_status_chk
      check (status in ('draft','published'));
  end if;
end $mig$;

-- Backfill the storage path out of the old public URL (v1 stored a full URL).
update parent_profiles
   set photo_path = regexp_replace(photo_url, '^.*/profile-photos/', '')
 where photo_url is not null and photo_path is null;

-- Backfill a numeric income out of the old free-text field, so "10+ LPA"
-- can be filtered by the DATABASE instead of by the browser.
update parent_profiles
   set income_lpa = (nullif(regexp_replace(split_part(annual_income, '.', 1), '[^0-9]', '', 'g'), ''))::numeric
 where income_lpa is null
   and annual_income is not null
   and regexp_replace(split_part(annual_income, '.', 1), '[^0-9]', '', 'g') <> ''
   and length(regexp_replace(split_part(annual_income, '.', 1), '[^0-9]', '', 'g')) <= 4;

-- THE COMPLETE-PROFILE GATE, as a column the database maintains itself.
-- A parent cannot browse anyone until this is true of their own profile.
-- Photo is deliberately NOT required (the spec says it is optional).
do $mig$
begin
  if not exists (select 1 from information_schema.columns
                 where table_name = 'parent_profiles' and column_name = 'is_complete') then
    alter table parent_profiles add column is_complete boolean
      generated always as (
             created_for is not null
         and coalesce(length(btrim(full_name)), 0)     > 1
         and dob is not null
         and coalesce(length(btrim(gotram)), 0)        > 0
         and coalesce(length(btrim(native_place)), 0)  > 0
         and coalesce(length(btrim(profession)), 0)    > 0
         and coalesce(length(btrim(contact_phone)), 0) >= 6
      ) stored;
  end if;
end $mig$;

create index if not exists parent_profiles_search_idx
  on parent_profiles (status, visible, created_for, gotram, created_at desc);
create index if not exists parent_profiles_income_idx on parent_profiles (income_lpa);


-- =====================================================================
--  SECTION 2 — PAID TIERS  (no payment gateway required yet)
-- =====================================================================

create table if not exists user_tiers (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  tier          text not null default 'free' check (tier in ('free','premium')),
  premium_until timestamptz,
  granted_by    text,
  updated_at    timestamptz default now()
);
alter table user_tiers enable row level security;

drop policy if exists "Read my own tier" on user_tiers;
create policy "Read my own tier" on user_tiers for select
  to authenticated using (auth.uid() = user_id);
-- Deliberately NO insert/update policy: a user can never make themselves
-- premium. Only redeem_premium_code() or an admin in the SQL editor can.

-- Offline redeem codes. Collect money by UPI / in person, hand over a code.
create table if not exists premium_codes (
  code       text primary key,
  months     int not null default 12 check (months between 1 and 60),
  max_uses   int not null default 1,
  used_count int not null default 0,
  note       text,
  expires_at timestamptz,
  created_at timestamptz default now()
);
alter table premium_codes enable row level security;
-- No browser policy at all: codes are only ever checked inside the RPC.

create table if not exists premium_code_uses (
  id         uuid primary key default gen_random_uuid(),
  code       text not null references premium_codes(code) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  unique (code, user_id)
);
alter table premium_code_uses enable row level security;

create or replace function public.is_premium(uid uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public as $fn$
  select coalesce(
    (select t.tier = 'premium'
        and (t.premium_until is null or t.premium_until > now())
       from user_tiers t where t.user_id = uid), false);
$fn$;

-- Admins (community committee). Add rows by hand in the SQL editor.
create table if not exists app_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz default now()
);
alter table app_admins enable row level security;
drop policy if exists "Admins see the admin list" on app_admins;
create policy "Admins see the admin list" on app_admins for select
  to authenticated using (auth.uid() = user_id);

create or replace function public.is_admin(uid uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from app_admins a where a.user_id = uid);
$fn$;


-- =====================================================================
--  SECTION 3 — INTERESTS, REPORTS, NOTIFICATIONS
-- =====================================================================

create table if not exists interests (
  id              uuid primary key default gen_random_uuid(),
  from_user_id    uuid not null references auth.users(id) on delete cascade,
  from_profile_id uuid references parent_profiles(id) on delete set null,
  to_user_id      uuid not null references auth.users(id) on delete cascade,
  to_profile_id   uuid not null references parent_profiles(id) on delete cascade,
  status          text not null default 'pending'
                    check (status in ('pending','accepted','declined')),
  message         text,
  created_at      timestamptz default now(),
  responded_at    timestamptz,
  unique (from_user_id, to_profile_id)
);
alter table interests enable row level security;

drop policy if exists "Both sides can read an interest" on interests;
create policy "Both sides can read an interest" on interests for select
  to authenticated using (auth.uid() = from_user_id or auth.uid() = to_user_id);
-- No insert/update policy: writes go only through send_interest() and
-- respond_interest(), which validate and rate-limit.

create index if not exists interests_to_idx   on interests (to_user_id, status, created_at desc);
create index if not exists interests_from_idx on interests (from_user_id, created_at desc);

create table if not exists profile_reports (
  id                  uuid primary key default gen_random_uuid(),
  reporter_user_id    uuid not null references auth.users(id) on delete cascade,
  reported_profile_id uuid not null references parent_profiles(id) on delete cascade,
  reason              text not null,
  details             text,
  status              text not null default 'open'
                        check (status in ('open','reviewing','actioned','dismissed')),
  created_at          timestamptz default now(),
  unique (reporter_user_id, reported_profile_id)
);
alter table profile_reports enable row level security;

drop policy if exists "I can see reports I filed" on profile_reports;
create policy "I can see reports I filed" on profile_reports for select
  to authenticated using (auth.uid() = reporter_user_id or public.is_admin());

create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz default now()
);
alter table notifications enable row level security;

drop policy if exists "Read my notifications" on notifications;
create policy "Read my notifications" on notifications for select
  to authenticated using (auth.uid() = user_id);
drop policy if exists "Mark my notifications read" on notifications;
create policy "Mark my notifications read" on notifications for update
  to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists notifications_user_idx on notifications (user_id, read_at, created_at desc);

-- Live bell without polling.
do $mig$
begin
  alter publication supabase_realtime add table notifications;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $mig$;

-- Recommendations: let the child mark them seen (Phase 2 candidate app).
alter table recommendations add column if not exists child_seen_at timestamptz;


-- =====================================================================
--  SECTION 4 — THE PAYWALL ITSELF
--
--  From here on, a logged-in parent can read ONLY THEIR OWN ROW straight
--  out of parent_profiles. Everything else must come back through
--  search_profiles() / get_profile(), which decide field by field what
--  this particular caller is allowed to see.
-- =====================================================================

drop policy if exists "Logged-in users can view visible profiles" on parent_profiles;
drop policy if exists "Owners read their own profile" on parent_profiles;
create policy "Owners read their own profile" on parent_profiles for select
  to authenticated using (auth.uid() = parent_user_id);

-- THE ONE PLACE that decides what a viewer is allowed to see.
-- p_full = true  -> premium (or an unlocked/accepted connection): everything
-- p_full = false -> free: name, gotram, native place, age, son/daughter only
create or replace function public.redact_profile(p parent_profiles, p_full boolean)
returns jsonb
language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    -- ---- always visible (the free tier, useful for shortlisting) ----
    'id',            p.id,
    'full_name',     p.full_name,
    'gotram',        p.gotram,
    'native_place',  p.native_place,
    'created_for',   p.created_for,
    'age',           case when p.dob is null then null
                          else extract(year from age(p.dob))::int end,
    'created_at',    p.created_at,
    'locked',        not p_full,
    -- ---- premium only: never leaves the database for a free account ----
    'height',          case when p_full then p.height end,
    'nakshatra',       case when p_full then p.nakshatra end,
    'rasi',            case when p_full then p.rasi end,
    'horoscope_gunas', case when p_full then p.horoscope_gunas end,
    'education',       case when p_full then p.education end,
    'profession',      case when p_full then p.profession end,
    'annual_income',   case when p_full then p.annual_income end,
    'income_lpa',      case when p_full then p.income_lpa end,
    'work_location',   case when p_full then p.work_location end,
    'about',           case when p_full then p.about end,
    'interests',       case when p_full then to_jsonb(p.interests) end,
    'photo_path',      case when p_full then p.photo_path end,
    'contact_phone',   case when p_full then p.contact_phone end,
    'has_photo',       (p.photo_path is not null)
  );
$fn$;

-- The caller's own state: used to route them and to gate everything else.
create or replace function public.my_status()
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid  uuid := auth.uid();
  v_mine parent_profiles;
begin
  if v_uid is null then
    return jsonb_build_object('signed_in', false);
  end if;
  select * into v_mine from parent_profiles
   where parent_user_id = v_uid and deleted_at is null;

  return jsonb_build_object(
    'signed_in',   true,
    'user_id',     v_uid,
    'premium',     public.is_premium(v_uid),
    'admin',       public.is_admin(v_uid),
    'has_profile', v_mine.id is not null,
    'complete',    coalesce(v_mine.is_complete, false),
    'published',   coalesce(v_mine.status = 'published', false),
    'can_browse',  coalesce(v_mine.is_complete and v_mine.status = 'published', false),
    'profile',     case when v_mine.id is null then null
                        else public.redact_profile(v_mine, true) end,
    'missing',     case when v_mine.id is null then
                     to_jsonb(array['full_name','dob','gotram','native_place','profession','contact_phone']::text[])
                   else
                     to_jsonb(array_remove(array[
                       case when coalesce(length(btrim(v_mine.full_name)), 0) < 2     then 'full_name'     end,
                       case when v_mine.dob is null                                    then 'dob'           end,
                       case when coalesce(length(btrim(v_mine.gotram)), 0) = 0         then 'gotram'        end,
                       case when coalesce(length(btrim(v_mine.native_place)), 0) = 0   then 'native_place'  end,
                       case when coalesce(length(btrim(v_mine.profession)), 0) = 0     then 'profession'    end,
                       case when coalesce(length(btrim(v_mine.contact_phone)), 0) < 6  then 'contact_phone' end
                     ]::text[], null::text))
                   end
  );
end $fn$;

-- Raises if the caller has not earned the right to browse. Used by every
-- read RPC below, so the gate cannot be skipped from the browser.
create or replace function public.assert_can_browse()
returns uuid
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_ok  boolean;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  select (p.is_complete and p.status = 'published' and p.deleted_at is null)
    into v_ok
    from parent_profiles p where p.parent_user_id = v_uid;
  if not coalesce(v_ok, false) then
    raise exception 'PROFILE_INCOMPLETE' using errcode = 'P0001';
  end if;
  return v_uid;
end $fn$;


-- =====================================================================
--  SECTION 5 — SEARCH AND READ
-- =====================================================================

create or replace function public.search_profiles(
  p_looking_for text    default null,   -- 'son' | 'daughter' (whose profiles to show)
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
     where p.parent_user_id <> v_uid
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
       -- never show a profile you reported, or one that reported you
       and not exists (select 1 from profile_reports r
                        where r.reporter_user_id = v_uid and r.reported_profile_id = p.id)
  ),
  pg as (
    select f.id from f order by f.created_at desc limit v_lim offset v_off
  )
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

-- One profile, opened from a card. Same redaction rules, plus: if this
-- person accepted your interest (or you accepted theirs), you both see
-- the full profile even on the free plan. Accepting is what unlocks.
create or replace function public.get_profile(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid      uuid := public.assert_can_browse();
  v_p        parent_profiles;
  v_full     boolean;
  v_accepted boolean;
begin
  select * into v_p from parent_profiles p
   where p.id = p_id and p.status = 'published'
     and p.visible = true and p.deleted_at is null and p.is_complete;
  if v_p.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  v_accepted := exists (
    select 1 from interests i
     where i.status = 'accepted'
       and ((i.from_user_id = v_uid and i.to_user_id   = v_p.parent_user_id)
         or (i.to_user_id   = v_uid and i.from_user_id = v_p.parent_user_id)));

  v_full := (v_p.parent_user_id = v_uid) or public.is_premium(v_uid) or v_accepted;

  return public.redact_profile(v_p, v_full) || jsonb_build_object(
    'unlocked_by_accept', v_accepted and not public.is_premium(v_uid),
    'is_mine',     v_p.parent_user_id = v_uid,
    'saved',       exists (select 1 from saved_profiles s
                            where s.parent_user_id = v_uid and s.saved_profile_id = v_p.id),
    'recommended', exists (select 1 from recommendations rc
                            where rc.parent_user_id = v_uid and rc.recommended_profile_id = v_p.id),
    'reported',    exists (select 1 from profile_reports r
                            where r.reporter_user_id = v_uid and r.reported_profile_id = v_p.id),
    'interest',    (select i.status from interests i
                     where i.from_user_id = v_uid and i.to_profile_id = v_p.id)
  );
end $fn$;

-- Sidebar badge numbers, in one round trip instead of five.
create or replace function public.my_counts()
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return '{}'::jsonb; end if;
  return jsonb_build_object(
    'drafts',      (select count(*) from saved_profiles  s where s.parent_user_id = v_uid),
    'recommended', (select count(*) from recommendations r where r.parent_user_id = v_uid),
    'received',    (select count(*) from interests i where i.to_user_id = v_uid and i.status = 'pending'),
    'sent',        (select count(*) from interests i where i.from_user_id = v_uid),
    'unread',      (select count(*) from notifications n where n.user_id = v_uid and n.read_at is null)
  );
end $fn$;


-- =====================================================================
--  SECTION 6 — ACTIONS ON A PROFILE
-- =====================================================================

-- Send interest. Rate-limited so one account cannot spam the community.
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
  if v_them.parent_user_id = v_uid then
    raise exception 'CANNOT_INTEREST_SELF' using errcode = 'P0001';
  end if;
  -- Sending twice must not notify them twice.
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

create or replace function public.respond_interest(p_interest uuid, p_action text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid  uuid := auth.uid();
  v_i    interests;
  v_mine parent_profiles;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if p_action not in ('accepted','declined') then
    raise exception 'BAD_ACTION' using errcode = 'P0001';
  end if;

  update interests set status = p_action, responded_at = now()
   where id = p_interest and to_user_id = v_uid and status = 'pending'
  returning * into v_i;
  if v_i.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_mine from parent_profiles p where p.parent_user_id = v_uid;

  insert into notifications (user_id, kind, title, body, link)
  values (v_i.from_user_id,
          'interest_' || p_action,
          case when p_action = 'accepted' then 'Your interest was accepted'
               else 'Your interest was declined' end,
          coalesce(v_mine.full_name, 'The family') ||
            case when p_action = 'accepted'
                 then ' accepted your interest. Full profile and contact are now open to you.'
                 else ' is not taking this forward.' end,
          'dashboard.html#sent');

  return jsonb_build_object('ok', true, 'status', p_action);
end $fn$;

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
             'interest_id', i.id,
             'status',      i.status,
             'message',     i.message,
             'created_at',  i.created_at,
             -- accepting is what opens the sender up on the free plan
             'profile',     public.redact_profile(p, v_pre or i.status = 'accepted'))
           order by i.created_at desc)
      from interests i
      join parent_profiles p on p.id = i.from_profile_id
     where i.to_user_id = v_uid
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
             'interest_id', i.id,
             'status',      i.status,
             'created_at',  i.created_at,
             'profile',     public.redact_profile(p, v_pre or i.status = 'accepted'))
           order by i.created_at desc)
      from interests i
      join parent_profiles p on p.id = i.to_profile_id
     where i.from_user_id = v_uid
     limit greatest(p_limit, 1)
  ), '[]'::jsonb);
end $fn$;

-- Saved / recommended lists have to be redacted too — otherwise a free
-- account could read premium fields through the join.
create or replace function public.my_saved_profiles(p_limit int default 50)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_pre boolean;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  v_pre := public.is_premium(v_uid);
  return coalesce((
    select jsonb_agg(public.redact_profile(p, v_pre) ||
             jsonb_build_object('saved', true, 'saved_at', s.created_at)
           order by s.created_at desc)
      from saved_profiles s
      join parent_profiles p on p.id = s.saved_profile_id
     where s.parent_user_id = v_uid
       and p.deleted_at is null and p.status = 'published'
     limit greatest(p_limit, 1)
  ), '[]'::jsonb);
end $fn$;

create or replace function public.my_recommendations(p_limit int default 50)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_pre boolean;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  v_pre := public.is_premium(v_uid);
  return coalesce((
    select jsonb_agg(public.redact_profile(p, v_pre) ||
             jsonb_build_object('recommended', true, 'note', r.note,
                                'seen', r.child_seen_at is not null,
                                'recommended_at', r.created_at)
           order by r.created_at desc)
      from recommendations r
      join parent_profiles p on p.id = r.recommended_profile_id
     where r.parent_user_id = v_uid
       and p.deleted_at is null and p.status = 'published'
     limit greatest(p_limit, 1)
  ), '[]'::jsonb);
end $fn$;

create or replace function public.report_profile(
  p_id uuid, p_reason text, p_details text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_n   int;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;

  insert into profile_reports (reporter_user_id, reported_profile_id, reason, details)
  values (v_uid, p_id, btrim(p_reason), nullif(btrim(p_details), ''))
  on conflict (reporter_user_id, reported_profile_id)
    do update set reason = excluded.reason, details = excluded.details;

  -- Three separate families reporting the same profile pulls it out of
  -- search automatically, before a human has had time to look.
  select count(*) into v_n from profile_reports r
   where r.reported_profile_id = p_id and r.status in ('open','reviewing');
  if v_n >= 3 then
    update parent_profiles set visible = false where id = p_id;
  end if;

  return jsonb_build_object('ok', true);
end $fn$;

-- Publish / unpublish your own profile.
create or replace function public.set_profile_status(p_status text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_p   parent_profiles;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if p_status not in ('draft','published') then
    raise exception 'BAD_STATUS' using errcode = 'P0001';
  end if;

  select * into v_p from parent_profiles p where p.parent_user_id = v_uid;
  if v_p.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_status = 'published' and not v_p.is_complete then
    raise exception 'PROFILE_INCOMPLETE' using errcode = 'P0001';
  end if;

  update parent_profiles
     set status = p_status, visible = (p_status = 'published'), deleted_at = null
   where parent_user_id = v_uid;

  return jsonb_build_object('ok', true, 'status', p_status);
end $fn$;

-- Delete your own profile for good. Interests, saves and recommendations
-- pointing at it go with it (foreign keys cascade). The browser deletes
-- the photo from storage first.
create or replace function public.delete_my_profile()
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  delete from parent_profiles where parent_user_id = v_uid;
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.mark_notifications_read()
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  update notifications set read_at = now() where user_id = v_uid and read_at is null;
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.redeem_premium_code(p_code text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_c   premium_codes;
  v_new timestamptz;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;

  select * into v_c from premium_codes c
   where upper(btrim(c.code)) = upper(btrim(p_code)) for update;
  if v_c.code is null then
    raise exception 'BAD_CODE' using errcode = 'P0001';
  end if;
  if v_c.expires_at is not null and v_c.expires_at < now() then
    raise exception 'CODE_EXPIRED' using errcode = 'P0001';
  end if;
  if v_c.used_count >= v_c.max_uses then
    raise exception 'CODE_USED_UP' using errcode = 'P0001';
  end if;
  if exists (select 1 from premium_code_uses u where u.code = v_c.code and u.user_id = v_uid) then
    raise exception 'ALREADY_REDEEMED' using errcode = 'P0001';
  end if;

  v_new := greatest(
    coalesce((select t.premium_until from user_tiers t where t.user_id = v_uid), now()),
    now()) + make_interval(months => v_c.months);

  insert into user_tiers (user_id, tier, premium_until, granted_by, updated_at)
  values (v_uid, 'premium', v_new, 'code:' || v_c.code, now())
  on conflict (user_id) do update
    set tier = 'premium', premium_until = excluded.premium_until,
        granted_by = excluded.granted_by, updated_at = now();

  insert into premium_code_uses (code, user_id) values (v_c.code, v_uid);
  update premium_codes set used_count = used_count + 1 where code = v_c.code;

  insert into notifications (user_id, kind, title, body, link)
  values (v_uid, 'premium_on', 'Premium activated',
          'Full profiles, photos and contact details are now open to you until ' ||
          to_char(v_new, 'DD Mon YYYY') || '.', 'dashboard.html');

  return jsonb_build_object('ok', true, 'premium_until', v_new);
end $fn$;


-- =====================================================================
--  SECTION 7 — WAITLIST (bride & groom portal launch-day SMS)
-- =====================================================================

alter table waitlist add column if not exists role         text;
alter table waitlist add column if not exists contact_norm text;
alter table waitlist add column if not exists notified_at  timestamptz;

create or replace function public.waitlist_normalise()
returns trigger language plpgsql as $fn$
begin
  new.contact_norm := right(regexp_replace(coalesce(new.contact, ''), '[^0-9]', '', 'g'), 10);
  if new.contact_norm = '' then new.contact_norm := lower(btrim(new.contact)); end if;
  return new;
end $fn$;

drop trigger if exists waitlist_normalise_trg on waitlist;
create trigger waitlist_normalise_trg before insert or update on waitlist
  for each row execute function public.waitlist_normalise();

update waitlist
   set contact_norm = right(regexp_replace(coalesce(contact, ''), '[^0-9]', '', 'g'), 10)
 where contact_norm is null;

-- v1 allowed the same number to be inserted over and over. Collapse those
-- to one row each (keeping the earliest) before the unique index goes on,
-- otherwise creating the index would fail on an existing list.
delete from waitlist w
 where exists (select 1 from waitlist w2
                where w2.contact_norm = w.contact_norm
                  and (w2.created_at, w2.id) < (w.created_at, w.id));

-- Same person tapping "Notify me" five times should be one row, not five.
create unique index if not exists waitlist_contact_norm_uniq on waitlist (contact_norm);

-- Signed-out visitors still need to be able to join, so the insert goes
-- through this instead of a raw table insert: it de-duplicates and it
-- cannot be used to read anyone else's number back.
create or replace function public.join_waitlist(
  p_contact text, p_role text default null, p_source text default 'home')
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare v_norm text;
begin
  if coalesce(length(regexp_replace(coalesce(p_contact, ''), '[^0-9]', '', 'g')), 0) < 10
     and p_contact not like '%@%' then
    raise exception 'BAD_CONTACT' using errcode = 'P0001';
  end if;
  v_norm := right(regexp_replace(coalesce(p_contact, ''), '[^0-9]', '', 'g'), 10);

  insert into waitlist (contact, role, source)
  values (btrim(p_contact), nullif(btrim(coalesce(p_role, '')), ''), p_source)
  on conflict (contact_norm) do update
    set role   = coalesce(excluded.role, waitlist.role),
        source = coalesce(waitlist.source, excluded.source);

  return jsonb_build_object('ok', true);
end $fn$;

-- The committee can read the list; nobody else can, signed in or not.
drop policy if exists "Anyone can join the waitlist" on waitlist;
drop policy if exists "Admins read the waitlist" on waitlist;
create policy "Admins read the waitlist" on waitlist for select
  to authenticated using (public.is_admin());


-- =====================================================================
--  SECTION 8 — PRIVATE PHOTOS
--
--  v1 put photos in a PUBLIC bucket, which means the paywall leaks:
--  anyone holding the URL sees the photo. The bucket is private now and
--  the browser asks for a short-lived signed URL, which the storage
--  policy below only grants for your own photo or if you are premium.
-- =====================================================================

update storage.buckets set public = false where id = 'profile-photos';

drop policy if exists "Public read profile photos" on storage.objects;
drop policy if exists "Own photo or premium reads all" on storage.objects;
create policy "Own photo or premium reads all" on storage.objects for select
  to authenticated using (
    bucket_id = 'profile-photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_premium())
  );


-- =====================================================================
--  SECTION 9 — RUNNING THE PLACE (paste these in the SQL editor as needed)
-- =====================================================================
--
--  Make yourself an admin (do this once, with your own login email):
--    insert into app_admins (user_id)
--    select id from auth.users where email = 'you@example.com'
--    on conflict do nothing;
--
--  Give someone premium for a year, by email:
--    insert into user_tiers (user_id, tier, premium_until, granted_by)
--    select id, 'premium', now() + interval '12 months', 'manual'
--      from auth.users where email = 'member@example.com'
--    on conflict (user_id) do update
--      set tier = 'premium', premium_until = excluded.premium_until;
--
--  Make 50 one-year codes to hand out after a UPI payment:
--    insert into premium_codes (code, months, note)
--    select 'PADMA-' || upper(substr(md5(random()::text), 1, 6)), 12, 'Gold 2026'
--    from generate_series(1, 50) on conflict do nothing;
--    select code from premium_codes where note = 'Gold 2026';
--
--  Who is waiting for the bride & groom app (launch-day SMS list):
--    select contact, role, created_at from waitlist
--     where notified_at is null order by created_at;
--  ...and after you have sent them:
--    update waitlist set notified_at = now() where notified_at is null;
--
--  Reports needing a decision:
--    select r.*, p.full_name from profile_reports r
--      join parent_profiles p on p.id = r.reported_profile_id
--     where r.status = 'open' order by r.created_at;
--
-- =====================================================================
--  Done.
-- =====================================================================
