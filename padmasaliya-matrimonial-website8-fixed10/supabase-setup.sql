-- =====================================================================
--  PADMASALIYA MATRIMONIAL — Supabase setup
--  Run this ONCE in: Supabase Dashboard -> SQL Editor -> New Query -> Run
--  Safe to re-run (everything is "if not exists" / "drop ... if exists").
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PROFILES TABLE (one row per son/daughter a parent adds)
-- ---------------------------------------------------------------------
create table if not exists parent_profiles (
  id uuid primary key default gen_random_uuid(),
  parent_user_id uuid not null references auth.users(id) on delete cascade,
  created_for text check (created_for in ('son','daughter')),
  full_name text,
  dob date,
  height text,
  native_place text,
  gotram text,
  nakshatra text,
  rasi text,
  horoscope_gunas text,
  education text,
  profession text,
  annual_income text,
  work_location text,
  photo_url text,
  contact_phone text,
  visible boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Add the newer columns if the table already existed from an older version
alter table parent_profiles add column if not exists photo_url text;
alter table parent_profiles add column if not exists contact_phone text;
alter table parent_profiles add column if not exists visible boolean not null default true;
alter table parent_profiles add column if not exists updated_at timestamptz default now();

-- One parent = one profile (re-submitting the form edits it instead of duplicating)
create unique index if not exists parent_profiles_one_per_parent
  on parent_profiles (parent_user_id);

-- keep updated_at fresh
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists parent_profiles_updated_at on parent_profiles;
create trigger parent_profiles_updated_at
  before update on parent_profiles
  for each row execute function set_updated_at();

alter table parent_profiles enable row level security;

-- Any logged-in parent can browse other visible profiles (needed for search)
drop policy if exists "Logged-in users can view visible profiles" on parent_profiles;
create policy "Logged-in users can view visible profiles"
  on parent_profiles for select
  to authenticated
  using (visible = true or auth.uid() = parent_user_id);

drop policy if exists "Parents can insert their own profiles" on parent_profiles;
create policy "Parents can insert their own profiles"
  on parent_profiles for insert
  to authenticated
  with check (auth.uid() = parent_user_id);

drop policy if exists "Parents can update their own profiles" on parent_profiles;
create policy "Parents can update their own profiles"
  on parent_profiles for update
  to authenticated
  using (auth.uid() = parent_user_id)
  with check (auth.uid() = parent_user_id);

drop policy if exists "Parents can delete their own profiles" on parent_profiles;
create policy "Parents can delete their own profiles"
  on parent_profiles for delete
  to authenticated
  using (auth.uid() = parent_user_id);

-- Old policy name from the first version — remove if present
drop policy if exists "Parents can view their own profiles" on parent_profiles;


-- ---------------------------------------------------------------------
-- 2. SAVED PROFILES  ("Drafts" — bookmarks a parent keeps)
-- ---------------------------------------------------------------------
create table if not exists saved_profiles (
  id uuid primary key default gen_random_uuid(),
  parent_user_id uuid not null references auth.users(id) on delete cascade,
  saved_profile_id uuid not null references parent_profiles(id) on delete cascade,
  created_at timestamptz default now(),
  unique (parent_user_id, saved_profile_id)
);

alter table saved_profiles enable row level security;

drop policy if exists "Parents manage their own saved list" on saved_profiles;
create policy "Parents manage their own saved list"
  on saved_profiles for all
  to authenticated
  using (auth.uid() = parent_user_id)
  with check (auth.uid() = parent_user_id);


-- ---------------------------------------------------------------------
-- 3. RECOMMENDATIONS  ("Recommend to Child")
-- ---------------------------------------------------------------------
create table if not exists recommendations (
  id uuid primary key default gen_random_uuid(),
  parent_user_id uuid not null references auth.users(id) on delete cascade,
  recommended_profile_id uuid not null references parent_profiles(id) on delete cascade,
  note text,
  created_at timestamptz default now(),
  unique (parent_user_id, recommended_profile_id)
);

alter table recommendations enable row level security;

drop policy if exists "Parents manage their own recommendations" on recommendations;
create policy "Parents manage their own recommendations"
  on recommendations for all
  to authenticated
  using (auth.uid() = parent_user_id)
  with check (auth.uid() = parent_user_id);


-- ---------------------------------------------------------------------
-- 4. WAITLIST  (Candidate-app "Notify me" / "Join Waitlist")
-- ---------------------------------------------------------------------
create table if not exists waitlist (
  id uuid primary key default gen_random_uuid(),
  contact text not null,
  source text,
  created_at timestamptz default now()
);

alter table waitlist enable row level security;

-- Anyone (even signed-out visitors on the homepage) may add themselves,
-- but nobody can read the list from the browser.
drop policy if exists "Anyone can join the waitlist" on waitlist;
create policy "Anyone can join the waitlist"
  on waitlist for insert
  to anon, authenticated
  with check (char_length(contact) between 3 and 120);


-- ---------------------------------------------------------------------
-- 5. STORAGE BUCKET for profile photos
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('profile-photos', 'profile-photos', true)
on conflict (id) do nothing;

-- Public read of photos
drop policy if exists "Public read profile photos" on storage.objects;
create policy "Public read profile photos"
  on storage.objects for select
  using (bucket_id = 'profile-photos');

-- A parent may upload/replace/delete only files inside a folder named
-- after their own user id, e.g.  <user-id>/photo.jpg
drop policy if exists "Parents upload their own photos" on storage.objects;
create policy "Parents upload their own photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Parents update their own photos" on storage.objects;
create policy "Parents update their own photos"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Parents delete their own photos" on storage.objects;
create policy "Parents delete their own photos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- =====================================================================
--  Done. Next: Dashboard -> Authentication -> Providers
--    * Enable "Email" (works out of the box, free) — OR —
--    * Enable "Phone" + connect an SMS provider (Twilio / MSG91) for OTP.
-- =====================================================================
