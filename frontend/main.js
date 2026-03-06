import { createClient } from '@supabase/supabase-js';

const CONFIG = {
    SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
    BACKEND_URL: import.meta.env.VITE_BACKEND_URL
};

// Properly initialize Supabase via the NPM package
const supabaseClient = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: {
        flowType: 'pkce',
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true
    }
});

try {
  let globalSession = null;
  let currentMode = 'evaluate'; 
  let lastAnalysisData = null;
  let cachedDossierHistory = []; 
  let cachedVaultInventory = []; 
  let parsedCareTagData = null; 

  function compressImage(file, maxSize = 1200) {
      return new Promise((resolve, reject) => {
          if (!file) return reject(new Error("No file provided."));
          
          const reader = new FileReader();
          reader.onload = (event) => {
              const img = new Image();
              img.onload = () => {
                  const canvas = document.createElement('canvas');
                  let width = img.width;
                  let height = img.height;

                  if (width > height && width > maxSize) {
                      height *= maxSize / width;
                      width = maxSize;
                  } else if (height > maxSize) {
                      width *= maxSize / height;
                      height = maxSize;
                  }

                  canvas.width = width;
                  canvas.height = height;
                  const ctx = canvas.getContext('2d');
                  ctx.drawImage(img, 0, 0, width, height);
                  
                  const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                  const rawBase64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
                  
                  resolve(rawBase64);
              };
              
              img.onerror = () => reject(new Error("Invalid image format. Please upload a standard JPG or PNG file."));
              img.src = event.target.result;
          };
          
          reader.onerror = () => reject(new Error("Failed to read the file from your device."));
          reader.readAsDataURL(file);
      });
  }
  
  async function secureFetch(endpoint, options = {}) {
      if (!globalSession || !globalSession.access_token) {
          throw new Error("Authentication required. Please sign out and log back in.");
      }

      const headers = {
          'Authorization': `Bearer ${globalSession.access_token}`,
          ...(options.headers || {})
      };

      if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
          options.body = JSON.stringify(options.body);
          if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(`${CONFIG.BACKEND_URL}${endpoint}`, { ...options, headers });
      
      if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `Backend Error: ${response.status}`);
      }
      
      return response;
  }

  async function syncUserProfile() {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (!user) return;
      
      const { data } = await supabaseClient.from('profiles').select('*').eq('id', user.id).maybeSingle();
      
      if (data) {
          document.getElementById('m_chest').value = data.chest || '';
          document.getElementById('m_inseam').value = data.inseam || '';
          document.getElementById('m_waist').value = data.waist || '';
          document.getElementById('m_height').value = data.height || '';
      }

      ['m_chest', 'm_inseam', 'm_waist', 'm_height'].forEach(id => {
          document.getElementById(id).addEventListener('change', async () => {
              const profile = {
                  id: user.id,
                  chest: document.getElementById('m_chest').value,
                  inseam: document.getElementById('m_inseam').value,
                  waist: document.getElementById('m_waist').value,
                  height: document.getElementById('m_height').value,
                  updated_at: new Date()
              };
              await supabaseClient.from('profiles').upsert(profile);
          });
      });
  }

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
      globalSession = session;
      const authOverlay = document.getElementById('authOverlay');
      if (session) {
          authOverlay.classList.add('hidden');
          await syncUserProfile();
          fetchVaultInventory(true); 
      } else {
          authOverlay.classList.remove('hidden');
          cachedVaultInventory = [];
          cachedDossierHistory = [];
          document.getElementById('vaultFeed').innerHTML = '';
          document.getElementById('historyFeed').innerHTML = '';
      }
  });

  document.getElementById('googleLoginBtn').addEventListener('click', async () => {
      localStorage.clear(); 
      sessionStorage.clear();
      const { error } = await supabaseClient.auth.signInWithOAuth({ 
          provider: 'google',
          options: { redirectTo: window.location.origin }
      });
      if (error) { document.getElementById('authErrorMsg').innerText = error.message; document.getElementById('authErrorMsg').style.display = 'block'; }
  });

  document.getElementById('appleLoginBtn').addEventListener('click', async () => {
      localStorage.clear();
      sessionStorage.clear();
      const { error } = await supabaseClient.auth.signInWithOAuth({ 
          provider: 'apple',
          options: { redirectTo: window.location.origin }
      });
      if (error) { document.getElementById('authErrorMsg').innerText = error.message; document.getElementById('authErrorMsg').style.display = 'block'; }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => await supabaseClient.auth.signOut());

  const WEAR_THRESHOLDS = { "Suit": 4, "Blazer": 5, "Outerwear": 5, "Bottom": 10, "Top": 2, "Accessory": 5, "Footwear": 10, "Default": 3 };
  const occasionMap = {
    "Activity / Outdoor": ["Beach", "Country Club", "Game", "Golf Scramble", "Hiking", "PickleBall", "Yacht / Sailing"],
    "Casual / Everyday": ["Casual", "Church", "Grocery Shopping", "Running Errands in Town", "Smart Casual"],
    "Formal": ["Black Tie", "Cocktail Attire", "Gala", "Rehearsal Dinner", "Wedding"],
    "Professional": ["Boardroom / Pitch", "Business Casual", "Business Formal", "Conference", "Creative Office", "Interview", "Networking Event", "Tech Casual"],
    "Seasonal / Holiday": ["Easter", "Holiday Party", "Kentucky Derby", "New Year’s"],
    "Social": ["Bar", "Concert", "Date Night", "Day Party", "Dinner", "Gallery Opening", "Speakeasy", "Upscale Lounge"],
    "Travel": ["5 Star Resort", "Airport", "Business Red-Eye", "Cruise", "European Summer", "Ski Resort Apres-Ski", "Vacation"],
    "Other": ["Other"]
  };

  const imageInput = document.getElementById('imageInput');
  const uploadTrigger = document.getElementById('uploadTrigger');
  const evaluateBtn = document.getElementById('evaluateBtn');
  const resultBox = document.getElementById('result');
  const categoryEl = document.getElementById('category');
  const occasionEl = document.getElementById('occasion');
  const customOccasionEl = document.getElementById('customOccasion');
  const fitPreferenceEl = document.getElementById('fitPreference');
  const previewImg = document.getElementById('imagePreview');
  const imageFrame = document.getElementById('imageFrame');
  const tailorInstructions = document.getElementById('tailorInstructions');
  const moodSlider = document.getElementById('moodSlider');
  const moodLabel = document.getElementById('moodLabel');
  const moodValues = { 1: "Understated", 2: "Balanced", 3: "Stand Out" };

  const tabAnalysis = document.getElementById('tab-analysis');
  const tabWardrobe = document.getElementById('tab-wardrobe');
  const tabVault = document.getElementById('tab-vault');
  const analysisView = document.getElementById('analysisView');
  const wardrobeView = document.getElementById('wardrobeView');
  const vaultView = document.getElementById('vaultView');
  const historyFeed = document.getElementById('historyFeed');
  const historyLoader = document.getElementById('historyLoader');
  const travelInputs = document.getElementById('travelInputs');
  const occasionBlock = document.getElementById('occasionBlock');

  document.addEventListener('DOMContentLoaded', () => {
    try {
      const todayStr = new Date().toISOString().split('T')[0];
      document.getElementById('evalDate').value = todayStr;
      document.getElementById('targetDate').value = todayStr;
      
      const evalBtn = document.getElementById('btn-evaluate');
      if (evalBtn) evalBtn.click();
    } catch (e) { console.warn("Initialization logic err."); }
  });

  function switchTab(activeTabId, activeViewId) {
    [tabAnalysis, tabWardrobe, tabVault].forEach(t => t.classList.remove('active'));
    [analysisView, wardrobeView, vaultView].forEach(v => v.classList.add('hidden'));
    document.getElementById(activeTabId).classList.add('active');
    document.getElementById(activeViewId).classList.remove('hidden');
    if(activeViewId === 'analysisView') updateTailorUI();
  }

  tabAnalysis.addEventListener('click', () => switchTab('tab-analysis', 'analysisView'));
  tabWardrobe.addEventListener('click', () => { switchTab('tab-wardrobe', 'wardrobeView'); fetchWardrobeHistory(); });
  tabVault.addEventListener('click', () => { switchTab('tab-vault', 'vaultView'); fetchVaultInventory(); });

  const garmentInput = document.getElementById('garmentInput');
  const garmentUploadTrigger = document.getElementById('garmentUploadTrigger');
  const careTagInput = document.getElementById('careTagInput');
  const careTagUploadTrigger = document.getElementById('careTagUploadTrigger');
  const careTagStatus = document.getElementById('careTagStatus');
  const garmentPreview = document.getElementById('garmentPreview');
  const garmentFrame = document.getElementById('garmentFrame');
  const garmentDetails = document.getElementById('garmentDetails');
  const saveGarmentBtn = document.getElementById('saveGarmentBtn');
  const vaultFeed = document.getElementById('vaultFeed');
  const vaultLoader = document.getElementById('vaultLoader');
  const garmentStatus = document.getElementById('garmentStatus');
  let currentGarmentFile = null;

  garmentUploadTrigger.addEventListener('click', () => garmentInput.click());
  careTagUploadTrigger.addEventListener('click', () => careTagInput.click());

  garmentInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      currentGarmentFile = file;
      garmentPreview.src = URL.createObjectURL(file);
      garmentFrame.classList.remove('hidden');
      garmentDetails.classList.remove('hidden');
      garmentUploadTrigger.innerText = "Change Photo";
    }
  });

  careTagInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    careTagStatus.classList.remove('hidden');
    careTagStatus.style.color = "var(--accent-gold)";
    careTagStatus.innerText = "Scanning Care Tag with AI...";
    
    try {
        const compressedBase64 = await compressImage(file);
        const res = await secureFetch('/api/ledger/analyze-care-tag', {
            method: 'POST',
            body: { image: compressedBase64 }
        });
        if (!res.ok) throw new Error("Failed to scan tag.");
        const data = await res.json();
        parsedCareTagData = data.careProfile;
        careTagStatus.style.color = "#10B981";
        careTagStatus.innerText = "Care Instructions Captured ✓";
    } catch (err) {
        careTagStatus.style.color = "#ef4444";
        careTagStatus.innerText = "Scan Failed. Proceeding without AI care data.";
        parsedCareTagData = null;
    }
  });

  saveGarmentBtn.addEventListener('click', async () => {
    const cat = document.getElementById('garmentCategory').value;
    let notes = document.getElementById('garmentNotes').value;
    const price = document.getElementById('garmentPrice').value || 0; 
    if (!cat) return alert("Please select a category.");
    if (!currentGarmentFile) return alert("Please upload a photo.");

    saveGarmentBtn.disabled = true;
    garmentStatus.classList.remove('hidden');
    garmentStatus.innerText = "Optimizing Image...";

    try {
        let base64Image = await compressImage(currentGarmentFile);
        
        garmentStatus.innerText = "Extracting Fabric Attributes (AI Vision)...";
        const tagRes = await secureFetch('/api/wardrobe/auto-tag', {
            method: 'POST',
            body: { image: base64Image }
        });
        
        let fabricData = {};
        if (tagRes.ok) {
            const tagData = await tagRes.json();
            const aiTags = tagData.tags;
            notes += ` | Tags: ${aiTags.primary_color}, ${aiTags.pattern}, Season: ${aiTags.seasonality}`;
            fabricData = {
              fabric_weight_category: aiTags.fabric_weight_category,
              drape_index: aiTags.drape_index,
              estimated_lifespan_wears: aiTags.estimated_lifespan_wears
            };
        }

        garmentStatus.innerText = "Isolating Background...";
        const bgRes = await secureFetch('/api/remove-bg', {
            method: 'POST',
            body: { image: base64Image }
        });

        if (!bgRes.ok) throw new Error(`Server Error: RemoveBG Failed`);
        const { image: transparentImageUri } = await bgRes.json();

        garmentStatus.innerText = "Encrypting & Storing in Private Vault...";
        
        let blob;
        try {
            const fetchRes = await fetch(transparentImageUri);
            blob = await fetchRes.blob();
        } catch (mobileError) {
            const byteString = atob(transparentImageUri.split(',')[1]);
            const mimeString = transparentImageUri.split(',')[0].split(':')[1].split(';')[0];
            const ab = new ArrayBuffer(byteString.length);
            const ia = new Uint8Array(ab);
            for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
            blob = new Blob([ab], { type: mimeString });
        }
        
        const fileName = `${globalSession.user.id}/vault_clean_${Math.random().toString(36).substring(2)}.png`;
        
        const { data: uploadData, error: uploadError } = await supabaseClient.storage
          .from('wardrobe_images')
          .upload(fileName, blob, { contentType: 'image/png' });

        if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
        const { data: { publicUrl } } = supabaseClient.storage.from('wardrobe_images').getPublicUrl(fileName);

        const { error: dbError } = await supabaseClient.from('my_closet').insert([{ 
          image_url: publicUrl, 
          category: cat, 
          notes: notes,
          price: price, 
          wear_count: 0,
          total_wears: 0,
          status: 'CLEAN',
          care_instructions: parsedCareTagData,
          ...fabricData 
        }]);
        
        if (dbError) throw new Error(`Database save failed: ${dbError.message}`);

        garmentStatus.innerText = "Wardrobe Updated Successfully.";
        setTimeout(() => {
          garmentFrame.classList.add('hidden');
          garmentDetails.classList.add('hidden');
          garmentStatus.classList.add('hidden');
          careTagStatus.classList.add('hidden');
          garmentUploadTrigger.innerText = "Upload Photo";
          document.getElementById('garmentCategory').value = "";
          document.getElementById('garmentNotes').value = "";
          document.getElementById('garmentPrice').value = "";
          currentGarmentFile = null;
          parsedCareTagData = null;
          garmentInput.value = ""; 
          fetchVaultInventory();
        }, 1500);

    } catch (err) {
      garmentStatus.innerText = "Failed to process: " + err.message;
    } finally {
      saveGarmentBtn.disabled = false; 
    }
  });

  async function fetchVaultInventory(backgroundOnly = false) {
    if (!backgroundOnly) {
        vaultFeed.innerHTML = '';
        vaultLoader.classList.remove('hidden');
    }
    
    // PRODUCTION FIX: AbortController Timeout to physically stop infinite loading spinners
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000); 

    try {
        const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/my_closet?select=*&order=created_at.desc`, {
            signal: controller.signal,
            headers: {
                'apikey': CONFIG.SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${globalSession?.access_token || ''}`,
                'Accept': 'application/json'
            }
        });
        
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`Database connection failed (${res.status})`);
        const data = await res.json();
        
        if (!backgroundOnly) vaultLoader.classList.add('hidden');
        cachedVaultInventory = data;

        const dirtyItems = cachedVaultInventory.filter(i => {
          const limit = i.wear_threshold || WEAR_THRESHOLDS[i.category] || WEAR_THRESHOLDS["Default"];
          return i.status === 'NEEDS_CARE' || (i.wear_count || 0) >= limit;
        });
        
        const valetBtn = document.getElementById('valetBtn');
        if (dirtyItems.length > 0) {
            valetBtn.innerHTML = `⚑ The Valet <span style="color:#ef4444; font-weight:bold;">(${dirtyItems.length} Items Need Care)</span>`;
            valetBtn.style.borderColor = "#ef4444";
        } else {
            valetBtn.innerHTML = `⚑ The Valet (All Items Clean)`;
            valetBtn.style.borderColor = "var(--accent-blue)";
        }

        if (backgroundOnly) return; 

        if (!data || data.length === 0) return vaultFeed.innerHTML = `<p style="text-align:center; color:var(--text-muted); font-size:12px; grid-column:span 2;">Your Wardrobe is currently empty. Start uploading garments!</p>`;

        const counts = { Top: 0, Bottom: 0, Outerwear: 0, Footwear: 0, Accessory: 0 };
        let total = data.length;
        data.forEach(item => { if(counts[item.category] !== undefined) counts[item.category]++; });

        const createStatBar = (label, count, total) => {
            const p = total > 0 ? (count / total) * 100 : 0;
            return `<div class="breakdown-item"><div class="breakdown-header"><span>${label}</span><span class="breakdown-score">${count}</span></div><div class="bar"><div class="bar-fill" style="width:${p}%"></div></div></div>`;
        };

        document.getElementById('analyticsGrid').innerHTML = 
            createStatBar("Tops", counts.Top, total) + 
            createStatBar("Bottoms", counts.Bottom, total) + 
            createStatBar("Outerwear", counts.Outerwear, total) + 
            createStatBar("Footwear", counts.Footwear, total);
        document.getElementById('vaultDashboard').style.display = 'block';

        data.forEach(item => {
          const wearCount = item.wear_count || 0;
          const limit = item.wear_threshold || WEAR_THRESHOLDS[item.category] || WEAR_THRESHOLDS["Default"];
          let statusClass = 'status-clean';
          let bannerHtml = '';

          if (item.status === 'NEEDS_CARE' || wearCount >= limit) {
              statusClass = 'status-care';
              bannerHtml = `<div style="position:absolute; bottom:40px; left:0; width:100%; background:rgba(239, 68, 68, 0.9); color:white; font-size:9px; font-weight:bold; text-align:center; padding:4px 0; letter-spacing:1px; z-index:5;">NEEDS CARE</div>`;
          }
          else if (wearCount >= limit - 1 && limit > 1) statusClass = 'status-worn';

          const div = document.createElement('div');
          div.className = 'vault-item';
          div.id = `vault-${item.id}`;
          div.onclick = (e) => { if(e.target.tagName !== 'BUTTON') openVaultItemDetail(item.id); };
          div.ondblclick = (e) => { e.preventDefault(); e.stopPropagation(); logWearQuick(item.id); };
          
          div.innerHTML = `
            <div class="status-dot ${statusClass}" title="Wear Count: ${wearCount}/${limit}"></div>
            <button class="delete-btn" onclick="event.stopPropagation(); deleteVaultItem('${item.id}')" style="position:absolute; top:15px; right:15px; background:rgba(0,0,0,0.5); border-radius:50%; width:20px; height:20px; line-height:18px; text-align:center; z-index: 10;">✕</button>
            <img src="${item.image_url}" loading="lazy" style="pointer-events: none;" alt="${item.category}">
            ${bannerHtml}
            <div class="vault-meta">${item.category}</div>
            <div class="vault-notes">${item.notes || 'No description'}</div>
          `;
          vaultFeed.appendChild(div);
        });
    } catch (error) {
        if (!backgroundOnly) {
            vaultLoader.classList.add('hidden');
            let msg = error.name === 'AbortError' ? "Network timeout" : error.message;
            vaultFeed.innerHTML = `<p style="color:#ef4444; grid-column:span 2; text-align:center;">Failed to load inventory: ${msg}</p>`;
        }
    }
  }

  window.openVaultItemDetail = function(id) {
    const item = cachedVaultInventory.find(i => i.id === id);
    if(!item) return;

    const wearCount = item.wear_count || 0;
    const totalWears = item.total_wears || 0;
    const limit = item.wear_threshold || WEAR_THRESHOLDS[item.category] || WEAR_THRESHOLDS["Default"];
    const progressPercent = Math.min((wearCount / limit) * 100, 100);
    
    const lifeLimit = item.estimated_lifespan_wears || 150; 
    const decayPercent = Math.min((totalWears / lifeLimit) * 100, 100).toFixed(1);
    
    const price = item.price || 0;
    const cpw = item.cost_per_wear || (price > 0 && totalWears > 0 ? (price / totalWears).toFixed(2) : 'N/A');
    
    let careHtml = '';
    if (item.care_instructions && item.care_instructions.instructions) {
      careHtml = `<div style="margin-top: 15px; padding: 10px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 4px; font-size: 10px; line-height: 1.4;">
        <div style="color: #10B981; font-weight: bold; margin-bottom: 5px; text-transform: uppercase;">Care Instructions</div>
        ${item.care_instructions.instructions.map(i => `• ${i}`).join('<br>')}
        <div style="margin-top: 4px; font-weight: bold;">Machine Washable: ${item.care_instructions.is_machine_washable ? 'Yes' : 'No'}</div>
      </div>`;
    }

    const html = `
      <div style="text-align: center; margin-bottom: 20px;">
        <img src="${item.image_url}" style="width: 100%; max-height: 300px; border-radius: 4px; object-fit: cover; border: 1px solid rgba(197, 160, 89, 0.2);" alt="Detail View">
        <div style="font-size: 14px; font-weight: bold; color: white; margin-top: 15px;">${item.notes || item.category}</div>
        <div style="display: flex; justify-content: center; gap: 15px; margin-top: 10px;">
            <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px;">Lifetime Wears: <span style="color: white; font-weight: bold;">${totalWears}</span></div>
            <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px;">Cost/Wear: <span style="color: #10B981; font-weight: bold;">$${cpw}</span></div>
        </div>
      </div>

      <div class="card" style="margin-top: 0; margin-bottom: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 8px;">
          <div class="label" style="margin-bottom: 0;">Wear Health</div>
          <div style="font-size: 10px; color: white;">${wearCount} / ${limit} Wears</div>
        </div>
        <div class="bar" style="height: 10px;"><div class="bar-fill" style="width: ${progressPercent}%; background: ${progressPercent >= 100 ? '#ef4444' : (progressPercent >= 75 ? '#EAB308' : '#10B981')};"></div></div>
        ${progressPercent >= 100 ? '<div style="font-size: 10px; color: #ef4444; margin-top: 8px; font-weight: bold; text-align: center;">Item requires care before next use.</div>' : ''}
      </div>

      <div class="card" style="margin-top: 0;">
        <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 8px;">
          <div class="label" style="margin-bottom: 0;">Fabric Lifecycle (Heirloom)</div>
          <div style="font-size: 10px; color: white;">${decayPercent}% Degraded</div>
        </div>
        <div class="bar" style="height: 6px;"><div class="bar-fill" style="width: ${decayPercent}%; background: ${decayPercent >= 80 ? '#ef4444' : '#9333EA'};"></div></div>
        <div style="font-size: 8px; color: var(--text-muted); margin-top: 6px; text-align: right;">Estimated Limit: ${lifeLimit} wears</div>
      </div>

      ${careHtml}

      <div style="display: flex; gap: 10px; margin-top: 20px;">
        <button class="action-btn" onclick="apiIncrementWear('${item.id}')" id="btn-inc-${item.id}">+1 Mark as Worn</button>
        <button class="action-btn" onclick="apiResetItem('${item.id}')" id="btn-reset-${item.id}" style="border-color: #10B981; color: #10B981;">Mark as Cleaned</button>
      </div>
    `;

    document.getElementById('genericModalBody').innerHTML = html;
    document.getElementById('genericModal').classList.add('active');
  };

  document.getElementById('ghostSimTrigger').addEventListener('click', () => { document.getElementById('ghostModal').classList.add('active'); });
  
  document.getElementById('ghostInput').addEventListener('change', (e) => {
    if (e.target.files[0]) {
      document.getElementById('ghostPreview').src = URL.createObjectURL(e.target.files[0]);
      document.getElementById('ghostFrame').classList.remove('hidden');
    }
  });

  document.getElementById('runGhostBtn').addEventListener('click', async () => {
    const file = document.getElementById('ghostInput').files[0];
    if (!file) return alert("Please upload an image of the anchor item.");
    
    const btn = document.getElementById('runGhostBtn');
    btn.innerText = "Analyzing Integration & Needs...";
    btn.disabled = true;

    try {
        const base64Image = await compressImage(file);

        const res = await secureFetch('/api/designer/ghost-simulation', {
          method: 'POST',
          body: {
            ghostItemImageBase64: base64Image,
            ghostItemDescription: document.getElementById('ghostDesc').value
          }
        });

        if (!res.ok) throw new Error("Simulation failed.");
        const data = await res.json();
        const sim = data.simulation;

        let resultHtml = `
          <div class="card" style="text-align: center; border-color: #9333EA;">
            <div class="label" style="color: #9333EA;">Versatility Index</div>
            <div class="score-num" style="font-size: 48px; color: white;">${sim.versatility_index}</div>
            <div style="font-size: 11px; color: #cbd5e1; margin-top: 10px;">${sim.aesthetic_impact}</div>
          </div>
          <div class="label" style="margin-top: 20px;">Wardrobe Combinations</div>
        `;
        
        sim.sample_outfits.forEach(outfit => {
            resultHtml += `
            <div style="margin-bottom: 12px; padding: 12px; border: 1px solid rgba(197, 160, 89, 0.1); border-radius: 4px;">
              <div style="font-size: 11px; font-weight: bold; color: white;">${outfit.outfit_name}</div>
              <div style="font-size: 10px; color: #cbd5e1; margin-top: 4px;">${outfit.reasoning}</div>
              <div style="font-size: 9px; color: #9333EA; margin-top: 6px; text-transform: uppercase;">Pairs with: ${outfit.existing_categories_used.join(', ')}</div>
            </div>`;
        });

        if (sim.missing_pieces && sim.missing_pieces.length > 0) {
            resultHtml += `<div class="card"><div class="label" style="color: #EAB308;">To Complete The Look (Buy Next)</div>`;
            sim.missing_pieces.forEach(item => {
                resultHtml += `<span class="list-item" style="color: #cbd5e1;">△ ${item}</span>`;
            });
            resultHtml += `</div>`;
        }

        document.getElementById('ghostResult').innerHTML = resultHtml;
        btn.innerText = "Simulation Complete";
    } catch (err) {
      alert("Failed to run Anchor Analysis: " + err.message);
      btn.innerText = "Run Stylist Analysis";
      btn.disabled = false;
    }
  });

  window.openValetDashboard = function() {
    const dirtyItems = cachedVaultInventory.filter(i => {
      const limit = i.wear_threshold || WEAR_THRESHOLDS[i.category] || WEAR_THRESHOLDS["Default"];
      return i.status === 'NEEDS_CARE' || (i.wear_count || 0) >= limit;
    });

    let html = `
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-family: 'Cinzel'; font-size: 24px; color: white;">The Valet</div>
        <div style="font-size: 10px; color: var(--accent-gold); letter-spacing: 2px; text-transform: uppercase; margin-top: 5px;">Laundry & Dry Cleaning Dashboard</div>
      </div>
    `;

    if (dirtyItems.length === 0) {
      html += `<div class="card"><div class="body-text" style="text-align:center;">All garments are currently clean and ready for rotation.</div></div>`;
    } else {
      html += `<div style="font-size: 12px; color: #ef4444; margin-bottom: 15px; font-weight: bold;">${dirtyItems.length} item(s) require attention:</div>`;
      html += `<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px; max-height: 40vh; overflow-y: auto;">`;
      
      dirtyItems.forEach(item => {
        html += `
          <div style="background: rgba(0,0,0,0.5); border: 1px solid #ef4444; border-radius: 4px; padding: 8px; text-align: center;">
            <img src="${item.image_url}" style="width: 100%; height: 80px; object-fit: cover; border-radius: 2px;" alt="${item.category}">
            <div style="font-size: 9px; color: white; margin-top: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.notes || item.category}</div>
          </div>
        `;
      });
      html += `</div>`;
      html += `<button class="action-btn" onclick="apiBulkReset()" id="btn-bulk-reset" style="border-color: #10B981; color: #10B981;">Mark All Items as Cleaned</button>`;
    }

    document.getElementById('genericModalBody').innerHTML = html;
    document.getElementById('genericModal').classList.add('active');
  };

  window.logWearQuick = async function(id) {
    const el = document.getElementById(`vault-${id}`);
    if(el) {
        el.style.transform = 'scale(0.95)';
        setTimeout(() => el.style.transform = 'scale(1)', 150);
    }
    await apiIncrementWear(id, true);
  };

  window.apiIncrementWear = async function(id, isQuickLog = false) {
    const btn = document.getElementById(`btn-inc-${id}`);
    if(!isQuickLog && btn) btn.innerText = "Logging...";
    try {
      const res = await secureFetch('/api/ledger/increment', {
        method: 'POST',
        body: { itemId: id }
      });
      if(res.ok) {
        await fetchVaultInventory();
        if(!isQuickLog) {
          closeGenericModal();
          setTimeout(() => openVaultItemDetail(id), 100); 
        }
      }
    } catch(e) { 
        console.error(e); 
        alert("Failed to log wear."); 
        if (!isQuickLog && btn) btn.innerText = "+1 Mark as Worn"; 
    }
  };

  window.triggerNightstandLog = async function(buttonEl, ...itemIds) {
      buttonEl.innerText = "Logging Wears...";
      buttonEl.disabled = true;
      try {
        const res = await secureFetch('/api/ledger/nightstand-log', {
            method: 'POST',
            body: { itemIds: itemIds }
        });
        if(res.ok) {
            buttonEl.innerText = "Outfit Logged ✓";
            buttonEl.style.borderColor = "#10B981";
            buttonEl.style.color = "#10B981";
            fetchVaultInventory(true);
        }
      } catch(e) { 
          console.error(e); 
          alert("Failed to log nightstand outfit."); 
          buttonEl.disabled = false;
          buttonEl.innerText = "Log This Wear";
      }
  };

  window.apiResetItem = async function(id) {
    const btn = document.getElementById(`btn-reset-${id}`);
    if (btn) btn.innerText = "Resetting...";
    try {
      const res = await secureFetch('/api/ledger/reset', {
        method: 'POST',
        body: { itemIds: [id] }
      });
      if(res.ok) {
        await fetchVaultInventory();
        closeGenericModal();
        setTimeout(() => openVaultItemDetail(id), 100);
      }
    } catch(e) { 
        console.error(e); 
        alert("Failed to reset item."); 
        if (btn) btn.innerText = "Mark as Cleaned";
    }
  };

  window.apiBulkReset = async function() {
    const btn = document.getElementById('btn-bulk-reset');
    if(btn) btn.innerText = "Processing Laundry...";
    const dirtyItems = cachedVaultInventory.filter(i => {
      const limit = i.wear_threshold || WEAR_THRESHOLDS[i.category] || WEAR_THRESHOLDS["Default"];
      return i.status === 'NEEDS_CARE' || (i.wear_count || 0) >= limit;
    }).map(i => i.id);

    try {
      const res = await secureFetch('/api/ledger/reset', {
        method: 'POST',
        body: { itemIds: dirtyItems }
      });
      if(res.ok) {
        await fetchVaultInventory();
        closeGenericModal();
      }
    } catch(e) { 
        console.error(e); 
        alert("Failed to process laundry list."); 
        if (btn) btn.innerText = "Mark All Items as Cleaned";
    }
  };

  window.closeGenericModal = function() { document.getElementById('genericModal').classList.remove('active'); };
  document.getElementById('genericModal').addEventListener('click', (e) => { if (e.target === document.getElementById('genericModal')) closeGenericModal(); });

  window.deleteVaultItem = async function(id) {
    if (!confirm("Remove this item from your Wardrobe?")) return;
    const el = document.getElementById(`vault-${id}`);
    if (el) el.style.opacity = '0.5';
    const { error } = await supabaseClient.from('my_closet').delete().eq('id', id);
    if (error) {
      alert("Failed to delete: " + error.message);
      if (el) el.style.opacity = '1'; 
    } else {
      if (el) el.remove(); 
      if (vaultFeed.children.length === 0) fetchVaultInventory();
    }
  };

  document.getElementById('acquisitionBoardBtn').addEventListener('click', async () => {
    const btn = document.getElementById('acquisitionBoardBtn');
    btn.innerText = "Generating...";
    btn.disabled = true;

    try {
        const response = await secureFetch('/api/chat', { 
            method: 'POST',
            body: { mode: 'acquisition_board' }
        });
        
        if (!response.ok) throw new Error(`Backend unavailable`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
        }
        
        let cleanJson = fullText.trim();
        if (cleanJson.startsWith('```json')) cleanJson = cleanJson.substring(7, cleanJson.length - 3).trim();
        const data = JSON.parse(cleanJson);
        
        let html = `<div style="text-align: center; margin-bottom: 24px;">
            <div style="font-family: 'Cinzel'; font-size: 24px; color: white;">Acquisition Board</div>
            <div style="font-size: 10px; color: var(--accent-gold); letter-spacing: 2px; text-transform: uppercase; margin-top: 5px;">Smart Shopping Priorities</div>
            <div style="font-size: 11px; color: #cbd5e1; margin-top: 10px;">${data.verdict}</div>
        </div>`;
        
        if(data.acquisition_list) {
            data.acquisition_list.forEach(item => {
                const color = item.priority === 'High' ? '#ef4444' : (item.priority === 'Medium' ? '#EAB308' : '#10B981');
                html += `
                <div class="card" style="border-left: 3px solid ${color};">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div class="label" style="margin-bottom:0; color:white;">${item.item}</div>
                        <div style="font-size:9px; font-weight:bold; text-transform:uppercase; color:${color};">${item.priority} Priority</div>
                    </div>
                    <div style="font-size:11px; color:#cbd5e1; margin-top:8px;">${item.reasoning}</div>
                </div>`;
            });
        }
        
        document.getElementById('genericModalBody').innerHTML = html;
        document.getElementById('genericModal').classList.add('active');
        
    } catch(err) {
        alert("Failed to generate Acquisition Board");
    } finally {
        btn.innerText = "View Acquisition Board";
        btn.disabled = false;
    }
  });

  document.getElementById('chronosBtn').addEventListener('click', async () => {
    const btn = document.getElementById('chronosBtn');
    btn.innerText = "Mapping...";
    btn.disabled = true;

    try {
        const response = await secureFetch('/api/analytics/chronos');
        if (!response.ok) throw new Error("Chronos fetch failed");
        
        const resData = await response.json();
        
        if (resData.message) {
           alert(resData.message);
           return;
        }

        const chronos = resData.chronos;
        const trajColor = chronos.trajectory === 'Improving' ? '#10B981' : (chronos.trajectory === 'Stagnant' ? '#EAB308' : '#ef4444');

        let html = `<div style="text-align: center; margin-bottom: 24px;">
            <div style="font-family: 'Cinzel'; font-size: 24px; color: white;">Chronos Heatmap</div>
            <div style="font-size: 10px; color: #9333EA; letter-spacing: 2px; text-transform: uppercase; margin-top: 5px;">Aesthetic Evolution</div>
        </div>
        <div class="card" style="text-align: center; border-color: ${trajColor};">
          <div class="label" style="color: ${trajColor};">Trajectory: ${chronos.trajectory}</div>
          <div style="font-size: 24px; font-weight: bold; color: white; margin-top: 10px;">${chronos.average_score_shift}</div>
        </div>
        <div class="card">
          <div class="label">Aesthetic Drift</div>
          <div style="font-size: 12px; color: #cbd5e1; line-height: 1.5;">${chronos.aesthetic_drift}</div>
        </div>
        <div class="card" style="border-left: 3px solid #9333EA;">
          <div class="label" style="color: #9333EA;">Course Correction</div>
          <div style="font-size: 12px; color: white; line-height: 1.5; font-style: italic;">"${chronos.course_correction}"</div>
        </div>`;

        document.getElementById('genericModalBody').innerHTML = html;
        document.getElementById('genericModal').classList.add('active');
        
    } catch(err) {
        alert("Failed to map Aesthetic Evolution.");
    } finally {
        btn.innerText = "Chronos Aesthetic Heatmap";
        btn.disabled = false;
    }
  });

  async function fetchWardrobeHistory() {
    historyFeed.innerHTML = '';
    historyLoader.classList.remove('hidden');
    
    // PRODUCTION FIX: AbortController Timeout to physically stop infinite loading spinners
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
        const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/wardrobe_analyses?select=*&order=created_at.desc`, {
            signal: controller.signal,
            headers: {
                'apikey': CONFIG.SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${globalSession?.access_token || ''}`,
                'Accept': 'application/json'
            }
        });
        
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`Database connection failed (${res.status})`);
        const data = await res.json();
        
        historyLoader.classList.add('hidden');

        if (!data || data.length === 0) return historyFeed.innerHTML = `<p style="text-align:center; color:var(--text-muted); font-size:12px;">Your archives are currently empty.</p>`;

        cachedDossierHistory = data; 
        
        const now = new Date();
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(now.getDate() - 7);

        let lifetimeSum = 0, lifetimeCount = 0;
        let weeklySum = 0, weeklyCount = 0;

        data.forEach(item => {
          const score = item.score;
          if (typeof score === 'number' && score > 0) {
            lifetimeSum += score;
            lifetimeCount++;
            const itemDate = new Date(item.created_at);
            if (itemDate >= oneWeekAgo) {
                weeklySum += score;
                weeklyCount++;
            }
          }
        });

        const lifetimeAvg = lifetimeCount > 0 ? Math.round(lifetimeSum / lifetimeCount) : '--';
        const weeklyAvg = weeklyCount > 0 ? Math.round(weeklySum / weeklyCount) : '--';

        document.getElementById('lifetimeAvgScore').innerText = lifetimeAvg;
        document.getElementById('lifetimeAvgScore').style.color = getTierColor(lifetimeAvg === '--' ? 0 : lifetimeAvg);
        document.getElementById('weeklyAvgScore').innerText = weeklyAvg;
        document.getElementById('weeklyAvgScore').style.color = getTierColor(weeklyAvg === '--' ? 0 : weeklyAvg);

        data.forEach(item => {
          if(item.mode === 'acquisition_board') return;

          const dateStr = new Date(item.created_at).toLocaleDateString();
          const score = item.score || 'N/A';
          const tierColor = getTierColor(item.score || 0);
          
          const div = document.createElement('div');
          div.className = 'history-item';
          div.id = `dossier-${item.id}`;
          div.onclick = () => openDossierModal(item.id);
          
          let displayMode = item.mode.replace('_', ' ');
          if (item.mode === 'wardrobe_builder') displayMode = "1-Day Look";
          if (item.mode === 'work_trip_curator') displayMode = "Work Trip";

          div.innerHTML = `
            <img src="${item.image_url}" alt="Wardrobe analysis image" loading="lazy">
            <div class="history-content">
              <div>
                <div class="history-meta">
                  <span>${dateStr} &bull; <span style="text-transform:capitalize;">${displayMode}</span></span>
                  <button class="delete-btn" onclick="event.stopPropagation(); deleteDossier('${item.id}')" title="Delete Dossier">✕</button>
                </div>
                <div class="label" style="font-size:8px;">Blueprint Verdict</div>
                <div class="history-verdict">${item.verdict || 'Analysis interrupted or pending.'}</div>
              </div>
              <div class="history-score-block">
                <span style="font-size: 10px; font-weight: bold; letter-spacing: 1px; color: ${tierColor}; text-transform: uppercase;">${item.tier || 'Pending'}</span>
                <div class="history-score" style="color: ${tierColor};">${score}</div>
              </div>
            </div>
          `;
          historyFeed.appendChild(div);
        });
    } catch (error) {
        historyLoader.classList.add('hidden');
        let msg = error.name === 'AbortError' ? "Network timeout" : error.message;
        historyFeed.innerHTML = `<p style="color:#ef4444; text-align:center;">Failed to load dossiers: ${msg}</p>`;
    }
  }

  window.openDossierModal = function(id) {
      const item = cachedDossierHistory.find(d => d.id === id);
      if (!item) return;
      let content = `<div style="text-align: center; margin-bottom: 24px;"><img src="${item.image_url}" style="width: 100%; max-height: 250px; border-radius: 4px; object-fit: cover; border: 1px solid rgba(197, 160, 89, 0.2);" alt="Dossier Image"><div style="font-size: 10px; color: var(--accent-gold); text-transform: uppercase; letter-spacing: 2px; margin-top: 15px;">${new Date(item.created_at).toLocaleDateString()} &bull; ${item.mode.replace('_', ' ')}</div></div>`;
      if (item.full_analysis) content += generateHTMLFromData(item.full_analysis, item.mode);
      else content += `<div class="card"><div class="body-text" style="text-align:center;">Detailed analysis data is not available for this legacy dossier.</div></div>`;
      document.getElementById('genericModalBody').innerHTML = content;
      document.getElementById('genericModal').classList.add('active');
  };

  window.deleteDossier = async function(id) {
    if (!confirm("Delete this dossier?")) return;
    const itemCard = document.getElementById(`dossier-${id}`);
    if (itemCard) itemCard.style.opacity = '0.5';
    const { error } = await supabaseClient.from('wardrobe_analyses').delete().eq('id', id);
    if (error) { alert("Failed to delete: " + error.message); if (itemCard) itemCard.style.opacity = '1'; } 
    else { if (itemCard) itemCard.remove(); }
  };

  uploadTrigger.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', (e) => {
    if (e.target.files[0]) {
      previewImg.src = URL.createObjectURL(e.target.files[0]);
      imageFrame.classList.remove('hidden');
      uploadTrigger.innerText = "Revise Silhouette";
    }
  });

  moodSlider.addEventListener('input', (e) => { moodLabel.innerText = moodValues[e.target.value]; });

  const modeBtns = { evaluate: document.getElementById('btn-evaluate'), tailor_base: document.getElementById('btn-tailor-base') };

  Object.keys(modeBtns).forEach(btnKey => {
    modeBtns[btnKey].addEventListener('click', () => {
      Object.values(modeBtns).forEach(btn => btn.classList.remove('active'));
      modeBtns[btnKey].classList.add('active');
      const isTailorBase = btnKey === 'tailor_base';
      document.getElementById('tailorSubMenu').classList.toggle('hidden', !isTailorBase);
      tailorInstructions.classList.add('hidden');
      document.getElementById('vaultConnectionStatus').classList.add('hidden');

      if (btnKey === 'evaluate') {
         currentMode = 'evaluate';
         evaluateBtn.innerText = "Consult Stylist";
         document.getElementById('selectionBlock').classList.remove('hidden');
         document.getElementById('buildDateBlock').classList.add('hidden');
         document.getElementById('tailorBlock').classList.add('hidden');
         document.getElementById('plannerBlock').classList.add('hidden');
         occasionBlock.classList.remove('hidden');
         travelInputs.classList.add('hidden'); 
         uploadTrigger.classList.remove('hidden');
         if(imageInput.files[0]) imageFrame.classList.remove('hidden');
      } else if (isTailorBase) {
         currentMode = document.querySelector('input[name="tailorMode"]:checked').value;
         updateTailorUI();
      }
    });
  });

  const tailorRadios = document.querySelectorAll('input[name="tailorMode"]');
  tailorRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      currentMode = e.target.value;
      document.querySelectorAll('.sub-btn').forEach(btn => btn.classList.remove('active'));
      e.target.parentElement.classList.add('active');
      updateTailorUI();
    });
  });

  document.getElementById('plannerType').addEventListener('change', handlePlannerChange);

  function handlePlannerChange() {
      if (currentMode !== 'wardrobe_planner') return;
      const pType = document.getElementById('plannerType').value;
      const targetLabel = document.getElementById('targetDateLabel');
      const targetBlock = document.getElementById('buildDateBlock');
      const occBlock = document.getElementById('occasionBlock');
      const travelBlock = document.getElementById('travelInputs');

      if (pType === '1_day') {
          evaluateBtn.innerText = "Build My Outfit";
          tailorInstructions.innerHTML = "* The Styling Core will analyze your Wardrobe and build an Elite ensemble for your specific occasion.";
          targetLabel.innerText = "Target Date (Weather/Season anchor)";
          targetBlock.classList.remove('hidden');
          occBlock.classList.remove('hidden');
          travelBlock.classList.add('hidden');
      } else if (pType === 'work_week') {
          evaluateBtn.innerText = "Plan Office Week";
          tailorInstructions.innerHTML = "* Curating a professional 5-day wardrobe (Mon-Fri) rotation.";
          targetLabel.innerText = "Start Date (Upcoming Sunday/Monday)";
          targetBlock.classList.remove('hidden');
          occBlock.classList.add('hidden');
          travelBlock.classList.add('hidden');
      } else if (pType === 'vacation') {
          evaluateBtn.innerText = "Plan Vacation Capsule";
          tailorInstructions.innerHTML = "* Building a minimalist leisure capsule wardrobe for your trip.";
          targetBlock.classList.add('hidden');
          occBlock.classList.add('hidden');
          travelBlock.classList.remove('hidden');
      } else if (pType === 'work_trip') {
          evaluateBtn.innerText = "Plan Work Trip Capsule";
          tailorInstructions.innerHTML = "* Curating a hybrid professional/travel capsule for your upcoming business trip.";
          targetBlock.classList.add('hidden');
          occBlock.classList.add('hidden');
          travelBlock.classList.remove('hidden');
      }
  }

  function updateTailorUI() {
    tailorInstructions.classList.remove('hidden');
    document.getElementById('vaultConnectionStatus').classList.add('hidden');
    document.getElementById('plannerBlock').classList.add('hidden'); 
    
    if (currentMode === 'morning_briefing') {
      evaluateBtn.innerText = "Generate Briefing";
      tailorInstructions.innerHTML = "* The Engine will analyze the live weather and pull ONE elite, ready-to-wear outfit from your least-worn Wardrobe items.";
      document.getElementById('selectionBlock').classList.add('hidden');
      document.getElementById('tailorBlock').classList.add('hidden');
      uploadTrigger.classList.add('hidden');
      imageFrame.classList.add('hidden');
    }
    else if (currentMode === 'fit') {
      evaluateBtn.innerText = "Request Fitting";
      tailorInstructions.innerHTML = "* Stand straight with arms resting naturally at your sides.<br>Position camera at waist height.";
      document.getElementById('selectionBlock').classList.add('hidden');
      document.getElementById('buildDateBlock').classList.add('hidden');
      travelInputs.classList.add('hidden');
      occasionBlock.classList.remove('hidden');
      document.getElementById('tailorBlock').classList.remove('hidden');
      uploadTrigger.classList.remove('hidden');
      if (imageInput.files[0]) imageFrame.classList.remove('hidden');
    } 
    else if (currentMode === 'wardrobe_planner') {
      document.getElementById('selectionBlock').classList.remove('hidden');
      document.getElementById('plannerBlock').classList.remove('hidden');
      document.getElementById('tailorBlock').classList.add('hidden');
      uploadTrigger.classList.add('hidden');
      imageFrame.classList.add('hidden');
      handlePlannerChange();
    }
  }

  categoryEl.addEventListener('change', () => {
    const cat = categoryEl.value;
    occasionEl.innerHTML = '<option value="">Select Occasion</option>';
    occasionEl.disabled = !cat;
    if (cat === 'Other') {
      customOccasionEl.classList.remove('hidden');
      occasionEl.classList.add('hidden');
    } else {
      customOccasionEl.classList.add('hidden');
      occasionEl.classList.remove('hidden');
      if (occasionMap[cat]) occasionMap[cat].forEach(occ => occasionEl.add(new Option(occ, occ)));
    }
  });

  async function fetchClimateData(cityInput) {
      if (!cityInput) return "Unknown";
      try {
          const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityInput)}&count=1`);
          const geoData = await geoRes.json();
          if (!geoData.results || geoData.results.length === 0) return cityInput; 
          
          const { latitude, longitude, name } = geoData.results[0];
          const wxRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m&temperature_unit=fahrenheit`);
          const wxData = await wxRes.json();
          
          const temp = wxData.current.temperature_2m;
          const hum = wxData.current.relative_humidity_2m;
          return `${name} (Live): ${temp}°F, ${hum}% Humidity`;
      } catch (e) {
          console.warn("Weather fetch failed, using raw input.");
          return cityInput;
      }
  }

  evaluateBtn.addEventListener('click', async () => {
    let activeApiMode = currentMode;
    if (currentMode === 'wardrobe_planner') {
        const pType = document.getElementById('plannerType').value;
        if (pType === '1_day') activeApiMode = 'wardrobe_builder';
        if (pType === 'work_week') activeApiMode = 'office_curation';
        if (pType === 'vacation') activeApiMode = 'travel_curator';
        if (pType === 'work_trip') activeApiMode = 'work_trip_curator';
    }

    if (activeApiMode !== 'office_curation' && activeApiMode !== 'morning_briefing' && activeApiMode !== 'travel_curator' && activeApiMode !== 'work_trip_curator') {
        const selectedOccasion = categoryEl.value === 'Other' ? customOccasionEl.value : occasionEl.value;
        if (!selectedOccasion) return alert("Please select a Target Occasion.");
    }
    
    if (activeApiMode !== 'wardrobe_builder' && activeApiMode !== 'travel_curator' && activeApiMode !== 'office_curation' && activeApiMode !== 'work_trip_curator' && activeApiMode !== 'morning_briefing' && !imageInput.files[0]) {
      return alert("Please submit a silhouette or inspiration image first.");
    }
    
    evaluateBtn.disabled = true;
    resultBox.classList.remove('hidden');
    
    let loadingMessage = "Engaging the Styling Core...";
    if (activeApiMode === 'evaluate') loadingMessage = "Evaluating your silhouette...";
    else if (activeApiMode === 'fit') loadingMessage = "Analyzing fit and proportions...";
    else if (activeApiMode === 'wardrobe_builder') loadingMessage = "Building your outfit...";
    else if (activeApiMode === 'travel_curator') loadingMessage = "Generating vacation packing list...";
    else if (activeApiMode === 'work_trip_curator') loadingMessage = "Curating work trip capsule...";
    else if (activeApiMode === 'office_curation') loadingMessage = "Curating your weekly office wardrobe...";
    else if (activeApiMode === 'morning_briefing') loadingMessage = "Fetching climate data & building daily outfit...";

    resultBox.innerHTML = `<div class="loader-container"><div class="spinner"></div><div class="loading-text" id="statusText">${loadingMessage}</div></div>`;
    
    try {
        if (activeApiMode === 'wardrobe_builder' || activeApiMode === 'travel_curator' || activeApiMode === 'office_curation' || activeApiMode === 'work_trip_curator' || activeApiMode === 'morning_briefing') {
            await sendStreamingRequest(null, activeApiMode);
        } else {
            const compressedBase64 = await compressImage(imageInput.files[0]);
            await sendStreamingRequest(compressedBase64, activeApiMode);
        }
    } catch (err) {
        resultBox.innerHTML = `<div style="color:#ef4444; text-align:center; padding: 20px;"><strong>Error</strong><br>${err.message}</div>`;
        evaluateBtn.disabled = false;
    }
  });

  async function sendStreamingRequest(base64, activeApiMode) {
    let selectedOccasion = categoryEl.value === 'Other' ? customOccasionEl.value : occasionEl.value;
    let currentMood = moodValues[moodSlider.value];
    
    if (activeApiMode === 'office_curation') { selectedOccasion = "Professional Office Week"; currentMood = "Executive/Balanced"; }
    if (activeApiMode === 'morning_briefing') { selectedOccasion = "Daily Wear"; currentMood = "Elevated/Intentional"; }
    
    const rawCity = document.getElementById('climate').value;
    if (rawCity) document.getElementById('statusText').innerText = "Pinging Live Climate Data...";
    const climateData = await fetchClimateData(rawCity);
    
    let finalNotes = document.getElementById('notes').value;
    let temporalContext = "";

    if (activeApiMode === 'evaluate' || activeApiMode === 'fit') {
        temporalContext = `SYSTEM ANCHOR (Current Evaluation Date/Season): ${document.getElementById('evalDate').value}. `;
        finalNotes = `${temporalContext} | User Notes: ${finalNotes}`;
    } else if (activeApiMode === 'wardrobe_builder') {
        temporalContext = `SYSTEM ANCHOR (Target Date for Outfit Generation): ${document.getElementById('targetDate').value}. `;
        finalNotes = `${temporalContext} | User Notes: ${finalNotes}`;
    } else if (activeApiMode === 'office_curation') {
        temporalContext = `SYSTEM ANCHOR (Start of Work Week): ${document.getElementById('targetDate').value}. `;
        finalNotes = `${temporalContext} | User Notes: ${finalNotes}`;
    } else if (activeApiMode === 'morning_briefing') {
        temporalContext = `SYSTEM ANCHOR (Today's Date): ${document.getElementById('evalDate').value}. `;
        finalNotes = `${temporalContext} | User Notes: ${finalNotes}`;
    } else if (activeApiMode === 'travel_curator' || activeApiMode === 'work_trip_curator') {
        const dep = document.getElementById('departureDate').value;
        const ret = document.getElementById('returnDate').value;
        let durationStr = "";
        if (dep && ret) {
            const diffTime = Math.abs(new Date(ret) - new Date(dep));
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
            durationStr = ` (${diffDays} Total Days)`;
        }
        finalNotes = `TRIP ITINERARY: ${document.getElementById('travelItinerary').value} | Trip Dates: ${dep} to ${ret}${durationStr} | User Notes: ${finalNotes}`;
    }

    let actionText = "Analyzing Wardrobe & Curating...";
    if (activeApiMode === 'evaluate') actionText = "Scoring silhouette & generating feedback...";
    else if (activeApiMode === 'fit') actionText = "Calculating alteration blueprint...";
    else if (activeApiMode === 'wardrobe_builder') actionText = "Engineering outfit from Wardrobe...";
    else if (activeApiMode === 'travel_curator') actionText = "Calculating optimal leisure capsule...";
    else if (activeApiMode === 'work_trip_curator') actionText = "Calculating optimal business trip capsule...";
    else if (activeApiMode === 'office_curation') actionText = "Calculating 5-day professional rotation...";
    else if (activeApiMode === 'morning_briefing') actionText = "Constructing your zero-friction outfit...";
    document.getElementById('statusText').innerText = actionText;
    
    const metrics = { chest: document.getElementById('m_chest').value, inseam: document.getElementById('m_inseam').value, waist: document.getElementById('m_waist').value, height: document.getElementById('m_height').value };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180000); 

    let safeImage = base64;
    if (safeImage && safeImage.includes(',')) {
        safeImage = safeImage.split(',')[1];
    }
    
    try {
        const response = await secureFetch('/api/chat', { 
            method: 'POST',
            signal: controller.signal,
            body: {
                image: safeImage, 
                mode: activeApiMode,
                occasion: selectedOccasion || "General",
                notes: finalNotes, 
                fitPreference: fitPreferenceEl.value || "",
                contrast: document.getElementById('contrastProfile').value,
                climate: climateData,
                mood: currentMood,
                measurements: metrics,
                stressTest: false,
                edgeCaseMode: false 
            }
        });
        
        if (!response.ok) throw new Error(`Backend unavailable (${response.status})`);
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
        }
        
        clearTimeout(timeoutId); 
        
        try {
            let cleanJson = fullText.trim();
            cleanJson = cleanJson.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim(); 
            const data = JSON.parse(cleanJson);
            lastAnalysisData = data;
            
            resultBox.innerHTML = generateHTMLFromData(data, activeApiMode) + `<button onclick="downloadDossier()" class="upload-btn" style="margin-top: 24px; border-color: var(--accent-blue); font-size: 10px;">Download Dossier</button>`;
            resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
            
        } catch (jsonErr) { throw new Error("Invalid response structure."); }
    } catch (error) {
        let msg = error.name === 'AbortError' ? "Generation timed out. The server dropped the connection." : error.message;
        resultBox.innerHTML = `<div style="color:#ef4444; text-align:center; padding: 20px;"><strong>Analysis Failed</strong><br>${msg}</div>`;
    } finally { 
        evaluateBtn.disabled = false; 
    }
  }

  function getTierColor(score) {
    if (score >= 90) return "#10B981";
    if (score >= 80) return "#9333EA";
    if (score >= 70) return "#EAB308";
    if (score >= 60) return "#F97316";
    return "#EF4444";
  }

  function generateHTMLFromData(data, displayMode) {
    let html = '';
    let score = data.score ?? 0;
    
    if (data.breakdown && displayMode === 'evaluate') {
      const b = data.breakdown;
      score = (b.color || 0) + (b.occasion || 0) + (b.fit || 0) + (b.cohesion || 0) + (b.presence || 0);
    }
    
    const tierName = data.tier || "Baseline";
    const tierColor = getTierColor(score);

    html += `<div class="score-badge">
                <div class="score-num" style="color: ${tierColor};">${score}</div>
                <div class="label">${displayMode === 'fit' ? 'Proportion Index' : 'Style Index'}</div>
                <div class="tier" style="color: ${tierColor};">${tierName}</div>
             </div>`;

    html += `<div class="card"><div class="label">Archetype</div><span class="body-text">${data.archetype || "The Individual"}</span></div>`;

    if (data.breakdown && displayMode === 'evaluate') {
      const b = data.breakdown;
      const createBar = (label, val) => `<div class="breakdown-item"><div class="breakdown-header"><span>${label}</span><span class="breakdown-score">${val}/20</span></div><div class="bar"><div class="bar-fill" style="width:${(val / 20) * 100}%"></div></div></div>`;
      html += `<div class="card"><div class="label">Sartorial Breakdown</div><div class="breakdown-grid">${createBar("Color", b.color || 0)}${createBar("Occasion", b.occasion || 0)}${createBar("Fit", b.fit || 0)}${createBar("Cohesion", b.cohesion || 0)}${createBar("Presence", b.presence || 0)}</div></div>`;
    }

    const renderList = (label, items, icon = "•") => {
        if (!items || items.length === 0) return '';
        return `<div class="card"><div class="label">${label}</div>${items.map(i => `<span class="list-item">${icon} ${i}</span>`).join('')}</div>`;
    };

    if (displayMode === 'wardrobe_builder' || displayMode === 'travel_curator' || displayMode === 'work_trip_curator' || displayMode === 'office_curation' || displayMode === 'morning_briefing') {
        if (data.outfit_combinations && data.outfit_combinations.length > 0) {
            
            if (displayMode === 'office_curation') {
                html += `<div class="card"><div class="label">Weekly Office Rotation</div>`;
                html += `<div class="week-grid">`;
                data.outfit_combinations.forEach(outfit => {
                    html += `<div class="day-card">`;
                    html += `<div class="day-header">${outfit.name || 'Workday'}</div>`;
                    html += `<div class="day-body">${outfit.reasoning || ''}</div>`;
                    if (outfit.item_urls && outfit.item_urls.length > 0) {
                        html += `<div class="day-items">`;
                        outfit.item_urls.forEach(url => { html += `<img src="${url}" loading="lazy" alt="Outfit item">`; });
                        html += `</div>`;
                    }
                    html += `</div>`;
                });
                html += `</div></div>`;
            } else {
                html += `<div class="card"><div class="label">${displayMode === 'travel_curator' || displayMode === 'work_trip_curator' ? 'The Packing List' : (displayMode === 'morning_briefing' ? 'The Daily Recommendation' : 'Outfit Combinations')}</div>`;
                data.outfit_combinations.forEach((outfit, index) => {
                    html += `<div style="margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid rgba(197, 160, 89, 0.1);">`;
                    html += `<div style="color: #F8FAFC; font-size: 13px; font-weight: 600; margin-bottom: 4px;">✦ ${outfit.name || 'Curated Look'}</div>`;
                    html += `<div style="color: #cbd5e1; font-size: 12px; margin-bottom: 10px; line-height: 1.4;">${outfit.reasoning || ''}</div>`;
                    
                    if (outfit.item_urls && outfit.item_urls.length > 0) {
                        html += `<div style="display: flex; gap: 8px; overflow-x: auto;">`;
                        outfit.item_urls.forEach(url => { 
                            html += `<img src="${url}" style="width: 70px; height: 90px; object-fit: cover; border-radius: 2px; border: 1px solid rgba(197, 160, 89, 0.2);" alt="Outfit Item">`; 
                        });
                        html += `</div>`;
                    }
                    
                    if (displayMode === 'morning_briefing' || displayMode === 'wardrobe_builder') {
                       html += `<button class="action-btn" style="border-color: rgba(255,255,255,0.2); color: white; margin-top: 15px;" onclick="this.innerText='Wear Logged ✓'; this.style.borderColor='#10B981'; this.style.color='#10B981'; this.disabled=true;">Log This Wear</button>`;
                    }
                    
                    html += `</div>`;
                });
                html += `</div>`;
            }
        } else {
             html += `<div class="card"><div class="label">Wardrobe Analysis Notice</div><span class="body-text" style="color: #EAB308;">The Stylist analyzed your wardrobe but could not confidently build complete outfits based on the current inventory. Review the styling notes below and consider adding more versatile pieces.</span></div>`;
        }
        html += renderList("Styling Notes", data.styling_notes);
    } else if (displayMode === 'fit') {
        html += renderList("Shoulders & Chest", data.fit_anatomy?.shoulders_and_chest);
        html += renderList("Waist & Torso", data.fit_anatomy?.waist_and_torso);
        html += renderList("Legs & Hem", data.fit_anatomy?.legs_and_hem);
        html += renderList("Alteration Blueprint", data.alteration_blueprint, "✂");
    } else {
        html += renderList("Key Strengths", data.what_works, "✓");
        html += renderList("Upgrades", data.recommendations);
    }

    if (data.missing_pieces && data.missing_pieces.length > 0) html += renderList("Missing Pieces (Wardrobe Gaps)", data.missing_pieces, "△");
    return html;
  }

  window.downloadDossier = function() {
    if (!lastAnalysisData) return;
    const d = lastAnalysisData;
    const blob = new Blob([`ELE VATE | OFFICIAL DOSSIER\nMODE: ${currentMode}\nSCORE: ${d.score}\nVERDICT: ${d.verdict}`], { type: 'text/plain' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `Dossier_${Date.now()}.txt`; link.click();
  }

} catch (globalError) {
  document.getElementById('crash-banner').style.display = 'block';
  document.getElementById('crash-banner').innerText = "SYSTEM CRASH: " + globalError.message;
}