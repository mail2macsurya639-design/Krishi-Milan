const API_BASE = "http://127.0.0.1:5000/api";
let currentUser = null;
let authToken = null;
let selectedRegion = "terai";
let lastCoords = null;
const REGION_ACCENT = { terai: ["#3F7D4D","#DCEBDD"], pahad: ["#B8763A","#F1E2CE"], himal: ["#4E7FA6","#DCE7EF"] };
// Midpoints of the backend's REGION_PROFILE ranges — used to auto-fill a
// *typical* rainfall value per region. This is NOT live weather (a live
// "is it raining right now" reading would be misleading for the model,
// which expects a seasonal average) — it's an editable starting estimate.
const REGION_TYPICAL = {
  terai: { temperature: 30, rainfall: 1750 },
  pahad: { temperature: 19, rainfall: 1400 },
  himal: { temperature: 6.5, rainfall: 725 },
};

function authHeaders(){
  return authToken ? { "Authorization": `Bearer ${authToken}` } : {};
}
function saveAuth(user, token){
  currentUser = user;
  authToken = token;
  localStorage.setItem("krishiMilanAuth", JSON.stringify({ user, token }));
}
function loadAuth(){
  try{
    const raw = localStorage.getItem("krishiMilanAuth");
    if(!raw) return;
    const parsed = JSON.parse(raw);
    currentUser = parsed.user;
    authToken = parsed.token;
  }catch(e){ /* ignore corrupt storage */ }
}
function clearAuth(){
  currentUser = null;
  authToken = null;
  localStorage.removeItem("krishiMilanAuth");
}
function logout(){
  clearAuth();
  updateAccountPill();
  document.getElementById("historyCard").classList.add("hidden");
  document.getElementById("dealsCard").classList.add("hidden");
}

