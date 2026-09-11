-- =====================================================================
--  PADMASALIYA MATRIMONIAL — v8: credits replace the subscription
--  Run this ONCE in: Supabase Dashboard -> SQL Editor -> New Query -> Run
--  Needs v1 through v7 to have run already.
--
--  THE NEW MODEL
--   Free, for everyone, unlimited:
--     photo, name, age, gotram, rasi, nakshatra, occupation, income, place
--   One credit, per profile, permanent until that profile is deleted:
--     contact number, jathagam, education, height, work location,
--     horoscope gunas, marital status, about, interests
--
--   Packs: 5 for Rs 499 | 15 for Rs 1,349 (10% off) | 50 for Rs 3,999 (20% off)
--   A pack is only offered when the member actually has that many profiles
--   left to spend it on — selling 50 credits into a community of 12 is how
--   you earn a refund request.
--
--  GONE: the time-based subscription, and the free unlock that used to come
--  with accepting an interest.
--  KEPT: is_premium, now purely an owner/committee override for unlimited
--  viewing. Nothing on the member-facing site sells it any more.
-- =====================================================================


-- =====================================================================
--  SECTION 1 — THE TABLES
-- =====================================================================

create table if not exists user_credits (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  balance      int not null default 0 check (balance >= 0),
  lifetime_in  int not null default 0,   -- every credit ever added
  lifetime_out int not null default 0,   -- every credit ever spent
  updated_at   timestamptz default now()
);
alter table user_credits enable row level security;

drop policy if exists "Read my own credits" on user_credits;
create policy "Read my own credits" on user_credits for select
  to authenticated using (auth.uid() = user_id);
-- No insert/update policy: a member can never write their own balance.


-- One row per profile a member has paid to see. Permanent — the whole
-- point is that they never pay twice for the same family.
create table if not exists profile_unlocks (
  user_id     uuid not null references auth.users(id) on delete cascade,
  profile_id  uuid not null references parent_profiles(id) on delete cascade,
  unlocked_at timestamptz default now(),
  primary key (user_id, profile_id)
);
alter table profile_unlocks enable row level security;

drop policy if exists "Read my own unlocks" on profile_unlocks;
create policy "Read my own unlocks" on profile_unlocks for select
  to authenticated using (auth.uid() = user_id);

create index if not exists profile_unlocks_profile_idx on profile_unlocks (profile_id);


-- Prices live here, not in the page, so the committee can change them
-- without anyone touching the site.
create table if not exists credit_packs (
  id          text primary key,
  credits     int  not null check (credits > 0),
  price_paise int  not null check (price_paise > 0),
  label       text not null,
  sort_order  int  not null default 0,
  active      boolean not null default true
);
alter table credit_packs enable row level security;

drop policy if exists "Anyone signed in can read the packs" on credit_packs;
create policy "Anyone signed in can read the packs" on credit_packs for select
  to authenticated using (active);

insert into credit_packs (id, credits, price_paise, label, sort_order) values
  ('c5',   5,  49900, 'Starter',  1),
  ('c15', 15, 134900, 'Family',   2),
  ('c50', 50, 399900, 'Community',3)
on conflict (id) do update
  set credits = excluded.credits,
      price_paise = excluded.price_paise,
      label = excluded.label,
      sort_order = excluded.sort_order;


-- Every payment attempt, from the moment an order is created. A row here
-- with status 'created' and no payment id is an abandoned checkout, which
-- is normal and worth being able to see.
create table if not exists credit_payments (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  pack_id             text references credit_packs(id),
  credits             int  not null,
  amount_paise        int  not null,
  razorpay_order_id   text unique,
  razorpay_payment_id text,
  status              text not null default 'created'
                        check (status in ('created','paid','failed','refunded')),
  created_at          timestamptz default now(),
  paid_at             timestamptz
);
alter table credit_payments enable row level security;

drop policy if exists "Read my own payments" on credit_payments;
create policy "Read my own payments" on credit_payments for select
  to authenticated using (auth.uid() = user_id or public.is_admin());

create index if not exists credit_payments_user_idx on credit_payments (user_id, created_at desc);


-- =====================================================================
--  SECTION 2 — THE NEW FREE / PAID SPLIT
-- =====================================================================

