// ---- Parents dashboard ----------------------------------------------------
// Every read goes through a database function (search_profiles, get_profile,
// my_*) instead of selecting from parent_profiles directly. Those functions
// decide, per caller, which fields come back. So the code below never has to
// "hide" a premium field: on a free account the field arrives as null and
// there is nothing in the browser to reveal.
//
// Requires: supabase-client.js and main.js loaded first.

(function () {
  'use strict';

  const PAGE = 9;

  // ---------- elements ----------
  const $ = (id) => document.getElementById(id);
  const grid           = $('profileGrid');
  const listGrid       = $('listGrid');
  const viewSearch     = $('viewSearch');
  const viewList       = $('viewList');
  const viewTitle      = $('viewTitle');
  const viewSub        = $('viewSub');
  const loadMoreBtn    = $('loadMoreBtn');
  const resultCount    = $('resultCount');
  const draftsPanel    = $('draftsPanel');
  const freeNote       = $('freeNote');
  const gateBanner     = $('gateBanner');
  const gateTitle      = $('gateTitle');
  const gateText       = $('gateText');
  const gateMissing    = $('gateMissing');
  const gateBtn        = $('gateBtn');
  const modal          = $('profileModal');
  const pmBody         = $('pmBody');
  const bellBtn        = $('bellBtn');
  const bellDot        = $('bellDot');
  const notifPop       = $('notifPop');
  const notifList      = $('notifList');
  const bottomStats    = document.querySelector('.s3-bottom-stats');

  const F = {
    looking:    $('filterLooking'),
    gotram:     $('filterGotram'),
    keyword:    $('searchKeyword'),
    income:     $('filterIncome'),
    profession: $('filterProfession'),
    place:      $('filterPlace'),
    minAge:     $('filterMinAge'),
    maxAge:     $('filterMaxAge'),
    onlyPhoto:  $('filterOnlyPhoto')
  };

  if (!grid) return;

  // ---------- state ----------
  let me = null;
  let status = null;          // whatever my_status() last returned
  let view = 'search';
  let offset = 0;
  let total = 0;
  let busy = false;
  const photoCache = new Map();   // storage path -> signed url

  // ---------- small helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function t(en, ta, te) {
    return currentLang === 'ta' ? ta : currentLang === 'te' ? te : en;
  }

  const icon = (name, cls) =>
    '<svg class="icon' + (cls ? ' ' + cls : '') + '"><use href="#i-' + name + '"></use></svg>';

  function fmtDate(d) {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function ago(d) {
    const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return t('just now', 'இப்போது', 'ఇప్పుడే');
    if (s < 3600) return Math.floor(s / 60) + t('m ago', ' நிமிடம்', ' నిమి');
    if (s < 86400) return Math.floor(s / 3600) + t('h ago', ' மணி', ' గం');
    return fmtDate(d);
  }

  // Turns a Postgres error into something a parent can act on.
  function explain(error) {
    const m = String((error && error.message) || '');
    if (m.includes('PROFILE_INCOMPLETE'))
      return t('Finish your own profile first.', 'முதலில் உங்கள் சுயவிவரத்தை பூர்த்தி செய்யுங்கள்.', 'ముందుగా మీ ప్రొఫైల్ పూర్తి చేయండి.');
    if (m.includes('DAILY_LIMIT'))
      return t('You have reached today’s interest limit. Premium raises it to 40 a day.',
               'இன்றைய வரம்பை எட்டிவிட்டீர்கள். பிரீமியத்தில் நாளொன்றுக்கு 40.',
               'నేటి పరిమితి ముగిసింది. ప్రీమియంలో రోజుకు 40.');
    if (m.includes('CANNOT_INTEREST_SELF'))
      return t('That is your own profile.', 'இது உங்கள் சொந்த சுயவிவரம்.', 'ఇది మీ స్వంత ప్రొఫైల్.');
    if (m.includes('BAD_CODE'))       return t('That code is not valid.', 'குறியீடு தவறு.', 'కోడ్ చెల్లదు.');
    if (m.includes('CODE_EXPIRED'))   return t('That code has expired.', 'குறியீடு காலாவதியானது.', 'కోడ్ గడువు ముగిసింది.');
    if (m.includes('CODE_USED_UP'))   return t('That code has already been used.', 'குறியீடு ஏற்கனவே பயன்படுத்தப்பட்டது.', 'కోడ్ ఇప్పటికే ఉపయోగించారు.');
    if (m.includes('ALREADY_REDEEMED'))return t('You have already used this code.', 'நீங்கள் ஏற்கனவே பயன்படுத்திவிட்டீர்கள்.', 'మీరు ఇప్పటికే ఉపయోగించారు.');
    if (m.includes('BAD_CONTACT'))    return t('Enter a valid 10-digit mobile number.', 'சரியான 10 இலக்க எண்.', 'సరైన 10 అంకెల నంబర్.');
    if (m.includes('NOT_FOUND'))      return t('That profile is no longer available.', 'சுயவிவரம் இல்லை.', 'ప్రొఫైల్ అందుబాటులో లేదు.');
    if (m.includes('AUTH_REQUIRED'))  return t('Please sign in again.', 'மீண்டும் உள்நுழையவும்.', 'మళ్లీ సైన్ ఇన్ చేయండి.');
    return m || t('Something went wrong.', 'ஏதோ தவறு.', 'ఏదో తప్పు జరిగింది.');
  }

  async function rpc(fn, args) {
    const { data, error } = await supabaseClient.rpc(fn, args || {});
    if (error) throw error;
    return data;
  }

  // Photos live in a PRIVATE bucket now. The database only hands out a
  // photo_path to someone allowed to see it; we swap it for a short-lived
  // signed URL here. A free account gets photo_path = null, so this loop
  // simply has nothing to sign.
  async function signPhotos(rows) {
    const want = [...new Set(
      rows.map((r) => (r && r.photo_path) || null).filter((p) => p && !photoCache.has(p))
    )];
    if (!want.length) return;
    try {
      const { data } = await supabaseClient.storage
        .from('profile-photos').createSignedUrls(want, 3600);
      (data || []).forEach((d) => {
        if (d && d.signedUrl) photoCache.set(d.path, d.signedUrl);
      });
    } catch (e) { /* photos are cosmetic — never block the list on them */ }
  }

  // ---------- identity in the header ----------
  function setIdentity() {
    const p = status && status.profile;
    const name = (p && p.full_name)
      ? t('Parent of ', 'பெற்றோர்: ', 'తల్లిదండ్రులు: ') + p.full_name.split(' ')[0]
      : (me && (me.email || (me.phone && '+' + me.phone))) || t('Parent Account', 'பெற்றோர் கணக்கு', 'తల్లిదండ్రుల ఖాతా');
    const initials = String(name).replace(/[^A-Za-z ]/g, '').trim().split(/\s+/)
      .slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || 'PP';
    document.querySelectorAll('.s3-avatar').forEach((el) => { el.textContent = initials; });
    document.querySelectorAll('.s3-user > div > b, .s3-side-user > div > b')
      .forEach((el) => { el.textContent = name; });

    const chip = document.querySelector('.s3-side-user .verified-chip span:last-child');
    if (chip) {
      chip.textContent = status && status.premium
        ? t('Premium member', 'பிரீமியம் உறுப்பினர்', 'ప్రీమియం సభ్యుడు')
        : t('Free plan', 'இலவச திட்டம்', 'ఉచిత ప్లాన్');
    }
  }

  // ---------- profile card ----------
  function cardHtml(p, opts) {
    opts = opts || {};
    const locked = !!p.locked;
    const photo = p.photo_path && photoCache.get(p.photo_path);
    const bits = [
      p.age ? p.age + ' ' + t('yrs', 'வயது', 'ఏళ్లు') : null,
      p.gotram ? p.gotram + ' ' + t('Gotram', 'கோத்திரம்', 'గోత్రం') : null,
      p.native_place
    ].filter(Boolean).join(' • ');

    const photoInner = photo
      ? '<img src="' + esc(photo) + '" alt="" style="width:100%;height:100%;object-fit:cover;">'
      : icon('user', 'icon-lg');

    const lockTag = locked
      ? '<span class="tag-locked">' + icon('lock') + ' ' +
        (p.has_photo ? t('Photo with Premium', 'படம்: பிரீமியம்', 'ఫోటో: ప్రీమియం')
                     : t('Premium', 'பிரீமியம்', 'ప్రీమియం')) + '</span>'
      : '';

    // Free plan: the fields simply are not in the payload, so we draw the
    // shape of the information instead of the information.
    const detail = locked
      ? '<div class="locked-line">' + icon('lock') + '<b>&nbsp;Software Engineer&nbsp;</b></div>' +
        '<div class="locked-line">' + icon('lock') + '<b>&nbsp;₹ 00 LPA&nbsp;</b></div>'
      : (p.profession ? '<div class="meta">' + esc(p.profession) + '</div>' : '') +
        (p.work_location ? '<div class="meta">' + esc(p.work_location) + '</div>' : '') +
        (p.annual_income ? '<div class="income">' + esc(p.annual_income) + '</div>' : '');

    const tags = locked ? '' : [p.nakshatra, p.rasi,
      p.horoscope_gunas ? p.horoscope_gunas + ' ' + t('Gunas', 'குணங்கள்', 'గుణాలు') : null]
      .filter(Boolean).map((x) => '<span>' + esc(x) + '</span>').join('');

    const sent = p.interest;
    const heartTitle = sent
      ? t('Interest already sent', 'ஆர்வம் அனுப்பப்பட்டது', 'ఆసక్తి పంపబడింది')
      : t('Send interest', 'ஆர்வம் அனுப்பு', 'ఆసక్తి పంపండి');

    const statusPill = opts.pill
      ? '<span class="pill pill-' + opts.pill + '">' + esc(opts.pillText || opts.pill) + '</span> '
      : '';

    return '' +
      '<div class="profile-card" data-id="' + esc(p.id) + '">' +
        '<div class="profile-photo' + (locked ? ' is-locked' : '') + '" data-act="open">' + photoInner +
          '<span class="tag-idv">' + icon('shield-check') + ' ' +
            t('Community verified', 'சமூக சரிபார்ப்பு', 'సమాజ ధృవీకరణ') + '</span>' + lockTag +
          '<span class="heart" data-act="interest" title="' + esc(heartTitle) + '" ' +
            'style="' + (sent ? 'color:#c0392b;' : '') + '">' +
            icon(sent ? 'heart-fill' : 'heart') + '</span>' +
        '</div>' +
        '<div class="profile-body">' +
          '<h4 data-act="open" style="cursor:pointer;">' + statusPill +
            esc(p.full_name || t('Padmasaliya Profile', 'சுயவிவரம்', 'ప్రొఫైల్')) + '</h4>' +
          (bits ? '<div class="meta">' + esc(bits) + '</div>' : '') +
          detail +
          (tags ? '<div class="profile-tags">' + tags + '</div>' : '') +
          (opts.note ? '<div class="meta" style="margin-top:6px;font-style:italic;">' + esc(opts.note) + '</div>' : '') +
          '<div class="profile-actions">' + (opts.actions || defaultActions(p)) + '</div>' +
        '</div>' +
      '</div>';
  }

  function defaultActions(p) {
    return '<button class="btn-ghost" data-act="save"' + (p.saved ? ' data-on="1"' : '') + '>' +
             icon('bookmark') + ' ' + (p.saved
               ? t('Saved', 'சேமித்தது', 'సేవ్ చేసారు')
               : t('Save to Drafts', 'வரைவில் சேமி', 'డ్రాఫ్ట్‌లో సేవ్')) + '</button>' +
           '<button class="btn-solid" data-act="recommend"' + (p.recommended ? ' data-on="1"' : '') + '>' +
             icon('send') + ' ' + (p.recommended
               ? t('Recommended', 'பரிந்துரைத்தது', 'సిఫార్సు చేసారు')
               : t('Recommend to Child', 'பிள்ளைக்கு பரிந்துரை', 'పిల్లలకు సిఫార్సు')) + '</button>';
  }

  function emptyState(iconName, title, body) {
    return '<div class="empty-state">' + icon(iconName, 'icon-lg') +
      '<b>' + esc(title) + '</b><p>' + esc(body) + '</p></div>';
  }

  // ---------- the gate ----------
  const FIELD_LABELS = () => ({
    full_name:     t('Full name', 'முழு பெயர்', 'పూర్తి పేరు'),
    dob:           t('Date of birth', 'பிறந்த தேதி', 'పుట్టిన తేదీ'),
    gotram:        t('Gotram', 'கோத்திரம்', 'గోత్రం'),
    native_place:  t('Native place', 'சொந்த ஊர்', 'స్వస్థలం'),
    profession:    t('Profession', 'தொழில்', 'వృత్తి'),
    contact_phone: t('Contact number', 'தொடர்பு எண்', 'సంప్రదింపు నంబర్')
  });

  function renderGate() {
    if (!gateBanner) return;
    const ok = status && status.can_browse;
    gateBanner.hidden = !!ok;
    if (bottomStats) bottomStats.hidden = !ok;
    if (ok) return;

    const labels = FIELD_LABELS();
    const missing = (status && status.missing) || [];
    const draftOnly = status && status.has_profile && status.complete && !status.published;

    if (draftOnly) {
      gateTitle.textContent = t('Your profile is still a draft',
        'உங்கள் சுயவிவரம் வரைவாக உள்ளது', 'మీ ప్రొఫైల్ ఇంకా డ్రాఫ్ట్‌లో ఉంది');
      gateText.textContent = t(
        'Publish it and you can browse every other family straight away. Nobody sees your details until you publish.',
        'வெளியிட்டால் உடனே மற்ற குடும்பங்களைப் பார்க்கலாம். வெளியிடும் வரை உங்கள் விவரங்கள் யாருக்கும் தெரியாது.',
        'ప్రచురిస్తే వెంటనే ఇతర కుటుంబాలను చూడవచ్చు. అప్పటివరకు మీ వివరాలు ఎవరికీ కనిపించవు.');
      gateMissing.innerHTML = '';
      gateBtn.textContent = t('Publish my profile', 'சுயவிவரத்தை வெளியிடு', 'ప్రొఫైల్ ప్రచురించు');
      gateBtn.dataset.act = 'publish';
    } else {
      gateTitle.textContent = status && status.has_profile
        ? t('A few details are still missing', 'சில விவரங்கள் விடுபட்டுள்ளன', 'కొన్ని వివరాలు మిగిలి ఉన్నాయి')
        : t('Create your profile to start browsing', 'உலாவ சுயவிவரம் உருவாக்கவும்', 'బ్రౌజ్ చేయడానికి ప్రొఫైల్ సృష్టించండి');
      gateText.textContent = t(
        'Families are only shown to a completed, published profile — the same rule keeps your daughter’s or son’s details away from anyone who has not filled theirs in.',
        'பூர்த்தி செய்யப்பட்ட சுயவிவரத்திற்கு மட்டுமே மற்ற குடும்பங்கள் காட்டப்படும் — இதே விதி உங்கள் பிள்ளையின் விவரங்களையும் பாதுகாக்கிறது.',
        'పూర్తయిన ప్రొఫైల్‌కు మాత్రమే ఇతర కుటుంబాలు కనిపిస్తాయి — అదే నియమం మీ పిల్లల వివరాలను కూడా కాపాడుతుంది.');
      gateMissing.innerHTML = missing.map((k) =>
        '<span>' + esc(labels[k] || k) + '</span>').join('');
      gateBtn.textContent = status && status.has_profile
        ? t('Finish my profile →', 'சுயவிவரத்தை முடி →', 'ప్రొఫైల్ పూర్తి చేయి →')
        : t('Create my profile →', 'சுயவிவரம் உருவாக்கு →', 'ప్రొఫైల్ సృష్టించు →');
      gateBtn.dataset.act = 'create';
    }
  }

  if (gateBtn) {
    gateBtn.addEventListener('click', async () => {
      if (gateBtn.dataset.act === 'publish') {
        gateBtn.disabled = true;
        try {
          await rpc('set_profile_status', { p_status: 'published' });
          showToast(t('Your profile is live.', 'உங்கள் சுயவிவரம் நேரலையில்.', 'మీ ప్రొఫైల్ లైవ్‌లో ఉంది.'));
          await refreshStatus();
          go('search');
        } catch (e) { showToast(explain(e)); }
        gateBtn.disabled = false;
      } else {
        window.location.href = 'create-profile.html';
      }
    });
  }

  // ---------- search ----------
  function filterArgs() {
    const num = (el) => {
      const v = el && parseInt(el.value, 10);
      return Number.isFinite(v) ? v : null;
    };
    const txt = (el) => {
      const v = el && el.value && el.value.trim();
      return v ? v : null;
    };
    return {
      // "Looking for a bride" means we want daughters' profiles.
      p_looking_for: (F.looking && F.looking.value === 'groom') ? 'son' : 'daughter',
      p_gotram:     txt(F.gotram),
      p_keyword:    txt(F.keyword),
      p_profession: txt(F.profession),
      p_place:      txt(F.place),
      p_min_income: F.income && F.income.value ? parseFloat(F.income.value) : null,
      p_min_age:    num(F.minAge),
      p_max_age:    num(F.maxAge),
      p_only_photo: !!(F.onlyPhoto && F.onlyPhoto.checked)
    };
  }

  async function runSearch(reset) {
    if (busy) return;
    if (!status || !status.can_browse) {
      grid.innerHTML = '';
      if (resultCount) resultCount.textContent = '';
      if (loadMoreBtn) loadMoreBtn.style.display = 'none';
      if (freeNote) freeNote.hidden = true;
      return;
    }
    busy = true;
    if (reset) { offset = 0; grid.innerHTML = ''; }
    if (loadMoreBtn) loadMoreBtn.disabled = true;

    try {
      const args = Object.assign(filterArgs(), { p_limit: PAGE, p_offset: offset });
      const res = await rpc('search_profiles', args);
      const rows = (res && res.rows) || [];
      total = (res && res.total) || 0;

      await signPhotos(rows);

      if (reset && rows.length === 0) {
        grid.innerHTML = emptyState('search',
          t('No matching profiles yet', 'பொருந்தும் சுயவிவரங்கள் இல்லை', 'సరిపోలే ప్రొఫైల్‌లు లేవు'),
          t('Try clearing a filter, or check back in a few days as more families join.',
            'ஒரு வடிகட்டியை நீக்கிப் பாருங்கள்.',
            'ఒక ఫిల్టర్ తొలగించి చూడండి.'));
      } else {
        grid.insertAdjacentHTML('beforeend', rows.map((p) => cardHtml(p)).join(''));
      }

      offset += PAGE;
      if (resultCount) {
        resultCount.textContent = total.toLocaleString('en-IN') + ' ' +
          t('profiles', 'சுயவிவரங்கள்', 'ప్రొఫైల్‌లు');
      }
      if (loadMoreBtn) {
        const more = offset < total;
        loadMoreBtn.style.display = more ? '' : 'none';
        loadMoreBtn.disabled = !more;
      }
      if (freeNote) freeNote.hidden = !!(res && res.premium);
    } catch (e) {
      if (String(e.message || '').includes('PROFILE_INCOMPLETE')) {
        await refreshStatus();
        renderGate();
      } else {
        grid.innerHTML = emptyState('help',
          t('Could not load profiles', 'சுயவிவரங்களை ஏற்ற முடியவில்லை', 'ప్రొఫైల్‌లు లోడ్ కాలేదు'),
          explain(e));
      }
    }
    busy = false;
  }

  // ---------- the other views ----------
  const VIEWS = {
    search: {
      title: () => t('Find the Right Alliance', 'சரியான உறவைத் தேடுங்கள்', 'సరైన సంబంధాన్ని కనుగొనండి'),
      sub:   () => t('Search & connect with verified Padmasaliya families',
                     'சரிபார்க்கப்பட்ட பத்மசாலிய குடும்பங்களுடன் இணையுங்கள்',
                     'ధృవీకరించిన పద్మశాలియ కుటుంబాలతో కనెక్ట్ అవ్వండి')
    },
    drafts: {
      title: () => t('Drafts (Saved)', 'வரைவுகள்', 'డ్రాఫ్ట్‌లు'),
      sub:   () => t('Profiles you bookmarked to decide on later',
                     'பின்னர் முடிவெடுக்க சேமித்தவை', 'తర్వాత నిర్ణయించడానికి సేవ్ చేసినవి'),
      load: async () => {
        const rows = await rpc('my_saved_profiles', {});
        await signPhotos(rows);
        return rows.length
          ? rows.map((p) => cardHtml(p, {
              actions: '<button class="btn-ghost" data-act="save" data-on="1">' + icon('bookmark') + ' ' +
                         t('Remove', 'நீக்கு', 'తొలగించు') + '</button>' +
                       '<button class="btn-solid" data-act="open">' + icon('user') + ' ' +
                         t('View', 'பார்', 'చూడు') + '</button>'
            })).join('')
          : emptyState('bookmark',
              t('No saved profiles yet', 'சேமித்தவை இல்லை', 'సేవ్ చేసినవి లేవు'),
              t('Tap "Save to Drafts" on any profile and it waits for you here.',
                'எந்த சுயவிவரத்திலும் "வரைவில் சேமி" அழுத்தவும்.',
                'ఏ ప్రొఫైల్‌లోనైనా "డ్రాఫ్ట్‌లో సేవ్" నొక్కండి.'));
      }
    },
    recommended: {
      title: () => t('Recommended to your child', 'பிள்ளைக்கு பரிந்துரைத்தவை', 'పిల్లలకు సిఫార్సు చేసినవి'),
      sub:   () => t('Profiles you have passed on for your son or daughter to look at',
                     'உங்கள் பிள்ளை பார்ப்பதற்காக அனுப்பியவை',
                     'మీ పిల్లలు చూడటానికి పంపినవి'),
      load: async () => {
        const rows = await rpc('my_recommendations', {});
        await signPhotos(rows);
        return rows.length
          ? rows.map((p) => cardHtml(p, {
              pill: p.seen ? 'accepted' : 'pending',
              pillText: p.seen ? t('Seen', 'பார்த்தார்', 'చూసారు')
                               : t('Waiting', 'காத்திருக்கிறது', 'వేచి ఉంది'),
              note: p.note,
              actions: '<button class="btn-ghost" data-act="unrecommend">' + icon('send') + ' ' +
                         t('Undo', 'நீக்கு', 'తీసివేయి') + '</button>' +
                       '<button class="btn-solid" data-act="open">' + icon('user') + ' ' +
                         t('View', 'பார்', 'చూడు') + '</button>'
            })).join('')
          : emptyState('send',
              t('Nothing recommended yet', 'இன்னும் பரிந்துரை இல்லை', 'ఇంకా సిఫార్సు లేదు'),
              t('When the bride & groom app opens, everything you recommend lands in your child’s inbox.',
                'மணமகன்/மணமகள் செயலி திறந்ததும் இவை உங்கள் பிள்ளைக்கு சேரும்.',
                'వధూవరుల యాప్ ప్రారంభమైనప్పుడు ఇవి మీ పిల్లలకు చేరతాయి.'));
      }
    },
    received: {
      title: () => t('Received interests', 'வந்த ஆர்வங்கள்', 'వచ్చిన ఆసక్తులు'),
      sub:   () => t('Families who have shown interest in your profile',
                     'உங்கள் சுயவிவரத்தில் ஆர்வம் காட்டியவர்கள்',
                     'మీ ప్రొఫైల్‌పై ఆసక్తి చూపినవారు'),
      load: async () => {
        const rows = await rpc('my_received_interests', {});
        await signPhotos(rows.map((r) => r.profile));
        return rows.length
          ? rows.map((r) => cardHtml(r.profile, {
              pill: r.status,
              pillText: r.status === 'pending'  ? t('New', 'புதிது', 'కొత్తది')
                      : r.status === 'accepted' ? t('Accepted', 'ஏற்றது', 'అంగీకరించారు')
                                                : t('Declined', 'நிராகரித்தது', 'తిరస్కరించారు'),
              note: r.message,
              actions: r.status === 'pending'
                ? '<button class="btn-ghost" data-act="decline" data-iid="' + esc(r.interest_id) + '">' +
                    t('Not interested', 'வேண்டாம்', 'వద్దు') + '</button>' +
                  '<button class="btn-solid" data-act="accept" data-iid="' + esc(r.interest_id) + '">' +
                    icon('heart') + ' ' + t('Accept', 'ஏற்கிறேன்', 'అంగీకరించు') + '</button>'
                : '<button class="btn-solid" data-act="open">' + icon('user') + ' ' +
                    t('View profile', 'சுயவிவரம் பார்', 'ప్రొఫైల్ చూడు') + '</button>'
            })).join('')
          : emptyState('heart',
              t('No interests received yet', 'இன்னும் ஆர்வம் இல்லை', 'ఇంకా ఆసక్తులు లేవు'),
              t('When another family sends interest, it appears here and you decide.',
                'மற்றொரு குடும்பம் ஆர்வம் அனுப்பினால் இங்கே தோன்றும்.',
                'మరో కుటుంబం ఆసక్తి పంపితే ఇక్కడ కనిపిస్తుంది.'));
      }
    },
    sent: {
      title: () => t('Sent interests', 'அனுப்பிய ஆர்வங்கள்', 'పంపిన ఆసక్తులు'),
      sub:   () => t('Families you reached out to',
                     'நீங்கள் தொடர்பு கொண்டவர்கள்', 'మీరు సంప్రదించినవారు'),
      load: async () => {
        const rows = await rpc('my_sent_interests', {});
        await signPhotos(rows.map((r) => r.profile));
        return rows.length
          ? rows.map((r) => cardHtml(r.profile, {
              pill: r.status,
              pillText: r.status === 'pending'  ? t('Awaiting reply', 'பதிலுக்காக', 'సమాధానం కోసం')
                      : r.status === 'accepted' ? t('Accepted — contact open', 'ஏற்றது', 'అంగీకరించారు')
                                                : t('Declined', 'நிராகரித்தது', 'తిరస్కరించారు'),
              actions: '<button class="btn-solid" data-act="open">' + icon('user') + ' ' +
                         t('View profile', 'சுயவிவரம் பார்', 'ప్రొఫైల్ చూడు') + '</button>'
            })).join('')
          : emptyState('send',
              t('No interests sent yet', 'ஆர்வம் அனுப்பவில்லை', 'ఆసక్తులు పంపలేదు'),
              t('Tap the heart on any profile to let that family know.',
                'எந்த சுயவிவரத்திலும் இதயத்தை அழுத்தவும்.',
                'ఏ ప్రొఫైల్‌లోనైనా హృదయాన్ని నొక్కండి.'));
      }
    },
    myprofile: {
      title: () => t('My profile', 'என் சுயவிவரம்', 'నా ప్రొఫైల్'),
      sub:   () => t('What other families see, and who can see it',
                     'மற்றவர்கள் பார்ப்பது', 'ఇతరులు చూసేది'),
      load: async () => myProfileHtml()
    },
    subscription: {
      title: () => t('Subscription', 'சந்தா', 'సభ్యత్వం'),
      sub:   () => t('Your plan, and what it opens up', 'உங்கள் திட்டம்', 'మీ ప్లాన్'),
      load: async () => subscriptionHtml()
    },
    settings: {
      title: () => t('Settings', 'அமைப்புகள்', 'సెట్టింగ్‌లు'),
      sub:   () => t('Privacy, visibility and your account', 'தனியுரிமை மற்றும் கணக்கு', 'గోప్యత మరియు ఖాతా'),
      load: async () => settingsHtml()
    }
  };

  function myProfileHtml() {
    const p = status && status.profile;
    if (!p) {
      return '<div class="self-card"><h3>' +
        esc(t('No profile yet', 'சுயவிவரம் இல்லை', 'ప్రొఫైల్ లేదు')) + '</h3><p>' +
        esc(t('Create the profile for your son or daughter to join the community listing.',
              'உங்கள் பிள்ளைக்கான சுயவிவரத்தை உருவாக்குங்கள்.',
              'మీ పిల్లల కోసం ప్రొఫైల్ సృష్టించండి.')) +
        '</p><div class="self-actions"><a class="primary" href="create-profile.html">' +
        icon('plus') + ' ' + esc(t('Create profile', 'உருவாக்கு', 'సృష్టించు')) + '</a></div></div>';
    }
    const live = status.published && status.complete;
    const row = (label, val) => '<div class="pm-row"><label>' + esc(label) + '</label><div>' +
      esc(val || '—') + '</div></div>';

    return '<div class="self-card">' +
      '<h3>' + esc(p.full_name || '') +
        ' <span class="pill pill-' + (live ? 'live' : 'draft') + '">' +
        esc(live ? t('Live in search', 'நேரலையில்', 'లైవ్‌లో')
                 : t('Draft — not visible', 'வரைவு', 'డ్రాఫ్ట్')) + '</span></h3>' +
      '<p>' + esc(live
        ? t('Other completed families can find this profile. They see the free fields; photo, income and your number open only to Premium or to a family whose interest you accept.',
            'மற்ற குடும்பங்கள் இதைக் காணலாம். படம், வருமானம், எண் ஆகியவை பிரீமியத்திற்கு மட்டும்.',
            'ఇతర కుటుంబాలు దీన్ని చూడగలరు. ఫోటో, ఆదాయం, నంబర్ ప్రీమియంకు మాత్రమే.')
        : t('Nobody can see this profile yet. Publish it when you are ready.',
            'இதை இன்னும் யாரும் பார்க்க முடியாது.',
            'దీన్ని ఇంకా ఎవరూ చూడలేరు.')) + '</p>' +
      '<div class="pm-rows">' +
        row(t('Profile for', 'யாருக்காக', 'ఎవరికోసం'),
            p.created_for === 'son' ? t('My son', 'என் மகன்', 'నా కుమారుడు')
                                    : t('My daughter', 'என் மகள்', 'నా కుమార్తె')) +
        row(t('Age', 'வயது', 'వయస్సు'), p.age) +
        row(t('Gotram', 'கோத்திரம்', 'గోత్రం'), p.gotram) +
        row(t('Native place', 'சொந்த ஊர்', 'స్వస్థలం'), p.native_place) +
        row(t('Profession', 'தொழில்', 'వృత్తి'), p.profession) +
        row(t('Annual income', 'ஆண்டு வருமானம்', 'వార్షిక ఆదాయం'), p.annual_income) +
        row(t('Contact', 'தொடர்பு', 'సంప్రదింపు'), p.contact_phone) +
      '</div>' +
      '<div class="self-actions">' +
        '<a class="primary" href="create-profile.html">' + icon('gear') + ' ' +
          esc(t('Edit profile', 'திருத்து', 'సవరించు')) + '</a>' +
        '<button data-self="' + (live ? 'unpublish' : 'publish') + '">' +
          icon(live ? 'lock' : 'shield-check') + ' ' +
          esc(live ? t('Hide from search', 'மறை', 'దాచు')
                   : t('Publish profile', 'வெளியிடு', 'ప్రచురించు')) + '</button>' +
        '<button class="danger" data-self="delete">' + icon('logout') + ' ' +
          esc(t('Delete profile', 'நீக்கு', 'తొలగించు')) + '</button>' +
      '</div></div>';
  }

  function subscriptionHtml() {
    const prem = status && status.premium;
    const plans = [
      ['Express Boost', '₹999', t('3 months of full profiles', '3 மாதம்', '3 నెలలు')],
      ['Gold Family Package', '₹2,499', t('12 months, the usual choice', '12 மாதம்', '12 నెలలు')],
      ['VIP Matchmaker', '₹4,999', t('12 months + a matchmaker calls you', 'திருமண தரகர் உதவி', 'మ్యాచ్‌మేకర్ సహాయం')]
    ];
    return '<div class="self-card">' +
      '<h3>' + icon('crown') + ' ' +
        esc(prem ? t('Premium is active', 'பிரீமியம் இயக்கத்தில்', 'ప్రీమియం యాక్టివ్')
                 : t('You are on the free plan', 'இலவச திட்டம்', 'ఉచిత ప్లాన్')) + '</h3>' +
      '<p>' + esc(prem
        ? t('Photos, profession, income and contact numbers are open to you on every profile.',
            'எல்லா சுயவிவரங்களிலும் முழு விவரம் திறந்துள்ளது.',
            'అన్ని ప్రొఫైల్‌లలో పూర్తి వివరాలు తెరిచి ఉన్నాయి.')
        : t('You can see every family’s name, gotram, place and age. Photo, profession, income and contact open with Premium — or free of charge the moment a family accepts your interest.',
            'பெயர், கோத்திரம், ஊர், வயது பார்க்கலாம். மீதி பிரீமியத்தில்.',
            'పేరు, గోత్రం, ఊరు, వయస్సు చూడవచ్చు. మిగతావి ప్రీమియంలో.')) + '</p>' +
      (prem ? '' : plans.map((pl) =>
        '<div class="plan-row"><div class="left"><span class="ic">' + icon('ticket') + '</span> <b>' +
        esc(pl[0]) + '</b> <span style="font-size:11.5px;color:var(--ink-soft);">' + esc(pl[2]) +
        '</span></div>' + pl[1] + '</div>').join('')) +
      '<div class="self-actions" style="margin-top:16px;">' +
        '<a class="primary" href="premium-plans.html">' + icon('crown') + ' ' +
          esc(t('See full plans', 'திட்டங்களைப் பார்', 'ప్లాన్‌లు చూడు')) + '</a>' +
        '<a href="help.html">' + icon('headset') + ' ' +
          esc(t('Talk to the committee', 'குழுவைத் தொடர்பு கொள்ள', 'కమిటీని సంప్రదించండి')) + '</a>' +
      '</div>' +
      '<p style="margin-top:16px;font-size:12.5px;">' +
        esc(t('Paid by UPI or in person? Enter the activation code you were given in the Premium box on the right.',
              'UPI மூலம் செலுத்தியிருந்தால், வலதுபுறம் குறியீட்டை உள்ளிடவும்.',
              'UPI ద్వారా చెల్లించారా? కుడివైపు కోడ్ నమోదు చేయండి.')) + '</p>' +
      '</div>';
  }

  function settingsHtml() {
    const live = status && status.published;
    return '<div class="self-card"><h3>' + icon('lock') + ' ' +
        esc(t('Who can see your profile', 'யார் பார்க்கலாம்', 'ఎవరు చూడగలరు')) + '</h3>' +
      '<p>' + esc(t('Only families who have completed and published their own profile can browse. Photos are stored privately and are never served on a public link.',
            'சொந்த சுயவிவரத்தை பூர்த்தி செய்தவர்கள் மட்டுமே பார்க்க முடியும்.',
            'తమ ప్రొఫైల్ పూర్తి చేసినవారు మాత్రమే చూడగలరు.')) + '</p>' +
      '<div class="self-actions">' +
        '<button data-self="' + (live ? 'unpublish' : 'publish') + '">' +
          icon(live ? 'lock' : 'shield-check') + ' ' +
          esc(live ? t('Hide my profile from search', 'மறை', 'దాచు')
                   : t('Publish my profile', 'வெளியிடு', 'ప్రచురించు')) + '</button>' +
      '</div></div>' +
      '<div class="self-card"><h3>' + icon('globe') + ' ' +
        esc(t('Language', 'மொழி', 'భాష')) + '</h3>' +
      '<div class="cp-chiprow">' +
        ['en', 'ta', 'te'].map((l) => '<button class="cp-chip' + (currentLang === l ? ' on' : '') +
          '" data-setlang="' + l + '">' +
          (l === 'en' ? 'English' : l === 'ta' ? 'தமிழ்' : 'తెలుగు') +
          '</button>').join('') + '</div></div>' +
      '<div class="self-card"><h3>' + icon('logout') + ' ' +
        esc(t('Account', 'கணக்கு', 'ఖాతా')) + '</h3>' +
      '<p>' + esc(t('Deleting your profile removes it, your photo and every interest tied to it. It cannot be undone.',
            'நீக்கினால் திரும்பப் பெற முடியாது.',
            'తొలగిస్తే తిరిగి పొందలేరు.')) + '</p>' +
      '<div class="self-actions">' +
        '<button data-self="signout">' + icon('logout') + ' ' +
          esc(t('Sign out', 'வெளியேறு', 'సైన్ అవుట్')) + '</button>' +
        '<button class="danger" data-self="delete">' +
          esc(t('Delete my profile', 'சுயவிவரத்தை நீக்கு', 'ప్రొఫైల్ తొలగించు')) + '</button>' +
      '</div></div>';
  }

  // ---------- view switching ----------
  async function go(name) {
    if (!VIEWS[name]) name = 'search';
    view = name;

    // "Dashboard" and "Search Profiles" both open the search view; only
    // highlight the first of them so one row reads as selected, not two.
    let marked = false;
    document.querySelectorAll('.s3-nav-item[data-view]').forEach((el) => {
      const hit = el.dataset.view === name && !marked;
      if (hit) marked = true;
      el.classList.toggle('active', hit);
    });
    if (viewTitle) { viewTitle.textContent = VIEWS[name].title(); viewTitle.removeAttribute('data-i18n'); }
    if (viewSub)   { viewSub.textContent   = VIEWS[name].sub();   viewSub.removeAttribute('data-i18n'); }

    const isSearch = name === 'search';
    const canBrowse = !!(status && status.can_browse);
    // While the gate is up there is nothing to search, so the filter bar
    // would only be noise next to the one thing they need to do.
    if (viewSearch) viewSearch.hidden = !isSearch || !canBrowse;
    if (viewList)   viewList.hidden = isSearch;
    if (bottomStats) bottomStats.hidden = !isSearch || !canBrowse;

    if (isSearch) { renderGate(); await runSearch(true); return; }

    if (gateBanner) gateBanner.hidden = true;
    listGrid.className = (name === 'myprofile' || name === 'subscription' || name === 'settings')
      ? '' : 'profile-grid';
    listGrid.innerHTML = '<div class="empty-state">' +
      esc(t('Loading…', 'ஏற்றுகிறது…', 'లోడ్…')) + '</div>';
    try {
      listGrid.innerHTML = await VIEWS[name].load();
    } catch (e) {
      listGrid.innerHTML = emptyState('help',
        t('Could not load this', 'ஏற்ற முடியவில்லை', 'లోడ్ కాలేదు'), explain(e));
    }
  }

  document.addEventListener('click', (e) => {
    const nav = e.target.closest('.s3-nav-item[data-view], [data-view-go]');
    if (!nav) return;
    const name = nav.dataset.view || nav.dataset.viewGo;
    if (!name) return;
    e.preventDefault();
    history.replaceState(null, '', '#' + name);
    go(name);
  });

  // ---------- card + list actions ----------
  async function toggleSave(id, on) {
    if (on) {
      await supabaseClient.from('saved_profiles').delete()
        .eq('parent_user_id', me.id).eq('saved_profile_id', id);
      return false;
    }
    const { error } = await supabaseClient.from('saved_profiles')
      .insert({ parent_user_id: me.id, saved_profile_id: id });
    if (error && error.code !== '23505') throw error;
    return true;
  }

  async function toggleRecommend(id, on) {
    if (on) {
      await supabaseClient.from('recommendations').delete()
        .eq('parent_user_id', me.id).eq('recommended_profile_id', id);
      return false;
    }
    const { error } = await supabaseClient.from('recommendations')
      .insert({ parent_user_id: me.id, recommended_profile_id: id });
    if (error && error.code !== '23505') throw error;
    return true;
  }

  async function onCardClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.profile-card');
    const id = card && card.dataset.id;
    const act = btn.dataset.act;
    if (!me) return;

    if (act === 'open' && id) { openProfile(id); return; }
    if (!id && !btn.dataset.iid) return;

    btn.disabled = true;
    try {
      if (act === 'save') {
        const now = await toggleSave(id, !!btn.dataset.on);
        if (view === 'drafts') { await go('drafts'); }
        else {
          if (now) btn.dataset.on = '1'; else delete btn.dataset.on;
          btn.innerHTML = icon('bookmark') + ' ' + (now
            ? t('Saved', 'சேமித்தது', 'సేవ్ చేసారు')
            : t('Save to Drafts', 'வரைவில் சேமி', 'డ్రాఫ్ట్‌లో సేవ్'));
        }
        showToast(now ? t('Saved to Drafts', 'சேமிக்கப்பட்டது', 'సేవ్ చేయబడింది')
                      : t('Removed from Drafts', 'நீக்கப்பட்டது', 'తీసివేయబడింది'));
      } else if (act === 'recommend' || act === 'unrecommend') {
        const now = await toggleRecommend(id, act === 'unrecommend' || !!btn.dataset.on);
        if (view === 'recommended') { await go('recommended'); }
        else {
          if (now) btn.dataset.on = '1'; else delete btn.dataset.on;
          btn.innerHTML = icon('send') + ' ' + (now
            ? t('Recommended', 'பரிந்துரைத்தது', 'సిఫార్సు చేసారు')
            : t('Recommend to Child', 'பிள்ளைக்கு பரிந்துரை', 'పిల్లలకు సిఫార్సు'));
        }
        showToast(now
          ? t('Passed on to your child', 'பிள்ளைக்கு அனுப்பப்பட்டது', 'పిల్లలకు పంపబడింది')
          : t('Removed', 'நீக்கப்பட்டது', 'తీసివేయబడింది'));
      } else if (act === 'interest') {
        const res = await rpc('send_interest', { p_to_profile: id, p_message: null });
        btn.innerHTML = icon('heart-fill');
        btn.style.color = '#c0392b';
        showToast(t('Interest sent — they have been notified.',
                    'ஆர்வம் அனுப்பப்பட்டது.', 'ఆసక్తి పంపబడింది.') +
                  (res && typeof res.remaining === 'number'
                    ? ' (' + res.remaining + ' ' + t('left today', 'மீதம் இன்று', 'నేడు మిగిలి') + ')' : ''));
        refreshCounts();
      } else if (act === 'accept' || act === 'decline') {
        await rpc('respond_interest', {
          p_interest: btn.dataset.iid,
          p_action: act === 'accept' ? 'accepted' : 'declined'
        });
        showToast(act === 'accept'
          ? t('Accepted — you can both see full details now.',
              'ஏற்கப்பட்டது.', 'అంగీకరించారు.')
          : t('Declined.', 'நிராகரிக்கப்பட்டது.', 'తిరస్కరించారు.'));
        await go('received');
        refreshCounts();
      }
    } catch (err) {
      showToast(explain(err));
    }
    btn.disabled = false;
  }

  grid.addEventListener('click', onCardClick);
  if (listGrid) listGrid.addEventListener('click', onCardClick);

  // ---------- self actions (my profile / settings) ----------
  if (listGrid) {
    listGrid.addEventListener('click', async (e) => {
      const lang = e.target.closest('[data-setlang]');
      if (lang) { applyLang(lang.dataset.setlang); go('settings'); return; }

      const btn = e.target.closest('[data-self]');
      if (!btn) return;
      const act = btn.dataset.self;

      if (act === 'signout') {
        await supabaseClient.auth.signOut();
        window.location.href = 'home.html';
        return;
      }

      if (act === 'delete') {
        const ok = window.confirm(t(
          'Delete your profile for good? Your photo and every saved interest connected to it go too. This cannot be undone.',
          'சுயவிவரத்தை நிரந்தரமாக நீக்கவா? திரும்பப் பெற முடியாது.',
          'ప్రొఫైల్‌ను శాశ్వతంగా తొలగించాలా? తిరిగి పొందలేరు.'));
        if (!ok) return;
        btn.disabled = true;
        try {
          const path = status && status.profile && status.profile.photo_path;
          if (path) {
            try { await supabaseClient.storage.from('profile-photos').remove([path]); } catch (x) {}
          }
          await rpc('delete_my_profile', {});
          showToast(t('Profile deleted.', 'நீக்கப்பட்டது.', 'తొలగించబడింది.'));
          await refreshStatus();
          go('myprofile');
        } catch (err) { showToast(explain(err)); }
        btn.disabled = false;
        return;
      }

      if (act === 'publish' || act === 'unpublish') {
        btn.disabled = true;
        try {
          await rpc('set_profile_status', { p_status: act === 'publish' ? 'published' : 'draft' });
          showToast(act === 'publish'
            ? t('Your profile is live.', 'நேரலையில்.', 'లైవ్‌లో ఉంది.')
            : t('Hidden from search.', 'மறைக்கப்பட்டது.', 'దాచబడింది.'));
          await refreshStatus();
          go(view);
        } catch (err) { showToast(explain(err)); }
        btn.disabled = false;
      }
    });
  }

  // ---------- profile modal ----------
  let openId = null;

  function pmRow(label, value, locked) {
    return '<div class="pm-row' + (locked ? ' locked' : '') + '"><label>' + esc(label) +
      '</label><div>' + esc(locked ? 'Locked value' : (value || '—')) + '</div></div>';
  }

  async function openProfile(id) {
    openId = id;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    pmBody.innerHTML = '<div class="pm-pad"><p class="pm-sub">' +
      esc(t('Loading…', 'ஏற்றுகிறது…', 'లోడ్…')) + '</p></div>';

    let p;
    try {
      p = await rpc('get_profile', { p_id: id });
    } catch (e) {
      pmBody.innerHTML = '<div class="pm-pad"><h3>' +
        esc(t('Not available', 'கிடைக்கவில்லை', 'అందుబాటులో లేదు')) +
        '</h3><p class="pm-sub">' + esc(explain(e)) + '</p></div>';
      return;
    }
    await signPhotos([p]);

    const locked = !!p.locked;
    const photo = p.photo_path && photoCache.get(p.photo_path);
    const hero = photo
      ? '<img src="' + esc(photo) + '" alt="">'
      : icon('user', 'icon-lg') +
        (locked && p.has_photo
          ? '<span class="tag-locked" style="bottom:14px;">' + icon('lock') + ' ' +
            esc(t('Photo hidden on the free plan', 'படம் மறைக்கப்பட்டுள்ளது', 'ఫోటో దాచబడింది')) + '</span>'
          : '');

    const sub = [
      p.age ? p.age + ' ' + t('yrs', 'வயது', 'ఏళ్లు') : null,
      p.gotram ? p.gotram + ' ' + t('Gotram', 'கோத்திரம்', 'గోత్రం') : null,
      p.native_place,
      p.created_for === 'son' ? t('Groom', 'மணமகன்', 'వరుడు') : t('Bride', 'மணமகள்', 'వధువు')
    ].filter(Boolean).join('  •  ');

    const upsell = locked
      ? '<div class="pm-upsell"><b>' + icon('lock') + ' ' +
          esc(t('Locked on the free plan', 'இலவசத் திட்டத்தில் பூட்டப்பட்டது', 'ఉచిత ప్లాన్‌లో లాక్')) + '</b>' +
          esc(t('Photo, profession, income and contact number open with Premium — or free of charge the moment this family accepts your interest.',
                'படம், தொழில், வருமானம், எண் ஆகியவை பிரீமியத்தில் அல்லது இவர்கள் உங்கள் ஆர்வத்தை ஏற்றால் திறக்கும்.',
                'ఫోటో, వృత్తి, ఆదాయం, నంబర్ ప్రీమియంలో లేదా వారు మీ ఆసక్తిని అంగీకరిస్తే తెరుచుకుంటాయి.')) +
        '</div>'
      : (p.unlocked_by_accept
          ? '<div class="pm-upsell"><b>' + icon('heart-fill') + ' ' +
            esc(t('Opened because they accepted your interest', 'ஆர்வம் ஏற்கப்பட்டதால் திறந்தது', 'ఆసక్తి అంగీకరించడంతో తెరిచింది')) +
            '</b>' + esc(t('You can contact this family directly.', 'நேரடியாக தொடர்பு கொள்ளலாம்.', 'నేరుగా సంప్రదించవచ్చు.')) + '</div>'
          : '');

    const sentPill = p.interest
      ? '<span class="pill pill-' + esc(p.interest) + '">' + esc(
          p.interest === 'pending'  ? t('Interest sent', 'ஆர்வம் அனுப்பியது', 'ఆసక్తి పంపారు')
        : p.interest === 'accepted' ? t('Accepted', 'ஏற்றது', 'అంగీకరించారు')
                                    : t('Declined', 'நிராகரித்தது', 'తిరస్కరించారు')) + '</span>'
      : '';

    pmBody.innerHTML =
      '<div class="pm-hero">' + hero + '</div>' +
      '<div class="pm-pad">' +
        '<h3 id="pmName">' + esc(p.full_name || '') + ' ' + sentPill + '</h3>' +
        '<p class="pm-sub">' + esc(sub) + '</p>' +
        upsell +
        '<div class="pm-rows">' +
          pmRow(t('Height', 'உயரம்', 'ఎత్తు'), p.height, locked) +
          pmRow(t('Education', 'கல்வி', 'విద్య'), p.education, locked) +
          pmRow(t('Profession', 'தொழில்', 'వృత్తి'), p.profession, locked) +
          pmRow(t('Annual income', 'ஆண்டு வருமானம்', 'వార్షిక ఆదాయం'), p.annual_income, locked) +
          pmRow(t('Work location', 'பணியிடம்', 'పని ప్రదేశం'), p.work_location, locked) +
          pmRow(t('Nakshatra', 'நட்சத்திரம்', 'నక్షత్రం'), p.nakshatra, locked) +
          pmRow(t('Rasi', 'ராசி', 'రాశి'), p.rasi, locked) +
          pmRow(t('Horoscope gunas', 'குணங்கள்', 'గుణాలు'), p.horoscope_gunas, locked) +
          pmRow(t('Contact', 'தொடர்பு', 'సంప్రదింపు'), p.contact_phone, locked) +
        '</div>' +
        (p.about && !locked ? '<p class="pm-sub">' + esc(p.about) + '</p>' : '') +
        '<div class="pm-actions">' +
          '<button data-pm="save"' + (p.saved ? ' data-on="1"' : '') + '>' + icon('bookmark') + ' ' +
            esc(p.saved ? t('Saved', 'சேமித்தது', 'సేవ్') : t('Save to Drafts', 'வரைவில் சேமி', 'డ్రాఫ్ట్')) + '</button>' +
          '<button data-pm="recommend"' + (p.recommended ? ' data-on="1"' : '') + '>' + icon('send') + ' ' +
            esc(p.recommended ? t('Recommended', 'பரிந்துரைத்தது', 'సిఫార్సు') : t('Recommend to child', 'பிள்ளைக்கு', 'పిల్లలకు')) + '</button>' +
          '<button class="primary" data-pm="interest"' + (p.interest ? ' disabled' : '') + '>' +
            icon('heart') + ' ' + esc(p.interest
              ? t('Interest sent', 'அனுப்பியது', 'పంపారు')
              : t('Send interest', 'ஆர்வம் அனுப்பு', 'ఆసక్తి పంపు')) + '</button>' +
          '<button class="danger" data-pm="report" title="' +
            esc(t('Report this profile', 'புகார் அளி', 'ఫిర్యాదు')) + '">' + icon('shield') + '</button>' +
        '</div>' +
        '<div class="pm-form" id="pmReport" hidden>' +
          '<select id="pmReason">' +
            '<option value="">' + esc(t('Why are you reporting this profile?', 'ஏன் புகார்?', 'ఎందుకు ఫిర్యాదు?')) + '</option>' +
            '<option value="fake">' + esc(t('Details look fake', 'விவரங்கள் போலி', 'వివరాలు నకిలీ')) + '</option>' +
            '<option value="already_married">' + esc(t('Already married / engaged', 'ஏற்கனவே திருமணம்', 'ఇప్పటికే వివాహం')) + '</option>' +
            '<option value="wrong_details">' + esc(t('Wrong details', 'தவறான விவரங்கள்', 'తప్పు వివరాలు')) + '</option>' +
            '<option value="harassment">' + esc(t('Harassment or abuse', 'தொந்தரவு', 'వేధింపు')) + '</option>' +
            '<option value="other">' + esc(t('Something else', 'வேறு', 'ఇతర')) + '</option>' +
          '</select>' +
          '<textarea id="pmDetails" rows="3" placeholder="' +
            esc(t('Anything the committee should know (optional)', 'கூடுதல் விவரம் (விருப்பம்)', 'అదనపు వివరాలు (ఐచ్ఛికం)')) + '"></textarea>' +
          '<div class="pm-actions"><button class="primary" data-pm="report-send">' +
            esc(t('Send report', 'புகார் அனுப்பு', 'ఫిర్యాదు పంపు')) + '</button></div>' +
        '</div>' +
      '</div>';
  }

  function closeModal() {
    modal.hidden = true;
    openId = null;
    document.body.style.overflow = '';
  }

  if (modal) {
    $('pmClose').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) closeModal();
    });

    pmBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-pm]');
      if (!btn || !openId) return;
      const act = btn.dataset.pm;

      if (act === 'report') { $('pmReport').hidden = !$('pmReport').hidden; return; }

      btn.disabled = true;
      try {
        if (act === 'save') {
          const now = await toggleSave(openId, !!btn.dataset.on);
          if (now) btn.dataset.on = '1'; else delete btn.dataset.on;
          btn.innerHTML = icon('bookmark') + ' ' +
            (now ? t('Saved', 'சேமித்தது', 'సేవ్') : t('Save to Drafts', 'வரைவில் சேமி', 'డ్రాఫ్ట్'));
          showToast(now ? t('Saved to Drafts', 'சேமிக்கப்பட்டது', 'సేవ్ చేయబడింది')
                        : t('Removed from Drafts', 'நீக்கப்பட்டது', 'తీసివేయబడింది'));
        } else if (act === 'recommend') {
          const now = await toggleRecommend(openId, !!btn.dataset.on);
          if (now) btn.dataset.on = '1'; else delete btn.dataset.on;
          btn.innerHTML = icon('send') + ' ' +
            (now ? t('Recommended', 'பரிந்துரைத்தது', 'సిఫార్సు') : t('Recommend to child', 'பிள்ளைக்கு', 'పిల్లలకు'));
        } else if (act === 'interest') {
          await rpc('send_interest', { p_to_profile: openId, p_message: null });
          btn.innerHTML = icon('heart-fill') + ' ' + t('Interest sent', 'அனுப்பியது', 'పంపారు');
          showToast(t('Interest sent — they have been notified.', 'ஆர்வம் அனுப்பப்பட்டது.', 'ఆసక్తి పంపబడింది.'));
          refreshCounts();
        } else if (act === 'report-send') {
          const reason = $('pmReason').value;
          if (!reason) {
            showToast(t('Choose a reason first.', 'ஒரு காரணத்தைத் தேர்ந்தெடுக்கவும்.', 'కారణం ఎంచుకోండి.'));
            btn.disabled = false;
            return;
          }
          await rpc('report_profile', {
            p_id: openId, p_reason: reason, p_details: $('pmDetails').value
          });
          showToast(t('Reported. The committee will review it.',
                      'புகார் அளிக்கப்பட்டது.', 'ఫిర్యాదు నమోదైంది.'));
          closeModal();
          if (view === 'search') runSearch(true);
          return;
        }
      } catch (err) {
        showToast(explain(err));
      }
      btn.disabled = false;
    });
  }

  // ---------- notifications ----------
  async function loadNotifications() {
    if (!notifList) return;
    const { data } = await supabaseClient
      .from('notifications').select('*')
      .order('created_at', { ascending: false }).limit(15);
    const rows = data || [];
    notifList.innerHTML = rows.length
      ? rows.map((n) =>
          '<div class="notif-item' + (n.read_at ? '' : ' unread') + '">' +
            '<b>' + esc(n.title) + '</b><p>' + esc(n.body || '') + '</p>' +
            '<time>' + esc(ago(n.created_at)) + '</time></div>').join('')
      : '<div class="notif-empty">' +
          esc(t('Nothing yet.', 'இன்னும் எதுவும் இல்லை.', 'ఇంకా ఏమీ లేదు.')) + '</div>';
  }

  if (bellBtn) {
    bellBtn.addEventListener('click', (e) => {
      if (e.target.closest('.notif-pop') && !e.target.closest('#notifReadAll')) return;
      if (e.target.closest('#notifReadAll')) {
        rpc('mark_notifications_read', {}).then(() => { loadNotifications(); refreshCounts(); });
        return;
      }
      notifPop.hidden = !notifPop.hidden;
      if (!notifPop.hidden) loadNotifications();
    });
    document.addEventListener('click', (e) => {
      if (!notifPop.hidden && !e.target.closest('#bellBtn')) notifPop.hidden = true;
    });
  }

  // ---------- counts ----------
  async function refreshCounts() {
    let c;
    try { c = await rpc('my_counts', {}); } catch (e) { return; }
    const set = (id, n) => {
      const el = $(id);
      if (!el) return;
      el.textContent = n;
      el.hidden = !n;
    };
    set('cntDrafts', c.drafts);
    set('cntRecommended', c.recommended);
    set('cntReceived', c.received);
    set('cntSent', c.sent);
    if (bellDot) {
      bellDot.textContent = c.unread;
      bellDot.hidden = !c.unread;
    }
  }

  // ---------- right-hand drafts panel ----------
  async function loadDraftsPanel() {
    if (!draftsPanel) return;
    const head = '<div class="panel-head"><h3>' + icon('bookmark') + ' ' +
      t('Your Drafts', 'உங்கள் வரைவுகள்', 'మీ డ్రాఫ్ట్‌లు') + '</h3>' +
      '<a href="#drafts" data-view-go="drafts" style="cursor:pointer;">' +
      t('See all', 'அனைத்தும்', 'అన్నీ') + '</a></div>';
    let rows = [];
    try { rows = await rpc('my_saved_profiles', { p_limit: 6 }); } catch (e) {}
    draftsPanel.innerHTML = head + (rows.length
      ? rows.map((p) =>
          '<div class="draft-row"><div class="draft-avatar">' + icon('user') + '</div>' +
          '<div><b>' + esc(p.full_name || 'Profile') + '</b><span>' +
          esc([p.gotram, p.native_place].filter(Boolean).join(' • ') ||
              t('Saved', 'சேமித்தது', 'సేవ్')) + '</span></div></div>').join('')
      : '<p style="font-size:13px;color:var(--ink-soft);margin:6px 0 0;">' +
        t('Profiles you save appear here.', 'நீங்கள் சேமிப்பவை இங்கே தோன்றும்.',
          'మీరు సేవ్ చేసినవి ఇక్కడ కనిపిస్తాయి.') + '</p>');
  }

  // ---------- premium ----------
  function renderPremiumBox() {
    const state = $('premiumState');
    if (!state) return;
    if (status && status.premium) {
      state.hidden = false;
      state.textContent = t('Premium is active on this account.',
        'பிரீமியம் இயக்கத்தில் உள்ளது.', 'ప్రీమియం యాక్టివ్‌గా ఉంది.');
    } else {
      state.hidden = true;
    }
  }

  const redeemBtn = $('redeemBtn');
  if (redeemBtn) {
    redeemBtn.addEventListener('click', async () => {
      const input = $('redeemInput');
      const code = (input.value || '').trim();
      if (!code) return;
      redeemBtn.disabled = true;
      try {
        await rpc('redeem_premium_code', { p_code: code });
        input.value = '';
        showToast(t('Premium activated. Full profiles are open to you now.',
          'பிரீமியம் இயக்கப்பட்டது.', 'ప్రీమియం యాక్టివ్ అయింది.'));
        await refreshStatus();
        renderPremiumBox();
        photoCache.clear();
        if (view === 'search') runSearch(true); else go(view);
      } catch (e) { showToast(explain(e)); }
      redeemBtn.disabled = false;
    });
  }

  const upgradeBtn = $('upgradeBtn');
  if (upgradeBtn) upgradeBtn.addEventListener('click', () => { window.location.href = 'premium-plans.html'; });

  // ---------- waitlist (bride & groom app) ----------
  const waitlistInput = $('waitlistInput');
  const waitlistBtn = $('waitlistBtn');
  if (waitlistBtn && waitlistInput) {
    waitlistBtn.addEventListener('click', async () => {
      const v = waitlistInput.value.trim();
      waitlistBtn.disabled = true;
      try {
        await rpc('join_waitlist', { p_contact: v, p_role: null, p_source: 'dashboard' });
        waitlistInput.value = '';
        showToast(t('You are on the list — we will text you the day it opens.',
          'பட்டியலில் சேர்க்கப்பட்டீர்கள்.', 'జాబితాలో చేరారు.'));
      } catch (e) { showToast(explain(e)); }
      waitlistBtn.disabled = false;
    });
  }

  // ---------- filters ----------
  const moreBtn = $('moreFiltersBtn');
  const morePanel = $('moreFiltersPanel');
  if (moreBtn && morePanel) {
    moreBtn.addEventListener('click', () => { morePanel.hidden = !morePanel.hidden; });
  }
  const clearBtn = $('clearFiltersBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      [F.gotram, F.keyword, F.income, F.profession, F.place, F.minAge, F.maxAge]
        .forEach((el) => { if (el) el.value = ''; });
      if (F.onlyPhoto) F.onlyPhoto.checked = false;
      runSearch(true);
    });
  }

  const searchBtn = $('doSearchBtn');
  if (searchBtn) searchBtn.addEventListener('click', () => runSearch(true));
  [F.looking, F.gotram, F.income, F.onlyPhoto].forEach((el) => {
    if (el) el.addEventListener('change', () => runSearch(true));
  });
  [F.keyword, F.profession, F.place, F.minAge, F.maxAge].forEach((el) => {
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(true); });
  });
  if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => runSearch(false));

  document.querySelectorAll('.s3-popular .chip').forEach((chip) => {
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', () => {
      const g = chip.textContent.trim();
      if (F.gotram && [...F.gotram.options].some((o) => o.value === g)) F.gotram.value = g;
      else if (F.keyword) F.keyword.value = g;
      go('search');
    });
  });

  // Gotram list: taken from the profile form so it does not need a second
  // query, and so it cannot be used to count who is on the platform.
  function fillGotrams() {
    if (!F.gotram) return;
    const list = ['Markandeya', 'Padmarishi', 'Kashyapa', 'Vasishta', 'Bharadwaja',
      'Gautama', 'Atri', 'Vishwamitra', 'Jamadagni', 'Agastya', 'Sandilya', 'Kaundinya'];
    list.forEach((g) => {
      const o = document.createElement('option');
      o.value = g; o.textContent = g;
      F.gotram.appendChild(o);
    });
  }

  // ---------- boot ----------
  async function refreshStatus() {
    status = await rpc('my_status', {});
    setIdentity();
    renderPremiumBox();
    return status;
  }

  (async function init() {
    const { data: s } = await supabaseClient.auth.getSession();
    if (!s || !s.session) { window.location.href = 'login.html'; return; }
    me = s.session.user;

    try {
      await refreshStatus();
    } catch (e) {
      grid.innerHTML = emptyState('help',
        t('Could not reach the server', 'சேவையகத்தை அடைய முடியவில்லை', 'సర్వర్‌ను చేరుకోలేదు'),
        explain(e) + ' — ' +
        t('If this is a fresh Supabase project, run supabase-setup-v2.sql once in the SQL editor.',
          'supabase-setup-v2.sql ஐ ஒருமுறை இயக்கவும்.',
          'supabase-setup-v2.sql ఒకసారి రన్ చేయండి.'));
      return;
    }

    fillGotrams();
    if (F.looking && status.profile) {
      F.looking.value = status.profile.created_for === 'son' ? 'bride' : 'groom';
    }

    const start = (location.hash || '').replace('#', '');
    await go(VIEWS[start] ? start : 'search');
    refreshCounts();
    loadDraftsPanel();

    window.addEventListener('hashchange', () => {
      const h = (location.hash || '').replace('#', '');
      if (VIEWS[h] && h !== view) go(h);
    });

    // Live bell: a new interest lands without the parent refreshing.
    try {
      supabaseClient.channel('notif-' + me.id)
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'notifications', filter: 'user_id=eq.' + me.id },
            (payload) => {
              refreshCounts();
              if (!notifPop.hidden) loadNotifications();
              const n = payload && payload.new;
              if (n && n.title) showToast(n.title);
            })
        .subscribe();
    } catch (e) { /* realtime is a nicety, not a requirement */ }

    // Re-render the dynamic strings when the language changes.
    document.querySelectorAll('[data-langdd] .lang-dd-menu button, .lang-card').forEach((b) => {
      b.addEventListener('click', () => setTimeout(() => {
        setIdentity();
        go(view);
        loadDraftsPanel();
      }, 60));
    });
  })();
})();