const I18N = {
  ne: {
    tab_predict:"बाली सिफारिस", tab_market:"बजार", tab_account:"खाता",
    hero_title:"तपाईंको माटो र क्षेत्रको लागि उत्तम बाली", hero_sub:"N-P-K, तापक्रम, र वर्षा भर्नुहोस् — क्षेत्र-अनुसार सिफारिस पाउनुहोस्।",
    pick_region:"क्षेत्र छान्नुहोस्", terai_sub:"समथर, तातो", pahad_sub:"पहाडी, समशीतोष्ण", himal_sub:"उच्च हिमाली",
    autofill_weather:"हालको मौसम भर्नुहोस्",
    lbl_n:"नाइट्रोजन (N)", lbl_p:"फस्फोरस (P)", lbl_k:"पोटासियम (K)", lbl_ph:"माटोको pH",
    lbl_temp:"तापक्रम (°C)", lbl_humidity:"आर्द्रता (%)", lbl_rainfall:"वर्षा (mm)",
    btn_predict:"बाली सिफारिस गर्नुहोस्",
    market_title:"किसान–खरिदकर्ता बजार", market_sub:"बीचमा कुनै मध्यस्थ बिना, सीधै जोडिनुहोस्।",
    new_listing:"नयाँ उब्जनी सूचीबद्ध गर्नुहोस्", lbl_crop:"बाली", lbl_qty:"परिमाण", lbl_unit:"एकाइ", lbl_price:"अपेक्षित मूल्य (प्रति एकाइ)",
    btn_post_listing:"सूचीबद्ध गर्नुहोस्",
    find_produce:"उब्जनी खोज्नुहोस्", lbl_need:"तपाईंलाई के चाहिन्छ, सामान्य भाषामा लेख्नुहोस्", btn_find_match:"मिलान खोज्नुहोस्",
    open_listings:"खुला सूचीहरू", all_regions:"सबै क्षेत्र",
    negotiate_title:"मूल्य सल्लाहकार", negotiate_hint:"कुनै सूचीमा 'मूल्य सल्लाह' थिच्नुहोस्, अनि आफ्नो प्रस्ताव मूल्य राख्नुहोस्।",
    assist_title:"किसान सहायक", assist_sub:"प्रश्न सोध्नुहोस्, वा बालीको फोटोबाट स्वास्थ्य जाँच गर्नुहोस्।",
    chat_title:"प्रश्न सोध्नुहोस्", btn_send:"पठाउनुहोस्",
    health_title:"बाली स्वास्थ्य जाँच", health_hint:"बालीको फोटो अपलोड गर्नुहोस्, AI ले समस्या पहिचान गर्ने प्रयास गर्छ।",
    btn_check_health:"जाँच गर्नुहोस्", btn_negotiate:"मूल्य सल्लाह",
    account_title:"तपाईंको खाता", account_sub:"किसान वा खरिदकर्ताको रूपमा लगइन/दर्ता गर्नुहोस्।",
    login_title:"लगइन", register_title:"नयाँ खाता दर्ता",
    lbl_phone:"फोन नम्बर", lbl_password:"पासवर्ड", lbl_name:"पूरा नाम", lbl_role:"भूमिका", lbl_region:"क्षेत्र",
    lbl_otp:"OTP कोड", btn_send_otp:"OTP पठाउनुहोस्",
    role_farmer:"किसान", role_buyer:"खरिदकर्ता",
    btn_login:"लगइन गर्नुहोस्", btn_register:"दर्ता गर्नुहोस्", btn_logout:"लगआउट",
    voice_btn:"बोल्नुहोस्", history_title:"मेरो अघिल्लो सिफारिसहरू", deals_title:"मेरो सम्झौताहरू",
  },
  en: {
    tab_predict:"Crop advisor", tab_market:"Marketplace", tab_account:"Account",
    hero_title:"The right crop for your soil and region", hero_sub:"Enter N-P-K, temperature, and rainfall — get a region-aware recommendation.",
    pick_region:"Choose your region", terai_sub:"Lowland, hot", pahad_sub:"Hilly, temperate", himal_sub:"High mountain",
    autofill_weather:"Auto-fill current weather",
    lbl_n:"Nitrogen (N)", lbl_p:"Phosphorus (P)", lbl_k:"Potassium (K)", lbl_ph:"Soil pH",
    lbl_temp:"Temperature (°C)", lbl_humidity:"Humidity (%)", lbl_rainfall:"Rainfall (mm)",
    btn_predict:"Get crop recommendation",
    market_title:"Farmer–buyer marketplace", market_sub:"Connect directly, no middleman.",
    new_listing:"List your produce", lbl_crop:"Crop", lbl_qty:"Quantity", lbl_unit:"Unit", lbl_price:"Expected price (per unit)",
    btn_post_listing:"Post listing",
    find_produce:"Find produce", lbl_need:"Describe what you need, in plain language", btn_find_match:"Find a match",
    open_listings:"Open listings", all_regions:"All regions",
    negotiate_title:"Price negotiation coach", negotiate_hint:"Tap 'Negotiate' on a listing, then enter your offer price.",
    assist_title:"Farming assistant", assist_sub:"Ask a question, or check a crop's health from a photo.",
    chat_title:"Ask a question", btn_send:"Send",
    health_title:"Crop health check", health_hint:"Upload a photo of your crop — AI will try to spot issues.",
    btn_check_health:"Check", btn_negotiate:"Negotiate",
    account_title:"Your account", account_sub:"Log in or register as a farmer or buyer.",
    login_title:"Log in", register_title:"Create an account",
    lbl_phone:"Phone number", lbl_password:"Password", lbl_name:"Full name", lbl_role:"Role", lbl_region:"Region",
    lbl_otp:"OTP code", btn_send_otp:"Send OTP",
    role_farmer:"Farmer", role_buyer:"Buyer",
    btn_login:"Log in", btn_register:"Register", btn_logout:"Log out",
    voice_btn:"Speak", history_title:"My past recommendations", deals_title:"My deals",
  }
};
let lang = "ne";

