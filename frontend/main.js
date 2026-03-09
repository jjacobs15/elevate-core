// Production-ready frontend controller for EleVate
// Notes:
// - Uses safe session retrieval for every authenticated call
// - Centralizes DOM access, request handling, and error handling
// - Removes storage clearing during OAuth
// - Avoids duplicate event binding
// - Adds config validation and guarded initialization
// - Keeps the single-file structure for easier drop-in replacement

import { createClient } from '@supabase/supabase-js';

const CONFIG = Object.freeze({
  SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  BACKEND_URL: import.meta.env.VITE_BACKEND_URL,
  STORAGE_BUCKET: 'wardrobe_images',
  REQUEST_TIMEOUT_MS: 30_000,
  STREAM_TIMEOUT_MS: 180_000,
  INVENTORY_TIMEOUT_MS: 12_000,
  MAX_IMAGE_DIMENSION: 1200,
  JPEG_QUALITY: 0.8,
});

function validateConfig() {
  const missing = Object.entries(CONFIG)
    .filter(([key, value]) => key !== 'STORAGE_BUCKET' && key !== 'REQUEST_TIMEOUT_MS' && key !== 'STREAM_TIMEOUT_MS' && key !== 'INVENTORY_TIMEOUT_MS' && key !== 'MAX_IMAGE_DIMENSION' && key !== 'JPEG_QUALITY' && !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

validateConfig();

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: {
    flowType: 'pkce',
    autoRefreshToken: true,
    detectSessionInUrl: true,
    persistSession: true,
  },
});

const STATE = {
  session: null,
  currentMode: 'evaluate',
  lastAnalysisData: null,
  cachedDossierHistory: [],
  cachedVaultInventory: [],
  parsedCareTagData: null,
  currentGarmentFile: null,
  profileListenersBound: false,
  initialized: false,
};

const CONSTANTS = {
  wearThresholds: Object.freeze({
    Suit: 4,
    Blazer: 5,
    Outerwear: 5,
    Bottom: 10,
    Top: 2,
    Accessory: 5,
    Footwear: 10,
    Default: 3,
  }),
  plannerRequirements: Object.freeze({
    '1_day': { Top: 1, Bottom: 1 },
    work_week: { Top: 5, Bottom: 3, Footwear: 2 },
    vacation: { Top: 4, Bottom: 2, Footwear: 2 },
    work_trip: { Top: 5, Bottom: 3, Outerwear: 1, Footwear: 2 },
  }),
  occasionMap: Object.freeze({
    'Activity / Outdoor': ['Beach', 'Country Club', 'Game', 'Golf Scramble', 'Hiking', 'PickleBall', 'Yacht / Sailing'],
    'Casual / Everyday': ['Casual', 'Church', 'Grocery Shopping', 'Running Errands in Town', 'Smart Casual'],
    Formal: ['Black Tie', 'Cocktail Attire', 'Gala', 'Rehearsal Dinner', 'Wedding'],
    Professional: ['Boardroom / Pitch', 'Business Casual', 'Business Formal', 'Conference', 'Creative Office', 'Interview', 'Networking Event', 'Tech Casual'],
    'Seasonal / Holiday': ['Easter', 'Holiday Party', 'Kentucky Derby', 'New Year’s'],
    Social: ['Bar', 'Concert', 'Date Night', 'Day Party', 'Dinner', 'Gallery Opening', 'Speakeasy', 'Upscale Lounge'],
    Travel: ['5 Star Resort', 'Airport', 'Business Red-Eye', 'Cruise', 'European Summer', 'Ski Resort Apres-Ski', 'Vacation'],
    Other: ['Other'],
  }),
  moodValues: Object.freeze({
    1: 'Understated',
    2: 'Balanced',
    3: 'Stand Out',
  }),
};

const DOM = {};

function $(id, required = true) {
  const el = document.getElementById(id);
  if (!el && required) throw new Error(`Missing required DOM element: #${id}`);
  return el;
}

function cacheDom() {
  Object.assign(DOM, {
    authOverlay: $('authOverlay'),
    authErrorMsg: $('authErrorMsg'),
    crashBanner: $('crash-banner', false),
    googleLoginBtn: $('googleLoginBtn'),
    appleLoginBtn: $('appleLoginBtn'),
    logoutBtn: $('logoutBtn'),
    imageInput: $('imageInput'),
    uploadTrigger: $('uploadTrigger'),
    evaluateBtn: $('evaluateBtn'),
    resultBox: $('result'),
    categoryEl: $('category'),
    occasionEl: $('occasion'),
    customOccasionEl: $('customOccasion'),
    fitPreferenceEl: $('fitPreference'),
    previewImg: $('imagePreview'),
    imageFrame: $('imageFrame'),
    tailorInstructions: $('tailorInstructions'),
    moodSlider: $('moodSlider'),
    moodLabel: $('moodLabel'),
    tabAnalysis: $('tab-analysis'),
    tabWardrobe: $('tab-wardrobe'),
    tabVault: $('tab-vault'),
    analysisView: $('analysisView'),
    wardrobeView: $('wardrobeView'),
    vaultView: $('vaultView'),
    historyFeed: $('historyFeed'),
    historyLoader: $('historyLoader'),
    travelInputs: $('travelInputs'),
    occasionBlock: $('occasionBlock'),
    garmentInput: $('garmentInput'),
    garmentUploadTrigger: $('garmentUploadTrigger'),
    careTagInput: $('careTagInput'),
    careTagUploadTrigger: $('careTagUploadTrigger'),
    careTagStatus: $('careTagStatus'),
    garmentPreview: $('garmentPreview'),
    garmentFrame: $('garmentFrame'),
    garmentDetails: $('garmentDetails'),
    saveGarmentBtn: $('saveGarmentBtn'),
    vaultFeed: $('vaultFeed'),
    vaultLoader: $('vaultLoader'),
    garmentStatus: $('garmentStatus'),
    genericModal: $('genericModal'),
    genericModalBody: $('genericModalBody'),
    ghostSimTrigger: $('ghostSimTrigger'),
    ghostInput: $('ghostInput'),
    ghostPreview: $('ghostPreview'),
    ghostFrame: $('ghostFrame'),
    runGhostBtn: $('runGhostBtn'),
    ghostDesc: $('ghostDesc'),
    ghostResult: $('ghostResult'),
    acquisitionBoardBtn: $('acquisitionBoardBtn'),
    chronosBtn: $('chronosBtn'),
    plannerType: $('plannerType'),
    tailorSubMenu: $('tailorSubMenu'),
    selectionBlock: $('selectionBlock'),
    buildDateBlock: $('buildDateBlock'),
    tailorBlock: $('tailorBlock'),
    plannerBlock: $('plannerBlock'),
    vaultConnectionStatus: $('vaultConnectionStatus'),
    evalDate: $('evalDate'),
    targetDate: $('targetDate'),
    targetDateLabel: $('targetDateLabel'),
    notes: $('notes'),
    climate: $('climate'),
    contrastProfile: $('contrastProfile'),
    departureDate: $('departureDate'),
    returnDate: $('returnDate'),
    travelItinerary: $('travelItinerary'),
    valetBtn: $('valetBtn'),
    analyticsGrid: $('analyticsGrid'),
    vaultDashboard: $('vaultDashboard'),
    lifetimeAvgScore: $('lifetimeAvgScore'),
    weeklyAvgScore: $('weeklyAvgScore'),
    garmentCategory: $('garmentCategory'),
    garmentNotes: $('garmentNotes'),
    garmentPrice: $('garmentPrice'),
    btnEvaluateMode: $('btn-evaluate'),
    btnTailorBaseMode: $('btn-tailor-base'),
    mChest: $('m_chest'),
    mInseam: $('m_inseam'),
    mWaist: $('m_waist'),
    mHeight: $('m_height'),
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setText(el, value) {
  if (el) el.textContent = String(value ?? '');
}

function setVisible(el, visible) {
  if (!el) return;
  el.classList.toggle('hidden', !visible);
}

function notifyError(message) {
  window.alert(message);
}

function showCrash(message) {
  if (DOM.crashBanner) {
    DOM.crashBanner.style.display = 'block';
    DOM.crashBanner.textContent = `SYSTEM CRASH: ${message}`;
    return;
  }
  console.error(message);
}

function withTimeout(controller, ms) {
  return window.setTimeout(() => controller.abort(), ms);
}

async function getSessionOrThrow() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(`Failed to retrieve session: ${error.message}`);
  if (!data.session?.access_token) throw new Error('Authentication required. Please sign in again.');
  STATE.session = data.session;
  return data.session;
}

async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);
  return data.user;
}

