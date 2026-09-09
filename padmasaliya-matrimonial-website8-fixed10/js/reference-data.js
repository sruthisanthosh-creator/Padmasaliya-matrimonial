// ---- Reference lists for the profile form -------------------------------
// Every one of these backs a <datalist>, not a <select>: the parent gets
// suggestions as they type but can still enter something the list does not
// have. A community list can never be complete, and a form that refuses a
// real gotram or a real village is worse than one that accepts a typo.

window.REF = (function () {
  'use strict';

  // ---- 27 nakshatras, with the rasi each one mostly falls in ----
  // A few nakshatras straddle two rasis by pada; the rasi named here is the
  // one the nakshatra sits in for most of its span. The form offers it as a
  // suggestion the parent can overwrite, never as a fact.
  const NAKSHATRA_RASI = [
    ['Ashwini',            'Mesha (Aries)'],
    ['Bharani',            'Mesha (Aries)'],
    ['Krittika',           'Vrishabha (Taurus)'],
    ['Rohini',             'Vrishabha (Taurus)'],
    ['Mrigashira',         'Mithuna (Gemini)'],
    ['Ardra',              'Mithuna (Gemini)'],
    ['Punarvasu',          'Mithuna (Gemini)'],
    ['Pushya',             'Karka (Cancer)'],
    ['Ashlesha',           'Karka (Cancer)'],
    ['Magha',              'Simha (Leo)'],
    ['Purva Phalguni',     'Simha (Leo)'],
    ['Uttara Phalguni',    'Kanya (Virgo)'],
    ['Hasta',              'Kanya (Virgo)'],
    ['Chitra',             'Kanya (Virgo)'],
    ['Swati',              'Tula (Libra)'],
    ['Vishakha',           'Tula (Libra)'],
    ['Anuradha',           'Vrischika (Scorpio)'],
    ['Jyeshtha',           'Vrischika (Scorpio)'],
    ['Mula',               'Dhanu (Sagittarius)'],
    ['Purva Ashadha',      'Dhanu (Sagittarius)'],
    ['Uttara Ashadha',     'Makara (Capricorn)'],
    ['Shravana',           'Makara (Capricorn)'],
    ['Dhanishta',          'Makara (Capricorn)'],
    ['Shatabhisha',        'Kumbha (Aquarius)'],
    ['Purva Bhadrapada',   'Kumbha (Aquarius)'],
    ['Uttara Bhadrapada',  'Meena (Pisces)'],
    ['Revati',             'Meena (Pisces)']
  ];

  const RASI = [
    'Mesha (Aries)', 'Vrishabha (Taurus)', 'Mithuna (Gemini)', 'Karka (Cancer)',
    'Simha (Leo)', 'Kanya (Virgo)', 'Tula (Libra)', 'Vrischika (Scorpio)',
    'Dhanu (Sagittarius)', 'Makara (Capricorn)', 'Kumbha (Aquarius)', 'Meena (Pisces)'
  ];

  const GOTRAM = [
    'Markandeya', 'Padmarishi', 'Kashyapa', 'Vasishta', 'Bharadwaja', 'Gautama',
    'Atri', 'Vishwamitra', 'Jamadagni', 'Agastya', 'Sandilya', 'Kaundinya',
    'Angirasa', 'Harita', 'Kaushika', 'Maudgalya', 'Parashara', 'Shaunaka',
    'Srivatsa', 'Vadhula', 'Garga', 'Kanva', 'Kutsa', 'Mudgala', 'Sankruti',
    'Upamanyu', 'Dhananjaya', 'Vishnuvardhana'
  ];

  const COUNTRY = [
    'India', 'United Arab Emirates', 'United States', 'United Kingdom', 'Canada',
    'Australia', 'Singapore', 'Malaysia', 'Qatar', 'Saudi Arabia', 'Kuwait',
    'Oman', 'Bahrain', 'New Zealand', 'Germany', 'Ireland', 'Switzerland',
    'South Africa', 'Sri Lanka', 'Nepal'
  ];

  const STATE = [
    'Tamil Nadu', 'Andhra Pradesh', 'Telangana', 'Karnataka', 'Kerala',
    'Maharashtra', 'Puducherry', 'Goa', 'Gujarat', 'Odisha', 'West Bengal',
    'Delhi', 'Uttar Pradesh', 'Madhya Pradesh', 'Rajasthan', 'Punjab',
    'Haryana', 'Bihar', 'Jharkhand', 'Chhattisgarh', 'Assam', 'Uttarakhand',
    'Himachal Pradesh', 'Jammu and Kashmir', 'Tripura', 'Meghalaya',
    'Manipur', 'Nagaland', 'Mizoram', 'Arunachal Pradesh', 'Sikkim',
    'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu',
    'Ladakh', 'Lakshadweep'
  ];

  // Weighted towards where the community actually lives, then the metros
  // people move to for work. Typing anything else still works.
  const CITY = [
    // Tamil Nadu
    'Chennai', 'Coimbatore', 'Madurai', 'Salem', 'Erode', 'Tiruppur', 'Trichy',
    'Vellore', 'Thanjavur', 'Tirunelveli', 'Dindigul', 'Karur', 'Namakkal',
    'Kanchipuram', 'Cuddalore', 'Thoothukudi', 'Hosur', 'Sivakasi', 'Pollachi',
    'Rajapalayam', 'Virudhunagar', 'Nagercoil', 'Kumbakonam', 'Ooty',
    // Andhra Pradesh / Telangana
    'Hyderabad', 'Secunderabad', 'Visakhapatnam', 'Vijayawada', 'Guntur',
    'Nellore', 'Tirupati', 'Rajahmundry', 'Kakinada', 'Warangal', 'Karimnagar',
    'Nizamabad', 'Kurnool', 'Anantapur', 'Kadapa', 'Eluru', 'Ongole',
    'Chittoor', 'Srikakulam', 'Vizianagaram', 'Khammam', 'Mahbubnagar',
    // Karnataka
    'Bengaluru', 'Mysuru', 'Mangaluru', 'Hubballi', 'Belagavi', 'Davangere',
    'Ballari', 'Shivamogga', 'Tumakuru', 'Kalaburagi',
    // Kerala
    'Kochi', 'Thiruvananthapuram', 'Kozhikode', 'Thrissur', 'Kollam',
    'Alappuzha', 'Kannur', 'Palakkad', 'Kottayam', 'Chengannur', 'Malappuram',
    // Rest of India
    'Mumbai', 'Pune', 'Nagpur', 'Nashik', 'Thane', 'Navi Mumbai',
    'Delhi', 'New Delhi', 'Gurugram', 'Noida', 'Faridabad', 'Ghaziabad',
    'Kolkata', 'Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Jaipur', 'Indore',
    'Bhopal', 'Lucknow', 'Kanpur', 'Chandigarh', 'Bhubaneswar', 'Patna',
    'Raipur', 'Guwahati', 'Dehradun', 'Puducherry', 'Panaji',
    // Common abroad
    'Dubai', 'Abu Dhabi', 'Sharjah', 'Doha', 'Muscat', 'Riyadh', 'Kuwait City',
    'Singapore', 'Kuala Lumpur', 'London', 'Manchester', 'Dublin',
    'New York', 'New Jersey', 'Chicago', 'Dallas', 'Houston', 'Seattle',
    'San Francisco', 'Toronto', 'Vancouver', 'Sydney', 'Melbourne', 'Auckland'
  ];

  const INTEREST = [
    'Music', 'Cooking', 'Reading', 'Travel', 'Temple visits', 'Classical dance',
    'Cricket', 'Gardening', 'Photography', 'Movies', 'Yoga', 'Volunteering',
    'Carnatic music', 'Bharatanatyam', 'Painting', 'Trekking', 'Badminton',
    'Chess', 'Writing', 'Fitness', 'Farming', 'Handicrafts', 'Teaching'
  ];

  const EDUCATION = [
    'B.E / B.Tech', 'M.E / M.Tech', 'B.Sc', 'M.Sc', 'B.Com', 'M.Com',
    'B.A', 'M.A', 'BBA', 'MBA', 'BCA', 'MCA', 'MBBS', 'MD', 'BDS', 'BAMS',
    'B.Pharm', 'M.Pharm', 'B.Ed', 'M.Ed', 'LLB', 'LLM', 'CA', 'CS', 'ICWA',
    'Diploma', 'ITI', 'Ph.D', 'Higher Secondary', 'SSLC'
  ];

  const PROFESSION = [
    'Software Engineer', 'Doctor', 'Teacher', 'Lecturer', 'Bank Officer',
    'Chartered Accountant', 'Civil Engineer', 'Mechanical Engineer',
    'Government Employee', 'Business', 'Textile Business', 'Shop Owner',
    'Nurse', 'Pharmacist', 'Lawyer', 'Architect', 'Accountant', 'Designer',
    'Sales Executive', 'Marketing Manager', 'Agriculture', 'Weaving',
    'Self Employed', 'Homemaker', 'Student', 'Retired'
  ];

  // Fills a <datalist> from one of the arrays above.
  function fillList(id, values) {
    const dl = document.getElementById(id);
    if (!dl) return;
    dl.innerHTML = values.map(function (v) {
      return '<option value="' + String(v).replace(/"/g, '&quot;') + '"></option>';
    }).join('');
  }

  // "Rohini" -> "Vrishabha (Taurus)". Tolerant of case and stray spaces so a
  // parent typing "rohini " still gets the suggestion.
  function rasiForNakshatra(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    const hit = NAKSHATRA_RASI.find(function (row) {
      return row[0].toLowerCase() === key;
    });
    return hit ? hit[1] : null;
  }

  return {
    NAKSHATRA: NAKSHATRA_RASI.map(function (r) { return r[0]; }),
    NAKSHATRA_RASI: NAKSHATRA_RASI,
    RASI: RASI,
    GOTRAM: GOTRAM,
    COUNTRY: COUNTRY,
    STATE: STATE,
    CITY: CITY,
    INTEREST: INTEREST,
    EDUCATION: EDUCATION,
    PROFESSION: PROFESSION,
    fillList: fillList,
    rasiForNakshatra: rasiForNakshatra
  };
})();
