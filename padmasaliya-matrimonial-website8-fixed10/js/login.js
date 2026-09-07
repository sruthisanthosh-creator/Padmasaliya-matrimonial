// ---- Login flow (Supabase Auth) ----
// Two ways in:
//   * Email  — sends a "magic link". User clicks it in their inbox and is signed in.
//              Works with Supabase's built-in email service, no template editing needed.
//   * Phone  — 6-digit SMS OTP. Needs the Phone provider + an SMS provider
//              (Twilio / MSG91) configured in Supabase. Optional.

let resendTimer = null;
let resendSeconds = 30;
let channel = 'email';          // 'email' | 'phone'  (email is the default)
let pendingPhone = '';
let pendingEmail = '';
let routing = false;            // guards against double navigation

const stepPhone = document.getElementById('stepPhone');
const stepOtp = document.getElementById('stepOtp');
const stepEmailSent = document.getElementById('stepEmailSent');
const phoneInput = document.getElementById('phoneInput');
const emailInput = document.getElementById('emailInput');
const phoneFieldWrap = document.getElementById('phoneFieldWrap');
const emailFieldWrap = document.getElementById('emailFieldWrap');
const switchChannelBtn = document.getElementById('switchChannelBtn');
const phoneError = document.getElementById('phoneError');
const sendOtpBtn = document.getElementById('sendOtpBtn');
const otpSentTo = document.getElementById('otpSentTo');
const emailSentTo = document.getElementById('emailSentTo');
const otpBoxes = document.querySelectorAll('.otp-box');
const otpError = document.getElementById('otpError');
const verifyOtpBtn = document.getElementById('verifyOtpBtn');
const resendLink = document.getElementById('resendLink');
const changeNumberBtn = document.getElementById('changeNumberBtn');
const resendLinkBtn = document.getElementById('resendLinkBtn');
const changeEmailBtn = document.getElementById('changeEmailBtn');

// Where the magic link should send people back to.
const RETURN_URL = new URL('login.html', window.location.href).href;

// ---------------------------------------------------------------
// After a successful sign-in (typed OTP, or returning from a magic
// link), decide whether to go to the dashboard or to Create Profile.
// ---------------------------------------------------------------
async function routeAfterLogin(session) {
  if (routing || !session) return;
  routing = true;
  const { data: existing } = await supabaseClient
    .from('parent_profiles')
    .select('id')
    .eq('parent_user_id', session.user.id)
    .limit(1);
  window.location.href = (existing && existing.length > 0) ? 'dashboard.html' : 'create-profile.html';
}

// Fires when the magic-link tokens in the URL are processed, and for an
// already-signed-in visitor.
supabaseClient.auth.onAuthStateChange((event, session) => {
  if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
    routeAfterLogin(session);
  }
});

(async function checkExistingSession() {
  const { data } = await supabaseClient.auth.getSession();
  if (data && data.session) routeAfterLogin(data.session);
})();

// ---------------------------------------------------------------
// Channel switch (email <-> phone)
// ---------------------------------------------------------------
function applyChannel() {
  const isPhone = channel === 'phone';
  if (phoneFieldWrap) phoneFieldWrap.hidden = !isPhone;
  if (emailFieldWrap) emailFieldWrap.hidden = isPhone;
  if (switchChannelBtn) {
    switchChannelBtn.textContent = isPhone ? 'Use email instead' : 'Use mobile number instead';
  }
  const otpLabel = (translations[currentLang] && translations[currentLang].login && translations[currentLang].login.sendOtp) || 'Send OTP →';
  const linkLabel = currentLang === 'ta' ? 'உள்நுழைவு இணைப்பை அனுப்பு →'
    : currentLang === 'te' ? 'లాగిన్ లింక్ పంపండి →'
    : 'Send login link →';
  sendOtpBtn.textContent = isPhone ? otpLabel : linkLabel;
  phoneError.style.display = 'none';
}
applyChannel();

if (switchChannelBtn) {
  switchChannelBtn.addEventListener('click', () => {
    channel = channel === 'phone' ? 'email' : 'phone';
    applyChannel();
  });
}

if (phoneInput) {
  phoneInput.addEventListener('input', () => {
    phoneInput.value = phoneInput.value.replace(/\D/g, '').slice(0, 10);
    phoneError.style.display = 'none';
  });
}
if (emailInput) {
  emailInput.addEventListener('input', () => { phoneError.style.display = 'none'; });
  emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendOtpBtn.click(); });
}

function showError(msg) {
  phoneError.textContent = msg;
  phoneError.style.display = 'block';
}

// ---------------------------------------------------------------
// Send the code / link
// ---------------------------------------------------------------
sendOtpBtn.addEventListener('click', () => {
  if (channel === 'phone') {
    if ((phoneInput.value || '').trim().length !== 10) {
      showError('Please enter a valid 10-digit mobile number.');
      return;
    }
  } else {
    const em = (emailInput.value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      showError('Please enter a valid email address.');
      return;
    }
  }
  sendLogin();
});

