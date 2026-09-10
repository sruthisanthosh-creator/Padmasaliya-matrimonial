// ---- Admin panel -------------------------------------------------------
// Every read and every action here is an admin_* database function that
// calls assert_admin() before it does anything. This file is the screen;
// the database is the guard. Opening admin.html without being an admin
// gets you a locked card and nothing else, and even if someone edited that
// away in their browser, every call would still refuse.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const shell = $('adShell'), gate = $('adGate'), main = $('adMain');
  const modal = $('adModal'), modalBody = $('adModalBody'), modalTitle = $('adModalTitle');

  let me = null;
  let tab = 'overview';
  const state = {
    profiles: { search: '', status: '', page: 0, total: 0 },
    members:  { search: '', filter: '', page: 0, total: 0 },
    reports:  { status: 'open' }
  };
  const PAGE = 25;

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (n, c) => '<svg class="icon' + (c ? ' ' + c : '') + '"><use href="#i-' + n + '"></use></svg>';
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));

  function date(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function ago(d) {
    if (!d) return 'never';
    const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 2592000) return Math.floor(s / 86400) + 'd ago';
    return date(d);
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = '✓ ' + msg;
    t.classList.add('show');
    clearTimeout(window._t);
    window._t = setTimeout(() => t.classList.remove('show'), 2400);
  }

  function explain(e) {
    const m = String((e && e.message) || e || '');
    if (m.includes('ADMIN_LOCKED')) return 'The panel locked itself. Enter the admin password again.';
    if (m.includes('WRONG_PASSWORD')) return 'That password is not right.';
    if (m.includes('PASSWORD_TOO_SHORT')) return 'Use at least 8 characters.';
    if (m.includes('LOCKED_OUT')) return 'Too many wrong tries. Wait 15 minutes and try again.';
    if (m.includes('NO_PASSWORD_SET')) return 'No admin password has been set yet.';
    if (m.includes('NOT_ADMIN')) return 'This account is not an administrator.';
    if (m.includes('AUTH_REQUIRED')) return 'Please sign in again.';
    if (m.includes('LAST_ADMIN')) return 'You cannot remove the only administrator.';
    if (m.includes('NOT_FOUND')) return 'That record no longer exists.';
    if (m.includes('BAD_MONTHS')) return 'Choose between 1 and 60 months.';
    if (m.includes('BAD_COUNT')) return 'Choose between 1 and 200 codes.';
    if (m.includes('does not exist')) return 'The admin functions are not installed yet — run supabase-setup-v6-admin.sql in the Supabase SQL editor.';
    return m || 'Something went wrong.';
  }

  async function rpc(fn, args) {
    const { data, error } = await supabaseClient.rpc(fn, args || {});
    if (error) throw error;
    return data;
  }

  function busy(html) { main.innerHTML = '<div class="ad-loading">' + (html || 'Loading…') + '</div>'; }

  // Photos and jathagams live in a private bucket. Sign what we are about
  // to show, in one batch, and keep the result for the session.
  const fileCache = new Map();
  async function signFiles(paths) {
    const want = [...new Set(paths.filter((p) => p && !fileCache.has(p)))];
    if (!want.length) return;
    try {
      const { data } = await supabaseClient.storage
        .from('profile-photos').createSignedUrls(want, 3600);
      (data || []).forEach((d) => { if (d && d.signedUrl) fileCache.set(d.path, d.signedUrl); });
    } catch (e) { /* the panel works without thumbnails */ }
  }
  async function openFile(path) {
    if (!path) return;
    if (!fileCache.has(path)) await signFiles([path]);
    const url = fileCache.get(path);
    if (url) window.open(url, '_blank', 'noopener');
    else toast('Could not open that file.');
  }

  // =====================================================================
  //  OVERVIEW
  // =====================================================================

  // A 14-day count is a magnitude over time with a small, discrete set of
  // buckets, so: bars, one series, no legend (the title names it), the axis
  // kept recessive, and only the peak labelled rather than every column.
  function barChart(series, label) {
    const w = 560, h = 150, padL = 8, padR = 8, padT = 18, padB = 22;
    const rows = series || [];
    if (!rows.length) return '<p class="ad-cardsub">No data yet.</p>';
    const max = Math.max(1, ...rows.map((r) => r.n));
    const innerW = w - padL - padR, innerH = h - padT - padB;
    const step = innerW / rows.length;
    const bw = Math.max(4, step - 4);   // 4px of surface between bars

    const bars = rows.map((r, i) => {
      const bh = r.n === 0 ? 0 : Math.max(2, (r.n / max) * innerH);
      const x = padL + i * step + (step - bw) / 2;
      const y = padT + innerH - bh;
      const d = new Date(r.day);
      const when = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      return '<rect class="ad-bar" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) +
             '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="3">' +
             '<title>' + esc(when + ': ' + r.n + ' ' + label) + '</title></rect>' +
             (r.n === max && max > 0
               ? '<text class="ad-bar-label" x="' + (x + bw / 2).toFixed(1) + '" y="' +
                 (y - 5).toFixed(1) + '" text-anchor="middle">' + r.n + '</text>'
               : '');
    }).join('');

    const first = new Date(rows[0].day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const last = new Date(rows[rows.length - 1].day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

    return '<div class="ad-chart"><svg viewBox="0 0 ' + w + ' ' + h + '" role="img" ' +
      'aria-label="' + esc(label + ' per day for the last ' + rows.length + ' days') + '">' +
      bars +
      '<line class="ad-axis" x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (w - padR) +
        '" y2="' + (padT + innerH) + '"/>' +
      '<text class="ad-axis-text" x="' + padL + '" y="' + (h - 6) + '">' + esc(first) + '</text>' +
      '<text class="ad-axis-text" x="' + (w - padR) + '" y="' + (h - 6) + '" text-anchor="end">' + esc(last) + '</text>' +
      '</svg></div>';
  }

  const tile = (n, label, cls) =>
    '<div class="ad-tile' + (cls ? ' ' + cls : '') + '"><b>' + num(n) + '</b><span>' + esc(label) + '</span></div>';

  async function viewOverview() {
    busy();
    const s = await rpc('admin_stats');
    const p = s.profiles, m = s.members, pr = s.premium, a = s.activity;

    main.innerHTML =
      '<div class="ad-h"><h1>Overview</h1></div>' +
      '<p class="ad-sub">Everything on the platform at a glance. Updated when you open this page.</p>' +

      '<div class="ad-tiles">' +
        tile(p.published, 'Live profiles', 'good') +
        tile(m.total, 'Accounts') +
        tile(pr.active, 'Premium members', 'gold') +
        tile(a.reports_open, 'Reports waiting', a.reports_open > 0 ? 'warn' : '') +
        tile(a.waitlist_pending, 'Waitlist to notify') +
        tile(m.active_7d, 'Signed in this week') +
      '</div>' +

      '<div class="ad-charts">' +
        '<div class="ad-card"><h2>New accounts</h2>' +
          '<p class="ad-cardsub">Last 14 days. Peak day labelled.</p>' +
          barChart(s.signups, 'accounts') + '</div>' +
        '<div class="ad-card"><h2>New profiles</h2>' +
          '<p class="ad-cardsub">Last 14 days. Peak day labelled.</p>' +
          barChart(s.profiles_by_day, 'profiles') + '</div>' +
      '</div>' +

      '<div class="ad-card"><h2>Profiles</h2>' +
        '<p class="ad-cardsub">' + num(p.demo) + ' of these are demo rows for testing.</p>' +
        '<div class="ad-tiles">' +
          tile(p.total, 'Total') + tile(p.draft, 'Unfinished drafts') +
          tile(p.incomplete, 'Missing required fields') + tile(p.hidden, 'Hidden from search') +
          tile(p.sons, 'For sons') + tile(p.daughters, 'For daughters') +
          tile(p.with_photo, 'With a photo') + tile(p.new_7d, 'Added this week') +
        '</div></div>' +

      '<div class="ad-card"><h2>Members</h2>' +
        '<div class="ad-tiles">' +
          tile(m.confirmed, 'Confirmed email') + tile(m.new_7d, 'Joined this week') +
          tile(m.active_30d, 'Active in 30 days') + tile(m.never_signed_in, 'Never signed in') +
        '</div></div>' +

      '<div class="ad-card"><h2>Premium</h2>' +
        '<div class="ad-tiles">' +
          tile(pr.active, 'Active', 'gold') + tile(pr.expiring_30d, 'Expiring in 30 days') +
          tile(pr.expired, 'Lapsed') + tile(pr.codes_unused, 'Unused codes') +
          tile(pr.codes_redeemed, 'Codes redeemed') +
        '</div></div>' +

      '<div class="ad-card"><h2>Activity</h2>' +
        '<div class="ad-tiles">' +
          tile(a.interests, 'Interests sent') + tile(a.interests_7d, 'This week') +
          tile(a.accepted, 'Accepted', 'good') + tile(a.pending, 'Awaiting a reply') +
          tile(a.saved, 'Profiles shortlisted') + tile(a.waitlist, 'On the waitlist') +
          tile(a.deletions, 'Profiles deleted') +
        '</div></div>';

    setBadge('navReports', a.reports_open);
    setBadge('navWaitlist', a.waitlist_pending);
  }

  function setBadge(id, n) {
    const el = $(id);
    if (!el) return;
    el.textContent = n;
    el.hidden = !n;
  }

  // =====================================================================
  //  PROFILES
  // =====================================================================

  function profileStatusPill(r) {
    if (r.deleted_at) return '<span class="ad-pill archived">Archived</span>';
    if (!r.is_complete) return '<span class="ad-pill incomplete">Incomplete</span>';
    if (!r.visible) return '<span class="ad-pill hidden">Hidden</span>';
    if (r.status !== 'published') return '<span class="ad-pill draft">Draft</span>';
    return '<span class="ad-pill live">Live</span>';
  }

  function thumb(r) {
    const url = r.photo_path && fileCache.get(r.photo_path);
    return url
      ? '<img class="ad-thumb" src="' + esc(url) + '" alt="" data-act="photo">'
      : '<span class="ad-thumb-empty">' + icon('user') + '</span>';
  }

  async function viewProfiles() {
    busy();
    const st = state.profiles;
    const res = await rpc('admin_list_profiles', {
      p_search: st.search || null, p_status: st.status || null,
      p_limit: PAGE, p_offset: st.page * PAGE
    });
    st.total = res.total;
    await signFiles(res.rows.map((r) => r.photo_path));

    const rows = res.rows.map((r) =>
      '<tr data-id="' + esc(r.id) + '"' + (r.deleted_at ? ' class="is-archived"' : '') + '>' +
        '<td><div class="ad-namecell">' + thumb(r) + '<div>' +
          '<div class="ad-name">' + esc(r.full_name || '—') +
            (r.is_demo ? ' <span class="ad-pill demo">Demo</span>' : '') + '</div>' +
          '<div class="ad-meta">' + esc(r.created_for === 'son' ? 'Groom' : 'Bride') +
            (r.age ? ' · ' + r.age + ' yrs' : '') + (r.gotram ? ' · ' + esc(r.gotram) : '') + '</div>' +
          (r.has_jathagam
            ? '<div class="ad-files"><button type="button" class="ad-filelink" data-act="jathagam">' +
              icon('ticket') + ' Jathagam</button></div>' : '') +
        '</div></div></td>' +
        '<td>' + esc(r.native_place || '—') + '</td>' +
        '<td>' + esc(r.profession || '—') +
          (r.annual_income ? '<div class="ad-meta">' + esc(r.annual_income) + '</div>' : '') + '</td>' +
        '<td class="nowrap">' + esc(r.contact_phone || '—') + '</td>' +
        '<td class="nowrap">' + profileStatusPill(r) +
          (r.reports > 0 ? ' <span class="ad-pill hidden">' + r.reports + ' report' +
            (r.reports > 1 ? 's' : '') + '</span>' : '') +
          (r.deleted_at ? '<div class="ad-meta">' + date(r.deleted_at) +
            (r.deleted_reason ? ' · ' + esc(r.deleted_reason) : '') + '</div>' : '') + '</td>' +
        '<td class="nowrap ad-meta">' + esc(r.owner_email || (r.is_demo ? 'demo row' : '—')) + '</td>' +
        '<td class="nowrap ad-meta">' + date(r.created_at) + '</td>' +
        '<td><div class="ad-rowactions">' +
          (r.deleted_at
            ? '<button class="ad-icon-btn" data-act="restore" title="Put back on the site">' +
              icon('check') + '</button>'
            : '<button class="ad-icon-btn" data-act="edit" title="Edit">' + icon('edit') + '</button>' +
              '<button class="ad-icon-btn" data-act="toggle" title="' +
                (r.visible ? 'Hide from search' : 'Show in search') + '">' +
                icon(r.visible ? 'eye' : 'eye-off') + '</button>') +
          '<button class="ad-icon-btn danger" data-act="delete" title="Erase permanently">' +
            icon('trash') + '</button>' +
        '</div></td>' +
      '</tr>').join('');

    main.innerHTML =
      '<div class="ad-h"><h1>Profiles</h1>' +
        '<div class="ad-spacer"></div>' +
        '<button class="ad-btn primary" id="adNewProfile">' + icon('plus') + ' New profile</button>' +
      '</div>' +
      '<p class="ad-sub">' + num(st.total) + ' profile' + (st.total === 1 ? '' : 's') +
        '. Editing here writes straight to the database.</p>' +
      (st.status === 'deleted'
        ? '<div class="ad-archnote">These families deleted their own profile. It is gone from the ' +
          'member site completely — out of search, shortlists and interest lists, and no member can ' +
          'reach it. It is kept here for your records. <b>Put back</b> returns it to the site; ' +
          '<b>Erase</b> removes it from the database for good.</div>'
        : '') +

      '<div class="ad-tools">' +
        '<input type="search" id="adSearch" placeholder="Name, gotram, place, phone…" value="' + esc(st.search) + '">' +
        '<select id="adStatus">' +
          [['', 'On the site'], ['published', 'Published'], ['draft', 'Draft'],
           ['hidden', 'Hidden'], ['incomplete', 'Incomplete'], ['demo', 'Demo'],
           ['deleted', 'Archived (deleted by owner)']].map(([v, l]) =>
            '<option value="' + v + '"' + (st.status === v ? ' selected' : '') + '>' +
            l + '</option>').join('') +
        '</select>' +
        '<button class="ad-btn" id="adSearchBtn">' + icon('search') + ' Search</button>' +
        '<button class="ad-btn" id="adExport">' + icon('download') + ' Export CSV</button>' +
      '</div>' +

      (res.rows.length
        ? '<div class="ad-tablewrap"><table class="ad-table"><thead><tr>' +
            '<th>Name</th><th>Place</th><th>Profession</th><th>Phone</th>' +
            '<th>Status</th><th>Account</th><th>Added</th><th></th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="ad-tablewrap"><div class="ad-empty">No profiles match that.</div></div>') +
      pager(st, 'profiles');

    $('adNewProfile').onclick = () => openProfileEditor(null);
    $('adSearchBtn').onclick = () => { st.search = $('adSearch').value.trim(); st.page = 0; viewProfiles(); };
    $('adSearch').onkeydown = (e) => { if (e.key === 'Enter') $('adSearchBtn').click(); };
    $('adStatus').onchange = () => { st.status = $('adStatus').value; st.page = 0; viewProfiles(); };
    $('adExport').onclick = () => exportCsv(res.rows);
    wirePager(st, viewProfiles);

    main.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.querySelectorAll('[data-act]').forEach((b) => {
        b.onclick = () => profileAction(b.dataset.act, tr.dataset.id, res.rows.find((x) => x.id === tr.dataset.id));
      });
    });
  }

  async function profileAction(act, id, row) {
    if (act === 'edit') { openProfileEditor(row); return; }
    if (act === 'photo') { openFile(row.photo_path); return; }
    if (act === 'jathagam') { openFile(row.jathagam_path); return; }
    if (act === 'restore') {
      if (!confirm('Put "' + (row.full_name || 'this profile') + '" back on the site?\n\n' +
        'It will be published and searchable again.')) return;
      try { await rpc('admin_restore_profile', { p_id: id }); toast('Back on the site.'); viewProfiles(); }
      catch (e) { toast(explain(e)); }
      return;
    }
    if (act === 'toggle') {
      try {
        await rpc('admin_set_visible', { p_id: id, p_visible: !row.visible });
        toast(row.visible ? 'Hidden from search.' : 'Back in search.');
        viewProfiles();
      } catch (e) { toast(explain(e)); }
      return;
    }
    if (act === 'delete') {
      if (!confirm('Erase "' + (row.full_name || 'this profile') +
        '" from the database for good?\n\nThis is not the same as the member deleting it — that keeps ' +
        'a copy here for you. This removes the row entirely, along with every interest, shortlist ' +
        'entry and report attached to it. It cannot be undone.')) return;
      try {
        await rpc('admin_delete_profile', { p_id: id });
        toast('Erased permanently.');
        viewProfiles();
      } catch (e) { toast(explain(e)); }
    }
  }

  const FIELDS = [
    ['full_name', 'Full name', 'text', 'full'],
    ['created_for', 'Profile for', 'select', '', [['son', 'Son (groom)'], ['daughter', 'Daughter (bride)']]],
    ['dob', 'Date of birth', 'date'],
    ['height', 'Height', 'text'],
    ['marital_status', 'Marital status', 'select', '', [['', '—'], ['never_married', 'Never married'], ['divorced', 'Divorced'], ['widowed', 'Widowed']]],
    ['city', 'City / town', 'list:dl_city'],
    ['state', 'State', 'list:dl_state'],
    ['country', 'Country', 'list:dl_country'],
    ['gotram', 'Gotram', 'list:dl_gotram'],
    ['nakshatra', 'Nakshatra', 'list:dl_nakshatra'],
    ['rasi', 'Rasi', 'list:dl_rasi'],
    ['horoscope_gunas', 'Horoscope gunas', 'text'],
    ['education', 'Education', 'list:dl_education'],
    ['profession', 'Profession', 'list:dl_profession'],
    ['income_lpa', 'Annual income (LPA)', 'number'],
    ['work_location', 'Work location', 'list:dl_city'],
    ['contact_phone', 'Contact number', 'text'],
    ['status', 'Listing status', 'select', '', [['published', 'Published'], ['draft', 'Draft']]],
    ['about', 'About the family', 'textarea', 'full']
  ];

  function openProfileEditor(row) {
    const isNew = !row;
    modalTitle.textContent = isNew ? 'New profile' : 'Edit profile';

    const field = ([key, label, type, cls, opts]) => {
      const v = row ? (row[key] == null ? '' : row[key]) : '';
      let input;
      if (type === 'textarea') {
        input = '<textarea id="f_' + key + '" rows="3">' + esc(v) + '</textarea>';
      } else if (type === 'select') {
        input = '<select id="f_' + key + '">' + opts.map(([ov, ol]) =>
          '<option value="' + ov + '"' + (String(v) === ov ? ' selected' : '') + '>' + esc(ol) + '</option>').join('') + '</select>';
      } else if (String(type).startsWith('list:')) {
        input = '<input id="f_' + key + '" type="text" list="' + type.slice(5) +
                '" autocomplete="off" value="' + esc(v) + '">';
      } else {
        input = '<input id="f_' + key + '" type="' + type + '" value="' + esc(v) + '">';
      }
      return '<div class="' + (cls || '') + '"><label for="f_' + key + '">' + esc(label) + '</label>' + input + '</div>';
    };

    const files = !row ? '' :
      '<div class="ad-files" style="margin-bottom:16px;">' +
        (row.has_photo
          ? '<button type="button" class="ad-filelink" data-file="' + esc(row.photo_path) + '">' +
            icon('eye') + ' Open photo</button>'
          : '<span class="ad-meta">No photo uploaded</span>') +
        (row.has_jathagam
          ? '<button type="button" class="ad-filelink" data-file="' + esc(row.jathagam_path) + '">' +
            icon('ticket') + ' Open jathagam</button>'
          : '<span class="ad-meta">No jathagam uploaded</span>') +
      '</div>';

    modalBody.innerHTML = files +
      '<div class="ad-form">' + FIELDS.map(field).join('') +
        '<div class="full"><label for="f_interests">Interests (comma separated)</label>' +
        '<input id="f_interests" type="text" value="' +
          esc(((row && row.interests) || []).join(', ')) + '"></div>' +
        '<div class="full"><label><input type="checkbox" id="f_visible"' +
          (!row || row.visible ? ' checked' : '') + '> Visible in search</label></div>' +
      '</div>' +
      (isNew ? '<p class="ad-cardsub" style="margin-top:14px;">A profile created here is a demo row — ' +
               'it has no login account behind it, and <code>delete from parent_profiles where is_demo;</code> ' +
               'clears every one of them at once.</p>' : '') +
      '<div class="ad-formactions">' +
        (isNew ? '' : '<button class="ad-btn danger" id="adDel">' + icon('trash') + ' Delete</button>') +
        '<button class="ad-btn" id="adCancel">Cancel</button>' +
        '<button class="ad-btn primary" id="adSave">' + icon('check') + ' ' +
          (isNew ? 'Create profile' : 'Save changes') + '</button>' +
      '</div>';

    modal.hidden = false;
    document.body.style.overflow = 'hidden';

    modalBody.querySelectorAll('[data-file]').forEach((b) => {
      b.onclick = () => openFile(b.dataset.file);
    });
    $('adCancel').onclick = closeModal;
    if ($('adDel')) $('adDel').onclick = async () => {
      if (!confirm('Delete "' + (row.full_name || 'this profile') + '" for good?')) return;
      try { await rpc('admin_delete_profile', { p_id: row.id }); closeModal(); toast('Profile deleted.'); viewProfiles(); }
      catch (e) { toast(explain(e)); }
    };
    $('adSave').onclick = async () => {
      const data = {};
      FIELDS.forEach(([key]) => { data[key] = ($('f_' + key).value || '').trim(); });
      data.visible = $('f_visible').checked;
      data.interests = ($('f_interests').value || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (data.income_lpa) data.annual_income = '₹' + data.income_lpa + ' LPA';
      if (!data.full_name) { toast('A name is needed.'); return; }
      $('adSave').disabled = true;
      try {
        await rpc('admin_save_profile', { p_id: row ? row.id : null, p_data: data });
        closeModal();
        toast(isNew ? 'Profile created.' : 'Saved.');
        viewProfiles();
      } catch (e) { toast(explain(e)); $('adSave').disabled = false; }
    };
  }

  function closeModal() { modal.hidden = true; document.body.style.overflow = ''; }
  $('adModalClose').onclick = closeModal;
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

  function exportCsv(rows) {
    const cols = ['full_name', 'created_for', 'age', 'gotram', 'city', 'state', 'country',
                  'profession', 'annual_income', 'education', 'contact_phone', 'status',
                  'visible', 'is_demo', 'owner_email', 'created_at'];
    const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = [cols.join(',')].concat(
      rows.map((r) => cols.map((c) => cell(r[c])).join(','))).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'padmasaliya-profiles-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('CSV downloaded.');
  }

  // =====================================================================
  //  REPORTS
  // =====================================================================

  async function viewReports() {
    busy();
    const rows = await rpc('admin_list_reports', { p_status: state.reports.status || null });

    main.innerHTML =
      '<div class="ad-h"><h1>Reports</h1></div>' +
      '<p class="ad-sub">Members report a profile from the shield button. Three open reports on the ' +
        'same profile hides it automatically, before anyone has looked.</p>' +
      '<div class="ad-tools">' +
        '<select id="adRepStatus">' +
          [['open', 'Open'], ['reviewing', 'Reviewing'], ['actioned', 'Actioned'],
           ['dismissed', 'Dismissed'], ['', 'All']].map(([v, l]) =>
            '<option value="' + v + '"' + (state.reports.status === v ? ' selected' : '') + '>' + l + '</option>').join('') +
        '</select>' +
      '</div>' +
      (rows.length ? rows.map(reportCard).join('')
        : '<div class="ad-card"><div class="ad-empty">Nothing here. ' +
          (state.reports.status === 'open' ? 'No reports are waiting.' : 'No reports with that status.') +
          '</div></div>');

    $('adRepStatus').onchange = () => { state.reports.status = $('adRepStatus').value; viewReports(); };
    main.querySelectorAll('[data-report]').forEach((b) => {
      b.onclick = async () => {
        const act = b.dataset.action;
        if (act === 'delete' && !confirm('Delete this profile for good?')) return;
        b.disabled = true;
        try {
          await rpc('admin_action_report', { p_id: b.dataset.report, p_action: act });
          toast({ dismiss: 'Dismissed — profile stays live.', hide: 'Profile hidden.',
                  delete: 'Profile deleted.', reviewing: 'Marked as reviewing.' }[act]);
          viewReports();
        } catch (e) { toast(explain(e)); b.disabled = false; }
      };
    });
  }

  function reportCard(r) {
    const done = r.status === 'actioned' || r.status === 'dismissed';
    return '<div class="ad-report' + (done ? ' resolved' : '') + '">' +
      '<div class="ad-report-head">' +
        '<b>' + esc(r.profile_name || 'Profile') + '</b>' +
        '<span class="ad-pill ' + (done ? 'live' : 'hidden') + '">' + esc(r.status) + '</span>' +
        (r.profile_visible ? '' : '<span class="ad-pill hidden">currently hidden</span>') +
        (r.other_reports > 0 ? '<span class="ad-pill incomplete">' + r.other_reports +
          ' other report' + (r.other_reports > 1 ? 's' : '') + '</span>' : '') +
        '<span class="ad-meta" style="margin-left:auto;">' + ago(r.created_at) + '</span>' +
      '</div>' +
      '<p><span class="ad-reason">' + esc(r.reason) + '</span>' +
        (r.details ? ' — ' + esc(r.details) : '') + '</p>' +
      '<p class="ad-meta">' + esc(r.profile_gotram || '') +
        (r.profile_place ? ' · ' + esc(r.profile_place) : '') +
        (r.profile_phone ? ' · ' + esc(r.profile_phone) : '') +
        ' · reported by ' + esc(r.reporter_email || 'a member') + '</p>' +
      (done ? '' :
      '<div class="ad-report-actions">' +
        '<button class="ad-btn" data-report="' + esc(r.id) + '" data-action="dismiss">' +
          icon('check') + ' Nothing wrong</button>' +
        '<button class="ad-btn" data-report="' + esc(r.id) + '" data-action="reviewing">Looking into it</button>' +
        '<button class="ad-btn danger" data-report="' + esc(r.id) + '" data-action="hide">' +
          icon('eye-off') + ' Hide profile</button>' +
        '<button class="ad-btn danger" data-report="' + esc(r.id) + '" data-action="delete">' +
          icon('trash') + ' Delete profile</button>' +
      '</div>') +
    '</div>';
  }

  // =====================================================================
  //  MEMBERS
  // =====================================================================

  async function viewMembers() {
    busy();
    const st = state.members;
    const res = await rpc('admin_list_members', {
      p_search: st.search || null, p_filter: st.filter || null,
      p_limit: PAGE, p_offset: st.page * PAGE
    });
    st.total = res.total;

    const rows = res.rows.map((r) =>
      '<tr data-uid="' + esc(r.user_id) + '">' +
        '<td><div class="ad-name">' + esc(r.email || r.phone || '—') + '</div>' +
          '<div class="ad-meta">' + esc(r.profile_name || 'no profile') + '</div></td>' +
        '<td class="nowrap">' +
          (r.premium_active ? '<span class="ad-pill premium">Premium</span>' : '<span class="ad-pill free">Free</span>') +
          (r.is_admin ? ' <span class="ad-pill admin">Admin</span>' : '') + '</td>' +
        '<td class="nowrap ad-meta">' + (r.premium_until ? date(r.premium_until) : '—') +
          (r.granted_by ? '<div class="ad-meta">' + esc(r.granted_by) + '</div>' : '') + '</td>' +
        '<td class="nowrap ad-meta">' + date(r.joined) + '</td>' +
        '<td class="nowrap ad-meta">' + ago(r.last_sign_in) + '</td>' +
        '<td><div class="ad-rowactions">' +
          (r.premium_active
            ? '<button class="ad-btn danger" data-act="cancel">Cancel premium</button>'
            : '<button class="ad-btn" data-act="grant">Give premium</button>') +
        '</div></td>' +
      '</tr>').join('');

    main.innerHTML =
      '<div class="ad-h"><h1>Members</h1></div>' +
      '<p class="ad-sub">' + num(st.total) + ' account' + (st.total === 1 ? '' : 's') +
        '. Premium is granted here or by an activation code the member redeems themselves.</p>' +
      '<div class="ad-tools">' +
        '<input type="search" id="adMSearch" placeholder="Email or phone…" value="' + esc(st.search) + '">' +
        '<select id="adMFilter">' +
          [['', 'Everyone'], ['premium', 'Premium'], ['free', 'Free'],
           ['admin', 'Admins'], ['noprofile', 'No profile yet']].map(([v, l]) =>
            '<option value="' + v + '"' + (st.filter === v ? ' selected' : '') + '>' + l + '</option>').join('') +
        '</select>' +
        '<button class="ad-btn" id="adMSearchBtn">' + icon('search') + ' Search</button>' +
      '</div>' +
      (res.rows.length
        ? '<div class="ad-tablewrap"><table class="ad-table"><thead><tr>' +
            '<th>Account</th><th>Plan</th><th>Premium until</th><th>Joined</th>' +
            '<th>Last sign-in</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="ad-tablewrap"><div class="ad-empty">No accounts match that.</div></div>') +
      pager(st, 'members');

    $('adMSearchBtn').onclick = () => { st.search = $('adMSearch').value.trim(); st.page = 0; viewMembers(); };
    $('adMSearch').onkeydown = (e) => { if (e.key === 'Enter') $('adMSearchBtn').click(); };
    $('adMFilter').onchange = () => { st.filter = $('adMFilter').value; st.page = 0; viewMembers(); };
    wirePager(st, viewMembers);

    main.querySelectorAll('tr[data-uid]').forEach((tr) => {
      tr.querySelectorAll('[data-act]').forEach((b) => {
        b.onclick = async () => {
          const uid = tr.dataset.uid;
          try {
            if (b.dataset.act === 'grant') {
              const months = prompt('Give premium for how many months?', '12');
              if (months === null) return;
              b.disabled = true;
              await rpc('admin_set_premium', { p_user_id: uid, p_months: parseInt(months, 10) || 12 });
              toast('Premium granted.');
            } else {
              if (!confirm('Cancel this member’s premium now?')) return;
              b.disabled = true;
              await rpc('admin_cancel_premium', { p_user_id: uid });
              toast('Premium cancelled.');
            }
            viewMembers();
          } catch (e) { toast(explain(e)); b.disabled = false; }
        };
      });
    });
  }

  // =====================================================================
  //  PREMIUM CODES
  // =====================================================================

  async function viewCodes() {
    busy();
    const rows = await rpc('admin_list_codes', { p_limit: 200 });
    const unused = rows.filter((c) => c.used_count < c.max_uses);

    main.innerHTML =
      '<div class="ad-h"><h1>Premium codes</h1></div>' +
      '<p class="ad-sub">Collect the money by UPI or in person and hand over a code. The member types ' +
        'it into their dashboard and premium switches on. No payment gateway needed.</p>' +
      '<div class="ad-tools">' +
        '<input type="number" id="adCodeCount" value="10" min="1" max="200" style="max-width:110px;" aria-label="How many">' +
        '<select id="adCodeMonths" aria-label="Months">' +
          [3, 6, 12, 24].map((m) => '<option value="' + m + '"' + (m === 12 ? ' selected' : '') + '>' +
            m + ' months</option>').join('') + '</select>' +
        '<input type="text" id="adCodeNote" placeholder="Batch name — e.g. Gold 2026" style="max-width:220px;">' +
        '<button class="ad-btn primary" id="adCodeGen">' + icon('plus') + ' Generate</button>' +
        (unused.length ? '<button class="ad-btn" id="adCodeCopy">Copy ' + unused.length + ' unused</button>' : '') +
      '</div>' +
      (rows.length
        ? '<div class="ad-tablewrap"><table class="ad-table"><thead><tr>' +
            '<th>Code</th><th>Months</th><th>Used</th><th>Batch</th><th>Redeemed by</th><th>Created</th>' +
          '</tr></thead><tbody>' + rows.map((c) =>
            '<tr><td><b style="font-family:monospace;font-size:13.5px;">' + esc(c.code) + '</b></td>' +
            '<td class="num">' + c.months + '</td>' +
            '<td class="num">' + c.used_count + ' / ' + c.max_uses + '</td>' +
            '<td class="ad-meta">' + esc(c.note || '—') + '</td>' +
            '<td class="ad-meta">' + esc((c.redeemed_by || []).join(', ') || '—') + '</td>' +
            '<td class="nowrap ad-meta">' + date(c.created_at) + '</td></tr>').join('') +
          '</tbody></table></div>'
        : '<div class="ad-tablewrap"><div class="ad-empty">No codes yet. Generate a batch above.</div></div>');

    $('adCodeGen').onclick = async () => {
      const btn = $('adCodeGen');
      btn.disabled = true;
      try {
        const r = await rpc('admin_create_codes', {
          p_count: parseInt($('adCodeCount').value, 10) || 10,
          p_months: parseInt($('adCodeMonths').value, 10) || 12,
          p_note: $('adCodeNote').value.trim() || null
        });
        toast((r.codes || []).length + ' codes ready.');
        viewCodes();
      } catch (e) { toast(explain(e)); btn.disabled = false; }
    };
    if ($('adCodeCopy')) $('adCodeCopy').onclick = async () => {
      const text = unused.map((c) => c.code).join('\n');
      try { await navigator.clipboard.writeText(text); toast('Copied ' + unused.length + ' codes.'); }
      catch (e) { toast('Could not copy — select them from the table instead.'); }
    };
  }

  // =====================================================================
  //  WAITLIST
  // =====================================================================

  async function viewWaitlist() {
    busy();
    const rows = await rpc('admin_list_waitlist', { p_only_pending: false });
    const pending = rows.filter((r) => !r.notified_at);

    main.innerHTML =
      '<div class="ad-h"><h1>Waitlist</h1></div>' +
      '<p class="ad-sub">Everyone who tapped “Notify me” for the Bride &amp; Groom app. ' +
        num(pending.length) + ' still to be told.</p>' +
      '<div class="ad-tools">' +
        (pending.length
          ? '<button class="ad-btn" id="adWlCopy">' + icon('download') +
            ' Copy ' + pending.length + ' numbers</button>' +
            '<button class="ad-btn primary" id="adWlMark">' + icon('check') + ' Mark all as notified</button>'
          : '') +
      '</div>' +
      (rows.length
        ? '<div class="ad-tablewrap"><table class="ad-table"><thead><tr>' +
            '<th>Contact</th><th>Role</th><th>Where from</th><th>Joined</th><th>Notified</th>' +
          '</tr></thead><tbody>' + rows.map((r) =>
            '<tr><td><b>' + esc(r.contact) + '</b></td>' +
            '<td class="ad-meta">' + esc(r.role || '—') + '</td>' +
            '<td class="ad-meta">' + esc(r.source || '—') + '</td>' +
            '<td class="nowrap ad-meta">' + date(r.created_at) + '</td>' +
            '<td class="nowrap">' + (r.notified_at
              ? '<span class="ad-pill live">' + date(r.notified_at) + '</span>'
              : '<span class="ad-pill incomplete">waiting</span>') + '</td></tr>').join('') +
          '</tbody></table></div>'
        : '<div class="ad-tablewrap"><div class="ad-empty">Nobody has joined the waitlist yet.</div></div>');

    if ($('adWlCopy')) $('adWlCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(pending.map((r) => r.contact).join('\n'));
        toast('Copied ' + pending.length + ' numbers — paste into your WhatsApp broadcast.'); }
      catch (e) { toast('Could not copy.'); }
    };
    if ($('adWlMark')) $('adWlMark').onclick = async () => {
      if (!confirm('Mark all ' + pending.length + ' as notified?\n\nDo this after you have actually sent the message.')) return;
      try { const r = await rpc('admin_mark_waitlist_notified'); toast(r.marked + ' marked as notified.'); viewWaitlist(); }
      catch (e) { toast(explain(e)); }
    };
  }

  // =====================================================================
  //  PAGER + TABS
  // =====================================================================

  function pager(st, kind) {
    const pages = Math.max(1, Math.ceil(st.total / PAGE));
    if (pages <= 1) return '';
    return '<div class="ad-pager">' +
      '<button class="ad-btn" id="adPrev"' + (st.page === 0 ? ' disabled' : '') + '>Previous</button>' +
      '<span>Page ' + (st.page + 1) + ' of ' + pages + '</span>' +
      '<button class="ad-btn" id="adNext"' + (st.page + 1 >= pages ? ' disabled' : '') + '>Next</button></div>';
  }
  function wirePager(st, render) {
    if ($('adPrev')) $('adPrev').onclick = () => { st.page = Math.max(0, st.page - 1); render(); };
    if ($('adNext')) $('adNext').onclick = () => { st.page += 1; render(); };
  }

  const VIEWS = { overview: viewOverview, profiles: viewProfiles, reports: viewReports,
                  members: viewMembers, codes: viewCodes, waitlist: viewWaitlist };

  async function go(name) {
    if (!VIEWS[name]) name = 'overview';
    tab = name;
    document.querySelectorAll('.ad-navitem').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === name));
    document.body.classList.remove('adnav-open');
    history.replaceState(null, '', '#' + name);
    try { await VIEWS[name](); }
    catch (e) { main.innerHTML = '<div class="ad-card"><div class="ad-empty">' + esc(explain(e)) + '</div></div>'; }
  }

  document.querySelectorAll('.ad-navitem').forEach((b) => { b.onclick = () => go(b.dataset.tab); });
  $('adBurger').onclick = () => document.body.classList.toggle('adnav-open');
  $('adSignOut').onclick = async () => {
    await supabaseClient.auth.signOut();
    window.location.href = 'home.html';
  };
  // Locking clears the unlock in the DATABASE, so it locks every device at
  // once — not just this browser tab.
  $('adLockBtn').onclick = async () => {
    try { await rpc('admin_lock'); } catch (e) {}
    window.location.reload();
  };
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('adnav-open') &&
        !e.target.closest('.ad-nav') && !e.target.closest('.ad-burger')) {
      document.body.classList.remove('adnav-open');
    }
  });

  // =====================================================================
  //  BOOT
  // =====================================================================

  (async function init() {
    const { data: s } = await supabaseClient.auth.getSession();
    if (!s || !s.session) { window.location.href = 'login.html'; return; }
    me = s.session.user;

    // Ask the database, not the browser, whether this account may be here.
    let status;
    try { status = await rpc('my_status'); }
    catch (e) {
      gate.hidden = false;
      $('adGateTitle').textContent = 'Cannot reach the server';
      $('adGateText').textContent = explain(e);
      return;
    }

    if (!status.admin) {
      gate.hidden = false;
      $('adGateText').textContent =
        me.email + ' is not an administrator of this site. Ask the owner to add you, ' +
        'or sign in with the owner account.';
      return;
    }

    // Second lock. The state lives in the database, so this is not a screen
    // that can be clicked past — assert_admin() refuses while it is locked.
    const lock = await rpc('admin_lock_state');
    if (!lock.has_password || !lock.unlocked) { showLock(lock); return; }

    await openPanel();
  })();

  function showLock(lock) {
    const first = !lock.has_password;
    $('adLock').hidden = false;
    $('adLockTitle').textContent = first ? 'Choose an admin password' : 'Admin password';
    $('adLockText').textContent = first
      ? 'Your email login proves who you are. This second password protects the panel if a ' +
        'signed-in laptop is ever left open. At least 8 characters.'
      : 'Enter the admin password to open the panel.';
    $('adPw').placeholder = first ? 'New password' : 'Password';
    $('adPw').setAttribute('autocomplete', first ? 'new-password' : 'current-password');
    $('adPw2').hidden = !first;
    $('adPw2').required = first;
    $('adLockGo').textContent = first ? 'Set password and open' : 'Unlock';
    $('adLockHint').textContent = first
      ? 'Write it down somewhere safe. If it is ever lost the owner can clear it from the Supabase SQL editor.'
      : 'The panel stays unlocked for two hours, then asks again.';

    if (lock.locked_out) {
      $('adLockErr').hidden = false;
      $('adLockErr').textContent = 'Too many wrong tries. Try again after ' +
        new Date(lock.locked_until).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) + '.';
    }

    $('adLockForm').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('adLockGo');
      const pw = $('adPw').value;
      $('adLockErr').hidden = true;
      if (first && pw !== $('adPw2').value) {
        $('adLockErr').hidden = false;
        $('adLockErr').textContent = 'The two passwords do not match.';
        return;
      }
      btn.disabled = true;
      try {
        if (first) await rpc('admin_set_password', { p_new: pw, p_current: null });
        else await rpc('admin_unlock', { p_password: pw });
        $('adLock').hidden = true;
        $('adPw').value = ''; $('adPw2').value = '';
        await openPanel();
      } catch (err) {
        $('adLockErr').hidden = false;
        $('adLockErr').textContent = explain(err);
        btn.disabled = false;
      }
    };
    $('adPw').focus();
  }

  async function openPanel() {
    shell.hidden = false;
    $('adWho').textContent = me.email || '';
    if (typeof REF !== 'undefined') {
      REF.fillList('dl_city', REF.CITY);       REF.fillList('dl_state', REF.STATE);
      REF.fillList('dl_country', REF.COUNTRY); REF.fillList('dl_gotram', REF.GOTRAM);
      REF.fillList('dl_nakshatra', REF.NAKSHATRA); REF.fillList('dl_rasi', REF.RASI);
      REF.fillList('dl_education', REF.EDUCATION); REF.fillList('dl_profession', REF.PROFESSION);
      REF.fillList('dl_interest', REF.INTEREST);
    }

    await go((location.hash || '').replace('#', '') || 'overview');
    window.addEventListener('hashchange', () => {
      const h = (location.hash || '').replace('#', '');
      if (VIEWS[h] && h !== tab) go(h);
    });
  }
})();