create or replace function public.redact_profile(p parent_profiles, p_full boolean)
returns jsonb
language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    -- ---- free for everyone, always ----
    'id',            p.id,
    'full_name',     p.full_name,
    'photo_path',    p.photo_path,
    'created_for',   p.created_for,
    'age',           case when p.dob is null then null
                          else extract(year from age(p.dob))::int end,
    'gotram',        p.gotram,
    'rasi',          p.rasi,
    'nakshatra',     p.nakshatra,
    'profession',    p.profession,
    'annual_income', p.annual_income,
    'income_lpa',    p.income_lpa,
    'native_place',  p.native_place,
    'city',          p.city,
    'state',         p.state,
    'country',       p.country,
    'created_at',    p.created_at,
    'locked',        not p_full,
    -- ---- one credit opens these, permanently, for this member ----
    'contact_phone',   case when p_full then p.contact_phone end,
    'jathagam_path',   case when p_full then p.jathagam_path end,
    'education',       case when p_full then p.education end,
    'height',          case when p_full then p.height end,
    'work_location',   case when p_full then p.work_location end,
    'horoscope_gunas', case when p_full then p.horoscope_gunas end,
    'marital_status',  case when p_full then p.marital_status end,
    'about',           case when p_full then p.about end,
    'interests',       case when p_full then to_jsonb(p.interests) end,
    'has_photo',       (p.photo_path is not null),
    'has_jathagam',    (p.jathagam_path is not null)
  );
$fn$;


-- =====================================================================
--  SECTION 3 — SPENDING A CREDIT
-- =====================================================================

-- How many profiles could this member still spend a credit on? This is
-- what decides which packs they are allowed to buy.
create or replace function public.unlockable_count(uid uuid default auth.uid())
returns int
language sql stable security definer set search_path = public as $fn$
  select count(*)::int
    from parent_profiles p
   where p.status = 'published'
     and p.visible = true
     and p.deleted_at is null
     and p.is_complete
     and p.parent_user_id is distinct from uid
     -- a parent looking for a bride only ever spends on daughters' profiles
     and (p.created_for is distinct from
          (select m.created_for from parent_profiles m
            where m.parent_user_id = uid and m.deleted_at is null))
     and not exists (select 1 from profile_unlocks u
                      where u.user_id = uid and u.profile_id = p.id);
$fn$;


create or replace function public.my_credit_state()
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_bal int;
  v_can int;
begin
  if v_uid is null then return jsonb_build_object('signed_in', false); end if;
  select coalesce(balance, 0) into v_bal from user_credits where user_id = v_uid;
  v_bal := coalesce(v_bal, 0);
  v_can := public.unlockable_count(v_uid);

  return jsonb_build_object(
    'signed_in', true,
    'balance',   v_bal,
    'unlocked',  (select count(*) from profile_unlocks where user_id = v_uid),
    'unlockable', v_can,
    'unlimited', public.is_premium(v_uid),
    -- Only offer a pack the member can actually use up. Selling 50 credits
    -- into a community of 12 profiles is how you earn a refund request.
    'packs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'credits', c.credits, 'label', c.label,
               'price_paise', c.price_paise,
               'price', (c.price_paise / 100),
               'per_credit', round((c.price_paise / 100.0) / c.credits),
               'affordable', c.credits <= v_can)
             order by c.sort_order)
        from credit_packs c where c.active), '[]'::jsonb)
  );
end $fn$;


-- Spend one credit on one profile. The balance check, the deduction and
-- the unlock row all happen in one statement each inside one transaction,
-- so a double-click cannot spend two credits on the same profile.
create or replace function public.unlock_profile(p_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid uuid := public.assert_can_browse();
  v_p   parent_profiles;
  v_bal int;
begin
  select * into v_p from parent_profiles p
   where p.id = p_id and p.status = 'published'
     and p.visible = true and p.deleted_at is null and p.is_complete;
  if v_p.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_p.parent_user_id = v_uid then
    raise exception 'OWN_PROFILE' using errcode = 'P0001';
  end if;

  -- Already paid for? Say so and charge nothing.
  if exists (select 1 from profile_unlocks u
              where u.user_id = v_uid and u.profile_id = p_id) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  -- The committee's own accounts see everything without spending.
  if public.is_premium(v_uid) then
    insert into profile_unlocks (user_id, profile_id) values (v_uid, p_id)
    on conflict do nothing;
    return jsonb_build_object('ok', true, 'free', true);
  end if;

  -- Take the credit first. The WHERE clause is the guard: if the balance is
  -- zero the update touches nothing and we stop before granting anything.
  update user_credits
     set balance = balance - 1,
         lifetime_out = lifetime_out + 1,
         updated_at = now()
   where user_id = v_uid and balance > 0
  returning balance into v_bal;

  if v_bal is null then
    raise exception 'NO_CREDITS' using errcode = 'P0001';
  end if;

  insert into profile_unlocks (user_id, profile_id) values (v_uid, p_id)
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'balance', v_bal);
end $fn$;


