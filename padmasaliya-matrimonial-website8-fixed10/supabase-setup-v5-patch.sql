-- =====================================================================
--  PADMASALIYA MATRIMONIAL — v5 patch
--  Run this ONCE in: Supabase Dashboard -> SQL Editor -> New Query -> Run
--  Needs v1, v2, v3 and v4 to have run already.
--
--  WHAT THIS ADDS
--   * City / State / Country stored separately, so search can filter on a
--     state or a country instead of guessing at one free-text string.
--   * The jathagam (horoscope) file, held to the same rule as the contact
--     number: Premium members and families whose interest you accepted.
-- =====================================================================


-- ---------------------------------------------------------------------
--  New columns. native_place stays and is still what every card shows —
--  the form writes "City, State, Country" into it — so nothing that reads
--  it needs to change.
-- ---------------------------------------------------------------------
alter table parent_profiles add column if not exists city          text;
alter table parent_profiles add column if not exists state         text;
alter table parent_profiles add column if not exists country       text;
alter table parent_profiles add column if not exists jathagam_path text;

-- Backfill the split fields from the single string older profiles have, so
-- an existing profile does not look half-empty when its owner opens the form.
update parent_profiles
   set city  = nullif(btrim(split_part(native_place, ',', 1)), ''),
       state = nullif(btrim(split_part(native_place, ',', 2)), '')
 where city is null and coalesce(native_place, '') <> '';

create index if not exists parent_profiles_place_idx on parent_profiles (state, city);


-- ---------------------------------------------------------------------
--  The jathagam is as private as the phone number, so it travels with the
--  premium fields — a free viewer never receives the path, which means the
--  signed-URL request they would need to make cannot even be formed.
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
    'city',          p.city,
    'state',         p.state,
    'country',       p.country,
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
    'jathagam_path',   case when p_full then p.jathagam_path end,
    'has_photo',       (p.photo_path is not null),
    'has_jathagam',    (p.jathagam_path is not null)
  );
$fn$;

-- =====================================================================
--  Done. The form now writes city/state/country and an optional jathagam;
--  the jathagam opens on the same terms as the contact number.
-- =====================================================================
