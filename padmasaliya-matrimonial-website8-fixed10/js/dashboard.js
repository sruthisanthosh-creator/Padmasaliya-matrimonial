// ---- Parents dashboard: live profile search from Supabase ----
// Requires: supabase-client.js and main.js loaded first.

(function () {
  const PAGE = 9;

  const grid = document.getElementById('profileGrid');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const resultCount = document.getElementById('resultCount');
  const draftsPanel = document.getElementById('draftsPanel');
  const lookingSel = document.getElementById('filterLooking');
  const gotramSel = document.getElementById('filterGotram');
  const incomeSel = document.getElementById('filterIncome');
  const keywordInput = document.getElementById('searchKeyword');
  const searchBtn = document.getElementById('doSearchBtn');
  const waitlistInput = document.getElementById('waitlistInput');
  const waitlistBtn = document.getElementById('waitlistBtn');
  if (!grid) return;

  let me = null;
  let myProfile = null;
  let offset = 0;
  let total = 0;
  let savedIds = new Set();

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function ageFromDob(dob) {
    if (!dob) return null;
    const d = new Date(dob);
    if (isNaN(d)) return null;
    const t = new Date();
    let a = t.getFullYear() - d.getFullYear();
    const m = t.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && t.getDate() < d.getDate())) a--;
    return a > 0 && a < 120 ? a : null;
  }

  const incomeNum = (s) => {
    const m = String(s || '').match(/(\d+(\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  };

  function targetRole() {
    // Bride  -> we want 'daughter' profiles;  Groom -> 'son' profiles
    return (lookingSel && lookingSel.value === 'groom') ? 'son' : 'daughter';
  }

  function t(en, ta, te) {
    return currentLang === 'ta' ? ta : currentLang === 'te' ? te : en;
  }

  // ---------- header / sidebar identity ----------
  function setIdentity() {
    const name = (myProfile && myProfile.full_name)
      ? ('Parent of ' + myProfile.full_name.split(' ')[0])
      : (me && me.phone ? '+' + me.phone : (me && me.email ? me.email : 'Parent Account'));
    const initials = name.replace(/[^A-Za-z ]/g, '').trim().split(/\s+/)
      .slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || 'PP';
    document.querySelectorAll('.s3-avatar').forEach(el => el.textContent = initials);
    document.querySelectorAll('.s3-user > div > b, .s3-side-user > div > b')
      .forEach(el => el.textContent = name);
  }

  // ---------- card ----------
  function cardHtml(p) {
    const age = ageFromDob(p.dob);
    const line1 = [age ? age + ' ' + t('yrs', 'வயது', 'ఏళ్లు') : null, p.height,
      p.gotram ? p.gotram + ' Gotram' : null].filter(Boolean).join(', ');
    const tags = [p.nakshatra, p.rasi, p.horoscope_gunas ? p.horoscope_gunas + ' ' + t('Gunas', 'குணங்கள்', 'గుణాలు') : null]
      .filter(Boolean).map(x => '<span>' + esc(x) + '</span>').join('');
    const photo = p.photo_url
      ? '<img src="' + esc(p.photo_url) + '" alt="' + esc(p.full_name) + '" style="width:100%;height:100%;object-fit:cover;">'
      : '<svg class="icon icon-lg"><use href="#i-user"></use></svg>';
    const isSaved = savedIds.has(p.id);
    return '' +
      '<div class="profile-card" data-id="' + p.id + '">' +
        '<div class="profile-photo">' + photo +
          '<span class="tag-idv"><svg class="icon"><use href="#i-shield-check"></use></svg> ' + t('ID Verified', 'அடையாளம் சரிபார்க்கப்பட்டது', 'ID ధృవీకరించబడింది') + '</span>' +
          '<span class="heart"><svg class="icon"><use href="#i-heart"></use></svg></span>' +
        '</div>' +
        '<div class="profile-body">' +
          '<h4>' + esc(p.full_name || 'Padmasaliya Profile') + '</h4>' +
          (line1 ? '<div class="meta">' + esc(line1) + '</div>' : '') +
          (p.profession ? '<div class="meta">' + esc(p.profession) + '</div>' : '') +
          (p.work_location || p.native_place ? '<div class="meta">' + esc(p.work_location || p.native_place) + '</div>' : '') +
          (p.annual_income ? '<div class="income">' + esc(p.annual_income) + '</div>' : '') +
          (tags ? '<div class="profile-tags">' + tags + '</div>' : '') +
          '<div class="profile-actions">' +
            '<button class="btn-ghost" data-act="save" ' + (isSaved ? 'data-saved="1"' : '') + '>' +
              '<svg class="icon"><use href="#i-bookmark"></use></svg> ' +
              (isSaved ? t('Saved', 'சேமிக்கப்பட்டது', 'సేవ్ చేయబడింది') : t('Save to Drafts', 'வரைவுகளில் சேமி', 'డ్రాఫ్ట్‌లో సేవ్')) + '</button>' +
            '<button class="btn-solid" data-act="recommend">' +
              '<svg class="icon"><use href="#i-send"></use></svg> ' + t('Recommend to Child', 'பிள்ளைக்கு பரிந்துரை', 'పిల్లలకు సిఫార్సు') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  // ---------- query ----------
  async function runQuery(reset) {
    if (reset) { offset = 0; grid.innerHTML = ''; }
    loadMoreBtn && (loadMoreBtn.disabled = true);

    let q = supabaseClient
      .from('parent_profiles')
      .select('*', { count: 'exact' })
      .eq('visible', true)
      .eq('created_for', targetRole())
      .order('created_at', { ascending: false });

    if (me) q = q.neq('parent_user_id', me.id);
    if (gotramSel && gotramSel.value) q = q.eq('gotram', gotramSel.value);

    const kw = keywordInput && keywordInput.value.trim();
    if (kw) {
      const safe = kw.replace(/[%,()]/g, ' ');
      q = q.or(
        ['full_name', 'profession', 'native_place', 'work_location', 'education']
          .map(f => f + '.ilike.%' + safe + '%').join(',')
      );
    }

    q = q.range(offset, offset + PAGE - 1);
    const { data, count, error } = await q;

    if (error) {
      grid.innerHTML = '<p style="color:#c0392b;padding:20px;">Could not load profiles: ' + esc(error.message) + '</p>';
      return;
    }

    total = count || 0;
    let rows = data || [];

    // client-side "minimum income" filter (annual_income is free text)
    const minInc = incomeSel ? incomeNum(incomeSel.value) : 0;
    if (minInc) rows = rows.filter(r => incomeNum(r.annual_income) >= minInc);

    if (reset && rows.length === 0) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:48px 20px;color:var(--ink-soft);">' +
        '<svg class="icon icon-lg" style="opacity:.4;"><use href="#i-search"></use></svg>' +
        '<p style="margin-top:10px;">' + t('No matching profiles yet. Check back soon.',
          'இன்னும் பொருந்தும் சுயவிவரங்கள் இல்லை.', 'ఇంకా సరిపోలే ప్రొఫైల్‌లు లేవు.') + '</p></div>';
    } else {
      grid.insertAdjacentHTML('beforeend', rows.map(cardHtml).join(''));
    }

    offset += PAGE;
    if (resultCount) {
      resultCount.textContent = t('Showing', 'காட்டுகிறது', 'చూపిస్తోంది') + ' ' +
        total.toLocaleString('en-IN') + ' ' + t('verified profiles', 'சரிபார்க்கப்பட்ட சுயவிவரங்கள்', 'ధృవీకరించిన ప్రొఫైల్‌లు');
    }
    if (loadMoreBtn) {
      const more = offset < total;
      loadMoreBtn.style.display = more ? '' : 'none';
      loadMoreBtn.disabled = !more;
    }
  }

  // ---------- actions (event delegation) ----------
  grid.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.profile-card');
    const id = card && card.dataset.id;
    if (!id || !me) return;

    if (btn.dataset.act === 'save') {
      btn.disabled = true;
      if (btn.dataset.saved) {
        await supabaseClient.from('saved_profiles').delete()
          .eq('parent_user_id', me.id).eq('saved_profile_id', id);
        savedIds.delete(id);
        btn.removeAttribute('data-saved');
        btn.innerHTML = '<svg class="icon"><use href="#i-bookmark"></use></svg> ' + t('Save to Drafts', 'வரைவுகளில் சேமி', 'డ్రాఫ్ట్‌లో సేవ్');
        showToast(t('Removed from Drafts', 'வரைவுகளில் இருந்து அகற்றப்பட்டது', 'డ్రాఫ్ట్‌ల నుండి తీసివేయబడింది'));
      } else {
        const { error } = await supabaseClient.from('saved_profiles')
          .insert({ parent_user_id: me.id, saved_profile_id: id });
        if (!error || error.code === '23505') {
          savedIds.add(id);
          btn.dataset.saved = '1';
          btn.innerHTML = '<svg class="icon"><use href="#i-bookmark"></use></svg> ' + t('Saved', 'சேமிக்கப்பட்டது', 'సేవ్ చేయబడింది');
          showToast(t('Saved to Drafts', 'வரைவுகளில் சேமிக்கப்பட்டது', 'డ్రాఫ్ట్‌లో సేవ్ చేయబడింది'));
        } else {
          showToast(error.message);
        }
      }
      btn.disabled = false;
      loadDrafts();
    }

    if (btn.dataset.act === 'recommend') {
      btn.disabled = true;
      const { error } = await supabaseClient.from('recommendations')
        .insert({ parent_user_id: me.id, recommended_profile_id: id });
      btn.disabled = false;
      if (!error || error.code === '23505') {
        showToast(t('Recommended to your child', 'உங்கள் பிள்ளைக்கு பரிந்துரைக்கப்பட்டது', 'మీ పిల్లలకు సిఫార్సు చేయబడింది'));
      } else {
        showToast(error.message);
      }
    }
  });

  // ---------- drafts side panel ----------
  async function loadDrafts() {
    if (!draftsPanel || !me) return;
    const { data } = await supabaseClient
      .from('saved_profiles')
      .select('created_at, parent_profiles(id, full_name, gotram)')
      .eq('parent_user_id', me.id)
      .order('created_at', { ascending: false })
      .limit(6);

    const rows = (data || []).filter(r => r.parent_profiles);
    savedIds = new Set(rows.map(r => r.parent_profiles.id).concat([...savedIds]));

    const head = '<div class="panel-head"><h3><svg class="icon"><use href="#i-bookmark"></use></svg> ' +
      t('Your Drafts', 'உங்கள் வரைவுகள்', 'మీ డ్రాఫ్ట్‌లు') + '</h3></div>';

    if (rows.length === 0) {
      draftsPanel.innerHTML = head + '<p style="font-size:13px;color:var(--ink-soft);margin:6px 0 0;">' +
        t('Profiles you save appear here.', 'நீங்கள் சேமிக்கும் சுயவிவரங்கள் இங்கே தோன்றும்.', 'మీరు సేవ్ చేసిన ప్రొఫైల్‌లు ఇక్కడ కనిపిస్తాయి.') + '</p>';
      return;
    }
    draftsPanel.innerHTML = head + rows.map(r => {
      const p = r.parent_profiles;
      const d = new Date(r.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      return '<div class="draft-row"><div class="draft-avatar"><svg class="icon"><use href="#i-user"></use></svg></div>' +
        '<div><b>' + esc(p.full_name || 'Profile') + '</b><span>' +
        t('Saved on', 'சேமித்த தேதி', 'సేవ్ చేసిన తేదీ') + ' ' + d + '</span></div></div>';
    }).join('');
  }

  // ---------- gotram filter options ----------
  async function fillGotrams() {
    if (!gotramSel) return;
    const { data } = await supabaseClient
      .from('parent_profiles').select('gotram').eq('visible', true).not('gotram', 'is', null);
    const set = [...new Set((data || []).map(r => (r.gotram || '').trim()).filter(Boolean))].sort();
    set.forEach(g => {
      const o = document.createElement('option');
      o.value = g; o.textContent = g;
      gotramSel.appendChild(o);
    });
  }

  // ---------- waitlist ----------
  if (waitlistBtn && waitlistInput) {
    waitlistBtn.addEventListener('click', async () => {
      const v = waitlistInput.value.trim();
      if (v.length < 3) { showToast(t('Enter a valid number', 'சரியான எண்ணை உள்ளிடவும்', 'సరైన నంబర్ నమోదు చేయండి')); return; }
      waitlistBtn.disabled = true;
      const { error } = await supabaseClient.from('waitlist').insert({ contact: v, source: 'dashboard' });
      waitlistBtn.disabled = false;
      if (error) { showToast(error.message); return; }
      waitlistInput.value = '';
      showToast(t('You are on the waitlist!', 'நீங்கள் காத்திருப்பு பட்டியலில் உள்ளீர்கள்!', 'మీరు వెయిట్‌లిస్ట్‌లో ఉన్నారు!'));
    });
  }

  // ---------- popular gotram chips ----------
  document.querySelectorAll('.s3-popular .chip').forEach(chip => {
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', () => {
      const g = chip.textContent.trim();
      if (gotramSel && [...gotramSel.options].some(o => o.value === g)) {
        gotramSel.value = g;
      } else if (keywordInput) {
        keywordInput.value = g;
      }
      runQuery(true);
    });
  });

  // ---------- wire filters ----------
  [searchBtn].forEach(b => b && b.addEventListener('click', () => runQuery(true)));
  [lookingSel, gotramSel, incomeSel].forEach(s => s && s.addEventListener('change', () => runQuery(true)));
  keywordInput && keywordInput.addEventListener('keydown', e => { if (e.key === 'Enter') runQuery(true); });
  loadMoreBtn && loadMoreBtn.addEventListener('click', () => runQuery(false));

  // ---------- boot ----------
  (async function init() {
    const { data: s } = await supabaseClient.auth.getSession();
    if (!s || !s.session) { window.location.href = 'login.html'; return; }
    me = s.session.user;

    const { data: mine } = await supabaseClient
      .from('parent_profiles').select('*').eq('parent_user_id', me.id).maybeSingle();
    myProfile = mine || null;
    setIdentity();

    // default "Looking for" to the opposite of what this parent registered
    if (lookingSel && myProfile) {
      lookingSel.value = myProfile.created_for === 'son' ? 'bride' : 'groom';
    }

    // load my saved ids so cards render in the right state
    const { data: sv } = await supabaseClient
      .from('saved_profiles').select('saved_profile_id').eq('parent_user_id', me.id);
    savedIds = new Set((sv || []).map(r => r.saved_profile_id));

    await fillGotrams();
    await runQuery(true);
    await loadDrafts();

    // re-translate dynamic bits when language changes
    document.querySelectorAll('[data-langdd] .lang-dd-menu button, .lang-card').forEach(b => {
      b.addEventListener('click', () => setTimeout(() => { setIdentity(); runQuery(true); loadDrafts(); }, 50));
    });
  })();
})();