function applyI18n(){
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach(el=>{
    const key = el.getAttribute("data-i18n");
    if(I18N[lang][key]) el.textContent = I18N[lang][key];
  });
}
function setLang(l){
  lang = l;
  document.getElementById("langNe").classList.toggle("active", l==="ne");
  document.getElementById("langEn").classList.toggle("active", l==="en");
  applyI18n();
}

function showTab(tab){
  document.querySelectorAll("section").forEach(s=>s.classList.remove("active"));
  document.getElementById(tab).classList.add("active");
  document.querySelectorAll("nav.tabs button").forEach(b=>b.classList.toggle("active", b.dataset.tab===tab));
  if(tab==="market") loadListings();
}

function selectRegion(region){
  selectedRegion = region;
  document.querySelectorAll(".region-card").forEach(c=>c.classList.toggle("selected", c.dataset.region===region));
  const [accent, soft] = REGION_ACCENT[region];
  document.documentElement.style.setProperty("--accent", accent);
  document.documentElement.style.setProperty("--accent-soft", soft);

  // Auto-fill a typical (not live) rainfall value for the region — only
  // if the farmer hasn't already typed something, and only touch rainfall
  // (temperature is better left to the live weather button or manual entry).
  const rainfallInput = document.getElementById("rainfall");
  const typical = REGION_TYPICAL[region];
  if(rainfallInput && typical && !rainfallInput.value){
    rainfallInput.value = typical.rainfall;
    setMsg("weatherMsg", lang==="ne"
      ? `वर्षा: ${region} को अनुमानित औसत भरियो (आवश्यक भए बदल्नुहोस्)`
      : `Rainfall: filled with a typical estimate for ${region} (edit if needed)`, "ok");
  }
}

function setMsg(id, text, type){
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "msg " + (type||"");
}

// ---- Weather ----
function fetchWeather(){
  if(!navigator.geolocation){
    setMsg("weatherMsg", lang==="ne" ? "Location सुविधा उपलब्ध छैन" : "Geolocation not available", "error");
    return;
  }
  navigator.geolocation.getCurrentPosition(async (pos)=>{
    lastCoords = {lat: pos.coords.latitude, lon: pos.coords.longitude};
    try{
      const res = await fetch(`${API_BASE}/weather?lat=${lastCoords.lat}&lon=${lastCoords.lon}`);
      if(!res.ok) throw new Error("weather fetch failed");
      const w = await res.json();
      document.getElementById("temperature").value = w.temperature;
      document.getElementById("humidity").value = w.humidity;
      setMsg("weatherMsg", lang==="ne" ? "मौसम भरियो ✓" : "Weather filled in ✓", "ok");
    }catch(e){
      setMsg("weatherMsg", lang==="ne" ? "मौसम सेवा अहिले उपलब्ध छैन" : "Weather service unavailable right now", "error");
    }
  }, ()=> setMsg("weatherMsg", lang==="ne" ? "Location अनुमति चाहियो" : "Location permission needed", "error"));
}

