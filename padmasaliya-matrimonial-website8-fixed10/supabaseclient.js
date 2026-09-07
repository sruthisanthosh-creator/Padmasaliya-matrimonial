// ---- Supabase client (shared across pages) ----
// Project URL + publishable (anon) key are safe to expose in frontend code.
// Data access is controlled by Row Level Security (RLS) policies in Supabase.
//
// SETUP: replace the two values below with your own project's values from
// Supabase Dashboard -> Project Settings -> API.  See SETUP.md.

const SUPABASE_URL = 'https://qzxhqbkjudohzurdbsup.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_omFPWVIsl-fvgXQoGZQf4w_1Ra-S5oJ';

if (!window.supabase) {
  console.error('Supabase library failed to load (check your internet / CDN).');
}

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
