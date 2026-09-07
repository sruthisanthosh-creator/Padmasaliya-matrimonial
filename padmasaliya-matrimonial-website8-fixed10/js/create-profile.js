// ---- Create / edit the profile a parent is publishing ----
// Requires: supabase-client.js and main.js loaded first.

(function () {
  const form = document.getElementById('profileForm');
  if (!form) return;

  const fileInput = document.getElementById('photoInput');
  const photoBox = document.querySelector('.cp-photo-upload');
  const chooseBtn = document.getElementById('choosePhotoBtn');
  let pickedFile = null;
  let existingId = null;

  const F = {
    fullName: document.getElementById('f_fullName'),
    dob: document.getElementById('f_dob'),
    height: document.getElementById('f_height'),
    nativePlace: document.getElementById('f_nativePlace'),
    gotram: document.getElementById('f_gotram'),
    nakshatra: document.getElementById('f_nakshatra'),
    rasi: document.getElementById('f_rasi'),
    gunas: document.getElementById('f_gunas'),
    education: document.getElementById('f_education'),
    profession: document.getElementById('f_profession'),
    income: document.getElementById('f_income'),
    workLocation: document.getElementById('f_workLocation')
  };

  function setRole(role) {
    document.querySelectorAll('.cp-toggle-btn').forEach(x =>
      x.classList.toggle('active', x.dataset.role === role));
  }

  // ---- photo picker ----
  if (chooseBtn && fileInput) {
    chooseBtn.addEventListener('click', () => fileInput.click());
  }
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (!f) return;
      if (!/^image\/(jpe?g|png|webp)$/i.test(f.type)) {
        showToast('Please choose a JPG, PNG or WEBP image');
        fileInput.value = '';
        return;
      }
      if (f.size > 5 * 1024 * 1024) {
        showToast('Image is larger than 5MB');
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
      '<img src="' + url + '" alt="Selected photo" ' +
      'style="width:110px;height:110px;object-fit:cover;border-radius:12px;margin:0 auto 12px;display:block;">' +
      '<button type="button" class="btn-outline-wide" id="choosePhotoBtn">Change Photo</button>';
    document.getElementById('choosePhotoBtn').addEventListener('click', () => fileInput.click());
  }

  document.querySelectorAll('.cp-toggle-btn').forEach(b => {
    b.addEventListener('click', () => setRole(b.dataset.role));
  });

  // ---- prefill if this parent already has a profile ----
  (async function prefill() {
    const { data: s } = await supabaseClient.auth.getSession();
    const userId = s?.session?.user?.id;
    if (!userId) { window.location.href = 'login.html'; return; }

    const { data: existing } = await supabaseClient
      .from('parent_profiles')
      .select('*')
      .eq('parent_user_id', userId)
      .maybeSingle();

    if (!existing) return;
    existingId = existing.id;
    setRole(existing.created_for || 'son');
    F.fullName.value = existing.full_name || '';
    F.dob.value = existing.dob || '';
    F.height.value = existing.height || '';
    F.nativePlace.value = existing.native_place || '';
    if (F.gotram) F.gotram.value = existing.gotram || '';
    F.nakshatra.value = existing.nakshatra || '';
    F.rasi.value = existing.rasi || '';
    F.gunas.value = existing.horoscope_gunas || '';
    F.education.value = existing.education || '';
    F.profession.value = existing.profession || '';
    F.income.value = existing.annual_income || '';
    F.workLocation.value = existing.work_location || '';
    if (existing.photo_url) renderPhotoPreview(existing.photo_url);

    const h1 = document.querySelector('.s3-main h1');
    if (h1) h1.textContent = 'Edit Profile';
  })();

  // ---- save ----
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    const { data: s } = await supabaseClient.auth.getSession();
    const session = s?.session;
    if (!session) { window.location.href = 'login.html'; return; }
    const userId = session.user.id;

    let photoUrl = null;
    try {
      if (pickedFile) {
        const ext = (pickedFile.name.split('.').pop() || 'jpg').toLowerCase();
        const path = userId + '/photo-' + Date.now() + '.' + ext;
        const up = await supabaseClient.storage
          .from('profile-photos')
          .upload(path, pickedFile, { upsert: true, cacheControl: '3600' });
        if (up.error) throw up.error;
        photoUrl = supabaseClient.storage.from('profile-photos').getPublicUrl(path).data.publicUrl;
      }
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save & Continue →';
      showToast('Photo upload failed: ' + (err.message || err));
      return;
    }

    const createdFor = document.querySelector('.cp-toggle-btn.active')?.dataset.role || 'son';
    const profile = {
      parent_user_id: userId,
      created_for: createdFor,
      full_name: F.fullName.value.trim(),
      dob: F.dob.value || null,
      height: F.height.value.trim(),
      native_place: F.nativePlace.value.trim(),
      gotram: F.gotram ? F.gotram.value : '',
      nakshatra: F.nakshatra.value.trim(),
      rasi: F.rasi.value.trim(),
      horoscope_gunas: F.gunas.value.trim(),
      education: F.education.value.trim(),
      profession: F.profession.value.trim(),
      annual_income: F.income.value.trim(),
      work_location: F.workLocation.value.trim(),
      contact_phone: session.user.phone || null,
      visible: true
    };
    if (photoUrl) profile.photo_url = photoUrl;

    const { error } = await supabaseClient
      .from('parent_profiles')
      .upsert(profile, { onConflict: 'parent_user_id' });

    submitBtn.disabled = false;
    submitBtn.textContent = 'Save & Continue →';

    if (error) { showToast('Could not save profile: ' + error.message); return; }
    window.location.href = 'dashboard.html';
  });
})();