async function apiFetch(endpoint, options = {}) {
  const session = await getSessionOrThrow();
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${session.access_token}`);

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers.set('Content-Type', headers.get('Content-Type') || 'application/json');
    options.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${CONFIG.BACKEND_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => null);
    throw new Error(errorPayload?.error || `Backend request failed (${response.status})`);
  }

  return response;
}

async function supabaseRestFetch(path, options = {}) {
  const session = await getSessionOrThrow();
  const headers = new Headers(options.headers || {});
  headers.set('apikey', CONFIG.SUPABASE_ANON_KEY);
  headers.set('Authorization', `Bearer ${session.access_token}`);
  headers.set('Accept', headers.get('Accept') || 'application/json');

  const response = await fetch(`${CONFIG.SUPABASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Supabase request failed (${response.status})`);
  }

  return response;
}

async function compressImage(file, maxSize = CONFIG.MAX_IMAGE_DIMENSION) {
  if (!file) throw new Error('No file provided.');

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error('Failed to read the file from your device.'));
    reader.onload = (event) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image format. Please upload a standard JPG or PNG file.'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;

        if (width > height && width > maxSize) {
          height *= maxSize / width;
          width = maxSize;
        } else if (height > maxSize) {
          width *= maxSize / height;
          height = maxSize;
        }

        canvas.width = Math.round(width);
        canvas.height = Math.round(height);
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Failed to initialize image canvas.'));

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', CONFIG.JPEG_QUALITY);
        const rawBase64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        resolve(rawBase64);
      };
      img.src = String(event.target?.result || '');
    };

    reader.readAsDataURL(file);
  });
}

async function dataUriToBlob(dataUri) {
  try {
    const fetchRes = await fetch(dataUri);
    return await fetchRes.blob();
  } catch {
    const base64 = dataUri.split(',')[1] || '';
    const mime = dataUri.split(',')[0]?.split(':')[1]?.split(';')[0] || 'image/png';
    const byteString = atob(base64);
    const buffer = new ArrayBuffer(byteString.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < byteString.length; i += 1) bytes[i] = byteString.charCodeAt(i);
    return new Blob([buffer], { type: mime });
  }
}

function getTierColor(score) {
  if (score >= 90) return '#10B981';
  if (score >= 80) return '#9333EA';
  if (score >= 70) return '#EAB308';
  if (score >= 60) return '#F97316';
  return '#EF4444';
}

function normalizeModeLabel(mode) {
  if (!mode) return 'Unknown';
  if (mode === 'wardrobe_builder') return '1-Day Look';
  if (mode === 'work_trip_curator') return 'Work Trip';
  return mode.replace(/_/g, ' ');
}

function getPlannerApiMode() {
  const plannerType = DOM.plannerType.value;
  if (plannerType === '1_day') return 'wardrobe_builder';
  if (plannerType === 'work_week') return 'office_curation';
  if (plannerType === 'vacation') return 'travel_curator';
  if (plannerType === 'work_trip') return 'work_trip_curator';
  return 'wardrobe_builder';
}

function getActiveApiMode() {
  return STATE.currentMode === 'wardrobe_planner' ? getPlannerApiMode() : STATE.currentMode;
}

function updateMoodLabel() {
  setText(DOM.moodLabel, CONSTANTS.moodValues[DOM.moodSlider.value] || 'Balanced');
}

function resetVaultUploadUi() {
  setVisible(DOM.garmentFrame, false);
  setVisible(DOM.garmentDetails, false);
  setVisible(DOM.garmentStatus, false);
  setVisible(DOM.careTagStatus, false);
  setText(DOM.garmentUploadTrigger, 'Upload Photo');
  DOM.garmentCategory.value = '';
  DOM.garmentNotes.value = '';
  DOM.garmentPrice.value = '';
  DOM.garmentInput.value = '';
  STATE.currentGarmentFile = null;
  STATE.parsedCareTagData = null;
}

async function syncUserProfile() {
  const user = await getCurrentUser();
  if (!user) return;

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    console.warn('Failed to load profile:', error.message);
    return;
  }

  if (data) {
    DOM.mChest.value = data.chest || '';
    DOM.mInseam.value = data.inseam || '';
    DOM.mWaist.value = data.waist || '';
    DOM.mHeight.value = data.height || '';
  }

  if (STATE.profileListenersBound) return;

  const persistProfile = async () => {
    try {
      const latestUser = await getCurrentUser();
      if (!latestUser) return;

      const payload = {
        id: latestUser.id,
        chest: DOM.mChest.value || null,
        inseam: DOM.mInseam.value || null,
        waist: DOM.mWaist.value || null,
        height: DOM.mHeight.value || null,
        updated_at: new Date().toISOString(),
      };

      const { error: upsertError } = await supabase.from('profiles').upsert(payload);
      if (upsertError) throw upsertError;
    } catch (err) {
      console.warn('Failed to persist profile:', err.message || err);
    }
  };

  [DOM.mChest, DOM.mInseam, DOM.mWaist, DOM.mHeight].forEach((input) => {
    input.addEventListener('change', persistProfile);
  });

  STATE.profileListenersBound = true;
}

async function handleAuthState(session) {
  STATE.session = session;

  if (session) {
    setVisible(DOM.authOverlay, false);
    await syncUserProfile();
    await fetchVaultInventory(true).catch((err) => {
      console.warn('Background inventory refresh failed:', err.message || err);
    });
  } else {
    setVisible(DOM.authOverlay, true);
    STATE.cachedVaultInventory = [];
    STATE.cachedDossierHistory = [];
    DOM.vaultFeed.innerHTML = '';
    DOM.historyFeed.innerHTML = '';
  }
}

function getVaultCounts(items = STATE.cachedVaultInventory) {
  const counts = { Top: 0, Bottom: 0, Outerwear: 0, Footwear: 0, Accessory: 0 };
  items.forEach((item) => {
    if (counts[item.category] !== undefined) counts[item.category] += 1;
  });
  return counts;
}

function evaluatePlannerEligibility() {
  const counts = getVaultCounts();
  const plannerSelect = DOM.plannerType;

  Array.from(plannerSelect.options).forEach((option) => {
    const requirements = CONSTANTS.plannerRequirements[option.value];
    if (!requirements) return;

    let eligible = true;
    const missing = [];

    Object.entries(requirements).forEach(([category, minNeeded]) => {
      if ((counts[category] || 0) < minNeeded) {
        eligible = false;
        missing.push(`${minNeeded} ${category}s`);
      }
    });

    const baseText = option.text.split(' 🔒')[0];
    option.disabled = !eligible;
    option.text = eligible ? baseText : `${baseText} 🔒 (Needs ${missing.join(', ')})`;
  });

  if (plannerSelect.options[plannerSelect.selectedIndex]?.disabled) {
    plannerSelect.value = '1_day';
    handlePlannerChange();
  }
}

function computeDirtyItems(items = STATE.cachedVaultInventory) {
  return items.filter((item) => {
    const limit = item.wear_threshold || CONSTANTS.wearThresholds[item.category] || CONSTANTS.wearThresholds.Default;
    return item.status === 'NEEDS_CARE' || (item.wear_count || 0) >= limit;
  });
}

function renderVaultDashboard(items) {
  const counts = getVaultCounts(items);
  const total = items.length;

  const createStatBar = (label, count) => {
    const percentage = total > 0 ? (count / total) * 100 : 0;
    return `<div class="breakdown-item"><div class="breakdown-header"><span>${escapeHtml(label)}</span><span class="breakdown-score">${count}</span></div><div class="bar"><div class="bar-fill" style="width:${percentage}%"></div></div></div>`;
  };

  DOM.analyticsGrid.innerHTML = [
    createStatBar('Tops', counts.Top),
    createStatBar('Bottoms', counts.Bottom),
    createStatBar('Outerwear', counts.Outerwear),
    createStatBar('Footwear', counts.Footwear),
  ].join('');
  DOM.vaultDashboard.style.display = 'block';
}

function updateValetButton(items = STATE.cachedVaultInventory) {
  const dirtyItems = computeDirtyItems(items);
  if (dirtyItems.length > 0) {
    DOM.valetBtn.innerHTML = `⚑ The Wardrobe Concierge <span style="color:#ef4444; font-weight:bold;">(${dirtyItems.length} Items Need Care)</span>`;
    DOM.valetBtn.style.borderColor = '#ef4444';
  } else {
    DOM.valetBtn.innerHTML = '⚑ The Wardrobe Concierge (All Items Clean)';
    DOM.valetBtn.style.borderColor = 'var(--accent-blue)';
  }
}

async function fetchVaultInventory(backgroundOnly = false) {
  if (!backgroundOnly) {
    DOM.vaultFeed.innerHTML = '';
    setVisible(DOM.vaultLoader, true);
  }

  const controller = new AbortController();
  const timeoutId = withTimeout(controller, CONFIG.INVENTORY_TIMEOUT_MS);

  try {
    const res = await supabaseRestFetch('/rest/v1/my_closet?select=*&order=created_at.desc', {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await res.json();
    STATE.cachedVaultInventory = Array.isArray(data) ? data : [];
    evaluatePlannerEligibility();
    updateValetButton();

    if (backgroundOnly) return;

    setVisible(DOM.vaultLoader, false);

    if (STATE.cachedVaultInventory.length === 0) {
      DOM.vaultFeed.innerHTML = '<p style="text-align:center; color:var(--text-muted); font-size:12px; grid-column:span 2;">Your wardrobe is currently empty. Start uploading garments.</p>';
      return;
    }

    renderVaultDashboard(STATE.cachedVaultInventory);
    const fragment = document.createDocumentFragment();

    STATE.cachedVaultInventory.forEach((item) => {
      const wearCount = item.wear_count || 0;
      const limit = item.wear_threshold || CONSTANTS.wearThresholds[item.category] || CONSTANTS.wearThresholds.Default;
      let statusClass = 'status-clean';
      let bannerHtml = '';

      if (item.status === 'NEEDS_CARE' || wearCount >= limit) {
        statusClass = 'status-care';
        bannerHtml = '<div style="position:absolute; bottom:40px; left:0; width:100%; background:rgba(239, 68, 68, 0.9); color:white; font-size:9px; font-weight:bold; text-align:center; padding:4px 0; letter-spacing:1px; z-index:5;">NEEDS CARE</div>';
      } else if (wearCount >= limit - 1 && limit > 1) {
        statusClass = 'status-worn';
      }

      const div = document.createElement('div');
      div.className = 'vault-item';
      div.id = `vault-${item.id}`;
      div.addEventListener('click', (event) => {
        if (event.target instanceof HTMLElement && event.target.tagName !== 'BUTTON') openVaultItemDetail(item.id);
      });
      div.addEventListener('dblclick', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await logWearQuick(item.id);
      });

      div.innerHTML = `
        <div class="status-dot ${statusClass}" title="Wear Count: ${wearCount}/${limit}"></div>
        <button class="delete-btn" data-delete-vault-id="${escapeHtml(item.id)}" style="position:absolute; top:15px; right:15px; background:rgba(0,0,0,0.5); border-radius:50%; width:20px; height:20px; line-height:18px; text-align:center; z-index:10;">✕</button>
        <img src="${escapeHtml(item.image_url)}" loading="lazy" style="pointer-events:none;" alt="${escapeHtml(item.category)}">
        ${bannerHtml}
        <div class="vault-meta">${escapeHtml(item.category)}</div>
        <div class="vault-notes">${escapeHtml(item.notes || 'No description')}</div>
      `;
      fragment.appendChild(div);
    });

    DOM.vaultFeed.appendChild(fragment);
  } catch (error) {
    if (!backgroundOnly) {
      setVisible(DOM.vaultLoader, false);
      const message = error.name === 'AbortError' ? 'Network timeout' : error.message;
      DOM.vaultFeed.innerHTML = `<p style="color:#ef4444; grid-column:span 2; text-align:center;">Failed to load inventory: ${escapeHtml(message)}</p>`;
    }
    throw error;
  }
}

async function fetchWardrobeHistory() {
  DOM.historyFeed.innerHTML = '';
  setVisible(DOM.historyLoader, true);

  const controller = new AbortController();
  const timeoutId = withTimeout(controller, CONFIG.INVENTORY_TIMEOUT_MS);

  try {
    const res = await supabaseRestFetch('/rest/v1/wardrobe_analyses?select=*&order=created_at.desc', {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await res.json();
    STATE.cachedDossierHistory = Array.isArray(data) ? data : [];
    setVisible(DOM.historyLoader, false);

    if (STATE.cachedDossierHistory.length === 0) {
      DOM.historyFeed.innerHTML = '<p style="text-align:center; color:var(--text-muted); font-size:12px;">Your archives are currently empty.</p>';
      return;
    }

    const now = new Date();
    const oneWeekAgo = new Date(now);
    oneWeekAgo.setDate(now.getDate() - 7);

    let lifetimeSum = 0;
    let lifetimeCount = 0;
    let weeklySum = 0;
    let weeklyCount = 0;

    STATE.cachedDossierHistory.forEach((item) => {
      const score = item.score;
      if (typeof score === 'number' && score > 0) {
        lifetimeSum += score;
        lifetimeCount += 1;
        if (new Date(item.created_at) >= oneWeekAgo) {
          weeklySum += score;
          weeklyCount += 1;
        }
      }
    });

    const lifetimeAvg = lifetimeCount > 0 ? Math.round(lifetimeSum / lifetimeCount) : '--';
    const weeklyAvg = weeklyCount > 0 ? Math.round(weeklySum / weeklyCount) : '--';

    setText(DOM.lifetimeAvgScore, lifetimeAvg);
    DOM.lifetimeAvgScore.style.color = getTierColor(lifetimeAvg === '--' ? 0 : lifetimeAvg);
    setText(DOM.weeklyAvgScore, weeklyAvg);
    DOM.weeklyAvgScore.style.color = getTierColor(weeklyAvg === '--' ? 0 : weeklyAvg);

    const fragment = document.createDocumentFragment();

    STATE.cachedDossierHistory.forEach((item) => {
      if (item.mode === 'acquisition_board') return;

      const score = item.score || 'N/A';
      const tierColor = getTierColor(item.score || 0);
      const displayMode = normalizeModeLabel(item.mode);
      const dateStr = new Date(item.created_at).toLocaleDateString();

      let thumbUrl = item.image_url;
      if (String(thumbUrl).includes('dummyimage.com') && item.full_analysis?.outfit_combinations?.[0]) {
        const firstCombo = item.full_analysis.outfit_combinations[0];
        const firstId = firstCombo.item_ids?.[0] || firstCombo.item_urls?.[0];
        if (firstId) {
          let match = STATE.cachedVaultInventory.find((v) => v.id === firstId)
            || STATE.cachedVaultInventory.find((v) => v.image_url === firstId)
            || STATE.cachedVaultInventory.find((v) => v.notes && v.notes.toLowerCase().includes(String(firstId).toLowerCase()));

          if (match) thumbUrl = match.image_url;
          else if (typeof firstId === 'string' && firstId.startsWith('http')) thumbUrl = firstId;
        }
      }

      const div = document.createElement('div');
      div.className = 'history-item';
      div.id = `dossier-${item.id}`;
      div.addEventListener('click', () => openDossierModal(item.id));
      div.innerHTML = `
        <img src="${escapeHtml(thumbUrl)}" alt="Wardrobe analysis image" loading="lazy">
        <div class="history-content">
          <div>
            <div class="history-meta">
              <span>${escapeHtml(dateStr)} &bull; <span style="text-transform:capitalize;">${escapeHtml(displayMode)}</span></span>
              <button class="delete-btn" data-delete-dossier-id="${escapeHtml(item.id)}" title="Delete Dossier">✕</button>
            </div>
            <div class="label" style="font-size:8px;">Blueprint Verdict</div>
            <div class="history-verdict">${escapeHtml(item.verdict || 'Analysis interrupted or pending.')}</div>
          </div>
          <div class="history-score-block">
            <span style="font-size:10px; font-weight:bold; letter-spacing:1px; color:${tierColor}; text-transform:uppercase;">${escapeHtml(item.tier || 'Pending')}</span>
            <div class="history-score" style="color:${tierColor};">${escapeHtml(score)}</div>
          </div>
        </div>
      `;
      fragment.appendChild(div);
    });

    DOM.historyFeed.appendChild(fragment);
  } catch (error) {
    setVisible(DOM.historyLoader, false);
    const message = error.name === 'AbortError' ? 'Network timeout' : error.message;
    DOM.historyFeed.innerHTML = `<p style="color:#ef4444; text-align:center;">Failed to load dossiers: ${escapeHtml(message)}</p>`;
  }
}

function switchTab(activeTabId, activeViewId) {
  [DOM.tabAnalysis, DOM.tabWardrobe, DOM.tabVault].forEach((tab) => tab.classList.remove('active'));
  [DOM.analysisView, DOM.wardrobeView, DOM.vaultView].forEach((view) => view.classList.add('hidden'));
  $(activeTabId).classList.add('active');
  $(activeViewId).classList.remove('hidden');
  if (activeViewId === 'analysisView') updateTailorUI();
}

function handlePlannerChange() {
  if (STATE.currentMode !== 'wardrobe_planner') return;

  const plannerType = DOM.plannerType.value;
  if (plannerType === '1_day') {
    setText(DOM.evaluateBtn, 'Build My Outfit');
    DOM.tailorInstructions.innerHTML = '* The Styling Core will analyze your wardrobe and build an elite ensemble for your specific occasion.';
    setText(DOM.targetDateLabel, 'Target Date (Weather/Season anchor)');
    setVisible(DOM.buildDateBlock, true);
    setVisible(DOM.occasionBlock, true);
    setVisible(DOM.travelInputs, false);
    return;
  }

  if (plannerType === 'work_week') {
    setText(DOM.evaluateBtn, 'Plan Office Week');
    DOM.tailorInstructions.innerHTML = '* Curating a professional 5-day wardrobe (Mon-Fri) rotation.';
    setText(DOM.targetDateLabel, 'Start Date (Upcoming Sunday/Monday)');
    setVisible(DOM.buildDateBlock, true);
    setVisible(DOM.occasionBlock, false);
    setVisible(DOM.travelInputs, false);
    return;
  }

  if (plannerType === 'vacation') {
    setText(DOM.evaluateBtn, 'Plan Vacation Capsule');
    DOM.tailorInstructions.innerHTML = '* Building a minimalist leisure capsule wardrobe for your trip.';
    setVisible(DOM.buildDateBlock, false);
    setVisible(DOM.occasionBlock, false);
    setVisible(DOM.travelInputs, true);
    return;
  }

  if (plannerType === 'work_trip') {
    setText(DOM.evaluateBtn, 'Plan Work Trip Capsule');
    DOM.tailorInstructions.innerHTML = '* Curating a hybrid professional/travel capsule for your upcoming business trip.';
    setVisible(DOM.buildDateBlock, false);
    setVisible(DOM.occasionBlock, false);
    setVisible(DOM.travelInputs, true);
  }
}

function updateTailorUI() {
  setVisible(DOM.tailorInstructions, true);
  setVisible(DOM.vaultConnectionStatus, false);
  setVisible(DOM.plannerBlock, false);

  if (STATE.currentMode === 'morning_briefing') {
    setText(DOM.evaluateBtn, 'Generate Briefing');
    DOM.tailorInstructions.innerHTML = '* The engine will analyze the live weather and pull one elite, ready-to-wear outfit from your least-worn wardrobe items.';
    setVisible(DOM.selectionBlock, false);
    setVisible(DOM.tailorBlock, false);
    setVisible(DOM.uploadTrigger, false);
    setVisible(DOM.imageFrame, false);
    return;
  }

  if (STATE.currentMode === 'fit') {
    setText(DOM.evaluateBtn, 'Request Fitting');
    DOM.tailorInstructions.innerHTML = '* Stand straight with arms resting naturally at your sides.<br>Position camera at waist height.';
    setVisible(DOM.selectionBlock, false);
    setVisible(DOM.buildDateBlock, false);
    setVisible(DOM.travelInputs, false);
    setVisible(DOM.occasionBlock, false);
    setVisible(DOM.tailorBlock, true);
    setVisible(DOM.uploadTrigger, true);
    setVisible(DOM.imageFrame, Boolean(DOM.imageInput.files?.[0]));
    return;
  }

  if (STATE.currentMode === 'wardrobe_planner') {
    setVisible(DOM.selectionBlock, true);
    setVisible(DOM.plannerBlock, true);
    setVisible(DOM.tailorBlock, false);
    setVisible(DOM.uploadTrigger, false);
    setVisible(DOM.imageFrame, false);
    handlePlannerChange();
    return;
  }

  setText(DOM.evaluateBtn, 'Consult Stylist');
  setVisible(DOM.selectionBlock, true);
  setVisible(DOM.buildDateBlock, false);
  setVisible(DOM.tailorBlock, false);
  setVisible(DOM.plannerBlock, false);
  setVisible(DOM.occasionBlock, true);
  setVisible(DOM.travelInputs, false);
  setVisible(DOM.uploadTrigger, true);
  setVisible(DOM.imageFrame, Boolean(DOM.imageInput.files?.[0]));
}

async function fetchClimateData(cityInput) {
  if (!cityInput?.trim()) return 'Unknown';

  try {
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityInput.trim())}&count=1`);
    const geoData = await geoRes.json();
    if (!geoData.results?.length) return cityInput.trim();

    const { latitude, longitude, name } = geoData.results[0];
    const wxRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m&temperature_unit=fahrenheit`);
    const wxData = await wxRes.json();

    const temp = wxData.current?.temperature_2m;
    const humidity = wxData.current?.relative_humidity_2m;
    if (typeof temp !== 'number' || typeof humidity !== 'number') return name;

    return `${name} (Live): ${temp}°F, ${humidity}% Humidity`;
  } catch {
    console.warn('Weather fetch failed, using raw input.');
    return cityInput.trim();
  }
}

function getSelectedOccasion() {
  return DOM.categoryEl.value === 'Other' ? DOM.customOccasionEl.value.trim() : DOM.occasionEl.value.trim();
}

function requireEvaluationInputs(mode) {
  if (mode === 'evaluate' || mode === 'wardrobe_builder') {
    if (!getSelectedOccasion()) throw new Error('Please select a specific event.');
  }

  const imageOptionalModes = new Set(['wardrobe_builder', 'travel_curator', 'office_curation', 'work_trip_curator', 'morning_briefing']);
  if (!imageOptionalModes.has(mode) && !DOM.imageInput.files?.[0]) {
    throw new Error('Please submit a silhouette or inspiration image first.');
  }
}

function setResultLoading(message) {
  DOM.resultBox.classList.remove('hidden');
  DOM.resultBox.innerHTML = `<div class="loader-container"><div class="spinner"></div><div class="loading-text" id="statusText">${escapeHtml(message)}</div></div>`;
}

function setStatusText(message) {
  const statusText = document.getElementById('statusText');
  if (statusText) statusText.textContent = message;
}

function getLoadingMessage(mode) {
  if (mode === 'evaluate') return 'Evaluating your silhouette...';
  if (mode === 'fit') return 'Analyzing fit and proportions...';
  if (mode === 'wardrobe_builder') return 'Building your outfit...';
  if (mode === 'travel_curator') return 'Generating vacation packing list...';
  if (mode === 'work_trip_curator') return 'Curating work trip capsule...';
  if (mode === 'office_curation') return 'Curating your weekly office wardrobe...';
  if (mode === 'morning_briefing') return 'Fetching climate data and building daily outfit...';
  return 'Engaging the Styling Core...';
}

function getActionText(mode) {
  if (mode === 'evaluate') return 'Scoring silhouette and generating feedback...';
  if (mode === 'fit') return 'Calculating alteration blueprint...';
  if (mode === 'wardrobe_builder') return 'Engineering outfit from wardrobe...';
  if (mode === 'travel_curator') return 'Calculating optimal leisure capsule...';
  if (mode === 'work_trip_curator') return 'Calculating optimal business trip capsule...';
  if (mode === 'office_curation') return 'Calculating 5-day professional rotation...';
  if (mode === 'morning_briefing') return 'Constructing your zero-friction outfit...';
  return 'Analyzing wardrobe and curating...';
}

function buildAnalysisPayload({ image, mode, climateData }) {
  let selectedOccasion = getSelectedOccasion();
  let currentMood = CONSTANTS.moodValues[DOM.moodSlider.value] || 'Balanced';

  if (mode === 'office_curation') {
    selectedOccasion = 'Professional Office Week';
    currentMood = 'Executive/Balanced';
  }
  if (mode === 'morning_briefing') {
    selectedOccasion = 'Daily Wear';
    currentMood = 'Elevated/Intentional';
  }

  let finalNotes = DOM.notes.value.trim();

  if (mode === 'evaluate' || mode === 'fit') {
    finalNotes = `SYSTEM ANCHOR (Current Evaluation Date/Season): ${DOM.evalDate.value}. | User Notes: ${finalNotes}`;
  } else if (mode === 'wardrobe_builder') {
    finalNotes = `SYSTEM ANCHOR (Target Date for Outfit Generation): ${DOM.targetDate.value}. | User Notes: ${finalNotes}`;
  } else if (mode === 'office_curation') {
    finalNotes = `SYSTEM ANCHOR (Start of Work Week): ${DOM.targetDate.value}. | User Notes: ${finalNotes}`;
  } else if (mode === 'morning_briefing') {
    finalNotes = `SYSTEM ANCHOR (Today's Date): ${DOM.evalDate.value}. | User Notes: ${finalNotes}`;
  } else if (mode === 'travel_curator' || mode === 'work_trip_curator') {
    const dep = DOM.departureDate.value;
    const ret = DOM.returnDate.value;
    let durationText = '';
    if (dep && ret) {
      const diffTime = Math.abs(new Date(ret) - new Date(dep));
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
      durationText = ` (${diffDays} Total Days)`;
    }
    finalNotes = `TRIP ITINERARY: ${DOM.travelItinerary.value.trim()} | Trip Dates: ${dep} to ${ret}${durationText} | User Notes: ${finalNotes}`;
  }

  return {
    image,
    mode,
    occasion: selectedOccasion || 'General',
    notes: finalNotes,
    fitPreference: DOM.fitPreferenceEl.value || '',
    contrast: DOM.contrastProfile.value,
    climate: climateData,
    mood: currentMood,
    measurements: {
      chest: DOM.mChest.value,
      inseam: DOM.mInseam.value,
      waist: DOM.mWaist.value,
      height: DOM.mHeight.value,
    },
    stressTest: false,
    edgeCaseMode: false,
  };
}

