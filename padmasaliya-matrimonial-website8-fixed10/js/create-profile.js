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
    nativePlace:  $('f_nativePlace'),
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
  let existingPhotoPath = null;
  let currentStatus = 'draft';
  let hasProfile = false;
  const chosenInterests = new Set();

  function t(en, ta, te) {
    return currentLang === 'ta' ? ta : currentLang === 'te' ? te : en;
  }

  const val = (el) => (el && el.value ? el.value.trim() : '');

  // ---------- interests ----------
  const INTEREST_LIST = [
    'Music', 'Cooking', 'Reading', 'Travel', 'Temple visits', 'Classical dance',
    'Cricket', 'Gardening', 'Photography', 'Movies', 'Yoga', 'Volunteering'
  ];

  function renderChips() {
    if (!chipRow) return;
    chipRow.innerHTML = INTEREST_LIST.map((i) =>
      '<button type="button" class="cp-chip' + (chosenInterests.has(i) ? ' on' : '') +
      '" data-interest="' + i + '">' + i + '</button>').join('');
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

  // ---------- completeness meter ----------
  // Same six fields, same order, as the is_complete column in the database.
  const REQUIRED = [
    ['fullName',    () => val(F.fullName).length > 1,    () => t('Full name', 'முழு பெயர்', 'పూర్తి పేరు')],
    ['dob',         () => !!val(F.dob),                  () => t('Date of birth', 'பிறந்த தேதி', 'పుట్టిన తేదీ')],
    ['gotram',      () => !!val(F.gotram),               () => t('Gotram', 'கோத்திரம்', 'గోత్రం')],
    ['nativePlace', () => !!val(F.nativePlace),          () => t('Native place', 'சொந்த ஊர்', 'స్వస్థలం')],
    ['profession',  () => !!val(F.profession),           () => t('Profession', 'தொழில்', 'వృత్తి')],
    ['contact',     () => digits(val(F.contact)).length >= 6, () => t('Contact number', 'தொடர்பு எண்', 'సంప్రదింపు నంబర్')]
  ];

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
      renderPhotoPreview(URL.createObjectURL(f));
    });
  }

  function renderPhotoPreview(url) {
    if (!photoBox) return;
    photoBox.innerHTML =
      '<img src="' + url + '" alt="" ' +
      'style="width:110px;height:110px;object-fit:cover;border-radius:12px;margin:0 auto 12px;display:block;">' +
      '<button type="button" class="btn-outline-wide" id="choosePhotoBtn">' +
      t('Change Photo', 'படத்தை மாற்று', 'ఫోటో మార్చు') + '</button>';
    bindChoose();
  }

  // ---------- prefill ----------
  (async function prefill() {
    const { data: s } = await supabaseClient.auth.getSession();
    const session = s && s.session;
    if (!session) { window.location.href = 'login.html'; return; }

    renderChips();

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
    F.nativePlace.value  = existing.native_place || '';
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

    // ---- photo goes to the PRIVATE bucket; we keep only the path ----
    let newPath = null;
    try {
      if (pickedFile) {
        const ext = (pickedFile.name.split('.').pop() || 'jpg').toLowerCase();
        newPath = userId + '/photo-' + Date.now() + '.' + ext;
        const up = await supabaseClient.storage
          .from('profile-photos').upload(newPath, pickedFile, { upsert: true, cacheControl: '3600' });
        if (up.error) throw up.error;
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
      native_place:    val(F.nativePlace),
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

    const { error } = await supabaseClient
      .from('parent_profiles').upsert(profile, { onConflict: 'parent_user_id' });

    if (error) {
      btn.textContent = original;
      if (draftBtn) draftBtn.disabled = false;
      if (publishBtn) publishBtn.disabled = false;
      showToast(t('Could not save: ', 'சேமிக்க முடியவில்லை: ', 'సేవ్ చేయలేకపోయాము: ') + error.message);
      return;
    }

    // Replaced the photo? Clear the old file out of storage.
    if (newPath && existingPhotoPath && existingPhotoPath !== newPath) {
      try { await supabaseClient.storage.from('profile-photos').remove([existingPhotoPath]); } catch (e) {}
    }
    if (newPath) existingPhotoPath = newPath;
    pickedFile = null;
    hasProfile = true;
    currentStatus = profile.status;

    if (publish) {
      window.location.href = 'dashboard.html';
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
      const ok = window.confirm(t(
        'Delete this profile for good? The photo and every interest connected to it go too. This cannot be undone.',
        'இந்த சுயவிவரத்தை நிரந்தரமாக நீக்கவா? திரும்பப் பெற முடியாது.',
        'ఈ ప్రొఫైల్‌ను శాశ్వతంగా తొలగించాలా? తిరిగి పొందలేరు.'));
      if (!ok) return;
      deleteBtn.disabled = true;
      try {
        if (existingPhotoPath) {
          try { await supabaseClient.storage.from('profile-photos').remove([existingPhotoPath]); } catch (e) {}
        }
        const { error } = await supabaseClient.rpc('delete_my_profile', {});
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