-- The only way credits are ever added. Called by the payment function after
-- Razorpay's signature checks out, by a redeemed code, or by an admin.
create or replace function public.grant_credits(
  p_user_id uuid, p_credits int, p_source text default 'manual')
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare v_bal int;
begin
  if p_credits is null or p_credits < 1 or p_credits > 1000 then
    raise exception 'BAD_CREDITS' using errcode = 'P0001';
  end if;

  insert into user_credits (user_id, balance, lifetime_in, updated_at)
  values (p_user_id, p_credits, p_credits, now())
  on conflict (user_id) do update
    set balance = user_credits.balance + p_credits,
        lifetime_in = user_credits.lifetime_in + p_credits,
        updated_at = now()
  returning balance into v_bal;

  insert into notifications (user_id, kind, title, body, link)
  values (p_user_id, 'credits_added',
          p_credits || ' credits added',
          'You now have ' || v_bal || ' credit' || case when v_bal = 1 then '' else 's' end ||
          '. One credit opens one family''s full details, permanently.',
          'dashboard.html#credits');

  return jsonb_build_object('ok', true, 'balance', v_bal);
end $fn$;

revoke execute on function public.grant_credits(uuid, int, text) from anon, authenticated;


-- =====================================================================
--  SECTION 4 — READS NOW CHECK THE UNLOCK, NOT A SUBSCRIPTION
-- =====================================================================

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
  v_uid   uuid := public.assert_can_browse();
  v_all   boolean := public.is_premium(v_uid);   -- committee override
  v_result jsonb;
  v_lim   int := least(greatest(coalesce(p_limit, 9), 1), 48);
  v_off   int := greatest(coalesce(p_offset, 0), 0);
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
    'balance', coalesce((select balance from user_credits where user_id = v_uid), 0),
    'rows', coalesce((
      select jsonb_agg(
               -- unlocked per row now, not one blanket subscription flag
               public.redact_profile(p2, v_all or u.user_id is not null) ||
               jsonb_build_object(
                 'unlocked',    u.user_id is not null,
                 'saved',       exists (select 1 from saved_profiles s
                                         where s.parent_user_id = v_uid and s.saved_profile_id = p2.id),
                 'recommended', exists (select 1 from recommendations rc
                                         where rc.parent_user_id = v_uid and rc.recommended_profile_id = p2.id),
                 'interest',    (select i.status from interests i
                                  where i.from_user_id = v_uid and i.to_profile_id = p2.id)
               )
               order by p2.created_at desc)
        from parent_profiles p2
        left join profile_unlocks u on u.profile_id = p2.id and u.user_id = v_uid
       where p2.id in (select pg.id from pg)
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end $fn$;


-- Accepting an interest no longer opens the profile — a credit is the only
-- way in now, apart from the committee override.
create or replace function public.get_profile(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid  uuid := public.assert_can_browse();
  v_p    parent_profiles;
  v_open boolean;
begin
  select * into v_p from parent_profiles p
   where p.id = p_id and p.status = 'published'
     and p.visible = true and p.deleted_at is null and p.is_complete;
  if v_p.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  v_open := (v_p.parent_user_id = v_uid)
         or public.is_premium(v_uid)
         or exists (select 1 from profile_unlocks u
                     where u.user_id = v_uid and u.profile_id = v_p.id);

  return public.redact_profile(v_p, v_open) || jsonb_build_object(
    'is_mine',     v_p.parent_user_id = v_uid,
    'unlocked',    exists (select 1 from profile_unlocks u
                            where u.user_id = v_uid and u.profile_id = v_p.id),
    'balance',     coalesce((select balance from user_credits where user_id = v_uid), 0),
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


-- The list views follow the same rule: unlocked per row.
create or replace function public.my_saved_profiles(p_limit int default 50)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_all boolean;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  v_all := public.is_premium(v_uid);
  return coalesce((
    select jsonb_agg(public.redact_profile(p, v_all or u.user_id is not null) ||
             jsonb_build_object('saved', true, 'unlocked', u.user_id is not null,
                                'saved_at', s.created_at)
           order by s.created_at desc)
      from saved_profiles s
      join parent_profiles p on p.id = s.saved_profile_id
      left join profile_unlocks u on u.profile_id = p.id and u.user_id = v_uid
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
  v_all boolean;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  v_all := public.is_premium(v_uid);
  return coalesce((
    select jsonb_agg(public.redact_profile(p, v_all or u.user_id is not null) ||
             jsonb_build_object('recommended', true, 'unlocked', u.user_id is not null,
                                'note', r.note, 'seen', r.child_seen_at is not null,
                                'recommended_at', r.created_at)
           order by r.created_at desc)
      from recommendations r
      join parent_profiles p on p.id = r.recommended_profile_id
      left join profile_unlocks u on u.profile_id = p.id and u.user_id = v_uid
     where r.parent_user_id = v_uid
       and p.deleted_at is null and p.status = 'published'
     limit greatest(p_limit, 1)
  ), '[]'::jsonb);
end $fn$;

create or replace function public.my_received_interests(p_limit int default 30, p_offset int default 0)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_all boolean;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  v_all := public.is_premium(v_uid);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'interest_id', i.id, 'status', i.status, 'message', i.message,
             'created_at',  i.created_at,
             'profile',     public.redact_profile(p, v_all or u.user_id is not null)
                              || jsonb_build_object('unlocked', u.user_id is not null))
           order by i.created_at desc)
      from interests i
      join parent_profiles p on p.id = i.from_profile_id
      left join profile_unlocks u on u.profile_id = p.id and u.user_id = v_uid
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
  v_all boolean;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  v_all := public.is_premium(v_uid);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'interest_id', i.id, 'status', i.status, 'created_at', i.created_at,
             'profile',     public.redact_profile(p, v_all or u.user_id is not null)
                              || jsonb_build_object('unlocked', u.user_id is not null))
           order by i.created_at desc)
      from interests i
      join parent_profiles p on p.id = i.to_profile_id
      left join profile_unlocks u on u.profile_id = p.id and u.user_id = v_uid
     where i.from_user_id = v_uid
       and p.deleted_at is null
     limit greatest(p_limit, 1)
  ), '[]'::jsonb);