async function readStreamingJsonResponse(response) {
  if (!response.body) throw new Error('Empty streaming response.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fullText += decoder.decode(value, { stream: true });
  }

  const cleanJson = fullText.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleanJson);
}

function renderList(label, items, icon = '•') {
  if (!Array.isArray(items) || items.length === 0) return '';
  return `<div class="card"><div class="label">${escapeHtml(label)}</div>${items.map((item) => `<span class="list-item">${escapeHtml(icon)} ${escapeHtml(item)}</span>`).join('')}</div>`;
}

function resolveOutfitImages(outfitObj) {
  const validUrls = [];
  const validIds = [];
  const returnedItems = outfitObj.item_ids || outfitObj.item_urls || [];

  if (returnedItems.length === 0 && outfitObj.reasoning) {
    const text = String(outfitObj.reasoning).toLowerCase();
    STATE.cachedVaultInventory.forEach((item) => {
      const note = String(item.notes || '').toLowerCase();
      if (note && note.length > 3 && text.includes(note) && !validIds.includes(item.id)) {
        validUrls.push(item.image_url);
        validIds.push(item.id);
      }
    });
  }

  returnedItems.forEach((aiValue) => {
    if (!aiValue || typeof aiValue !== 'string') return;

    let match = STATE.cachedVaultInventory.find((item) => item.id === aiValue)
      || STATE.cachedVaultInventory.find((item) => item.image_url === aiValue);

    if (!match) {
      let bestScore = 0;
      let bestItem = null;
      const searchStr = aiValue.toLowerCase();

      STATE.cachedVaultInventory.forEach((item) => {
        if (validIds.includes(item.id)) return;

        let score = 0;
        const note = String(item.notes || '').toLowerCase();
        const category = String(item.category || '').toLowerCase();

        if (note && searchStr.includes(note)) score += 10;
        if (note && note.includes(searchStr)) score += 10;

        const words = searchStr.split(/[\s,.-]+/).filter((word) => word.length > 2);
        words.forEach((word) => {
          if (note.includes(word)) score += 2;
          if (category.includes(word)) score += 1;
        });

        if (score > bestScore) {
          bestScore = score;
          bestItem = item;
        }
      });

      if (bestScore >= 2) match = bestItem;
    }

    if (match && !validIds.includes(match.id)) {
      validUrls.push(match.image_url);
      validIds.push(match.id);
    } else if (aiValue.startsWith('http') && !validUrls.includes(aiValue)) {
      validUrls.push(aiValue);
    }
  });

  return { validUrls, validIds };
}