// ---- Predict ----
async function predictCrop(){
  const btn = document.getElementById("predictBtn");
  btn.disabled = true;
  const payload = {
    region: selectedRegion, lang: lang,
    N: document.getElementById("N").value, P: document.getElementById("P").value, K: document.getElementById("K").value,
    ph: document.getElementById("ph").value, temperature: document.getElementById("temperature").value,
    humidity: document.getElementById("humidity").value, rainfall: document.getElementById("rainfall").value,
  };
  try{
    const res = await fetch(`${API_BASE}/predict`, {
      method:"POST",
      headers:{"Content-Type":"application/json", ...authHeaders()},
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "predict failed");
    const box = document.getElementById("resultBox");
    box.classList.remove("hidden");
    const top = data.top3[0];
    document.getElementById("cropName").textContent = top.crop.toUpperCase();
    document.getElementById("cropConf").textContent = `${lang==="ne"?"भरोसा":"Confidence"}: ${top.confidence}%`;
    document.getElementById("cropExplain").innerHTML = `${data.explanation || ""} ${data.explanation ? `<button type="button" class="speak-btn" onclick="speakText(${JSON.stringify(data.explanation)})" title="${lang==='ne'?'सुन्नुहोस्':'Listen'}">${ICON_LISTEN}</button>` : ""}`;
    const altHtml = data.top3.slice(1).map(t=>`<span class="pill">${t.crop} · ${t.confidence}%</span>`).join(" ");
    document.getElementById("alt3").innerHTML = altHtml;
    if(currentUser && currentUser.role === "farmer") loadPredictionHistory();
    if(data.explanation){
      const introLine = lang==="ne"
        ? `सिफारिस गरिएको बाली ${top.crop} हो, भरोसा ${top.confidence} प्रतिशत। `
        : `The recommended crop is ${top.crop}, with ${top.confidence} percent confidence. `;
      speakText(introLine + data.explanation);
    }
  }catch(e){
    alert((lang==="ne"?"त्रुटि: ":"Error: ") + e.message);
  }
  btn.disabled = false;
}

// ---- Auth ----
async function sendOtp(){
  const phone = document.getElementById("regPhone").value.trim();
  if(!phone){
    setMsg("otpMsg", lang==="ne" ? "पहिले फोन नम्बर लेख्नुहोस्" : "Enter phone number first", "error");
    return;
  }
  setMsg("otpMsg", lang==="ne" ? "OTP पठाउँदै..." : "Sending OTP...", "");
  try{
    const res = await fetch(`${API_BASE}/register/send-otp`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "send-otp failed");
    if(data.demo_mode){
      document.getElementById("regOtp").value = data.demo_otp;
      setMsg("otpMsg",
        (lang==="ne"
          ? `डेमो मोड — real SMS छैन। Demo OTP: `
          : `Demo mode — no real SMS. Demo OTP: `) + data.demo_otp,
        "ok");
    }else{
      setMsg("otpMsg", lang==="ne" ? "OTP पठाइयो, फोन जाँच्नुहोस्" : "OTP sent, check your phone", "ok");
    }
  }catch(e){
    setMsg("otpMsg", e.message, "error");
  }
}

async function registerUser(){
  const payload = {
    name: document.getElementById("regName").value,
    phone: document.getElementById("regPhone").value,
    password: document.getElementById("regPassword").value,
    otp: document.getElementById("regOtp").value,
    role: document.getElementById("regRole").value,
    region: document.getElementById("regRegion").value,
    language_pref: lang,
  };
  try{
    const res = await fetch(`${API_BASE}/register`, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "register failed");
    saveAuth(data, data.token);
    updateAccountPill();
    setMsg("registerMsg", lang==="ne" ? "दर्ता भयो ✓" : "Registered ✓", "ok");
  }catch(e){
    setMsg("registerMsg", e.message, "error");
  }
}
async function login(){
  const payload = { phone: document.getElementById("loginPhone").value, password: document.getElementById("loginPassword").value };
  try{
    const res = await fetch(`${API_BASE}/login`, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "login failed");
    saveAuth(data, data.token);
    updateAccountPill();
    setMsg("loginMsg", lang==="ne" ? "लगइन भयो ✓" : "Logged in ✓", "ok");
  }catch(e){
    setMsg("loginMsg", e.message, "error");
  }
}
function updateAccountPill(){
  const pill = document.getElementById("accountPill");
  const logoutBtn = document.getElementById("logoutBtn");
  const historyCard = document.getElementById("historyCard");
  const dealsCard = document.getElementById("dealsCard");
  if(currentUser){
    pill.textContent = `${currentUser.name} · ${currentUser.role}`;
    logoutBtn.classList.remove("hidden");
    if(currentUser.role === "farmer"){
      historyCard.classList.remove("hidden");
      loadPredictionHistory();
    }
    dealsCard.classList.remove("hidden");
    loadMyDeals();
  }else{
    pill.textContent = "";
    logoutBtn.classList.add("hidden");
    historyCard.classList.add("hidden");
    dealsCard.classList.add("hidden");
  }
}

// ---- Prediction history ----
async function loadPredictionHistory(){
  if(!currentUser || !authToken) return;
  try{
    const res = await fetch(`${API_BASE}/predictions`, { headers: authHeaders() });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "failed");
    const list = document.getElementById("historyList");
    list.innerHTML = data.map(p => `
      <div class="listing-item">
        <div><div class="crop">${p.top3 && p.top3[0] ? p.top3[0].crop : "?"}</div>
        <div class="meta">${new Date(p.created_at).toLocaleDateString()}</div></div>
        <div class="pill">${p.top3 && p.top3[0] ? p.top3[0].confidence + "%" : ""}</div>
      </div>`).join("") || `<p class="msg">${lang==="ne"?"अझै कुनै सिफारिस छैन":"No predictions yet"}</p>`;
  }catch(e){
    document.getElementById("historyList").innerHTML = `<p class="msg error">${e.message}</p>`;
  }
}