end $fn$;


-- The interest cap no longer depends on a subscription that does not exist.
create or replace function public.send_interest(p_to_profile uuid, p_message text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid   uuid := public.assert_can_browse();
  v_mine  parent_profiles;
  v_them  parent_profiles;
  v_today int;
begin
  select * into v_mine from parent_profiles p where p.parent_user_id = v_uid;
  select * into v_them from parent_profiles p
   where p.id = p_to_profile and p.status = 'published'
     and p.visible = true and p.deleted_at is null;
  if v_them.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_them.parent_user_id is null then raise exception 'DEMO_PROFILE' using errcode = 'P0001'; end if;
  if v_them.parent_user_id = v_uid then raise exception 'CANNOT_INTEREST_SELF' using errcode = 'P0001'; end if;
  if exists (select 1 from interests i
              where i.from_user_id = v_uid and i.to_profile_id = v_them.id) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  select count(*) into v_today from interests i
   where i.from_user_id = v_uid and i.created_at > now() - interval '24 hours';
  if v_today >= 20 then
    raise exception 'DAILY_LIMIT' using errcode = 'P0001';
  end if;

  insert into interests (from_user_id, from_profile_id, to_user_id, to_profile_id, message)
  values (v_uid, v_mine.id, v_them.parent_user_id, v_them.id, nullif(btrim(p_message), ''))
  on conflict (from_user_id, to_profile_id) do nothing;

  insert into notifications (user_id, kind, title, body, link)
  values (v_them.parent_user_id, 'interest_received', 'New interest received',
          coalesce(v_mine.full_name, 'A family') || ' (' ||
            coalesce(v_mine.gotram, 'Padmasaliya') || ') has shown interest in ' ||
            coalesce(v_them.full_name, 'your profile') || '.',
          'dashboard.html#received');

  return jsonb_build_object('ok', true, 'remaining', 20 - v_today - 1);
end $fn$;


-- my_status carries the balance so the shell can show it immediately.
create or replace function public.my_status()
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid  uuid := auth.uid();
  v_mine parent_profiles;
begin
  if v_uid is null then return jsonb_build_object('signed_in', false); end if;
  select * into v_mine from parent_profiles
   where parent_user_id = v_uid and deleted_at is null;

  return jsonb_build_object(
    'signed_in',   true,
    'user_id',     v_uid,
    'credits',     coalesce((select balance from user_credits where user_id = v_uid), 0),
    'unlimited',   public.is_premium(v_uid),
    'premium',     public.is_premium(v_uid),   -- kept so older code keeps working
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


-- =====================================================================
--  SECTION 5 — OFFLINE CODES NOW CARRY CREDITS
--  The committee still collects by UPI or in person and hands over a code;
--  the code just grants credits now instead of a month of subscription.
-- =====================================================================

alter table premium_codes add column if not exists credits int;
update premium_codes set credits = 5 where credits is null;

create or replace function public.redeem_premium_code(p_code text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_c   premium_codes;
  v_res jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;

  select * into v_c from premium_codes c
   where upper(btrim(c.code)) = upper(btrim(p_code)) for update;
  if v_c.code is null then raise exception 'BAD_CODE' using errcode = 'P0001'; end if;
  if v_c.expires_at is not null and v_c.expires_at < now() then
    raise exception 'CODE_EXPIRED' using errcode = 'P0001';
  end if;
  if v_c.used_count >= v_c.max_uses then
    raise exception 'CODE_USED_UP' using errcode = 'P0001';
  end if;
  if exists (select 1 from premium_code_uses u where u.code = v_c.code and u.user_id = v_uid) then
    raise exception 'ALREADY_REDEEMED' using errcode = 'P0001';
  end if;

  v_res := public.grant_credits(v_uid, coalesce(v_c.credits, 5), 'code:' || v_c.code);

  insert into premium_code_uses (code, user_id) values (v_c.code, v_uid);
  update premium_codes set used_count = used_count + 1 where code = v_c.code;

  return jsonb_build_object('ok', true, 'credits', coalesce(v_c.credits, 5),
                            'balance', v_res->'balance');
end $fn$;


-- =====================================================================
--  SECTION 6 — THE ADMIN SIDE
-- =====================================================================

create or replace function public.admin_grant_credits(p_user_id uuid, p_credits int)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  return public.grant_credits(p_user_id, p_credits, 'admin');
end $fn$;

create or replace function public.admin_take_credits(p_user_id uuid, p_credits int)
returns jsonb
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_uid uuid := public.assert_admin();
  v_bal int;
begin
  update user_credits
     set balance = greatest(0, balance - greatest(p_credits, 0)), updated_at = now()
   where user_id = p_user_id
  returning balance into v_bal;
  return jsonb_build_object('ok', true, 'balance', coalesce(v_bal, 0));
end $fn$;

create or replace function public.admin_list_payments(p_limit int default 100)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', x.id, 'email', (select u.email from auth.users u where u.id = x.user_id),
             'credits', x.credits, 'amount', (x.amount_paise / 100),
             'status', x.status, 'pack_id', x.pack_id,
             'razorpay_order_id', x.razorpay_order_id,
             'razorpay_payment_id', x.razorpay_payment_id,
             'created_at', x.created_at, 'paid_at', x.paid_at)
           order by x.created_at desc)
      from (select * from credit_payments order by created_at desc
             limit greatest(p_limit, 1)) x
  ), '[]'::jsonb);