function generateHTMLFromData(data, displayMode) {
  let html = '';
  let score = data.score ?? 0;

  if (data.breakdown && displayMode === 'evaluate') {
    const breakdown = data.breakdown;
    score = (breakdown.color || 0) + (breakdown.occasion || 0) + (breakdown.fit || 0) + (breakdown.cohesion || 0) + (breakdown.presence || 0);
  }

  const tierName = data.tier || 'Baseline';
  const tierColor = getTierColor(score);

  html += `
    <div class="score-badge">
      <div class="score-num" style="color:${tierColor};">${escapeHtml(score)}</div>
      <div class="label">${displayMode === 'fit' ? 'Proportion Index' : 'Style Index'}</div>
      <div class="tier" style="color:${tierColor};">${escapeHtml(tierName)}</div>
    </div>
  `;

  html += `<div class="card"><div class="label">Archetype</div><span class="body-text">${escapeHtml(data.archetype || 'The Individual')}</span></div>`;

  if (data.breakdown && displayMode === 'evaluate') {
    const breakdown = data.breakdown;
    const createBar = (label, value) => `<div class="breakdown-item"><div class="breakdown-header"><span>${escapeHtml(label)}</span><span class="breakdown-score">${escapeHtml(value)}/20</span></div><div class="bar"><div class="bar-fill" style="width:${(value / 20) * 100}%"></div></div></div>`;
    html += `<div class="card"><div class="label">Sartorial Breakdown</div><div class="breakdown-grid">${createBar('Color', breakdown.color || 0)}${createBar('Occasion', breakdown.occasion || 0)}${createBar('Fit', breakdown.fit || 0)}${createBar('Cohesion', breakdown.cohesion || 0)}${createBar('Presence', breakdown.presence || 0)}</div></div>`;
  }

  if (['wardrobe_builder', 'travel_curator', 'work_trip_curator', 'office_curation', 'morning_briefing'].includes(displayMode)) {
    if (Array.isArray(data.outfit_combinations) && data.outfit_combinations.length > 0) {
      if (displayMode === 'office_curation') {
        html += '<div class="card"><div class="label">Weekly Office Rotation</div><div class="week-grid">';
        data.outfit_combinations.forEach((outfit) => {
          const { validUrls } = resolveOutfitImages(outfit);
          html += `<div class="day-card"><div class="day-header">${escapeHtml(outfit.name || 'Workday')}</div><div class="day-body">${escapeHtml(outfit.reasoning || '')}</div>`;
          if (validUrls.length > 0) {
            html += '<div class="day-items">';
            validUrls.forEach((url) => {
              html += `<img src="${escapeHtml(url)}" loading="lazy" alt="Outfit item">`;
            });
            html += '</div>';
          }
          html += '</div>';
        });
        html += '</div></div>';
      } else {
        const label = displayMode === 'travel_curator' || displayMode === 'work_trip_curator'
          ? 'The Packing List'
          : displayMode === 'morning_briefing'
            ? 'The Daily Recommendation'
            : 'Outfit Combinations';

        html += `<div class="card"><div class="label">${escapeHtml(label)}</div>`;
        data.outfit_combinations.forEach((outfit) => {
          const { validUrls, validIds } = resolveOutfitImages(outfit);
          html += `<div style="margin-bottom:16px; padding-bottom:16px; border-bottom:1px solid rgba(197, 160, 89, 0.1);">`;
          html += `<div style="color:#F8FAFC; font-size:13px; font-weight:600; margin-bottom:4px;">✦ ${escapeHtml(outfit.name || 'Curated Look')}</div>`;
          html += `<div style="color:#cbd5e1; font-size:12px; margin-bottom:10px; line-height:1.4;">${escapeHtml(outfit.reasoning || '')}</div>`;

          if (validUrls.length > 0) {
            html += '<div style="display:flex; gap:8px; overflow-x:auto;">';
            validUrls.forEach((url) => {
              html += `<img src="${escapeHtml(url)}" style="width:70px; height:90px; object-fit:cover; border-radius:2px; border:1px solid rgba(197, 160, 89, 0.2);" alt="Outfit Item">`;
            });
            html += '</div>';
          }

          if ((displayMode === 'morning_briefing' || displayMode === 'wardrobe_builder') && validIds.length > 0) {
            html += `<button class="action-btn js-log-nightstand" data-item-ids="${escapeHtml(JSON.stringify(validIds))}" style="border-color:rgba(255,255,255,0.2); color:white; margin-top:15px;">Log This Wear</button>`;
          }

          html += '</div>';
        });
        html += '</div>';
      }
    } else {
      html += '<div class="card"><div class="label">Wardrobe Analysis Notice</div><span class="body-text" style="color:#EAB308;">The stylist analyzed your wardrobe but could not confidently build complete outfits based on the current inventory. Review the styling notes below and consider adding more versatile pieces.</span></div>';
    }
    html += renderList('Styling Notes', data.styling_notes);
  } else if (displayMode === 'fit') {
    html += renderList('Shoulders & Chest', data.fit_anatomy?.shoulders_and_chest);
    html += renderList('Waist & Torso', data.fit_anatomy?.waist_and_torso);
    html += renderList('Legs & Hem', data.fit_anatomy?.legs_and_hem);
    html += renderList('Alteration Blueprint', data.alteration_blueprint, '✂');
  } else {
    html += renderList('Key Strengths', data.what_works, '✓');
    html += renderList('Upgrades', data.recommendations);
  }

  if (Array.isArray(data.missing_pieces) && data.missing_pieces.length > 0) {
    html += renderList('Missing Pieces (Wardrobe Gaps)', data.missing_pieces, '△');
  }

  return html;
}