// ---- Deal status (My deals) ----
const STATUS_LABEL = {
  ne: { pending:"पेन्डिङ", confirmed:"पक्का भयो", completed:"सम्पन्न", rejected:"अस्वीकृत" },
  en: { pending:"Pending", confirmed:"Confirmed", completed:"Completed", rejected:"Rejected" },
};
const NEXT_STATUS = { pending:"confirmed", confirmed:"completed" };

async function loadMyDeals(){
  if(!currentUser || !authToken) return;
  try{
    const res = await fetch(`${API_BASE}/matches`, { headers: authHeaders() });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "failed");
    const list = document.getElementById("dealsList");
    list.innerHTML = data.map(m => {
      const ls = m.listing_summary || {};
      const next = NEXT_STATUS[m.status];
      const nextBtn = next
        ? `<button class="btn secondary" style="padding:6px 12px;font-size:12px;" onclick="advanceDeal('${m._id}','${next}')">${STATUS_LABEL[lang][next]} →</button>`
        : "";
      return `
      <div class="listing-item">
        <div><div class="crop">${ls.crop_name || "—"}</div>
        <div class="meta">${ls.quantity||""} ${ls.unit||""} · ${ls.region||""}</div></div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="pill">${STATUS_LABEL[lang][m.status] || m.status}</span>
          ${nextBtn}
        </div>
      </div>`;
    }).join("") || `<p class="msg">${lang==="ne"?"अझै कुनै सम्झौता छैन":"No deals yet"}</p>`;
  }catch(e){
    document.getElementById("dealsList").innerHTML = `<p class="msg error">${e.message}</p>`;
  }
}

