# Running the site day to day

`SETUP.md` gets the site online once. This file is the short list of jobs you will
actually do after that. Every one of them is: **Supabase → SQL Editor → New query →
paste → Run**.

---

## 0. Make yourself an admin (do this once)

Sign in to the live site with your own email first, so your account exists. Then:

```sql
insert into app_admins (user_id)
select id from auth.users where email = 'you@example.com'
on conflict do nothing;
```

Admins are the only people who can read the waitlist and the reports.

---

## 1. Someone paid — give them Premium

There is no payment gateway yet. The community collects money by UPI, cash or bank
transfer, and hands over a code. That is deliberate: it costs nothing, needs no
paperwork, and you can start today.

### Make a batch of codes

```sql
insert into premium_codes (code, months, note)
select 'PADMA-' || upper(substr(md5(random()::text), 1, 6)), 12, 'Gold 2026'
from generate_series(1, 50)
on conflict do nothing;

select code from premium_codes where note = 'Gold 2026' and used_count = 0;
```

Write the codes down. Give one out per payment. The member types it into
**Premium Boost → "Already paid? Enter your activation code"** on their dashboard and
Premium switches on instantly.

- `months` controls how long it lasts. Use 3 for Express Boost, 12 for Gold.
- A code works once. Change `max_uses` if you want a shared family code.
- Nobody can guess or brute-force a code from the browser — the codes table is not
  readable by anyone, only checkable through `redeem_premium_code()`.

### Or switch Premium on by hand, by email

```sql
insert into user_tiers (user_id, tier, premium_until, granted_by)
select id, 'premium', now() + interval '12 months', 'manual'
  from auth.users where email = 'member@example.com'
on conflict (user_id) do update
  set tier = 'premium', premium_until = excluded.premium_until;
```

### See who is Premium and when it lapses

```sql
select u.email, t.tier, t.premium_until, t.granted_by
  from user_tiers t join auth.users u on u.id = t.user_id
 order by t.premium_until;
```

---

## 2. Launch day for the Bride & Groom app

Everyone who tapped "Notify me" is stored, de-duplicated, with a `notified_at` column
so you can never message the same person twice.

### Who is waiting, and has not been told yet

```sql
select contact, role, source, created_at
  from waitlist
 where notified_at is null
 order by created_at;
```

Export that (the **Download CSV** button above the results), send the SMS or WhatsApp
broadcast through whatever service you use, and then mark them done:

```sql
update waitlist set notified_at = now() where notified_at is null;
```

That is the "SMS-on-launch job" from the build map. It is a copy, a broadcast and one
line of SQL — no server to build and nothing to pay for until you actually send.

---

## 3. Somebody reported a profile

Reports come in from the shield button on a profile. **Three separate families reporting
the same profile pulls it out of search automatically**, before anyone has looked at it.

### Reports waiting for a decision

```sql
select r.id, r.reason, r.details, r.created_at,
       p.full_name, p.gotram, p.native_place, p.contact_phone
  from profile_reports r
  join parent_profiles p on p.id = r.reported_profile_id
 where r.status = 'open'
 order by r.created_at;
```

### After you have looked into it

```sql
-- nothing wrong, put it back in search
update profile_reports set status = 'dismissed' where id = 'THE-REPORT-ID';
update parent_profiles set visible = true where id = 'THE-PROFILE-ID';

-- genuinely bad, keep it hidden
update profile_reports set status = 'actioned' where id = 'THE-REPORT-ID';
update parent_profiles set visible = false where id = 'THE-PROFILE-ID';

-- remove it entirely (this also removes every interest and bookmark pointing at it)
delete from parent_profiles where id = 'THE-PROFILE-ID';
```

---

## 4. How the community is doing

```sql
select
  (select count(*) from parent_profiles where status = 'published' and is_complete) as live_profiles,
  (select count(*) from parent_profiles where status = 'draft')                     as unfinished,
  (select count(*) from parent_profiles where created_for = 'son')                  as grooms,
  (select count(*) from parent_profiles where created_for = 'daughter')             as brides,
  (select count(*) from interests)                                                  as interests_sent,
  (select count(*) from interests where status = 'accepted')                        as matches_made,
  (select count(*) from user_tiers where tier = 'premium')                          as premium_members,
  (select count(*) from waitlist)                                                   as waitlist;
```

`unfinished` is the number worth watching in the first month. Those are families who
started and stopped — a phone call from the committee converts most of them.

---

## 5. Testing on your own computer before you deploy

Double-clicking the HTML files will not work for login (Supabase needs a real web
address). Run the little helper server instead:

```bash
powershell -ExecutionPolicy Bypass -File dev-server.ps1
```

Then open <http://localhost:8765/home.html>. Stop it with Ctrl+C. Add
`http://localhost:8765/**` to Supabase → **Authentication → URL Configuration →
Redirect URLs** if you want the login link to work locally too.

`dev-server.ps1` is only for your computer. It does nothing on Netlify — you can
delete it before deploying if you prefer.

---

## What the paywall actually does — worth knowing

The free/premium split is enforced **inside the database**, in one function called
`redact_profile`. When a free account asks for a profile, the photo, profession,
income and phone number are replaced with nothing *before the answer leaves Supabase*.

This matters because anyone can read your site's JavaScript and call your database
directly — that is how every browser-based site works. Hiding fields with CSS or
JavaScript would mean a curious teenager could download every phone number on the
platform in about five minutes. This way there is nothing to download.

The same applies to photos: the storage bucket is **private**. Photos are handed out as
links that expire after an hour, and only to a Premium member or to the person who
uploaded it.

If you ever want to change what the free plan shows, there is exactly one place to edit:
`redact_profile` in `supabase-setup-v2.sql` — move a field above or below the
`premium only` comment, re-run the file, done.
