# Padmasaliya Matrimonial — Setup & Go-Live Guide

The website code is complete. To put it online you need to do three things:

1. Create a free Supabase project (the database + login).
2. Paste two values into `js/supabase-client.js`.
3. Upload the folder to a free static host (Netlify).

Total time: about 20–30 minutes. No coding required.

---

## 1. Supabase (database + login)

### 1a. Create the project
1. Go to <https://supabase.com> → **Start your project** → sign in with GitHub/Google.
2. **New project**. Pick a name (e.g. `padmasaliya`), a strong database password, and the
   region closest to your users (e.g. *Mumbai / ap-south-1*). Wait ~2 min for it to build.

### 1b. Create the tables — TWO scripts, in this order
1. In the left menu open **SQL Editor** → **New query**.
2. Open `supabase-setup.sql` from this folder, copy **everything**, paste it in, click **Run**.
   You should see "Success. No rows returned".
3. **New query** again. Open `supabase-setup-v2.sql`, copy everything, paste, **Run**.
   Same message. This one adds the paywall, interests, reports, premium codes and the
   private photo storage.

Both are safe to run again at any time. **Do not skip v2** — without it the dashboard
will say it cannot reach the server, and profile details would be readable by anyone.

Day-to-day jobs (handing out premium codes, reading the waitlist, reviewing reports)
are in `RUNNING-THE-SITE.md`.

### 1c. Turn on login
Open **Authentication → Providers** and enable **Email**. That's it — no email template
editing needed.

How it works: the parent types their email, Supabase emails them a **login link**, they tap
it, and they're signed in. (Supabase greys out the email-template editor unless you pay for
a custom SMTP server, so the site uses the link instead of a 6-digit code.)

> **Important:** you must also do step 3.5 below (set the Site URL), or the link in the
> email will send people to the wrong place.

**Optional — Phone / SMS OTP (costs money):**
- Enable **Phone** and connect an SMS provider (Twilio, MSG91, Vonage).
  That provider bills you per SMS.
- The site supports both. Users see a "Use mobile number instead" link on the login page.

### 1d. Get your keys
Open **Project Settings → API**. Copy:
- **Project URL** (looks like `https://xxxxxxxx.supabase.co`)
- **anon public** key (a long string starting with `eyJ...`)

---

## 2. Put your keys in the code

Open `js/supabase-client.js` and replace the two values:

```js
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
```

These two values are meant to be public — the database is protected by the security
rules (Row Level Security) created by `supabase-setup.sql`. Save the file.

---

## 3. Publish the website (Netlify — free)

### Easiest: drag and drop
1. Go to <https://app.netlify.com/drop>.
2. Drag this whole folder (`padmasaliya-matrimonial-website8-fixed10`) onto the page.
3. In ~30 seconds you get a live URL like `https://random-name.netlify.app`.
4. (Optional) **Site settings → Change site name** to something like `padmasaliya`.

### 3.5. Point Supabase at your live site (required — do not skip)
Back in Supabase → **Authentication → URL Configuration**:
- **Site URL**: your live address, e.g. `https://padmasaliya.netlify.app`
- **Redirect URLs**: add `https://padmasaliya.netlify.app/**`

Without this, the login link in the email won't bring people back to your site.

> Email login only works on the **live site**, not by double-clicking the HTML files on
> your computer. Deploy first, then test.

### Custom domain (optional, ~₹800–1200/year)
- Buy a domain (e.g. from GoDaddy, Namecheap, BigRock).
- In Netlify: **Domain settings → Add a domain** and follow the DNS instructions.
- HTTPS is added automatically by Netlify.

### Updating later
Whenever you change a file, drag the folder onto Netlify again (or connect a GitHub
repo for automatic deploys).

---

## 4. First test (do this once after going live)

1. Open your site → choose a language → **Enter Parents Portal** → **Login**.
2. Type your email → **Send login link** → open the email → tap the link.
   (Check Spam / Promotions if it isn't in the inbox.)
3. Fill in **Create Profile** (add a photo) → Save.
4. Log in from a second email (or ask a family member) and create an opposite
   (son/daughter) profile.
5. On the dashboard you should now see the other profile, be able to search it,
   **Save to Drafts**, and **Recommend to Child**.

If profiles don't show up, re-check that `supabase-setup.sql` ran without errors
(SQL Editor → History).

---

## What's built vs. what's still a placeholder

**Working (real data):**
- Language selection (English / Tamil / Telugu)
- Email login via a one-tap link (and optional phone SMS OTP)
- Create / edit one profile per account, with photo upload, a completeness meter,
  **save as draft vs. publish**, and **delete my profile**
- **Complete-profile gate** — browsing is blocked until your own profile is complete
  and published. Enforced by the database, not by the page.
- **Free vs. premium visibility** — a free account can only ever receive name, gotram,
  native place and age. Photo, profession, income and contact number never leave the
  database for a free account. Enforced by the database, not by the page.
- Dashboard search: bride/groom, gotram, keyword, profession, place, min income,
  age range, with-photo-only — all filtered and paginated **on the server**
- Save to Drafts, Recommend to Child, **Send interest**, **Received / Sent interests**
  with accept & decline, **Report profile**
- Accepting an interest opens both families' full profiles to each other, free of charge
- Notification bell with live updates, and real sidebar counts
- Premium via **activation codes** you hand out after a UPI/cash payment — no payment
  gateway needed yet
- "Notify me" / "Join Waitlist" capture, de-duplicated and ready for a launch-day SMS run

**Still placeholder (wire up later if you want them):**
- Online card/UPI payment (`premium-plans.html`) — needs Razorpay; activation codes
  cover the same ground manually in the meantime
- The separate Bride/Groom candidate app (the waitlist for it works)
- ID verification (the badge now reads "Community verified"; there is no ID check step)
- Sending an email or SMS when an interest arrives (it shows in the bell, and the
  `notifications` table is ready for a job to read)

---

## Files added/changed in this completion

| File | Purpose |
|---|---|
| `supabase-setup.sql` | Full schema: profiles, saved_profiles, recommendations, waitlist, photo storage + security rules |
| `js/dashboard.js` | Live profile search, save/recommend, drafts panel, waitlist (new) |
| `js/create-profile.js` | Photo upload to Supabase Storage, edit existing profile (new) |
| `js/login.js` | Added email-OTP option alongside phone |
| `js/main.js` | Homepage "Notify me" now saves to the waitlist |
| `dashboard.html` / `create-profile.html` / `login.html` / `home.html` | Wired to the new scripts |
| all `*.html` | Added favicon, description and social-share meta tags |
| `netlify.toml`, `robots.txt`, `404.html` | Deploy configuration |