async function sendStreamingRequest(base64Image, activeApiMode) {
  const rawCity = DOM.climate.value.trim();
  if (rawCity) setStatusText('Pinging live climate data...');
  const climateData = await fetchClimateData(rawCity);
  setStatusText(getActionText(activeApiMode));

  const controller = new AbortController();
  const timeoutId = withTimeout(controller, CONFIG.STREAM_TIMEOUT_MS);

  try {
    const payload = buildAnalysisPayload({
      image: base64Image,
      mode: activeApiMode,
      climateData,
    });

    const response = await apiFetch('/api/chat', {
      method: 'POST',
      signal: controller.signal,
      body: payload,
    });

    const data = await readStreamingJsonResponse(response);
    STATE.lastAnalysisData = data;
    DOM.resultBox.innerHTML = `${generateHTMLFromData(data, activeApiMode)}<button id="downloadDossierBtn" class="upload-btn" style="margin-top:24px; border-color:var(--accent-blue); font-size:10px;">Download Dossier</button>`;
    DOM.resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    const message = error.name === 'AbortError' ? 'Generation timed out. The server dropped the connection.' : error.message;
    DOM.resultBox.innerHTML = `<div style="color:#ef4444; text-align:center; padding:20px;"><strong>Analysis Failed</strong><br>${escapeHtml(message)}</div>`;
  } finally {
    clearTimeout(timeoutId);
    DOM.evaluateBtn.disabled = false;
  }
}

async function handleEvaluateClick() {
  try {
    const activeApiMode = getActiveApiMode();
    requireEvaluationInputs(activeApiMode);

    DOM.evaluateBtn.disabled = true;
    setResultLoading(getLoadingMessage(activeApiMode));

    let base64Image = null;
    const noImageModes = new Set(['wardrobe_builder', 'travel_curator', 'office_curation', 'work_trip_curator', 'morning_briefing']);
    if (!noImageModes.has(activeApiMode)) {
      base64Image = await compressImage(DOM.imageInput.files[0]);
    }

    await sendStreamingRequest(base64Image, activeApiMode);
  } catch (err) {
    DOM.resultBox.innerHTML = `<div style="color:#ef4444; text-align:center; padding:20px;"><strong>Error</strong><br>${escapeHtml(err.message)}</div>`;
    DOM.evaluateBtn.disabled = false;
  }
}

function renderCareInstructions(item) {
  const instructions = item?.care_instructions?.instructions;
  if (!Array.isArray(instructions) || instructions.length === 0) return '';

  return `
    <div style="margin-top:15px; padding:10px; background:rgba(16, 185, 129, 0.1); border:1px solid rgba(16, 185, 129, 0.3); border-radius:4px; font-size:10px; line-height:1.4;">
      <div style="color:#10B981; font-weight:bold; margin-bottom:5px; text-transform:uppercase;">Care Instructions</div>
      ${instructions.map((i) => `• ${escapeHtml(i)}`).join('<br>')}
      <div style="margin-top:4px; font-weight:bold;">Machine Washable: ${item.care_instructions.is_machine_washable ? 'Yes' : 'No'}</div>
    </div>
  `;
}