async function advanceDeal(matchId, newStatus){
  try{
    const res = await fetch(`${API_BASE}/matches/${matchId}/status`, {
      method:"PATCH", headers:{"Content-Type":"application/json", ...authHeaders()},
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "update failed");
    loadMyDeals();
  }catch(e){
    alert((lang==="ne"?"त्रुटि: ":"Error: ") + e.message);
  }
}

// ---- Listings ----
async function createListing(){
  if(!currentUser){ setMsg("listingMsg", lang==="ne" ? "पहिले लगइन गर्नुहोस्" : "Please log in first", "error"); return; }
  if(currentUser.role !== "farmer"){ setMsg("listingMsg", lang==="ne" ? "किसान खाताले मात्र सूचीबद्ध गर्न सक्छ" : "Only farmer accounts can post listings", "error"); return; }
  const payload = {
    crop_name: document.getElementById("listCrop").value,
    quantity: document.getElementById("listQty").value,
    unit: document.getElementById("listUnit").value,
    price_expected: document.getElementById("listPrice").value,
    region: currentUser.region,
  };
  try{
    const res = await fetch(`${API_BASE}/listings`, {
      method:"POST",
      headers:{"Content-Type":"application/json", ...authHeaders()},
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "listing failed");
    setMsg("listingMsg", lang==="ne" ? "सूचीबद्ध भयो ✓" : "Posted ✓", "ok");
    loadListings();
  }catch(e){
    setMsg("listingMsg", e.message, "error");
  }
}
async function loadListings(){
  const region = document.getElementById("filterRegion").value;
  const url = region ? `${API_BASE}/listings?region=${region}` : `${API_BASE}/listings`;
  try{
    const res = await fetch(url);
    const data = await res.json();
    const container = document.getElementById("listingsList");
    container.innerHTML = data.map(l => `
      <div class="listing-item">
        <div><div class="crop">${l.crop_name}</div><div class="meta">${l.quantity} ${l.unit} · ${l.region}</div></div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="pill">${l.price_expected}/${l.unit}</div>
          <button class="btn secondary" style="padding:6px 12px;font-size:12px;" onclick="openNegotiate('${l._id}', ${l.price_expected}, '${l.unit}')">${I18N[lang].btn_negotiate}</button>
        </div>
      </div>`).join("") || `<p class="msg">${lang==="ne"?"अहिले कुनै सूची छैन":"No listings yet"}</p>`;
  }catch(e){
    document.getElementById("listingsList").innerHTML = `<p class="msg error">${lang==="ne"?"लोड गर्न सकिएन":"Could not load listings"}</p>`;
  }
}

// ---- Price negotiation coach ----
async function openNegotiate(listingId, askingPrice, unit){
  const promptText = lang==="ne"
    ? `तपाईंको प्रस्ताव मूल्य (प्रति ${unit}) राख्नुहोस्:`
    : `Enter your offer price (per ${unit}):`;
  const offer = window.prompt(promptText, askingPrice);
  if(offer === null || offer === "") return;

  const resultBox = document.getElementById("negotiateResult");
  resultBox.innerHTML = `<p class="msg">${lang==="ne"?"सल्लाह तयार गर्दै...":"Preparing advice..."}</p>`;
  try{
    const res = await fetch(`${API_BASE}/negotiate`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ listing_id: listingId, offer_price: offer, lang })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "negotiate failed");
    resultBox.innerHTML = `
      <div class="result">
        <div class="conf">${lang==="ne"?"माग मूल्य":"Asking"}: ${data.asking_price}/${data.unit} · ${lang==="ne"?"प्रस्ताव":"Offer"}: ${data.offer_price}/${data.unit}</div>
        <div class="explain">${data.coaching}</div>
      </div>`;
  }catch(e){
    resultBox.innerHTML = `<p class="msg error">${e.message}</p>`;
  }
}