async function sendLogin() {
  const original = sendOtpBtn.textContent;
  sendOtpBtn.disabled = true;
  sendOtpBtn.textContent = 'Sending...';

  let error;
  if (channel === 'phone') {
    pendingPhone = '+91' + phoneInput.value.trim();
    ({ error } = await supabaseClient.auth.signInWithOtp({ phone: pendingPhone }));
  } else {
    pendingEmail = emailInput.value.trim();
    ({ error } = await supabaseClient.auth.signInWithOtp({
      email: pendingEmail,
      options: { shouldCreateUser: true, emailRedirectTo: RETURN_URL }
    }));
  }

  sendOtpBtn.disabled = false;
  sendOtpBtn.textContent = original;

  if (error) {
    showError(error.message || 'Could not send. Please try again.');
    return;
  }

  stepPhone.classList.remove('active');

  if (channel === 'phone') {
    const prefix = (translations[currentLang] && translations[currentLang].login && translations[currentLang].login.otpSubtitlePrefix)
      || 'Enter the 6-digit code sent to';
    otpSentTo.textContent = prefix + ' +91 ' + phoneInput.value.trim();
    stepOtp.classList.add('active');
    otpBoxes.forEach(b => b.value = '');
    otpBoxes[0].focus();
    startResendTimer();
    showToast(currentLang === 'en' ? 'OTP sent' : (currentLang === 'ta' ? 'OTP அனுப்பப்பட்டது' : 'OTP పంపబడింది'));
  } else {
    emailSentTo.textContent = 'We sent a login link to ' + pendingEmail;
    stepEmailSent.classList.add('active');
    showToast(currentLang === 'en' ? 'Login link sent' : (currentLang === 'ta' ? 'இணைப்பு அனுப்பப்பட்டது' : 'లింక్ పంపబడింది'));
  }
}

// ---------------------------------------------------------------
// Email step: resend / change address
// ---------------------------------------------------------------
if (resendLinkBtn) {
  resendLinkBtn.addEventListener('click', async () => {
    resendLinkBtn.textContent = 'Sending...';
    const { error } = await supabaseClient.auth.signInWithOtp({
      email: pendingEmail,
      options: { shouldCreateUser: true, emailRedirectTo: RETURN_URL }
    });
    resendLinkBtn.textContent = 'Resend the email';
    showToast(error ? error.message : 'Login link sent again');
  });
}
if (changeEmailBtn) {
  changeEmailBtn.addEventListener('click', () => {
    stepEmailSent.classList.remove('active');
    stepPhone.classList.add('active');
  });
}

// ---------------------------------------------------------------
// Phone step: OTP boxes, resend timer, verify
// ---------------------------------------------------------------
function startResendTimer() {
  resendSeconds = 30;
  resendLink.classList.add('disabled');
  clearInterval(resendTimer);
  updateResendLabel();
  resendTimer = setInterval(() => {
    resendSeconds--;
    if (resendSeconds <= 0) {
      clearInterval(resendTimer);
      resendLink.classList.remove('disabled');
      resendLink.textContent = currentLang === 'en' ? 'Resend OTP' : (currentLang === 'ta' ? 'மீண்டும் அனுப்பு' : 'మళ్లీ పంపండి');
    } else {
      updateResendLabel();
    }
  }, 1000);
}
function updateResendLabel() {
  const base = currentLang === 'en' ? 'Resend in' : (currentLang === 'ta' ? 'மீண்டும் அனுப்ப' : 'మళ్లీ పంపడానికి');
  resendLink.textContent = base + ' ' + resendSeconds + 's';
}
resendLink.addEventListener('click', () => {
  if (resendLink.classList.contains('disabled')) return;
  sendLogin();
});

otpBoxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/\D/g, '').slice(0, 1);
    otpError.style.display = 'none';
    if (box.value && i < otpBoxes.length - 1) otpBoxes[i + 1].focus();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) otpBoxes[i - 1].focus();
  });
  box.addEventListener('paste', (e) => {
    const txt = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!txt) return;
    e.preventDefault();
    otpBoxes.forEach((b, k) => b.value = txt[k] || '');
    otpBoxes[Math.min(txt.length, 5)].focus();
  });
});

verifyOtpBtn.addEventListener('click', async () => {
  const entered = Array.from(otpBoxes).map(b => b.value).join('');
  if (entered.length !== 6) {
    otpError.textContent = (translations[currentLang] && translations[currentLang].login && translations[currentLang].login.otpIncomplete)
      || 'Please enter all 6 digits.';
    otpError.style.display = 'block';
    return;
  }

  verifyOtpBtn.disabled = true;
  const { data, error } = await supabaseClient.auth.verifyOtp({
    phone: pendingPhone, token: entered, type: 'sms'
  });
  verifyOtpBtn.disabled = false;

  if (error || !data || !data.session) {
    otpError.textContent = (error && error.message)
      || (translations[currentLang] && translations[currentLang].login && translations[currentLang].login.otpError)
      || 'Incorrect OTP. Please try again.';
    otpError.style.display = 'block';
    return;
  }
  routeAfterLogin(data.session);
});

changeNumberBtn.addEventListener('click', () => {
  clearInterval(resendTimer);
  stepOtp.classList.remove('active');
  stepPhone.classList.add('active');
});