end $fn$;

create or replace function public.admin_credit_stats()
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_uid uuid := public.assert_admin();
begin
  return jsonb_build_object(
    'credits_outstanding', coalesce((select sum(balance) from user_credits), 0),
    'credits_sold',        coalesce((select sum(lifetime_in) from user_credits), 0),
    'credits_spent',       coalesce((select sum(lifetime_out) from user_credits), 0),
    'unlocks',             (select count(*) from profile_unlocks),
    'unlocks_7d',          (select count(*) from profile_unlocks where unlocked_at > now() - interval '7 days'),
    'members_with_credits',(select count(*) from user_credits where balance > 0),
    'revenue_paise',       coalesce((select sum(amount_paise) from credit_payments where status = 'paid'), 0),
    'revenue_7d_paise',    coalesce((select sum(amount_paise) from credit_payments
                                      where status = 'paid' and paid_at > now() - interval '7 days'), 0),
    'payments_paid',       (select count(*) from credit_payments where status = 'paid'),
    'payments_abandoned',  (select count(*) from credit_payments where status = 'created'
                                                                  and created_at < now() - interval '1 hour')
  );
end $fn$;


-- =====================================================================
--  Done.
--
--  Give someone credits by hand (before Razorpay is live):
--    select public.admin_grant_credits(
--      (select id from auth.users where email = 'member@example.com'), 5);
--
--  Change a price (rupees x 100):
--    update credit_packs set price_paise = 44900 where id = 'c5';
--
--  Make a batch of 5-credit codes to hand out for UPI payments:
--    insert into premium_codes (code, credits, months, note)
--    select 'PADMA-' || upper(substr(md5(random()::text), 1, 6)), 5, 12, 'Sept 2026'
--    from generate_series(1, 20) on conflict do nothing;
-- =====================================================================