// ---- Matching ----
async function findMatch(){
  const need_text = document.getElementById("buyerNeed").value;
  if(!need_text) return;
  const payload = { need_text, lang };
  const el = document.getElementById("matchResults");
  el.innerHTML = `<p class="msg">${lang==="ne"?"खोजी हुँदैछ...":"Searching..."}</p>`;
  try{
    const res = await fetch(`${API_BASE}/match`, {
      method:"POST",
      headers:{"Content-Type":"application/json", ...authHeaders()},
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "match failed");
    const items = (data.matches||[]).map(l => `
      <div class="listing-item">
        <div><div class="crop">${l.crop_name}</div><div class="meta">${l.quantity} ${l.unit} · ${l.region}</div></div>
        <div class="pill">${l.price_expected}/${l.unit}</div>
      </div>`).join("");
    el.innerHTML = items + (data.deal_summary ? `<div class="result" style="margin-top:10px;">${data.deal_summary}</div>` : "");
    if(!data.matches || data.matches.length===0){
      el.innerHTML = `<p class="msg">${lang==="ne"?"मिल्दो उब्जनी भेटिएन":"No matching listing found"}</p>`;
    }
    if(currentUser) loadMyDeals();
  }catch(e){
    el.innerHTML = `<p class="msg error">${e.message}</p>`;
  }
}

// ---- Voice input ----
// ---- Voice input ----

function convertDevanagariDigits(str) {
  const map = {
    "०":"0", "१":"1", "२":"2", "३":"3", "४":"4",
    "५":"5", "६":"6", "७":"7", "८":"8", "९":"9"
  };

  return str.replace(/[०-९]/g, ch => map[ch] || ch);
}

let activeRecognition = null;

function startVoice(targetId, numeric = false) {

  console.log("🎤 startVoice called:", targetId);

  const SpeechRecognition =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

  const btn =
    document.getElementById("mic-" + targetId);

  const target =
    document.getElementById(targetId);

  if (!SpeechRecognition) {
    alert(
      lang === "ne"
        ? "यो browser मा voice recognition उपलब्ध छैन। Chrome प्रयोग गर्नुहोस्।"
        : "Voice recognition is not available in this browser."
    );
    return;
  }

  if (!target) {
    console.error("Input not found:", targetId);
    return;
  }

  // Stop previous recognition
  if (activeRecognition) {
    try {
      activeRecognition.abort();
    } catch (_) {}
  }

  const recognition = new SpeechRecognition();
  activeRecognition = recognition;

  // Keep English ONLY for diagnosis.
  // Change back to ne-NP after Safari/browser support is confirmed.
  recognition.lang = "en-US";

  recognition.interimResults = false;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  if (btn) {
    btn.classList.add("listening");
  }

  recognition.onstart = () => {
    console.log("✅ SPEECH STARTED:", targetId);

    setMsg(
      "voiceFieldMsg",
      "Listening...",
      "ok"
    );
  };

  recognition.onresult = (event) => {

    const text =
      event.results?.[0]?.[0]?.transcript?.trim() || "";

    console.log("✅ SPEECH RESULT:", text);

    if (!text) return;

    if (numeric) {

      const converted =
        convertDevanagariDigits(text);

      const match =
        converted.match(/-?\d+(\.\d+)?/);

      if (match) {

        target.value = match[0];

        setMsg(
          "voiceFieldMsg",
          "Filled: " + match[0],
          "ok"
        );

      } else {

        setMsg(
          "voiceFieldMsg",
          `Heard "${text}" but no number was found.`,
          "error"
        );
      }

    } else {

      target.value =
        target.value
          ? `${target.value} ${text}`
          : text;
    }
  };

  recognition.onerror = (event) => {

    console.error(
      "❌ SPEECH ERROR:",
      event.error
    );

    if (btn) {
      btn.classList.remove("listening");
    }

    let message = "";

    switch (event.error) {

      case "not-allowed":
        message =
          "Microphone/speech permission was denied.";
        break;

      case "service-not-allowed":
        message =
          "Speech recognition service is unavailable in this browser.";
        break;

      case "language-not-supported":
        message =
          "This speech-recognition language is not supported.";
        break;

      case "no-speech":
        message =
          "No speech was detected.";
        break;

      case "audio-capture":
        message =
          "No microphone was detected.";
        break;

      case "network":
        message =
          "Speech recognition network error.";
        break;

      default:
        message =
          "Speech recognition error: " + event.error;
    }

    setMsg("voiceFieldMsg", message, "error");

    activeRecognition = null;
  };

  recognition.onend = () => {

    console.log("⏹ SPEECH ENDED");

    if (btn) {
      btn.classList.remove("listening");
    }

    activeRecognition = null;
  };

  try {

    console.log("Starting recognition...");

    recognition.start();

  } catch (error) {

    console.error(
      "❌ START ERROR:",
      error
    );

    if (btn) {
      btn.classList.remove("listening");
    }

    activeRecognition = null;

    setMsg(
      "voiceFieldMsg",
      "Could not start voice recognition.",
      "error"
    );
  }
}

// ---- Icon constants (SVG, not emoji — consistent rendering across browsers) ----
const ICON_MIC = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
const ICON_SPEAKER = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
const ICON_SPEAKER_MUTE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
const ICON_LISTEN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';

let chatHistory = [];
let autoSpeak = true;

function speakText(text){
  if(!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // stop any earlier speech first
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang === "ne" ? "ne-NP" : "en-US";
  window.speechSynthesis.speak(utter);
}

function toggleAutoSpeak(){
  autoSpeak = !autoSpeak;
  const btn = document.getElementById("autoSpeakToggle");
  if(btn) btn.innerHTML = autoSpeak ? ICON_SPEAKER : ICON_SPEAKER_MUTE;
  if(!autoSpeak) window.speechSynthesis.cancel();
}

function renderChatLog(){
  const log = document.getElementById("chatLog");
  log.innerHTML = chatHistory.map((t,i) => `
    <div class="chat-bubble ${t.role}">
      ${t.text}
      ${t.role==="model" ? `<button type="button" class="speak-btn" onclick="speakText(${JSON.stringify(t.text)})" title="${lang==='ne'?'सुन्नुहोस्':'Listen'}">${ICON_LISTEN}</button>` : ""}
    </div>
  `).join("");
  log.scrollTop = log.scrollHeight;
}

async function sendChat(){
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if(!text) return;
  chatHistory.push({role:"user", text});
  renderChatLog();
  input.value = "";

  chatHistory.push({role:"model", text: lang==="ne" ? "सोच्दैछु..." : "Thinking..."});
  renderChatLog();

  try{
    const res = await fetch(`${API_BASE}/chat`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ history: chatHistory.slice(0,-1), lang })
    });
    const data = await res.json();
    chatHistory.pop(); // remove "thinking..." placeholder
    if(!res.ok) throw new Error(data.error || "chat failed");
    chatHistory.push({role:"model", text: data.reply});
    if(autoSpeak) speakText(data.reply);
  }catch(e){
    chatHistory.pop();
    chatHistory.push({role:"model", text: (lang==="ne"?"त्रुटि: ":"Error: ") + e.message});
  }
  renderChatLog();
}