function openVaultItemDetail(id) {
  const item = STATE.cachedVaultInventory.find((entry) => entry.id === id);
  if (!item) return;

  const wearCount = item.wear_count || 0;
  const totalWears = item.total_wears || 0;
  const limit = item.wear_threshold || CONSTANTS.wearThresholds[item.category] || CONSTANTS.wearThresholds.Default;
  const progressPercent = Math.min((wearCount / limit) * 100, 100);
  const lifeLimit = item.estimated_lifespan_wears || 150;
  const decayPercent = Math.min((totalWears / lifeLimit) * 100, 100).toFixed(1);
  const price = item.price || 0;
  const costPerWear = item.cost_per_wear || (price > 0 && totalWears > 0 ? (price / totalWears).toFixed(2) : 'N/A');

  DOM.genericModalBody.innerHTML = `
    <div style="text-align:center; margin-bottom:20px;">
      <img src="${escapeHtml(item.image_url)}" style="width:100%; max-height:300px; border-radius:4px; object-fit:cover; border:1px solid rgba(197, 160, 89, 0.2);" alt="Detail View">
      <div style="font-size:14px; font-weight:bold; color:white; margin-top:15px;">${escapeHtml(item.notes || item.category)}</div>
      <div style="display:flex; justify-content:center; gap:15px; margin-top:10px;">
        <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px;">Lifetime Wears: <span style="color:white; font-weight:bold;">${totalWears}</span></div>
        <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px;">Cost/Wear: <span style="color:#10B981; font-weight:bold;">$${escapeHtml(costPerWear)}</span></div>
      </div>
    </div>
    <div class="card" style="margin-top:0; margin-bottom:10px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:8px;">
        <div class="label" style="margin-bottom:0;">Wear Health</div>
        <div style="font-size:10px; color:white;">${wearCount} / ${limit} Wears</div>
      </div>
      <div class="bar" style="height:10px;"><div class="bar-fill" style="width:${progressPercent}%; background:${progressPercent >= 100 ? '#ef4444' : progressPercent >= 75 ? '#EAB308' : '#10B981'};"></div></div>
      ${progressPercent >= 100 ? '<div style="font-size:10px; color:#ef4444; margin-top:8px; font-weight:bold; text-align:center;">Item requires care before next use.</div>' : ''}
    </div>
    <div class="card" style="margin-top:0;">
      <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:8px;">
        <div class="label" style="margin-bottom:0;">Fabric Lifecycle (Heirloom)</div>
        <div style="font-size:10px; color:white;">${decayPercent}% Degraded</div>
      </div>
      <div class="bar" style="height:6px;"><div class="bar-fill" style="width:${decayPercent}%; background:${decayPercent >= 80 ? '#ef4444' : '#9333EA'};"></div></div>
      <div style="font-size:8px; color:var(--text-muted); margin-top:6px; text-align:right;">Estimated Limit: ${lifeLimit} wears</div>
    </div>
    ${renderCareInstructions(item)}
    <div style="display:flex; gap:10px; margin-top:20px;">
      <button class="action-btn js-inc-wear" data-item-id="${escapeHtml(item.id)}" id="btn-inc-${escapeHtml(item.id)}">+1 Mark as Worn</button>
      <button class="action-btn js-reset-item" data-item-id="${escapeHtml(item.id)}" id="btn-reset-${escapeHtml(item.id)}" style="border-color:#10B981; color:#10B981;">Mark as Cleaned</button>
    </div>
  `;
  DOM.genericModal.classList.add('active');
}

function closeGenericModal() {
  DOM.genericModal.classList.remove('active');
}

async function logWearQuick(id) {
  const el = document.getElementById(`vault-${id}`);
  if (el) {
    el.style.transform = 'scale(0.95)';
    window.setTimeout(() => {
      el.style.transform = 'scale(1)';
    }, 150);
  }
  await apiIncrementWear(id, true);
}

async function apiIncrementWear(id, isQuickLog = false) {
  const btn = document.getElementById(`btn-inc-${id}`);
  if (!isQuickLog && btn) btn.textContent = 'Logging...';

  try {
    await apiFetch('/api/ledger/increment', {
      method: 'POST',
      body: { itemId: id },
    });
    await fetchVaultInventory();
    if (!isQuickLog) {
      closeGenericModal();
      window.setTimeout(() => openVaultItemDetail(id), 100);
    }
  } catch (err) {
    console.error(err);
    notifyError('Failed to log wear.');
    if (!isQuickLog && btn) btn.textContent = '+1 Mark as Worn';
  }
}

async function apiResetItem(id) {
  const btn = document.getElementById(`btn-reset-${id}`);
  if (btn) btn.textContent = 'Resetting...';

  try {
    await apiFetch('/api/ledger/reset', {
      method: 'POST',
      body: { itemIds: [id] },
    });
    await fetchVaultInventory();
    closeGenericModal();
    window.setTimeout(() => openVaultItemDetail(id), 100);
  } catch (err) {
    console.error(err);
    notifyError('Failed to reset item.');
    if (btn) btn.textContent = 'Mark as Cleaned';
  }
}

async function apiBulkReset() {
  const btn = document.getElementById('btn-bulk-reset');
  if (btn) btn.textContent = 'Processing Laundry...';

  const itemIds = computeDirtyItems().map((item) => item.id);

  try {
    await apiFetch('/api/ledger/reset', {
      method: 'POST',
      body: { itemIds },
    });
    await fetchVaultInventory();
    closeGenericModal();
  } catch (err) {
    console.error(err);
    notifyError('Failed to process laundry list.');
    if (btn) btn.textContent = 'Mark All Items as Cleaned';
  }
}

function openValetDashboard() {
  const dirtyItems = computeDirtyItems();
  let html = `
    <div style="text-align:center; margin-bottom:24px;">
      <div style="font-family:'Cinzel'; font-size:24px; color:white;">The Wardrobe Concierge</div>
      <div style="font-size:10px; color:var(--accent-gold); letter-spacing:2px; text-transform:uppercase; margin-top:5px;">Laundry & Dry Cleaning Dashboard</div>
    </div>
  `;

  if (dirtyItems.length === 0) {
    html += '<div class="card"><div class="body-text" style="text-align:center;">All garments are currently clean and ready for rotation.</div></div>';
  } else {
    html += `<div style="font-size:12px; color:#ef4444; margin-bottom:15px; font-weight:bold;">${dirtyItems.length} item(s) require attention:</div>`;
    html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:20px; max-height:40vh; overflow-y:auto;">';
    dirtyItems.forEach((item) => {
      html += `
        <div style="background:rgba(0,0,0,0.5); border:1px solid #ef4444; border-radius:4px; padding:8px; text-align:center;">
          <img src="${escapeHtml(item.image_url)}" style="width:100%; height:80px; object-fit:cover; border-radius:2px;" alt="${escapeHtml(item.category)}">
          <div style="font-size:9px; color:white; margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(item.notes || item.category)}</div>
        </div>
      `;
    });
    html += '</div>';
    html += '<button class="action-btn js-bulk-reset" id="btn-bulk-reset" style="border-color:#10B981; color:#10B981;">Mark All Items as Cleaned</button>';
  }

  DOM.genericModalBody.innerHTML = html;
  DOM.genericModal.classList.add('active');
}

