-- =====================================================================
--  PADMASALIYA MATRIMONIAL — v4 patch
--  Run this ONCE in: Supabase Dashboard -> SQL Editor -> New Query -> Run
--  Only needed if you have ALREADY run supabase-setup-v2.sql.
--  (A fresh project can just run v1 then v2 — v2 now contains all of this.)
--
--  WHAT THIS CHANGES
--   * The photo is now part of the FREE plan. A free member sees
--     photo, name, gotram, place and age. Profession, income, education,
--     horoscope details and the contact number stay behind Premium.
--   * Because the photo is free, the private photo bucket now opens to
--     any member who has completed and published their own profile —
--     not only to Premium members.
-- =====================================================================


-- ---------------------------------------------------------------------
--  A non-raising version of the browse gate, so a storage policy can ask
--  the question without blowing up. (assert_can_browse() raises; this
--  one just answers true/false.)
-- ---------------------------------------------------------------------
create or replace function public.can_browse(uid uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public as $fn$
  select coalesce(
    (select p.is_complete and p.status = 'published' and p.deleted_at is null
       from parent_profiles p where p.parent_user_id = uid), false);
$fn$;


-- ---------------------------------------------------------------------
--  THE ONE PLACE that decides what a viewer is allowed to see.
--  Moving a field between the two blocks below is all it takes to change
--  what the free plan shows.
-- ---------------------------------------------------------------------
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
    'photo_path',    p.photo_path,
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
    'contact_phone',   case when p_full then p.contact_phone end,
    'has_photo',       (p.photo_path is not null)
  );
$fn$;


-- ---------------------------------------------------------------------
--  Photos stay in a PRIVATE bucket and are still served only as
--  short-lived signed links — but now any member who has published their
--  own completed profile can ask for one, not only Premium members.
--  Someone who has not filled in their own profile still gets nothing.
-- ---------------------------------------------------------------------
drop policy if exists "Public read profile photos"        on storage.objects;
drop policy if exists "Own photo or premium reads all"    on storage.objects;
drop policy if exists "Own photo or any browsing member"  on storage.objects;
create policy "Own photo or any browsing member" on storage.objects for select
  to authenticated using (
    bucket_id = 'profile-photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.can_browse())
  );

-- =====================================================================
--  Done. Free plan now shows: photo, name, gotram, place, age.
--  Premium unlocks: profession, income, education, height, nakshatra,
--  rasi, gunas, work location, about, interests, contact number.
-- =====================================================================
