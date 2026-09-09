// ---- Create / edit the profile a parent is publishing ---------------------
// Two ways out of this form:
//   Save as draft  — stored, visible to nobody, browsing stays locked.
//   Save & publish — goes into search, and is what unlocks browsing.
// The six starred fields are exactly the ones parent_profiles.is_complete
// checks in the database, so the meter below can never disagree with it.
//
// Requires: supabase-client.js and main.js loaded first.

(function () {
  'use strict';

  const form = document.getElementById('profileForm');
  if (!form) return;

  const $ = (id) => document.getElementById(id);

  const fileInput   = $('photoInput');
  const photoBox    = document.querySelector('.cp-photo-upload');
  const draftBtn    = $('saveDraftBtn');
  const publishBtn  = $('publishBtn');
  const deleteBtn   = $('deleteProfileBtn');
  const meterBar    = $('cpMeterBar');
  const meterPct    = $('cpMeterPct');
  const meterHint   = $('cpMeterHint');
  const meterTitle  = $('cpMeterTitle');
  const chipRow     = $('cpInterests');

  const F = {
    fullName:     $('f_fullName'),
    dob:          $('f_dob'),
    height:       $('f_height'),
    city:         $('f_city'),
    state:        $('f_state'),
    country:      $('f_country'),
    contact:      $('f_contact'),
    marital:      $('f_marital'),
    gotram:       $('f_gotram'),
    nakshatra:    $('f_nakshatra'),
    rasi:         $('f_rasi'),
    gunas:        $('f_gunas'),
    education:    $('f_education'),
    profession:   $('f_profession'),
    income:       $('f_income'),
    workLocation: $('f_workLocation'),
    about:        $('f_about')
  };

  let pickedFile = null;
  let pickedJathagam = null;
  let existingPhotoPath = null;
  let existingJathagamPath = null;
  let removePhoto = false;      // they had a photo and chose to take it off
  let currentStatus = 'draft';
  let hasProfile = false;
  const chosenInterests = new Set();

  function t(en, ta, te) {
    return currentLang === 'ta' ? ta : currentLang === 'te' ? te : en;
  }

  const val = (el) => (el && el.value ? el.value.trim() : '');

  // ---------- the shell around the form (name, plan, counts) ----------
  // Everything here comes from the signed-in account. A brand new account
  // shows no counts at all, rather than the sample numbers this page used
  // to carry over from the design mock-up.
  async function fillShell() {
    let status = null, counts = null;
    try { status = await supabaseClient.rpc('my_status', {}).then((r) => r.data); } catch (e) {}
    try { counts = await supabaseClient.rpc('my_counts', {}).then((r) => r.data); } catch (e) {}

    const { data: s } = await supabaseClient.auth.getSession();
    const user = s && s.session && s.session.user;
    const p = status && status.profile;

    const name = (p && p.full_name)
      ? t('Parent of ', 'பெற்றோர்: ', 'తల్లిదండ్రులు: ') + p.full_name.split(' ')[0]
      : (user && (user.email || (user.phone && '+' + user.phone)))
        || t('Parent Account', 'பெற்றோர் கணக்கு', 'తల్లిదండ్రుల ఖాతా');
    const initials = String(name).replace(/[^A-Za-z ]/g, '').trim().split(/\s+/)
      .slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || 'PP';

    document.querySelectorAll('.s3-avatar').forEach((el) => { el.textContent = initials; });
    document.querySelectorAll('.s3-user > div > b, .s3-side-user > div > b')
      .forEach((el) => { el.textContent = name; });

    const chip = $('planChip');
    if (chip && status) {
      chip.hidden = false;
      $('planChipText').textContent = status.premium
        ? t('Premium member', 'பிரீமியம் உறுப்பினர்', 'ప్రీమియం సభ్యుడు')
        : t('Free plan', 'இலவச திட்டம்', 'ఉచిత ప్లాన్');
    }

    if (counts) {
      const set = (id, n) => {
        const el = $(id);
        if (!el) return;
        el.textContent = n;
        el.hidden = !n;
      };
      set('cntDrafts', counts.drafts);
      set('cntRecommended', counts.recommended);
      set('cntReceived', counts.received);
      const dot = $('bellDot');
      if (dot) { dot.textContent = counts.unread; dot.hidden = !counts.unread; }
    }
  }

  // Sidebar links across to the matching dashboard view.
  document.querySelectorAll('[data-goto]').forEach((el) => {
    el.addEventListener('click', () => {
      window.location.href = 'dashboard.html#' + el.dataset.goto;
    });
  });

  // ---------- suggestion lists ----------
  // Every list below suggests without restricting — a parent whose gotram or
  // village is not in our list can still type it and save.
  (function fillDatalists() {
    if (typeof REF === 'undefined') return;
    REF.fillList('dl_city',       REF.CITY);
    REF.fillList('dl_state',      REF.STATE);
    REF.fillList('dl_country',    REF.COUNTRY);
    REF.fillList('dl_gotram',     REF.GOTRAM);
    REF.fillList('dl_nakshatra',  REF.NAKSHATRA);
    REF.fillList('dl_rasi',       REF.RASI);
    REF.fillList('dl_education',  REF.EDUCATION);
    REF.fillList('dl_profession', REF.PROFESSION);
    REF.fillList('dl_interest',   REF.INTEREST);
  })();

  // Picking a nakshatra offers the rasi it usually falls in. It fills an empty
  // Rasi box and otherwise only suggests — a jathagam can disagree with the
  // general rule and the family's own copy wins.
  const rasiHint = $('rasiSuggest');
  if (F.nakshatra && typeof REF !== 'undefined') {
    F.nakshatra.addEventListener('change', () => {
      const rasi = REF.rasiForNakshatra(val(F.nakshatra));
      if (!rasi || !rasiHint) { if (rasiHint) rasiHint.hidden = true; return; }
      if (!val(F.rasi)) {
        F.rasi.value = rasi;
        updateMeter();
        rasiHint.hidden = false;
        rasiHint.textContent = t('Filled from your nakshatra — change it if your jathagam says otherwise.',
          'நட்சத்திரத்திலிருந்து நிரப்பப்பட்டது — ஜாதகம் வேறு சொன்னால் மாற்றவும்.',
          'నక్షత్రం నుండి నింపబడింది — జాతకం వేరుగా ఉంటే మార్చండి.');
      } else if (val(F.rasi) !== rasi) {
        rasiHint.hidden = false;
        rasiHint.textContent = t('Usually ', 'பொதுவாக ', 'సాధారణంగా ') + rasi +
          t(' — keeping what you entered.', ' — நீங்கள் இட்டதே வைக்கிறோம்.', ' — మీరు ఇచ్చినదే ఉంచుతున్నాము.');
      } else {
        rasiHint.hidden = true;
      }
    });
  }

  // ---------- interests ----------
  function renderChips() {
    if (!chipRow) return;
    const base = (typeof REF !== 'undefined') ? REF.INTEREST : [];
    // anything the parent typed themselves shows alongside the suggestions
    const all = base.concat([...chosenInterests].filter((i) => base.indexOf(i) === -1));
    chipRow.innerHTML = all.map((i) =>
      '<button type="button" class="cp-chip' + (chosenInterests.has(i) ? ' on' : '') +
      '" data-interest="' + i.replace(/"/g, '&quot;') + '">' + i + '</button>').join('');
  }

  if (chipRow) {
    chipRow.addEventListener('click', (e) => {
      const b = e.target.closest('[data-interest]');
      if (!b) return;
      const v = b.dataset.interest;
      if (chosenInterests.has(v)) chosenInterests.delete(v); else chosenInterests.add(v);
      b.classList.toggle('on');
    });
  }

  const interestAdd = $('f_interestAdd');
  const addInterestBtn = $('addInterestBtn');
  function addInterest() {
    const v = val(interestAdd);
    if (!v) return;
    if (chosenInterests.size >= 15) {
      showToast(t('That is enough interests for one profile.',
        'இது போதும்.', 'ఇది సరిపోతుంది.'));
      return;
    }
    chosenInterests.add(v);
    interestAdd.value = '';
    renderChips();
  }
  if (addInterestBtn) addInterestBtn.addEventListener('click', addInterest);
  if (interestAdd) {
    interestAdd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addInterest(); }
    });
  }

  // ---------- completeness meter ----------
  // Same six fields, same order, as the is_complete column in the database.
  const REQUIRED = [
    ['fullName',   () => val(F.fullName).length > 1,    () => t('Full name', 'முழு பெயர்', 'పూర్తి పేరు')],
    ['dob',        () => !!val(F.dob),                  () => t('Date of birth', 'பிறந்த தேதி', 'పుట్టిన తేదీ')],
    ['gotram',     () => !!val(F.gotram),               () => t('Gotram', 'கோத்திரம்', 'గోత్రం')],
    ['city',       () => !!val(F.city),                 () => t('City / town', 'ஊர்', 'ఊరు')],
    ['profession', () => !!val(F.profession),           () => t('Profession', 'தொழில்', 'వృత్తి')],
    ['contact',    () => digits(val(F.contact)).length >= 6, () => t('Contact number', 'தொடர்பு எண்', 'సంప్రదింపు నంబర్')]
  ];

  // The database keeps one native_place string (search and every card read
  // it), so the three boxes are joined back into one on save and split apart
  // again on load.
  function composePlace() {
    return [val(F.city), val(F.state), val(F.country)].filter(Boolean).join(', ');
  }

  const digits = (s) => String(s || '').replace(/[^0-9]/g, '');

  function isComplete() {
    return REQUIRED.every((r) => r[1]());
  }

  function updateMeter() {
    if (!meterBar) return;
    const missing = REQUIRED.filter((r) => !r[1]());
    const done = REQUIRED.length - missing.length;
    const pct = Math.round((done / REQUIRED.length) * 100);

    meterBar.style.width = pct + '%';
    meterPct.textContent = pct + '%';
    meterTitle.textContent = t('Profile completeness', 'சுயவிவர நிறைவு', 'ప్రొఫైల్ పూర్తి');

    if (!missing.length) {
      meterHint.innerHTML = t(
        'All set. Publish and you can start browsing other families right away.',
        'தயார். வெளியிட்டால் உடனே மற்ற குடும்பங்களைப் பார்க்கலாம்.',
        'సిద్ధం. ప్రచురిస్తే వెంటనే ఇతర కుటుంబాలను చూడవచ్చు.');
    } else {
      meterHint.innerHTML = t('Still needed: ', 'இன்னும் தேவை: ', 'ఇంకా కావాలి: ') +
        '<span class="cp-req">' + missing.map((r) => r[2]()).join(', ') + '</span>';
    }
    if (publishBtn) {
      publishBtn.textContent = missing.length
        ? t('Save & Publish →', 'சேமித்து வெளியிடு →', 'సేవ్ చేసి ప్రచురించు →')
        : (currentStatus === 'published'
            ? t('Save changes →', 'மாற்றங்களை சேமி →', 'మార్పులు సేవ్ →')
            : t('Save & Publish →', 'சேமித்து வெளியிடு →', 'సేవ్ చేసి ప్రచురించు →'));
    }
  }

  Object.values(F).forEach((el) => {
    if (!el) return;
    el.addEventListener('input', updateMeter);
    el.addEventListener('change', updateMeter);
  });

  // ---------- role toggle ----------
  function setRole(role) {
    document.querySelectorAll('.cp-toggle-btn').forEach((x) =>
      x.classList.toggle('active', x.dataset.role === role));
  }
  document.querySelectorAll('.cp-toggle-btn').forEach((b) => {
    b.addEventListener('click', () => setRole(b.dataset.role));
  });

  // ---------- photo ----------
  function bindChoose() {
    const btn = $('choosePhotoBtn');
    if (btn && fileInput) btn.addEventListener('click', () => fileInput.click());
  }
  bindChoose();

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (!f) return;
      if (!/^image\/(jpe?g|png|webp)$/i.test(f.type)) {
        showToast(t('Please choose a JPG, PNG or WEBP image',
          'JPG, PNG அல்லது WEBP படத்தைத் தேர்ந்தெடுக்கவும்',
          'JPG, PNG లేదా WEBP చిత్రం ఎంచుకోండి'));
        fileInput.value = '';
        return;
      }
      if (f.size > 5 * 1024 * 1024) {
        showToast(t('Image is larger than 5MB', 'படம் 5MB க்கு மேல்', 'చిత్రం 5MB కంటే పెద్దది'));
        fileInput.value = '';
        return;
      }
      pickedFile = f;
      removePhoto = false;
      renderPhotoPreview(URL.createObjectURL(f));
    });
  }

  // A photo is optional, so it also has to be undoable — otherwise picking
  // one by mistake would be permanent.
  // ---------- jathagam (horoscope) ----------
  const JATHAGAM_MAX = 5 * 1024 * 1024;
  const jathagamInput = $('jathagamInput');
  const jathagamBox = $('jathagamBox');

  function bindChooseJathagam() {
    const btn = $('chooseJathagamBtn');
    if (btn && jathagamInput) btn.addEventListener('click', () => jathagamInput.click());
  }
  bindChooseJathagam();

  if (jathagamInput) {
    jathagamInput.addEventListener('change', () => {
      const f = jathagamInput.files[0];
      if (!f) return;
      if (!/^(application\/pdf|image\/(jpe?g|png|webp))$/i.test(f.type)) {
        showToast(t('Upload the jathagam as a PDF or an image (JPG, PNG, WEBP).',
          'ஜாதகத்தை PDF அல்லது படமாக பதிவேற்றவும்.',
          'జాతకాన్ని PDF లేదా చిత్రంగా అప్‌లోడ్ చేయండి.'));
        jathagamInput.value = '';
        return;
      }
      if (f.size > JATHAGAM_MAX) {
        showToast(t('That file is ' + (f.size / 1048576).toFixed(1) + 'MB — the limit is 5MB.',
          'கோப்பு 5MB க்கு மேல்.', 'ఫైల్ 5MB కంటే పెద్దది.'));
        jathagamInput.value = '';
        return;
      }
      pickedJathagam = f;
      renderJathagam(f.name, (f.size / 1048576).toFixed(1) + 'MB');
    });
  }

  function renderJathagam(name, size) {
    if (!jathagamBox) return;
    jathagamBox.innerHTML =
      '<svg class="icon icon-lg" style="color:var(--green);"><use href="#i-shield-check"></use></svg>' +
      '<p><b>' + String(name).replace(/</g, '&lt;').slice(0, 48) + '</b>' +
      (size ? ' &middot; ' + size : '') + '</p>' +
      '<button type="button" class="btn-outline-wide" id="chooseJathagamBtn">' +
      t('Change file', 'கோப்பை மாற்று', 'ఫైల్ మార్చు') + '</button>';
    bindChooseJathagam();
  }

  function renderPhotoPreview(url) {
    if (!photoBox) return;
    photoBox.innerHTML =
      '<img src="' + url + '" alt="" ' +
      'style="width:110px;height:110px;object-fit:cover;border-radius:12px;margin:0 auto 12px;display:block;">' +
      '<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">' +
        '<button type="button" class="btn-outline-wide" id="choosePhotoBtn" style="width:auto;padding:10px 18px;">' +
          t('Change Photo', 'படத்தை மாற்று', 'ఫోటో మార్చు') + '</button>' +
        '<button type="button" class="btn-outline-wide" id="removePhotoBtn" ' +
          'style="width:auto;padding:10px 18px;color:#a33;border-color:#e6c9c9;">' +
          t('Remove Photo', 'படத்தை நீக்கு', 'ఫోటో తీసివేయి') + '</button>' +
      '</div>';
    bindChoose();
    const rm = $('removePhotoBtn');
    if (rm) rm.addEventListener('click', clearPhoto);
  }

  function renderPhotoEmpty() {
    if (!photoBox) return;
    photoBox.innerHTML =
      '<svg class="icon icon-lg" style="color:var(--gold);"><use href="#i-user"></use></svg>' +
      '<p>' + t('Upload a clear, recent photo (JPG or PNG, max 5MB). Optional — a profile works without one.',
                'தெளிவான, சமீபத்திய படம் (JPG/PNG, அதிகபட்சம் 5MB). விருப்பமானது.',
                'స్పష్టమైన ఇటీవలి ఫోటో (JPG/PNG, గరిష్టంగా 5MB). ఐచ్ఛికం.') + '</p>' +
      '<button type="button" class="btn-outline-wide" id="choosePhotoBtn">' +
      t('Choose File', 'கோப்பைத் தேர்ந்தெடு', 'ఫైల్ ఎంచుకోండి') + '</button>';
    bindChoose();
  }

  function clearPhoto() {
    pickedFile = null;
    if (fileInput) fileInput.value = '';
    // If a photo was already saved, mark it for removal when they next save.
    if (existingPhotoPath) removePhoto = true;
    renderPhotoEmpty();
    showToast(existingPhotoPath
      ? t('Photo will be removed when you save.', 'சேமிக்கும்போது படம் நீக்கப்படும்.', 'సేవ్ చేసినప్పుడు ఫోటో తీసివేయబడుతుంది.')
      : t('Photo removed.', 'படம் நீக்கப்பட்டது.', 'ఫోటో తీసివేయబడింది.'));
  }

  // ---------- prefill ----------
  (async function prefill() {
    const { data: s } = await supabaseClient.auth.getSession();
    const session = s && s.session;
    if (!session) { window.location.href = 'login.html'; return; }

    renderChips();
    fillShell();

    const { data: existing } = await supabaseClient
      .from('parent_profiles').select('*')
      .eq('parent_user_id', session.user.id).maybeSingle();

    if (!existing) {
      // Seed the contact box with whatever they signed in with, if it was a phone.
      if (F.contact && session.user.phone) F.contact.value = session.user.phone;
      updateMeter();
      return;
    }

    hasProfile = true;
    currentStatus = existing.status || 'draft';
    existingPhotoPath = existing.photo_path || null;

    setRole(existing.created_for || 'son');
    F.fullName.value     = existing.full_name || '';
    F.dob.value          = existing.dob || '';
    F.height.value       = existing.height || '';
    // New profiles store city/state/country separately; older ones only have
    // the single native_place string, so split that back into the boxes.
    if (existing.city || existing.state || existing.country) {
      F.city.value    = existing.city || '';
      F.state.value   = existing.state || '';
      F.country.value = existing.country || '';
    } else {
      const parts = String(existing.native_place || '').split(',').map((s) => s.trim());
      F.city.value    = parts[0] || '';
      F.state.value   = parts[1] || '';
      F.country.value = parts[2] || '';
    }
    if (F.contact)  F.contact.value  = existing.contact_phone || '';
    if (F.marital)  F.marital.value  = existing.marital_status || '';
    if (F.gotram)   F.gotram.value   = existing.gotram || '';
    F.nakshatra.value    = existing.nakshatra || '';
    F.rasi.value         = existing.rasi || '';
    F.gunas.value        = existing.horoscope_gunas || '';
    F.education.value    = existing.education || '';
    F.profession.value   = existing.profession || '';
    if (F.income)   F.income.value   = existing.income_lpa != null ? existing.income_lpa : '';
    F.workLocation.value = existing.work_location || '';
    if (F.about)    F.about.value    = existing.about || '';

    (existing.interests || []).forEach((i) => chosenInterests.add(i));
    renderChips();

    existingJathagamPath = existing.jathagam_path || null;
    if (existingJathagamPath) {
      renderJathagam(existingJathagamPath.split('/').pop(), '');
    }

    if (existingPhotoPath) {
      try {
        const { data } = await supabaseClient.storage
          .from('profile-photos').createSignedUrl(existingPhotoPath, 3600);
        if (data && data.signedUrl) renderPhotoPreview(data.signedUrl);
      } catch (e) { /* the form works fine without the preview */ }
    }

    const h1 = document.querySelector('.s3-main h1');
    if (h1) {
      h1.textContent = t('Edit Profile', 'சுயவிவரத்தைத் திருத்து', 'ప్రొఫైల్ సవరించు');
      h1.removeAttribute('data-i18n');
    }
    if (deleteBtn) deleteBtn.hidden = false;
    updateMeter();
  })();

  // ---------- save ----------
  async function save(publish) {
    const btn = publish ? publishBtn : draftBtn;
    const original = btn.textContent;

    if (publish && !isComplete()) {
      showToast(t('Fill the starred fields before publishing.',
        'நட்சத்திரக் குறியிட்ட புலங்களை நிரப்பவும்.',
        'నక్షత్రం ఉన్న ఫీల్డ్‌లు నింపండి.'));
      updateMeter();
      const first = REQUIRED.find((r) => !r[1]());
      const el = first && F[first[0]];
      if (el) { el.focus(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      return;
    }

    btn.disabled = true;
    if (draftBtn) draftBtn.disabled = true;
    if (publishBtn) publishBtn.disabled = true;
    btn.textContent = t('Saving…', 'சேமிக்கிறது…', 'సేవ్ చేస్తోంది…');

    const { data: s } = await supabaseClient.auth.getSession();
    const session = s && s.session;
    if (!session) { window.location.href = 'login.html'; return; }
    const userId = session.user.id;

    // ---- photo and jathagam go to the PRIVATE bucket; we keep only paths ----
    let newPath = null;
    let newJathagamPath = null;
    try {
      if (pickedFile) {
        const ext = (pickedFile.name.split('.').pop() || 'jpg').toLowerCase();
        newPath = userId + '/photo-' + Date.now() + '.' + ext;
        const up = await supabaseClient.storage
          .from('profile-photos').upload(newPath, pickedFile, { upsert: true, cacheControl: '3600' });
        if (up.error) throw up.error;
      }
      if (pickedJathagam) {
        const jext = (pickedJathagam.name.split('.').pop() || 'pdf').toLowerCase();
        newJathagamPath = userId + '/jathagam-' + Date.now() + '.' + jext;
        const jup = await supabaseClient.storage
          .from('profile-photos').upload(newJathagamPath, pickedJathagam, { upsert: true, cacheControl: '3600' });
        if (jup.error) throw jup.error;
      }
    } catch (err) {
      btn.textContent = original;
      if (draftBtn) draftBtn.disabled = false;
      if (publishBtn) publishBtn.disabled = false;
      showToast(t('Photo upload failed: ', 'படம் பதிவேற்ற முடியவில்லை: ', 'ఫోటో అప్‌లోడ్ విఫలమైంది: ') +
        (err.message || err));
      return;
    }

    const incomeNum = F.income && F.income.value !== '' ? parseFloat(F.income.value) : null;
    const activeToggle = document.querySelector('.cp-toggle-btn.active');
    const profile = {
      parent_user_id:  userId,
      created_for:     (activeToggle && activeToggle.dataset.role) || 'son',
      full_name:       val(F.fullName),
      dob:             val(F.dob) || null,
      height:          val(F.height),
      city:            val(F.city),
      state:           val(F.state) || null,
      country:         val(F.country) || null,
      native_place:    composePlace(),
      contact_phone:   digits(val(F.contact)),
      marital_status:  val(F.marital) || null,
      gotram:          val(F.gotram),
      nakshatra:       val(F.nakshatra),
      rasi:            val(F.rasi),
      horoscope_gunas: val(F.gunas),
      education:       val(F.education),
      profession:      val(F.profession),
      income_lpa:      Number.isFinite(incomeNum) ? incomeNum : null,
      annual_income:   Number.isFinite(incomeNum) ? ('₹' + incomeNum + ' LPA') : '',
      work_location:   val(F.workLocation),
      about:           val(F.about) || null,
      interests:       [...chosenInterests],
      status:          publish ? 'published' : 'draft',
      visible:         !!publish
    };
    if (newPath) {
      profile.photo_path = newPath;
      profile.photo_url = null;   // v1 stored a public URL; the bucket is private now
    }
    if (newJathagamPath) profile.jathagam_path = newJathagamPath; else if (removePhoto) {
      profile.photo_path = null;
      profile.photo_url = null;
    }

    const { error } = await supabaseClient
      .from('parent_profiles').upsert(profile, { onConflict: 'parent_user_id' });

    if (error) {
      btn.textContent = original;
      if (draftBtn) draftBtn.disabled = false;
      if (publishBtn) publishBtn.disabled = false;
      showToast(t('Could not save: ', 'சேமிக்க முடியவில்லை: ', 'సేవ్ చేయలేకపోయాము: ') + error.message);
      return;
    }

    // Replaced or removed the photo? Clear the old file out of storage.
    if (existingPhotoPath && (removePhoto || (newPath && existingPhotoPath !== newPath))) {
      try { await supabaseClient.storage.from('profile-photos').remove([existingPhotoPath]); } catch (e) {}
      existingPhotoPath = null;
    }
    if (newPath) existingPhotoPath = newPath;
    // Same for a replaced jathagam — don't leave the old copy behind.
    if (newJathagamPath && existingJathagamPath && existingJathagamPath !== newJathagamPath) {
      try { await supabaseClient.storage.from('profile-photos').remove([existingJathagamPath]); } catch (e) {}
    }
    if (newJathagamPath) existingJathagamPath = newJathagamPath;
    removePhoto = false;
    pickedFile = null;
    pickedJathagam = null;
    hasProfile = true;
    currentStatus = profile.status;

    if (publish) {
      // Land on My Profile, so the first thing they see after saving is the
      // profile they just created, with its Edit and Delete controls.
      window.location.href = 'dashboard.html#myprofile';
    } else {
      btn.textContent = original;
      if (draftBtn) draftBtn.disabled = false;
      if (publishBtn) publishBtn.disabled = false;
      if (deleteBtn) deleteBtn.hidden = false;
      showToast(t('Saved as a draft. Nobody can see it until you publish.',
        'வரைவாக சேமிக்கப்பட்டது. வெளியிடும் வரை யாரும் பார்க்க முடியாது.',
        'డ్రాఫ్ట్‌గా సేవ్ అయింది. ప్రచురించే వరకు ఎవరూ చూడలేరు.'));
      updateMeter();
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); save(true); });
  if (draftBtn) draftBtn.addEventListener('click', () => save(false));

  // ---------- delete ----------
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      const answer = await askDeleteReason();
      if (!answer) return;
      deleteBtn.disabled = true;
      try {
        const files = [existingPhotoPath, existingJathagamPath].filter(Boolean);
        if (files.length) {
          try { await supabaseClient.storage.from('profile-photos').remove(files); } catch (e) {}
        }
        const { error } = await supabaseClient.rpc('delete_my_profile', {
          p_reason: answer.reason, p_details: answer.details
        });
        if (error) throw error;
        showToast(t('Profile deleted.', 'நீக்கப்பட்டது.', 'తొలగించబడింది.'));
        setTimeout(() => { window.location.href = 'dashboard.html'; }, 900);
      } catch (err) {
        showToast(err.message || String(err));
        deleteBtn.disabled = false;
      }
    });
  }

  updateMeter();
})();