async function deleteVaultItem(id) {
  if (!window.confirm('Remove this item from your wardrobe?')) return;
  const el = document.getElementById(`vault-${id}`);
  if (el) el.style.opacity = '0.5';

  try {
    await supabaseRestFetch(`/rest/v1/my_closet?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (el) el.remove();
    if (DOM.vaultFeed.children.length === 0) await fetchVaultInventory();
  } catch (err) {
    notifyError(`Failed to delete item: ${err.message}`);
    if (el) el.style.opacity = '1';
  }
}

async function deleteDossier(id) {
  if (!window.confirm('Delete this dossier?')) return;
  const itemCard = document.getElementById(`dossier-${id}`);
  if (itemCard) itemCard.style.opacity = '0.5';

  try {
    await supabaseRestFetch(`/rest/v1/wardrobe_analyses?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (itemCard) itemCard.remove();
  } catch (err) {
    notifyError(`Failed to delete dossier: ${err.message}`);
    if (itemCard) itemCard.style.opacity = '1';
  }
}

function openDossierModal(id) {
  const item = STATE.cachedDossierHistory.find((entry) => entry.id === id);
  if (!item) return;

  let content = `
    <div style="text-align:center; margin-bottom:24px;">
      <img src="${escapeHtml(item.image_url)}" style="width:100%; max-height:250px; border-radius:4px; object-fit:cover; border:1px solid rgba(197, 160, 89, 0.2);" alt="Dossier Image">
      <div style="font-size:10px; color:var(--accent-gold); text-transform:uppercase; letter-spacing:2px; margin-top:15px;">${escapeHtml(new Date(item.created_at).toLocaleDateString())} &bull; ${escapeHtml(normalizeModeLabel(item.mode))}</div>
    </div>
  `;

  if (item.full_analysis) content += generateHTMLFromData(item.full_analysis, item.mode);
  else content += '<div class="card"><div class="body-text" style="text-align:center;">Detailed analysis data is not available for this legacy dossier.</div></div>';

  DOM.genericModalBody.innerHTML = content;
  DOM.genericModal.classList.add('active');
}

function downloadDossier() {
  if (!STATE.lastAnalysisData) return;
  const payload = `ELE VATE | OFFICIAL DOSSIER\nMODE: ${STATE.currentMode}\nSCORE: ${STATE.lastAnalysisData.score ?? ''}\nVERDICT: ${STATE.lastAnalysisData.verdict ?? ''}`;
  const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Dossier_${Date.now()}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

async function handleCareTagUpload(file) {
  if (!file) return;

  setVisible(DOM.careTagStatus, true);
  DOM.careTagStatus.style.color = 'var(--accent-gold)';
  DOM.careTagStatus.textContent = 'Scanning care tag with AI...';

  try {
    const compressedBase64 = await compressImage(file);
    const res = await apiFetch('/api/ledger/analyze-care-tag', {
      method: 'POST',
      body: { image: compressedBase64 },
    });
    const data = await res.json();
    STATE.parsedCareTagData = data.careProfile || null;
    DOM.careTagStatus.style.color = '#10B981';
    DOM.careTagStatus.textContent = 'Care instructions captured.';
  } catch {
    DOM.careTagStatus.style.color = '#ef4444';
    DOM.careTagStatus.textContent = 'Scan failed. Proceeding without AI care data.';
    STATE.parsedCareTagData = null;
  }
}

async function handleSaveGarment() {
  const category = DOM.garmentCategory.value;
  let notes = DOM.garmentNotes.value.trim();
  const price = Number(DOM.garmentPrice.value || 0);

  if (!category) {
    notifyError('Please select a category.');
    return;
  }

  if (!STATE.currentGarmentFile) {
    notifyError('Please upload a photo.');
    return;
  }

  DOM.saveGarmentBtn.disabled = true;
  setVisible(DOM.garmentStatus, true);
  DOM.garmentStatus.textContent = 'Optimizing image...';

  try {
    const session = await getSessionOrThrow();
    const base64Image = await compressImage(STATE.currentGarmentFile);

    DOM.garmentStatus.textContent = 'Extracting fabric attributes...';
    const tagRes = await apiFetch('/api/wardrobe/auto-tag', {
      method: 'POST',
      body: { image: base64Image },
    });

    let fabricData = {};
    const tagData = await tagRes.json().catch(() => null);
    if (tagData?.tags) {
      const tags = tagData.tags;
      notes = `${notes}${notes ? ' | ' : ''}Tags: ${tags.primary_color}, ${tags.pattern}, Season: ${tags.seasonality}`;
      fabricData = {
        fabric_weight_category: tags.fabric_weight_category,
        drape_index: tags.drape_index,
        estimated_lifespan_wears: tags.estimated_lifespan_wears,
      };
    }

    DOM.garmentStatus.textContent = 'Removing background...';
    const bgRes = await apiFetch('/api/remove-bg', {
      method: 'POST',
      body: { image: base64Image },
    });
    const bgData = await bgRes.json();
    if (!bgData?.image) throw new Error('Remove background failed.');

    DOM.garmentStatus.textContent = 'Preparing upload...';
    const blob = await dataUriToBlob(bgData.image);
    const fileName = `${session.user.id}/vault_clean_${crypto.randomUUID()}.png`;

    const uploadRes = await fetch(`${CONFIG.SUPABASE_URL}/storage/v1/object/${CONFIG.STORAGE_BUCKET}/${fileName}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: CONFIG.SUPABASE_ANON_KEY,
        'Content-Type': blob.type || 'image/png',
      },
      body: blob,
    });

    if (!uploadRes.ok) {
      throw new Error(await uploadRes.text());
    }

    const imageUrl = `${CONFIG.SUPABASE_URL}/storage/v1/object/public/${CONFIG.STORAGE_BUCKET}/${fileName}`;

    await supabaseRestFetch('/rest/v1/my_closet', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        image_url: imageUrl,
        category,
        notes,
        price,
        wear_count: 0,
        total_wears: 0,
        status: 'CLEAN',
        care_instructions: STATE.parsedCareTagData,
        ...fabricData,
      }),
    });

    DOM.garmentStatus.textContent = 'Wardrobe updated successfully.';
    window.setTimeout(async () => {
      resetVaultUploadUi();
      await fetchVaultInventory();
    }, 1500);
  } catch (err) {
    DOM.garmentStatus.textContent = `Failed to process: ${err.message}`;
  } finally {
    DOM.saveGarmentBtn.disabled = false;
  }
}

async function handleGhostSimulation() {
  const file = DOM.ghostInput.files?.[0];
  if (!file) {
    notifyError('Please upload an image of the anchor item.');
    return;
  }

  DOM.runGhostBtn.textContent = 'Analyzing Integration & Needs...';
  DOM.runGhostBtn.disabled = true;

  try {
    const base64Image = await compressImage(file);
    const res = await apiFetch('/api/designer/ghost-simulation', {
      method: 'POST',
      body: {
        ghostItemImageBase64: base64Image,
        ghostItemDescription: DOM.ghostDesc.value.trim(),
      },
    });

    const data = await res.json();
    const simulation = data.simulation;
    if (!simulation) throw new Error('Simulation failed.');

    let resultHtml = `
      <div class="card" style="text-align:center; border-color:#9333EA;">
        <div class="label" style="color:#9333EA;">Versatility Index</div>
        <div class="score-num" style="font-size:48px; color:white;">${escapeHtml(simulation.versatility_index)}</div>
        <div style="font-size:11px; color:#cbd5e1; margin-top:10px;">${escapeHtml(simulation.aesthetic_impact)}</div>
      </div>
      <div class="label" style="margin-top:20px;">Wardrobe Combinations</div>
    `;

    (simulation.sample_outfits || []).forEach((outfit) => {
      resultHtml += `
        <div style="margin-bottom:12px; padding:12px; border:1px solid rgba(197, 160, 89, 0.1); border-radius:4px;">
          <div style="font-size:11px; font-weight:bold; color:white;">${escapeHtml(outfit.outfit_name)}</div>
          <div style="font-size:10px; color:#cbd5e1; margin-top:4px;">${escapeHtml(outfit.reasoning)}</div>
          <div style="font-size:9px; color:#9333EA; margin-top:6px; text-transform:uppercase;">Pairs with: ${escapeHtml((outfit.existing_categories_used || []).join(', '))}</div>
        </div>
      `;
    });

    if (Array.isArray(simulation.missing_pieces) && simulation.missing_pieces.length > 0) {
      resultHtml += '<div class="card"><div class="label" style="color:#EAB308;">To Complete The Look (Buy Next)</div>';
      simulation.missing_pieces.forEach((item) => {
        resultHtml += `<span class="list-item" style="color:#cbd5e1;">△ ${escapeHtml(item)}</span>`;
      });
      resultHtml += '</div>';
    }

    DOM.ghostResult.innerHTML = resultHtml;
    DOM.runGhostBtn.textContent = 'Simulation Complete';
  } catch (err) {
    notifyError(`Failed to run anchor analysis: ${err.message}`);
    DOM.runGhostBtn.textContent = 'Run Stylist Analysis';
    DOM.runGhostBtn.disabled = false;
  }
}

async function handleAcquisitionBoard() {
  DOM.acquisitionBoardBtn.textContent = 'Generating...';
  DOM.acquisitionBoardBtn.disabled = true;

  try {
    const response = await apiFetch('/api/chat', {
      method: 'POST',
      body: { mode: 'acquisition_board' },
    });

    const data = await readStreamingJsonResponse(response);
    let html = `
      <div style="text-align:center; margin-bottom:24px;">
        <div style="font-family:'Cinzel'; font-size:24px; color:white;">Acquisition Board</div>
        <div style="font-size:10px; color:var(--accent-gold); letter-spacing:2px; text-transform:uppercase; margin-top:5px;">Smart Shopping Priorities</div>
        <div style="font-size:11px; color:#cbd5e1; margin-top:10px;">${escapeHtml(data.verdict || '')}</div>
      </div>
    `;

    (data.acquisition_list || []).forEach((item) => {
      const color = item.priority === 'High' ? '#ef4444' : item.priority === 'Medium' ? '#EAB308' : '#10B981';
      html += `
        <div class="card" style="border-left:3px solid ${color};">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div class="label" style="margin-bottom:0; color:white;">${escapeHtml(item.item)}</div>
            <div style="font-size:9px; font-weight:bold; text-transform:uppercase; color:${color};">${escapeHtml(item.priority)} Priority</div>
          </div>
          <div style="font-size:11px; color:#cbd5e1; margin-top:8px;">${escapeHtml(item.reasoning)}</div>
        </div>
      `;
    });

    DOM.genericModalBody.innerHTML = html;
    DOM.genericModal.classList.add('active');
  } catch (err) {
    notifyError('Failed to generate Acquisition Board.');
  } finally {
    DOM.acquisitionBoardBtn.textContent = 'View Acquisition Board';
    DOM.acquisitionBoardBtn.disabled = false;
  }
}

async function handleChronos() {
  DOM.chronosBtn.textContent = 'Mapping...';
  DOM.chronosBtn.disabled = true;

  try {
    const response = await apiFetch('/api/analytics/chronos');
    const payload = await response.json();

    if (payload.message) {
      notifyError(payload.message);
      return;
    }

    const chronos = payload.chronos;
    const color = chronos.trajectory === 'Improving' ? '#10B981' : chronos.trajectory === 'Stagnant' ? '#EAB308' : '#ef4444';

    DOM.genericModalBody.innerHTML = `
      <div style="text-align:center; margin-bottom:24px;">
        <div style="font-family:'Cinzel'; font-size:24px; color:white;">Aesthetic Trajectory</div>
        <div style="font-size:10px; color:#9333EA; letter-spacing:2px; text-transform:uppercase; margin-top:5px;">Aesthetic Evolution</div>
      </div>
      <div class="card" style="text-align:center; border-color:${color};">
        <div class="label" style="color:${color};">Trajectory: ${escapeHtml(chronos.trajectory)}</div>
        <div style="font-size:24px; font-weight:bold; color:white; margin-top:10px;">${escapeHtml(chronos.average_score_shift)}</div>
      </div>
      <div class="card">
        <div class="label">Aesthetic Drift</div>
        <div style="font-size:12px; color:#cbd5e1; line-height:1.5;">${escapeHtml(chronos.aesthetic_drift)}</div>
      </div>
      <div class="card" style="border-left:3px solid #9333EA;">
        <div class="label" style="color:#9333EA;">Course Correction</div>
        <div style="font-size:12px; color:white; line-height:1.5; font-style:italic;">&quot;${escapeHtml(chronos.course_correction)}&quot;</div>
      </div>
    `;
    DOM.genericModal.classList.add('active');
  } catch {
    notifyError('Failed to map aesthetic evolution.');
  } finally {
    DOM.chronosBtn.textContent = 'Aesthetic Trajectory';
    DOM.chronosBtn.disabled = false;
  }
}

function bindEvents() {
  DOM.googleLoginBtn.addEventListener('click', async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      DOM.authErrorMsg.textContent = error.message;
      DOM.authErrorMsg.style.display = 'block';
    }
  });

  DOM.appleLoginBtn.addEventListener('click', async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      DOM.authErrorMsg.textContent = error.message;
      DOM.authErrorMsg.style.display = 'block';
    }
  });

  DOM.logoutBtn.addEventListener('click', async () => {
    DOM.logoutBtn.textContent = 'Signing Out...';
    DOM.logoutBtn.disabled = true;
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.warn('Sign out failed:', err.message || err);
    } finally {
      window.location.reload();
    }
  });

  DOM.tabAnalysis.addEventListener('click', () => switchTab('tab-analysis', 'analysisView'));
  DOM.tabWardrobe.addEventListener('click', async () => {
    switchTab('tab-wardrobe', 'wardrobeView');
    await fetchWardrobeHistory();
  });
  DOM.tabVault.addEventListener('click', async () => {
    switchTab('tab-vault', 'vaultView');
    await fetchVaultInventory();
  });

  DOM.garmentUploadTrigger.addEventListener('click', () => DOM.garmentInput.click());
  DOM.careTagUploadTrigger.addEventListener('click', () => DOM.careTagInput.click());
  DOM.uploadTrigger.addEventListener('click', () => DOM.imageInput.click());

  DOM.garmentInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    STATE.currentGarmentFile = file;
    DOM.garmentPreview.src = URL.createObjectURL(file);
    setVisible(DOM.garmentFrame, true);
    setVisible(DOM.garmentDetails, true);
    setText(DOM.garmentUploadTrigger, 'Change Photo');
  });

  DOM.careTagInput.addEventListener('change', async (event) => {
    await handleCareTagUpload(event.target.files?.[0]);
  });

  DOM.saveGarmentBtn.addEventListener('click', handleSaveGarment);

  DOM.ghostSimTrigger.addEventListener('click', () => {
    DOM.genericModal.classList.remove('active');
    $('ghostModal').classList.add('active');
  });

  DOM.ghostInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    DOM.ghostPreview.src = URL.createObjectURL(file);
    setVisible(DOM.ghostFrame, true);
  });

  DOM.runGhostBtn.addEventListener('click', handleGhostSimulation);
  DOM.acquisitionBoardBtn.addEventListener('click', handleAcquisitionBoard);
  DOM.chronosBtn.addEventListener('click', handleChronos);

  DOM.imageInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    DOM.previewImg.src = URL.createObjectURL(file);
    setVisible(DOM.imageFrame, true);
    setText(DOM.uploadTrigger, 'Scan New Ensemble');
  });

  DOM.moodSlider.addEventListener('input', updateMoodLabel);
  DOM.evaluateBtn.addEventListener('click', handleEvaluateClick);
  DOM.plannerType.addEventListener('change', handlePlannerChange);

  DOM.categoryEl.addEventListener('change', () => {
    const category = DOM.categoryEl.value;
    DOM.occasionEl.innerHTML = '<option value="">Select Specific Event</option>';
    DOM.occasionEl.disabled = !category;

    if (category === 'Other') {
      setVisible(DOM.customOccasionEl, true);
      DOM.occasionEl.classList.add('hidden');
      return;
    }

    setVisible(DOM.customOccasionEl, false);
    DOM.occasionEl.classList.remove('hidden');
    (CONSTANTS.occasionMap[category] || []).forEach((occasion) => {
      DOM.occasionEl.add(new Option(occasion, occasion));
    });
  });

  const modeButtons = {
    evaluate: DOM.btnEvaluateMode,
    tailor_base: DOM.btnTailorBaseMode,
  };

  Object.entries(modeButtons).forEach(([key, button]) => {
    button.addEventListener('click', () => {
      Object.values(modeButtons).forEach((btn) => btn.classList.remove('active'));
      button.classList.add('active');
      const isTailorBase = key === 'tailor_base';
      DOM.tailorSubMenu.classList.toggle('hidden', !isTailorBase);
      DOM.tailorInstructions.classList.add('hidden');
      DOM.vaultConnectionStatus.classList.add('hidden');

      if (key === 'evaluate') {
        STATE.currentMode = 'evaluate';
        updateTailorUI();
      } else {
        STATE.currentMode = document.querySelector('input[name="tailorMode"]:checked')?.value || 'fit';
        updateTailorUI();
      }
    });
  });

  document.querySelectorAll('input[name="tailorMode"]').forEach((radio) => {
    radio.addEventListener('change', (event) => {
      STATE.currentMode = event.target.value;
      document.querySelectorAll('input[name="tailorMode"]').forEach((entry) => {
        entry.closest('.sub-btn')?.classList.remove('active');
      });
      event.target.closest('.sub-btn')?.classList.add('active');
      updateTailorUI();
    });
  });

  DOM.genericModal.addEventListener('click', (event) => {
    if (event.target === DOM.genericModal) closeGenericModal();
  });

  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.id === 'downloadDossierBtn') {
      downloadDossier();
      return;
    }

    if (target.matches('[data-delete-vault-id]')) {
      event.stopPropagation();
      await deleteVaultItem(target.getAttribute('data-delete-vault-id'));
      return;
    }

    if (target.matches('[data-delete-dossier-id]')) {
      event.stopPropagation();
      await deleteDossier(target.getAttribute('data-delete-dossier-id'));
      return;
    }

    if (target.matches('.js-inc-wear')) {
      await apiIncrementWear(target.getAttribute('data-item-id'));
      return;
    }

    if (target.matches('.js-reset-item')) {
      await apiResetItem(target.getAttribute('data-item-id'));
      return;
    }

    if (target.matches('.js-bulk-reset')) {
      await apiBulkReset();
      return;
    }

    if (target.matches('.js-log-nightstand')) {
      target.textContent = 'Logging Wears...';
      target.setAttribute('disabled', 'disabled');
      try {
        const ids = JSON.parse(target.getAttribute('data-item-ids') || '[]');
        await apiFetch('/api/ledger/nightstand-log', {
          method: 'POST',
          body: { itemIds: ids },
        });
        target.textContent = 'Outfit Logged ✓';
        target.style.borderColor = '#10B981';
        target.style.color = '#10B981';
        await fetchVaultInventory(true);
      } catch (err) {
        console.error(err);
        notifyError('Failed to log nightstand outfit.');
        target.removeAttribute('disabled');
        target.textContent = 'Log This Wear';
      }
      return;
    }
  });
}

async function initialize() {
  cacheDom();
  bindEvents();
  updateMoodLabel();

  const today = new Date().toISOString().split('T')[0];
  DOM.evalDate.value = today;
  DOM.targetDate.value = today;

  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(`Failed to initialize auth session: ${error.message}`);

  await handleAuthState(data.session || null);

  supabase.auth.onAuthStateChange(async (_event, session) => {
    try {
      await handleAuthState(session || null);
    } catch (err) {
      console.error('Auth state sync failed:', err.message || err);
    }
  });

  STATE.initialized = true;
}

initialize().catch((err) => {
  showCrash(err.message || String(err));
});

// Optional globals for legacy inline integrations still present in the page.
window.EleVateApp = {
  openVaultItemDetail,
  openValetDashboard,
  closeGenericModal,
  openDossierModal,
  downloadDossier,
};