// ---- Photo-based crop health check ----
document.addEventListener("DOMContentLoaded", ()=>{
  const fileInput = document.getElementById("healthPhoto");
  if(fileInput){
    fileInput.addEventListener("change", ()=>{
      const file = fileInput.files[0];
      const preview = document.getElementById("healthPreview");
      if(!file){ preview.classList.add("hidden"); return; }
      const reader = new FileReader();
      reader.onload = e => { preview.src = e.target.result; preview.classList.remove("hidden"); };
      reader.readAsDataURL(file);
    });
  }
});

async function checkCropHealth(){
  const fileInput = document.getElementById("healthPhoto");
  const file = fileInput.files[0];
  const resultBox = document.getElementById("healthResult");
  if(!file){
    resultBox.classList.remove("hidden");
    resultBox.innerHTML = `<p class="msg error">${lang==="ne"?"पहिले फोटो छान्नुहोस्":"Please choose a photo first"}</p>`;
    return;
  }
  resultBox.classList.remove("hidden");
  resultBox.innerHTML = `<p class="msg">${lang==="ne"?"जाँच हुँदैछ...":"Checking..."}</p>`;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try{
      const res = await fetch(`${API_BASE}/crop-health`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ image_base64: e.target.result, lang })
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || "check failed");
      resultBox.innerHTML = `<div class="explain">${data.analysis}</div>`;
    }catch(err){
      resultBox.innerHTML = `<p class="msg error">${err.message}</p>`;
    }
  };
  reader.readAsDataURL(file);
}

// ---- Init ----
selectRegion("terai");
loadAuth();
applyI18n();
updateAccountPill();