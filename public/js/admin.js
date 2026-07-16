// State variables
let qrCodes = [];
let scanLogs = [];
let photoFrames = [];
let autoRefreshInterval = null;
let serverInfo = null;
let currentUserRole = null;
let currentUserName = '';

function getAuthKey() {
  return localStorage.getItem('ajc_security_key') || '';
}

function getDeviceID() {
  return localStorage.getItem('ajc_device_id') || '';
}

// Initialize Admin Dashboard
document.addEventListener('DOMContentLoaded', async () => {
  // Generate unique Device ID if not exists
  if (!localStorage.getItem('ajc_device_id')) {
    localStorage.setItem('ajc_device_id', 'dev_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15));
  }
  
  await fetchServerInfo();
  
  // Auth Check
  const storedKey = getAuthKey();
  if (storedKey) {
    const success = await validateAndLoad(storedKey);
    if (!success) {
      showLoginScreen();
    }
  } else {
    showLoginScreen();
  }
  
  setupEventListeners();
  
  // Align Heights
  window.addEventListener('resize', () => {
    if (window.alignDashboardHeights) window.alignDashboardHeights();
  });
  if (window.alignDashboardHeights) window.alignDashboardHeights();

  // Start auto-refreshing scan logs every 4 seconds for "real-time" experience
  autoRefreshInterval = setInterval(fetchLogsAndStatsOnly, 4000);
});

async function validateAndLoad(key) {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-ID': getDeviceID()
      },
      body: JSON.stringify({ key: key })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.error) {
        showToast(data.error, 'error');
      }
      return false;
    }
    
    // Save to localStorage
    localStorage.setItem('ajc_security_key', key);
    currentUserRole = data.role;
    currentUserName = data.note || '';
    
    // Configure UI based on role
    configureRoleUI();
    
    // Load dashboard
    await fetchData();
    
    if (currentUserRole === 'admin' || currentUserRole === 'moderator') {
      await Promise.all([
        loadKeysData(),
        loadFramesData(),
        loadRecoverySetting()
      ]);
    }
    
    // Hide login screen and show welcome badge
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('btn-logout').classList.remove('hidden');
    
    // Show welcome message with user's name
    const welcomeBadge = document.getElementById('welcome-badge');
    const welcomeNameEl = document.getElementById('welcome-name');
    if (welcomeBadge && welcomeNameEl) {
      const roleLabel = currentUserRole === 'admin' ? 'Admin' : currentUserRole === 'moderator' ? 'Moderator' : 'User';
      const displayName = currentUserName ? currentUserName : roleLabel;
      welcomeNameEl.textContent = displayName;
      welcomeBadge.classList.remove('hidden');
      welcomeBadge.style.display = 'flex';
    }
    
    // Start keep-alive pings to prevent Render.com free tier from sleeping
    if (currentUserRole === 'admin' || currentUserRole === 'moderator') {
      if (typeof startKeepAlive === 'function') startKeepAlive();
    }
    
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

function showLoginScreen() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('btn-logout').classList.add('hidden');
}

function logout() {
  localStorage.removeItem('ajc_security_key');
  currentUserRole = null;
  currentUserName = '';
  
  // Hide welcome badge
  const welcomeBadge = document.getElementById('welcome-badge');
  if (welcomeBadge) {
    welcomeBadge.classList.add('hidden');
    welcomeBadge.style.display = '';
  }
  
  // Stop keep-alive pings
  if (typeof stopKeepAlive === 'function') stopKeepAlive();
  
  showLoginScreen();
  // Clear state
  qrCodes = [];
  scanLogs = [];
  renderQRCodes();
  renderScanLogs();
}

function configureRoleUI() {
  const createFormAside = document.querySelector('aside');
  const settingsTabBtn = document.getElementById('tab-btn-settings');
  const frameManagerGroup = document.getElementById('sidebar-frame-manager-group');
  const dashboardGrid = document.querySelector('.dashboard-grid');
  
  if (currentUserRole === 'user') {
    if (createFormAside) createFormAside.classList.add('hidden');
    if (settingsTabBtn) settingsTabBtn.classList.add('hidden');
    if (frameManagerGroup) frameManagerGroup.style.display = 'none';
    if (dashboardGrid) dashboardGrid.classList.add('full-width');
    
    const selectAllQrs = document.getElementById('select-all-qrs');
    if (selectAllQrs) selectAllQrs.parentElement.classList.add('hidden');
  } else {
    if (createFormAside) createFormAside.classList.remove('hidden');
    if (settingsTabBtn) settingsTabBtn.classList.remove('hidden');
    if (frameManagerGroup) frameManagerGroup.style.display = 'block';
    if (dashboardGrid) dashboardGrid.classList.remove('full-width');
    
    const selectAllQrs = document.getElementById('select-all-qrs');
    if (selectAllQrs) selectAllQrs.parentElement.classList.remove('hidden');
    
    if (currentUserRole === 'moderator') {
      const roleOptAdmin = document.getElementById('role-opt-admin');
      const roleOptModerator = document.getElementById('role-opt-moderator');
      if (roleOptAdmin) roleOptAdmin.disabled = true;
      if (roleOptModerator) roleOptModerator.disabled = true;
      
      const roleSelect = document.getElementById('new-key-role');
      if (roleSelect) roleSelect.value = 'user';
    } else if (currentUserRole === 'admin') {
      const roleOptAdmin = document.getElementById('role-opt-admin');
      const roleOptModerator = document.getElementById('role-opt-moderator');
      if (roleOptAdmin) roleOptAdmin.disabled = false;
      if (roleOptModerator) roleOptModerator.disabled = false;
    }
  }
  
  // Hide select-all headers if user
  const selectAllLogsHeader = document.getElementById('select-all-logs');
  if (selectAllLogsHeader) {
    selectAllLogsHeader.style.visibility = currentUserRole === 'user' ? 'hidden' : 'visible';
  }
  const selectAllQrsHeader = document.getElementById('select-all-qrs');
  if (selectAllQrsHeader) {
    selectAllQrsHeader.style.visibility = currentUserRole === 'user' ? 'hidden' : 'visible';
  }
}

async function fetchServerInfo() {
  try {
    const res = await fetch('/api/server-info');
    if (res.ok) {
      serverInfo = await res.json();
    }
  } catch (e) {
    console.error("Failed to fetch server info:", e);
  }
}

function getScanUrl(qrId) {
  let baseOrigin = window.location.origin;
  if ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && serverInfo && serverInfo.local_ip) {
    baseOrigin = `http://${serverInfo.local_ip}:${serverInfo.port}`;
  }
  return `${baseOrigin}/scan.html?qr_id=${qrId}`;
}

// Setup DOM Event Listeners
function setupEventListeners() {
  // Login Form Submission
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  
  // Logout Button
  document.getElementById('btn-logout').addEventListener('click', logout);
  
  // Add Key Form Submission
  document.getElementById('add-key-form').addEventListener('submit', handleAddKey);

  // Generate Key trigger click
  document.getElementById('btn-generate-key').addEventListener('click', (e) => {
    e.preventDefault();
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const p1 = Array.from({length: 5}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const p2 = Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const p3 = Array.from({length: 3}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const generatedKey = `${p1}-${p2}-${p3}`;
    document.getElementById('new-key-value').value = generatedKey;
    showToast('បានបង្កើត Key ស្វ័យប្រវត្តរួចរាល់!', 'success');
  });

  // Form submission
  const form = document.getElementById('create-qr-form');
  form.addEventListener('submit', handleCreateQR);

  // Custom frame file selection trigger
  const frameTrigger = document.getElementById('upload-custom-trigger');
  const frameFileInput = document.getElementById('frame-file');

  if (frameTrigger && frameFileInput) {
    frameTrigger.addEventListener('click', () => {
      frameFileInput.click();
    });

    frameFileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        const file = e.target.files[0];
        handleSidebarFrameUpload(file);
      }
    });
  }

  // Clear all frames link trigger
  const clearAllLink = document.getElementById('sidebar-clear-all-frames');
  if (clearAllLink) {
    clearAllLink.addEventListener('click', (e) => {
      e.preventDefault();
      deleteAllFrames();
    });
  }

  // Search input events (instant filtering)
  document.getElementById('search-qr').addEventListener('input', filterQRCodes);
  document.getElementById('search-logs').addEventListener('input', applyLogFilters);
  document.getElementById('filter-log-date').addEventListener('change', applyLogFilters);
  document.getElementById('filter-log-team').addEventListener('change', applyLogFilters);
  if (document.getElementById('filter-log-depot')) document.getElementById('filter-log-depot').addEventListener('change', applyLogFilters);
  if (document.getElementById('filter-log-market')) document.getElementById('filter-log-market').addEventListener('change', applyLogFilters);
  document.getElementById('btn-clear-log-filters').addEventListener('click', clearLogFilters);

  // Select all checkbox for QRs
  const selectAllCheckbox = document.getElementById('select-all-qrs');
  selectAllCheckbox.addEventListener('change', (e) => {
    const checkboxes = document.querySelectorAll('.qr-card-select');
    checkboxes.forEach(cb => cb.checked = e.target.checked);
  });

  // Select all checkbox for Logs
  const selectAllLogsCheckbox = document.getElementById('select-all-logs');
  if (selectAllLogsCheckbox) {
    selectAllLogsCheckbox.addEventListener('change', (e) => {
      // Only select/unselect currently visible (filtered) logs
      const rows = document.querySelectorAll('#logs-table-body tr');
      rows.forEach(row => {
        if (row.style.display !== 'none') {
          const cb = row.querySelector('.log-select');
          if (cb) cb.checked = e.target.checked;
        }
      });
      updateSelectedLogsCount();
    });
  }

  // Batch download button
  document.getElementById('btn-batch-download').addEventListener('click', handleBatchDownload);

  // Batch delete QR Codes button
  const btnBatchDelete = document.getElementById('btn-batch-delete');
  if (btnBatchDelete) {
    btnBatchDelete.addEventListener('click', handleBatchDeleteQR);
  }

  // Excel export button
  document.getElementById('btn-export-excel').addEventListener('click', exportLogsToExcel);

  // Batch delete logs button
  document.getElementById('btn-delete-selected-logs').addEventListener('click', deleteSelectedLogs);
  document.getElementById('btn-delete-filtered-logs').addEventListener('click', deleteFilteredLogs);

  // Manual refresh button
  document.getElementById('btn-refresh-logs').addEventListener('click', () => {
    fetchData();
    showToast('បានផ្ទុកទិន្នន័យថ្មីៗឡើងវិញ!', 'success');
  });

  // Forgot Key click
  const forgetKeyBtn = document.getElementById('btn-forget-key');
  if (forgetKeyBtn) {
    forgetKeyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const msgContainer = document.getElementById('recovery-message-container');
      if (!msgContainer) return;
      
      if (msgContainer.classList.contains('hidden')) {
        msgContainer.innerHTML = `
          <div style="font-weight: 700; color: #ff3344; margin-bottom: 4px; font-size: 0.85rem;">
            ករណីភ្លេចលេខកូដ (In case forget Key password)
          </div>
          <div style="color: #1e293b; font-size: 0.82rem; font-weight: 500; line-height: 1.4;">
            សូមទាក់ទង Admin តាមរយៈ Telegram: @admin ឬ លេខទូរស័ព្ទ: 096 000 0000
          </div>
        `;
        msgContainer.classList.remove('hidden');
      } else {
        msgContainer.classList.add('hidden');
      }
    });
  }

  // Set default start date picker value (today) on create form
  const startInput = document.getElementById('qr-start-date');
  if (startInput) {
    startInput.value = new Date().toLocaleDateString('sv');
  }

  // Set default expiration date picker value (today) on create form
  const expiresInput = document.getElementById('qr-expires-at');
  if (expiresInput) {
    expiresInput.value = new Date().toLocaleDateString('sv');
  }

  // Edit QR Form Submission
  const editQRForm = document.getElementById('edit-qr-form');
  if (editQRForm) {
    editQRForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('edit-qr-id').value;
      const new_id = document.getElementById('edit-qr-id-val').value.trim();
      const name = document.getElementById('edit-qr-name-val').value.trim();
      const hashtag = document.getElementById('edit-qr-hashtag').value.trim();
      const default_location = document.getElementById('edit-qr-default-location').value.trim();
      const cannot_edit_market = document.getElementById('edit-qr-cannot-edit-market').checked;
      const start_date = document.getElementById('edit-qr-start-date').value;
      const expires_at = document.getElementById('edit-qr-expires-at').value;
      const facebook_url = document.getElementById('edit-qr-facebook-url').value.trim();
      const tiktok_url = document.getElementById('edit-qr-tiktok-url').value.trim();
      const youtube_url = document.getElementById('edit-qr-youtube-url').value.trim();
      const show_facebook = document.getElementById('edit-qr-show-facebook').checked;
      const show_tiktok = document.getElementById('edit-qr-show-tiktok').checked;
      const show_youtube = document.getElementById('edit-qr-show-youtube').checked;
      const capture_location = document.getElementById('edit-qr-capture-location').checked;

      // Uniqueness and Exact Duplicate Check for Edit Modal
      let finalNewId = new_id;
      if (typeof qrCodes !== 'undefined' && qrCodes) {
        const otherQRs = qrCodes.filter(qr => qr.id.toLowerCase() !== id.toLowerCase());
        const idExists = otherQRs.some(qr => qr.id.toLowerCase() === finalNewId.toLowerCase());
        
        if (idExists) {
          const exactMatch = otherQRs.find(qr => 
            qr.id.toLowerCase() === finalNewId.toLowerCase() &&
            qr.name.toLowerCase() === name.toLowerCase() &&
            (qr.hashtag || '').toLowerCase() === hashtag.toLowerCase() &&
            (qr.default_location || '').toLowerCase() === default_location.toLowerCase() &&
            (qr.start_date || '') === start_date &&
            (qr.expires_at || '') === expires_at
          );
          
          if (exactMatch) {
            const proceed = confirm("ព័ត៌មាននេះដូចគ្នាទាំងស្រុងដែលបានបង្កើតហើយ តើអ្នកចង់រក្សាទុកមែនទេ?");
            if (!proceed) return;
          }
          
          // Auto-generate unique ID by appending -copy or -copy-1
          let candidate = finalNewId + '-copy';
          if (!qrCodes.some(qr => qr.id.toLowerCase() === candidate.toLowerCase())) {
            finalNewId = candidate;
          } else {
            let counter = 1;
            while (qrCodes.some(qr => qr.id.toLowerCase() === (finalNewId + '-copy-' + counter).toLowerCase())) {
              counter++;
            }
            finalNewId = finalNewId + '-copy-' + counter;
          }
        }
      }

      const submitBtn = editQRForm.querySelector('button[type="submit"]');
      const origHtml = submitBtn.innerHTML;
      
      submitBtn.disabled = true;
      submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> រក្សាទុក...`;
      
      try {
        const res = await fetch(`/api/qrcodes/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': getAuthKey(),
            'X-Device-ID': getDeviceID()
          },
          body: JSON.stringify({
            new_id: finalNewId,
            name,
            hashtag,
            default_location,
            cannot_edit_market,
            start_date,
            expires_at,
            facebook_url,
            tiktok_url,
            youtube_url,
            show_facebook,
            show_tiktok,
            show_youtube,
            capture_location
          })
        });
        
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'កែប្រែបរាជ័យ!', 'error');
          return;
        }
        
        showToast('បានកែប្រែព័ត៌មាន QR Code ជោគជ័យ!', 'success');
        closeEditQRModal();
        fetchData(); // Reload grid
      } catch (err) {
        console.error(err);
        showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = origHtml;
      }
    });
  }

  // Excel Documents download
  const btnDownloadDocs = document.getElementById('btn-download-excel-documents');
  if (btnDownloadDocs) {
    btnDownloadDocs.addEventListener('click', downloadCheckedExcelDocuments);
  }

  // Excel Upload trigger
  const btnImportExcel = document.getElementById('btn-import-excel');
  const excelFileInput = document.getElementById('excel-file-input');
  if (btnImportExcel && excelFileInput) {
    btnImportExcel.addEventListener('click', () => excelFileInput.click());
    excelFileInput.addEventListener('change', handleExcelUpload);
  }

  // Sales Team ID Input event to auto-populate Depot and Market Name
  const qrIdInput = document.getElementById('qr-id');
  if (qrIdInput) {
    qrIdInput.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      if (typeof uploadedExcelData !== 'undefined' && uploadedExcelData && uploadedExcelData.length > 0) {
        if (val) {
          const matches = uploadedExcelData.filter(item => item.teamId.toLowerCase() === val.toLowerCase());
          if (matches.length > 0) {
            const nameInput = document.getElementById('qr-name');
            if (nameInput) nameInput.value = matches[0].depot;
            
            const hashtagInput = document.getElementById('qr-hashtag');
            if (hashtagInput && matches[0].hashtag) {
              hashtagInput.value = matches[0].hashtag;
            }
            
            const locInput = document.getElementById('qr-default-location');
            if (locInput) {
              if (matches[0].market) {
                locInput.value = matches[0].market;
              }
              
              // Filter markets datalist specifically for this team preserving list order
              let marketDatalist = document.getElementById('markets-list');
              if (!marketDatalist) {
                marketDatalist = document.createElement('datalist');
                marketDatalist.id = 'markets-list';
                document.body.appendChild(marketDatalist);
              }
              marketDatalist.innerHTML = '';
              
              const teamMarkets = [];
              matches.forEach(item => {
                if (item.market && !teamMarkets.includes(item.market)) {
                  teamMarkets.push(item.market);
                }
              });
              
              teamMarkets.forEach(market => {
                const option = document.createElement('option');
                option.value = market;
                marketDatalist.appendChild(option);
              });
              
              locInput.setAttribute('list', 'markets-list');
            }
          }
        } else {
          // If val is cleared, restore all markets to the datalist
          let marketDatalist = document.getElementById('markets-list');
          if (marketDatalist) {
            marketDatalist.innerHTML = '';
            const uniqueMarkets = [...new Set(uploadedExcelData.map(item => item.market).filter(m => m !== ""))];
            uniqueMarkets.forEach(market => {
              const option = document.createElement('option');
              option.value = market;
              marketDatalist.appendChild(option);
            });
          }
        }
      }
    });
  }

  // Edit Sales Team ID Input event to auto-populate Depot and Market Name in Edit modal
  const editQrIdValInput = document.getElementById('edit-qr-id-val');
  if (editQrIdValInput) {
    editQrIdValInput.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      if (typeof uploadedExcelData !== 'undefined' && uploadedExcelData && uploadedExcelData.length > 0) {
        if (val) {
          const matches = uploadedExcelData.filter(item => item.teamId.toLowerCase() === val.toLowerCase());
          if (matches.length > 0) {
            const nameInput = document.getElementById('edit-qr-name-val');
            if (nameInput) nameInput.value = matches[0].depot;
            
            const hashtagInput = document.getElementById('edit-qr-hashtag');
            if (hashtagInput && matches[0].hashtag) {
              hashtagInput.value = matches[0].hashtag;
            }
            
            const locInput = document.getElementById('edit-qr-default-location');
            if (locInput) {
              if (matches[0].market) {
                locInput.value = matches[0].market;
              }
              
              // Filter markets datalist specifically for this team
              let marketDatalist = document.getElementById('markets-list');
              if (marketDatalist) {
                marketDatalist.innerHTML = '';
                const teamMarkets = [];
                matches.forEach(item => {
                  if (item.market && !teamMarkets.includes(item.market)) {
                    teamMarkets.push(item.market);
                  }
                });
                teamMarkets.forEach(market => {
                  const option = document.createElement('option');
                  option.value = market;
                  marketDatalist.appendChild(option);
                });
                locInput.setAttribute('list', 'markets-list');
              }
            }
          }
        }
      }
    });
  }

  // Clear value on mousedown/focus to show all datalist options, restore on blur
  const locInput = document.getElementById('qr-default-location');
  if (locInput) {
    let prevVal = '';
    locInput.addEventListener('mousedown', () => {
      prevVal = locInput.value;
      locInput.value = '';
    });
    locInput.addEventListener('focus', () => {
      if (locInput.value !== '') {
        prevVal = locInput.value;
        locInput.value = '';
      }
      locInput.placeholder = prevVal || 'ឧ. ផ្សារអូរឫស្សី Stall A12';
    });
    locInput.addEventListener('blur', () => {
      // Small timeout so datalist option selection registers first
      setTimeout(() => {
        if (locInput.value === '') {
          locInput.value = prevVal;
        }
        locInput.placeholder = 'ឧ. ផ្សារអូរឫស្សី Stall A12';
      }, 200);
    });
  }

  // Clear value on mousedown/focus for Edit Default Location to show all datalist options
  const editLocInput = document.getElementById('edit-qr-default-location');
  if (editLocInput) {
    let prevVal = '';
    editLocInput.addEventListener('mousedown', () => {
      prevVal = editLocInput.value;
      editLocInput.value = '';
    });
    editLocInput.addEventListener('focus', () => {
      if (editLocInput.value !== '') {
        prevVal = editLocInput.value;
        editLocInput.value = '';
      }
      editLocInput.placeholder = prevVal || 'ឧ. ផ្សារអូរឫស្សី Stall A12';
    });
    editLocInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (editLocInput.value === '') {
          editLocInput.value = prevVal;
        }
        editLocInput.placeholder = 'ឧ. ផ្សារអូរឫស្សី Stall A12';
      }, 200);
    });
  }

  // Default Location input listener to update Hashtag based on selected market
  const qrDefaultLocInput = document.getElementById('qr-default-location');
  if (qrDefaultLocInput) {
    qrDefaultLocInput.addEventListener('input', (e) => {
      const marketVal = e.target.value.trim();
      const teamVal = document.getElementById('qr-id').value.trim();
      if (teamVal && marketVal && typeof uploadedExcelData !== 'undefined' && uploadedExcelData && uploadedExcelData.length > 0) {
        const match = uploadedExcelData.find(item => 
          item.teamId.toLowerCase() === teamVal.toLowerCase() && 
          item.market.toLowerCase() === marketVal.toLowerCase()
        );
        if (match && match.hashtag) {
          const hashtagInput = document.getElementById('qr-hashtag');
          if (hashtagInput) hashtagInput.value = match.hashtag;
        }
      }
    });
  }

  // Edit Default Location input listener to update Hashtag in Edit Modal
  const editQrDefaultLocInput = document.getElementById('edit-qr-default-location');
  if (editQrDefaultLocInput) {
    editQrDefaultLocInput.addEventListener('input', (e) => {
      const marketVal = e.target.value.trim();
      const teamVal = document.getElementById('edit-qr-id-val').value.trim();
      if (teamVal && marketVal && typeof uploadedExcelData !== 'undefined' && uploadedExcelData && uploadedExcelData.length > 0) {
        const match = uploadedExcelData.find(item => 
          item.teamId.toLowerCase() === teamVal.toLowerCase() && 
          item.market.toLowerCase() === marketVal.toLowerCase()
        );
        if (match && match.hashtag) {
          const hashtagInput = document.getElementById('edit-qr-hashtag');
          if (hashtagInput) hashtagInput.value = match.hashtag;
        }
      }
    });
  }
}

// Fetch all QR codes, scan logs and update UI
async function fetchData() {
  try {
    const [qrRes, scanRes] = await Promise.all([
      fetch('/api/qrcodes', { 
        headers: { 
          'Authorization': getAuthKey(),
          'X-Device-ID': getDeviceID()
        } 
      }),
      fetch('/api/scans', { 
        headers: { 
          'Authorization': getAuthKey(),
          'X-Device-ID': getDeviceID()
        } 
      })
    ]);

    if (qrRes.status === 401 || scanRes.status === 401) {
      logout();
      return;
    }

    if (!qrRes.ok || !scanRes.ok) throw new Error('Failed to fetch data');

    qrCodes = await qrRes.json();
    scanLogs = await scanRes.json();

    updateStats();
    renderQRCodes();
    renderScanLogs();
    fetchMarketTemplates();
    if (window.alignDashboardHeights) window.alignDashboardHeights();
  } catch (error) {
    console.error('Fetch error:', error);
    showToast('មានបញ្ហាក្នុងការតភ្ជាប់ទៅកាន់ Server!', 'error');
  }
}

// Background poll only for scans/stats to keep UX smooth without re-rendering QR grid unnecessarily
async function fetchLogsAndStatsOnly() {
  try {
    const [qrRes, scanRes] = await Promise.all([
      fetch('/api/qrcodes', { 
        headers: { 
          'Authorization': getAuthKey(),
          'X-Device-ID': getDeviceID()
        } 
      }), // To get updated scan counts
      fetch('/api/scans', { 
        headers: { 
          'Authorization': getAuthKey(),
          'X-Device-ID': getDeviceID()
        } 
      })
    ]);

    if (qrRes.status === 401 || scanRes.status === 401) {
      logout();
      return;
    }

    if (!qrRes.ok || !scanRes.ok) return;

    const freshQRs = await qrRes.json();
    const freshScans = await scanRes.json();

    // Check if scans count changed before re-rendering logs to avoid UI flicker
    if (freshScans.length !== scanLogs.length) {
      qrCodes = freshQRs;
      scanLogs = freshScans;
      
      updateStats();
      renderScanLogs();
      
      // Update scan count badges in the QR list without rebuilding whole grid
      qrCodes.forEach(qr => {
        const badge = document.getElementById(`scan-count-${qr.id}`);
        if (badge) {
          badge.textContent = `ចំនួន Scan៖ ${qr.scan_count || 0}`;
        }
      });
      
      showToast('ទទួលបានទិន្នន័យ scan ថ្មី!', 'success');
    }
  } catch (e) {
    // Fail silently in background poll
  }
}

// Update Stats Cards
function updateStats() {
  document.getElementById('stat-total-qr').textContent = qrCodes.length;
  document.getElementById('stat-total-scans').textContent = scanLogs.length;

  // Calculate scans today
  const todayStr = new Date().toISOString().split('T')[0];
  const todayScansCount = scanLogs.filter(s => {
    return s.timestamp && s.timestamp.startsWith(todayStr);
  }).length;

  document.getElementById('stat-today-scans').textContent = todayScansCount;
}

// Render QR Code Grid List
// Render QR codes as a compact table list
function renderQRCodes() {
  const container = document.getElementById('qr-list-container');
  const emptyState = document.getElementById('qr-empty-state');

  container.innerHTML = '';

  if (qrCodes.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  const tableWrapper = document.createElement('div');
  tableWrapper.className = 'table-wrapper';
  tableWrapper.style.marginTop = '15px';

  const table = document.createElement('table');
  table.className = 'logs-table';
  // Fixed layout lets us control column widths strictly
  table.style.tableLayout = 'fixed';
  table.style.width = '100%';

  const isAdmin = currentUserRole !== 'user';

  table.innerHTML = `
    <colgroup>
      ${isAdmin ? '<col style="width:34px">' : ''}
      <col style="width:52px">
      <col style="width:16%">
      <col style="width:13%">
      <col style="width:14%">
      <col style="width:16%">
      <col style="width:48px">
      <col style="width:${isAdmin ? '124px' : '64px'}">
    </colgroup>
    <thead>
      <tr>
        ${isAdmin ? '<th style="text-align:center;padding:10px 6px;vertical-align:top;"></th>' : ''}
        <th style="text-align:center;padding:10px 6px;vertical-align:top;">QR</th>
        <th style="padding:10px 8px;vertical-align:top;">
          <div style="margin-bottom:6px;">Depot</div>
          <select id="filter-depot" style="width:100%;padding:4px;font-size:0.75rem;border-radius:6px;border:1px solid rgba(0,0,0,0.15);color:var(--text-main);font-weight:normal;background:#fff;cursor:pointer;">
            <option value="">ទាំងអស់</option>
          </select>
        </th>
        <th style="padding:10px 8px;vertical-align:top;">
          <div style="margin-bottom:6px;">Sales Team</div>
          <select id="filter-sales-team" style="width:100%;padding:4px;font-size:0.75rem;border-radius:6px;border:1px solid rgba(0,0,0,0.15);color:var(--text-main);font-weight:normal;background:#fff;cursor:pointer;">
            <option value="">ទាំងអស់</option>
          </select>
        </th>
        <th style="padding:10px 8px;vertical-align:top;">Hashtag</th>
        <th style="padding:10px 8px;vertical-align:top;">
          <div style="margin-bottom:6px;">Location</div>
          <select id="filter-location" style="width:100%;padding:4px;font-size:0.75rem;border-radius:6px;border:1px solid rgba(0,0,0,0.15);color:var(--text-main);font-weight:normal;background:#fff;cursor:pointer;">
            <option value="">ទាំងអស់</option>
          </select>
        </th>
        <th style="text-align:center;padding:10px 6px;vertical-align:top;">Scans</th>
        <th style="text-align:center;padding:10px 6px;vertical-align:top;">Actions</th>
      </tr>
    </thead>
    <tbody id="qr-table-body"></tbody>
  `;

  tableWrapper.appendChild(table);
  container.appendChild(tableWrapper);

  // Populate dynamic dropdown filters
  const filterDepot = document.getElementById('filter-depot');
  const uniqueDepots = [...new Set(qrCodes.map(qr => qr.name).filter(Boolean))].sort();
  uniqueDepots.forEach(depot => {
    const opt = document.createElement('option');
    opt.value = depot;
    opt.textContent = depot;
    filterDepot.appendChild(opt);
  });

  const filterSales = document.getElementById('filter-sales-team');
  const uniqueSales = [...new Set(qrCodes.map(qr => qr.id.replace(/-copy(-\d+)?$/, '')).filter(Boolean))].sort();
  uniqueSales.forEach(sales => {
    const opt = document.createElement('option');
    opt.value = sales;
    opt.textContent = sales;
    filterSales.appendChild(opt);
  });

  const filterLocation = document.getElementById('filter-location');
  const uniqueLocs = [...new Set(qrCodes.map(qr => qr.default_location).filter(Boolean))].sort();
  uniqueLocs.forEach(loc => {
    const opt = document.createElement('option');
    opt.value = loc;
    opt.textContent = loc;
    filterLocation.appendChild(opt);
  });

  [filterDepot, filterSales, filterLocation].forEach(el => {
    if (el) el.addEventListener('change', applyFilters);
  });

  const tbody = document.getElementById('qr-table-body');

  qrCodes.forEach(qr => {
    const row = document.createElement('tr');
    row.id = `qr-row-${qr.id}`;

    const scanUrl = getScanUrl(qr.id);

    const hashLabel = escapeHTML(qr.hashtag || '—');
    const locLabel  = qr.default_location
      ? `<span style="font-size:0.75rem;color:#ff007f;"><i class="fa-solid fa-location-dot"></i> ${escapeHTML(qr.default_location)}</span>`
      : '<span style="color:var(--text-muted);font-size:0.8rem;">—</span>';

    row.innerHTML = `
      ${isAdmin ? `
        <td style="text-align:center;vertical-align:middle;padding:10px 4px;">
          <input type="checkbox" class="qr-card-select"
            data-id="${qr.id}" data-name="${qr.name}"
            style="position:static;width:16px;height:16px;cursor:pointer;accent-color:#00e5ff;margin:0;">
        </td>` : ''}
      <td style="text-align:center;vertical-align:middle;padding:8px 4px;">
        <div style="background:#fff;padding:3px;border-radius:5px;display:inline-block;box-shadow:0 2px 5px rgba(0,0,0,.15);width:40px;height:40px;">
          <canvas id="canvas-qr-${qr.id}" style="width:34px;height:34px;display:block;"></canvas>
        </div>
      </td>
      <td style="vertical-align:middle;padding:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        <div style="font-weight:700;color:var(--text-main);" title="${escapeHTML(qr.name)}">${escapeHTML(qr.name)}</div>
        <div style="font-size:0.7rem;color:#2ec4b6;margin-top:2px;" title="ថ្ងៃចាប់ផ្តើម">
          <i class="fa-regular fa-calendar-check" style="opacity:0.75;"></i> ${qr.start_date ? qr.start_date : 'No Start'}
        </div>
        <div style="font-size:0.7rem;color:#ff3344;margin-top:1px;" title="ថ្ងៃហួសកំណត់">
          <i class="fa-regular fa-calendar-times" style="opacity:0.75;"></i> ${qr.expires_at ? qr.expires_at : 'No Limit'}
        </div>
      </td>
      <td style="vertical-align:middle;padding:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
          title="${escapeHTML(qr.id)}">
        <span class="badge-id" style="font-size:0.78rem;">${escapeHTML(qr.id.replace(/-copy(-\d+)?$/, ''))}</span>
      </td>
      <td style="vertical-align:middle;padding:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
          title="${hashLabel}">
        <span style="font-size:0.78rem;color:#ff3344;"><i class="fa-solid fa-hashtag" style="opacity:.6;"></i> ${hashLabel}</span>
      </td>
      <td style="vertical-align:middle;padding:8px;color:var(--text-main);">${locLabel}</td>
      <td style="text-align:center;vertical-align:middle;font-weight:700;color:#ff3344;padding:8px 4px;">${qr.scan_count || 0}</td>
      <td style="text-align:center;vertical-align:middle;padding:8px 4px;">
        <div style="display:flex;gap:4px;justify-content:center;flex-wrap:nowrap;">
          <button type="button" class="btn btn-secondary btn-sm"
            style="padding:0;font-size:0.8rem;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-color:rgba(0,0,0,0.12);background:#fff;"
            onclick="previewQRCode('${qr.id}')"
            title="មើល QR Code">
            <i class="fa-solid fa-eye" style="color:#8f00ff;"></i>
          </button>
          <button type="button" class="btn btn-secondary btn-sm"
            style="padding:0;font-size:0.8rem;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-color:rgba(0,0,0,0.12);background:#fff;"
            onclick="downloadSingleQR('${qr.id}','${escapeHTML(qr.name)}','png')"
            title="Download PNG">
            <i class="fa-solid fa-file-image" style="color:#ff3344;"></i>
          </button>
          <button type="button" class="btn btn-secondary btn-sm"
            style="padding:0;font-size:0.8rem;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-color:rgba(0,0,0,0.12);background:#fff;"
            onclick="downloadSingleQR('${qr.id}','${escapeHTML(qr.name)}','svg')"
            title="Download SVG">
            <i class="fa-solid fa-file-code" style="color:#00e5ff;"></i>
          </button>
          ${isAdmin ? `
          <button type="button" class="btn btn-secondary btn-sm"
            style="padding:5px 8px;font-size:0.75rem;min-width:28px;height:28px;border-color:rgba(0,0,0,0.12);background:#fff;"
            onclick="duplicateQR('${qr.id}')"
            title="Duplicate (ចម្លងបង្កើតថ្មី)">
            <i class="fa-solid fa-copy" style="color:#4CAF50;"></i>
          </button>
          <button type="button" class="btn btn-secondary btn-sm"
            style="padding:5px 8px;font-size:0.75rem;min-width:28px;height:28px;border-color:rgba(0,0,0,0.12);background:#fff;"
            onclick="openEditQRModal('${qr.id}')"
            title="កែប្រែព័ត៌មាន">
            <i class="fa-solid fa-pen-to-square" style="color:#ffb703;"></i>
          </button>
          <button type="button" class="btn btn-danger btn-sm"
            style="padding:5px 8px;font-size:0.75rem;min-width:28px;height:28px;"
            onclick="deleteQRCode('${qr.id}')"
            title="លុប QR Code">
            <i class="fa-solid fa-trash"></i>
          </button>` : ''}
        </div>
      </td>
    `;

    tbody.appendChild(row);

    const canvas = document.getElementById(`canvas-qr-${qr.id}`);
    QRCode.toCanvas(canvas, scanUrl, {
      width: 34, margin: 0,
      color: { dark: '#0f061d', light: '#ffffff' }
    }, err => { if (err) console.error('QR render error:', err); });
  });
}

// Render Scan Logs Table
function renderScanLogs() {
  const tableBody = document.getElementById('logs-table-body');
  const tableContainer = document.getElementById('logs-table-container');
  const emptyState = document.getElementById('logs-empty-state');
  
  tableBody.innerHTML = '';
  
  if (scanLogs.length === 0) {
    tableContainer.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }
  
  emptyState.classList.add('hidden');
  tableContainer.classList.remove('hidden');
  
  // Populate the team, depot, and market filter dropdown options based on current logs
  populateTeamFilterDropdown();
  populateDepotFilterDropdown();
  populateMarketFilterDropdown();
  
  scanLogs.forEach(log => {
    const row = document.createElement('tr');
    row.id = `log-row-${log.id}`;
    // Save details as data attributes for easier filtering
    row.dataset.timestamp = log.timestamp;
    row.dataset.qrId = log.qr_id;
    row.dataset.qrName = log.qr_name || '';
    row.dataset.location = log.location || '';
    
    // Format timestamp nicely
    const dateObj = new Date(log.timestamp);
    const dateFormatted = dateObj.toLocaleDateString('km-KH') + ' ' + dateObj.toLocaleTimeString('km-KH');
    
    row.innerHTML = `
      <td style="text-align: center; vertical-align: middle;">
        ${currentUserRole === 'user' ? '-' : `
          <input type="checkbox" class="log-select" data-id="${log.id}" style="width: 18px; height: 18px; cursor: pointer; accent-color: #00e5ff; margin: 0; vertical-align: middle;">
        `}
      </td>
      <td class="time-stamp" style="vertical-align: middle;">${dateFormatted}</td>
      <td style="vertical-align: middle;"><span class="badge-id">${escapeHTML(log.qr_id.replace(/-copy(-\d+)?$/, ''))}</span></td>
      <td style="font-weight: 700; vertical-align: middle;">${escapeHTML(log.qr_name)}</td>
      <td style="font-weight: 600; vertical-align: middle;">${escapeHTML(log.name)}</td>
      <td style="vertical-align: middle;"><a href="tel:${log.phone}" style="color: #3b82f6; text-decoration: none; font-weight: 600;"><i class="fa-solid fa-phone"></i> ${escapeHTML(log.phone)}</a></td>
      <td style="vertical-align: middle; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
        <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; min-width: 0; gap: 8px;">
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;" title="${escapeHTML(log.location)}">
            <i class="fa-solid fa-location-dot" style="color: #ff3366; margin-right: 4px;"></i>${escapeHTML(log.location)}
          </span>
          ${(log.latitude && log.longitude) ? `
            <a href="https://www.google.com/maps/search/?api=1&query=${log.latitude},${log.longitude}" target="_blank" class="btn btn-secondary btn-sm" style="padding: 2px 6px; font-size: 0.7rem; border-radius: 4px; box-shadow: 0 0 10px rgba(0, 0, 0, 0.05); border-color: rgba(0,0,0,0.12); flex-shrink: 0; display: inline-flex; align-items: center; gap: 3px;" title="មើលលើ Google Maps">
              <i class="fa-solid fa-map-location-dot" style="color: #3b82f6; margin-right: 0;"></i> Map
            </a>
          ` : ''}
        </div>
      </td>
      <td style="text-align: center; vertical-align: middle;">
        ${currentUserRole === 'user' ? '-' : `
          <button class="btn btn-danger btn-sm" onclick="deleteSingleLog('${log.id}')" style="padding: 6px 10px; font-size: 0.8rem;" title="លុប Log នេះ">
            <i class="fa-solid fa-trash"></i>
          </button>
        `}
      </td>
    `;
    
    tableBody.appendChild(row);
    
    // Bind checkbox change event to update batch counter
    const checkbox = row.querySelector('.log-select');
    if (checkbox) {
      checkbox.addEventListener('change', () => {
        updateSelectedLogsCount();
        // Handle the "Select All" main checkbox state
        const allChecked = document.querySelectorAll('.log-select:checked').length === document.querySelectorAll('.log-select').length;
        const selectAllLogsCheckbox = document.getElementById('select-all-logs');
        if (selectAllLogsCheckbox) selectAllLogsCheckbox.checked = allChecked;
      });
    }
  });

  // Re-apply filters on reload to ensure view stays synced
  applyLogFilters();
}

// Create New QR Code
async function handleCreateQR(e) {
  e.preventDefault();
  
  const form = document.getElementById('create-qr-form');
  const formData = new FormData(form);
  
  // Validate ID format (no spaces, alpha-numeric)
  const qrId = formData.get('id').trim();
  if (/\s/.test(qrId)) {
    showToast('Sales Team ID មិនត្រូវមានចន្លោះទំនេរទេ!', 'error');
    return;
  }
  
  if (typeof qrCodes !== 'undefined' && qrCodes) {
    const idExists = qrCodes.some(qr => qr.id.toLowerCase() === qrId.toLowerCase());
    if (idExists) {
      const nameVal = formData.get('name').trim();
      const hashtagVal = formData.get('hashtag').trim();
      const defaultLocationVal = formData.get('default_location').trim();
      const startDateVal = formData.get('start_date').trim();
      const expiresAtVal = formData.get('expires_at').trim();
      
      const exactMatch = qrCodes.find(qr => 
        qr.id.toLowerCase() === qrId.toLowerCase() &&
        qr.name.toLowerCase() === nameVal.toLowerCase() &&
        (qr.hashtag || '').toLowerCase() === hashtagVal.toLowerCase() &&
        (qr.default_location || '').toLowerCase() === defaultLocationVal.toLowerCase() &&
        (qr.start_date || '') === startDateVal &&
        (qr.expires_at || '') === expiresAtVal
      );
      
      if (exactMatch) {
        const proceed = confirm("ព័ត៌មាននេះដូចគ្នាទាំងស្រុងដែលបានបង្កើតហើយ តើអ្នកចង់បង្កើតមួយទៀតមែនទេ?");
        if (!proceed) return;
      }
      
      // Auto-generate unique ID by appending -copy or -copy-1
      let finalId = qrId;
      let candidate = qrId + '-copy';
      if (!qrCodes.some(qr => qr.id.toLowerCase() === candidate.toLowerCase())) {
        finalId = candidate;
      } else {
        let counter = 1;
        while (qrCodes.some(qr => qr.id.toLowerCase() === (qrId + '-copy-' + counter).toLowerCase())) {
          counter++;
        }
        finalId = qrId + '-copy-' + counter;
      }
      
      formData.set('id', finalId);
    }
  }
  
  try {
    const res = await fetch('/api/qrcodes', {
      method: 'POST',
      headers: {
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      },
      body: formData
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      showToast(data.error || 'មានបញ្ហាក្នុងការបង្កើត QR Code!', 'error');
      return;
    }
    
    showToast('បានបង្កើត QR Code ដោយជោគជ័យ!', 'success');
    
    // Reset Form
    form.reset();
    
    // Re-initialize default dates
    const startInput = document.getElementById('qr-start-date');
    if (startInput) {
      startInput.value = new Date().toLocaleDateString('sv');
    }
    const expiresInput = document.getElementById('qr-expires-at');
    if (expiresInput) {
      expiresInput.value = new Date().toLocaleDateString('sv');
    }
    
    // Fetch and redraw
    fetchData();
  } catch (error) {
    console.error('Error creating QR:', error);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

// Delete QR Code
async function deleteQRCode(id) {
  if (!confirm(`តើអ្នកពិតជាចង់លុប Sales Team "${id}" នេះមែនទេ?`)) return;
  
  try {
    const res = await fetch(`/api/qrcodes/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      }
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      showToast(data.error || 'មិនអាចលុបបានទេ!', 'error');
      return;
    }
    
    showToast('បានលុប QR Code ដោយជោគជ័យ!', 'success');
    fetchData();
  } catch (error) {
    console.error('Error deleting QR:', error);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

// Bulk Delete Checked QR Codes
async function handleBatchDeleteQR() {
  const checkedBoxes = document.querySelectorAll('.qr-card-select:checked');
  if (checkedBoxes.length === 0) {
    showToast('សូមជ្រើសរើស QR Code យ៉ាងហោចណាស់មួយដើម្បីលុប!', 'error');
    return;
  }
  
  if (!confirm(`តើអ្នកពិតជាចង់លុប QR Code ទាំង ${checkedBoxes.length} ដែលបានជ្រើសរើសនេះមែនទេ? (សកម្មភាពនេះមិនអាចត្រឡប់ក្រោយបានឡើយ)`)) {
    return;
  }
  
  showToast('កំពុងលុប QR Code ដែលបានជ្រើសរើស...', 'info');
  
  const promises = [];
  checkedBoxes.forEach(cb => {
    const qrId = cb.dataset.id;
    const promise = fetch(`/api/qrcodes/${qrId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      }
    }).then(async res => {
      if (!res.ok) {
        const data = await res.json();
        console.error(`Failed to delete ${qrId}:`, data.error);
      }
    }).catch(err => {
      console.error(`Error deleting ${qrId}:`, err);
    });
    promises.push(promise);
  });
  
  await Promise.all(promises);
  showToast('បានលុប QR Code ដែលបានជ្រើសរើសដោយជោគជ័យ!', 'success');
  
  // Uncheck the select-all checkbox
  const selectAll = document.getElementById('select-all-qrs');
  if (selectAll) selectAll.checked = false;
  
  fetchData();
}

// Helper to draw QR Code with Text Header (Team, Location & Expiration) on canvas
function drawQRWithText(qrId, qrName, defaultLocation, expiresAt, startDate, scanUrl, callback) {
  // Generate QR in a temporary canvas
  const qrCanvas = document.createElement('canvas');
  QRCode.toCanvas(qrCanvas, scanUrl, {
    width: 600,
    margin: 2
  }, function (err) {
    if (err) {
      console.error(err);
      callback(null);
      return;
    }
    
    // Create final canvas with extra height at the top for headers (800 total height)
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = 600;
    finalCanvas.height = 800;
    const ctx = finalCanvas.getContext('2d');
    
    // Fill background with white
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 600, 800);
    
    // Format top line
    const cleanId = qrId.replace(/-copy(-\d+)?$/, '');
    const cleanName = qrName.replace(/^Team[-:]\s*/i, '');
    let line1 = `Team: ${qrName}`;
    if (qrName.toLowerCase().includes('team')) {
      line1 = `Team: ${cleanName}`;
    } else if (/\d+/.test(cleanId)) {
      line1 = `Team: ${cleanId}`;
    }
    
    // Draw top line
    ctx.font = "bold 30px 'Kantumruy Pro', Arial, sans-serif";
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.fillText(line1, 300, 45);
    
    // Format bottom line
    const line2 = `ផ្សារ៖ ${defaultLocation || ''}`;
    
    // Draw bottom line
    ctx.font = "bold 24px 'Kantumruy Pro', Arial, sans-serif";
    ctx.fillText(line2, 300, 85);

    // Format start date line
    let startFormatted = '';
    if (startDate) {
      const parts = startDate.split('-');
      if (parts.length === 3) {
        startFormatted = `${parts[2]}/${parts[1]}/${parts[0]}`;
      } else {
        startFormatted = startDate;
      }
    }
    const lineStart = `ចាប់ផ្តើម៖ ${startFormatted || '—'}`;

    // Draw start date line
    ctx.fillText(lineStart, 300, 125);

    // Format expiration line
    let expFormatted = '';
    if (expiresAt) {
      const parts = expiresAt.split('-');
      if (parts.length === 3) {
        expFormatted = `${parts[2]}/${parts[1]}/${parts[0]}`;
      } else {
        expFormatted = expiresAt;
      }
    }
    const line3 = `ផុតកំណត់៖ ${expFormatted || 'មិនមានកំណត់'}`;

    // Draw expiration line
    ctx.fillText(line3, 300, 165);
    
    // Draw the QR Code canvas (600x600) onto the final canvas (starts at Y=200)
    ctx.drawImage(qrCanvas, 0, 200, 600, 600);
    
    callback(finalCanvas);
  });
}

// Trigger dynamic download via backend form post (fully compatible with iOS Safari / iPhone)
function triggerSecureDownload(dataUrl, filename, mimetype = 'image/png') {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/utils/download-attachment';
  form.style.display = 'none';

  const inputData = document.createElement('input');
  inputData.type = 'hidden';
  inputData.name = 'image_data';
  inputData.value = dataUrl;
  form.appendChild(inputData);

  const inputFilename = document.createElement('input');
  inputFilename.type = 'hidden';
  inputFilename.name = 'filename';
  inputFilename.value = filename;
  form.appendChild(inputFilename);

  const inputMime = document.createElement('input');
  inputMime.type = 'hidden';
  inputMime.name = 'mimetype';
  inputMime.value = mimetype;
  form.appendChild(inputMime);

  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);
}

// Download Single QR Code (PNG or SVG)
function downloadSingleQR(qrId, qrName, format) {
  const scanUrl = getScanUrl(qrId);
  const qr = qrCodes.find(q => q.id === qrId) || {};
  const defaultLocation = qr.default_location || '';
  const expiresAt = qr.expires_at || '';
  const startDate = qr.start_date || '';
  
  if (format === 'png') {
    drawQRWithText(qrId, qrName, defaultLocation, expiresAt, startDate, scanUrl, function(finalCanvas) {
      if (!finalCanvas) {
        showToast('មានបញ្ហាក្នុងការទាញយក!', 'error');
        return;
      }
      const cleanId = qrId.replace(/-copy(-\d+)?$/, '');
      const cleanDepot = qrName.replace(/\s+/g, '_');
      const cleanMarket = defaultLocation ? defaultLocation.replace(/\s+/g, '_') : '';
      const finalFilename = cleanMarket ? `${cleanDepot}_${cleanId}_${cleanMarket}.png` : `${cleanDepot}_${cleanId}.png`;
      const dataUrl = finalCanvas.toDataURL('image/png');
      triggerSecureDownload(dataUrl, finalFilename, 'image/png');
    });
  } else if (format === 'svg') {
    QRCode.toString(scanUrl, {
      type: 'svg',
      width: 600,
      margin: 2
    }, function (err, svgString) {
      if (err) {
        showToast('មានបញ្ហាក្នុងការទាញយក!', 'error');
        return;
      }
      
      const cleanName = qrName.replace(/^Team[-:]\s*/i, '');
      let line1 = `Team: ${qrName}`;
      if (qrName.toLowerCase().includes('team')) {
        line1 = `Team: ${cleanName}`;
      } else if (/\d+/.test(qrId)) {
        line1 = `Team: ${qrId}`;
      }
      const line2 = `ផ្សារ៖ ${defaultLocation || ''}`;
      
      let startFormatted = '';
      if (startDate) {
        const parts = startDate.split('-');
        if (parts.length === 3) {
          startFormatted = `${parts[2]}/${parts[1]}/${parts[0]}`;
        } else {
          startFormatted = startDate;
        }
      }
      const lineStart = `ចាប់ផ្តើម៖ ${startFormatted || '—'}`;

      let expFormatted = '';
      if (expiresAt) {
        const parts = expiresAt.split('-');
        if (parts.length === 3) {
          expFormatted = `${parts[2]}/${parts[1]}/${parts[0]}`;
        } else {
          expFormatted = expiresAt;
        }
      }
      const line3 = `ផុតកំណត់៖ ${expFormatted || 'មិនមានកំណត់'}`;
      
      const qrSvgContent = svgString.replace(/<svg[^>]*>/i, '').replace(/<\/svg>/i, '');
      const finalSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
          <rect width="600" height="800" fill="#ffffff"/>
          <text x="300" y="45" font-family="'Kantumruy Pro', Arial, sans-serif" font-weight="bold" font-size="30" fill="#000000" text-anchor="middle">${line1}</text>
          <text x="300" y="85" font-family="'Kantumruy Pro', Arial, sans-serif" font-weight="bold" font-size="24" fill="#000000" text-anchor="middle">${line2}</text>
          <text x="300" y="125" font-family="'Kantumruy Pro', Arial, sans-serif" font-weight="bold" font-size="24" fill="#000000" text-anchor="middle">${lineStart}</text>
          <text x="300" y="165" font-family="'Kantumruy Pro', Arial, sans-serif" font-weight="bold" font-size="24" fill="#000000" text-anchor="middle">${line3}</text>
          <g transform="translate(0, 200)">
            ${qrSvgContent}
          </g>
        </svg>
      `;
      
      const cleanId = qrId.replace(/-copy(-\d+)?$/, '');
      const cleanDepot = qrName.replace(/\s+/g, '_');
      const cleanMarket = defaultLocation ? defaultLocation.replace(/\s+/g, '_') : '';
      const finalFilename = cleanMarket ? `${cleanDepot}_${cleanId}_${cleanMarket}.svg` : `${cleanDepot}_${cleanId}.svg`;
      triggerSecureDownload(finalSvg, finalFilename, 'image/svg+xml');
    });
  }
}

// Batch download checked QR Codes
async function handleBatchDownload() {
  const checkedBoxes = document.querySelectorAll('.qr-card-select:checked');
  
  if (checkedBoxes.length === 0) {
    showToast('សូមជ្រើសរើស QR Code យ៉ាងហោចណាស់មួយដើម្បីទាញយក!', 'error');
    return;
  }
  
  showToast('កំពុងរៀបចំទាញយកជាកញ្ចប់ (ZIP)...', 'success');
  
  const zip = new JSZip();
  const promises = [];
  
  checkedBoxes.forEach(cb => {
    const qrId = cb.dataset.id;
    const qr = qrCodes.find(q => q.id === qrId) || {};
    const qrName = qr.name || cb.dataset.name;
    const defaultLocation = qr.default_location || '';
    const expiresAt = qr.expires_at || '';
    const scanUrl = getScanUrl(qrId);
    
    const promise = new Promise((resolve) => {
      const startDate = qr.start_date || '';
      drawQRWithText(qrId, qrName, defaultLocation, expiresAt, startDate, scanUrl, function(finalCanvas) {
        if (!finalCanvas) {
          resolve();
          return;
        }
        
        finalCanvas.toBlob((blob) => {
          if (blob) {
            const cleanId = qrId.replace(/-copy(-\d+)?$/, '');
            const cleanDepot = qrName.replace(/\s+/g, '_');
            const cleanMarket = defaultLocation ? defaultLocation.replace(/\s+/g, '_') : '';
            const fileName = cleanMarket ? `${cleanDepot}_${cleanId}_${cleanMarket}.png` : `${cleanDepot}_${cleanId}.png`;
            zip.file(fileName, blob);
          }
          resolve();
        }, 'image/png');
      });
    });
    
    promises.push(promise);
  });
  
  await Promise.all(promises);
  
  // Generate and save ZIP
  zip.generateAsync({ type: 'blob' }).then((content) => {
    saveAs(content, `AJC_QR_Codes_${new Date().toISOString().slice(0,10)}.zip`);
    showToast('ការទាញយកជា ZIP បានសម្រេច!', 'success');
  });
}

// Export Scan Logs to Excel (supports Microsoft Excel 365 natively)
function exportLogsToExcel() {
  if (scanLogs.length === 0) {
    showToast('គ្មានទិន្នន័យសម្រាប់នាំចេញឡើយ!', 'error');
    return;
  }
  
  const data = scanLogs.map(log => {
    const dateObj = new Date(log.timestamp);
    // Format date: MM-DD-YY H:MM (e.g. 07-10-26 9:24)
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    const year = String(dateObj.getFullYear()).slice(-2);
    const hours = dateObj.getHours();
    const minutes = String(dateObj.getMinutes()).padStart(2, '0');
    const dateFormatted = `${month}-${day}-${year} ${hours}:${minutes}`;
    
    return {
      'ឈ្មោះ QR Code': log.qr_name || '',
      'លេខសម្គាល់ QR': log.qr_id || '',
      'ពេលវេលា': dateFormatted,
      'ឈ្មោះអ្នក Scan': log.name || '',
      'លេខទូរស័ព្ទ': log.phone || '',
      'ទីតាំង / ឈ្មោះផ្សារ': log.location || '',
      'Latitude': log.latitude || '',
      'Longitude': log.longitude || ''
    };
  });
  
  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Scan Logs");
  
  // Set default column widths for optimal view
  const colWidths = [
    { wch: 25 }, // ឈ្មោះ QR Code
    { wch: 18 }, // លេខសម្គាល់ QR
    { wch: 20 }, // ពេលវេលា
    { wch: 20 }, // ឈ្មោះអ្នក Scan
    { wch: 15 }, // លេខទូរស័ព្ទ
    { wch: 30 }, // ទីតាំង / ឈ្មោះផ្សារ
    { wch: 12 }, // Latitude
    { wch: 12 }  // Longitude
  ];
  worksheet['!cols'] = colWidths;
  
  XLSX.writeFile(workbook, `scan_logs_${new Date().toISOString().slice(0,10)}.xlsx`);
  showToast('បាននាំចេញទិន្នន័យជា Excel ដោយជោគជ័យ!', 'success');
}

// Filter/Search QR Codes (unified table filter)
function applyFilters() {
  const query = (document.getElementById('search-qr')?.value || '').toLowerCase().trim();
  
  const depotVal = document.getElementById('filter-depot')?.value || '';
  const salesVal = document.getElementById('filter-sales-team')?.value || '';
  const locVal   = document.getElementById('filter-location')?.value || '';
  
  qrCodes.forEach(qr => {
    const searchString = `${qr.name} ${qr.id} ${qr.hashtag || ''} ${qr.default_location || ''}`.toLowerCase();
    
    const matchesSearch = !query || searchString.includes(query);
    const matchesDepot  = !depotVal || qr.name === depotVal;
    const matchesSales  = !salesVal || qr.id.replace(/-copy(-\d+)?$/, '') === salesVal;
    const matchesLoc    = !locVal || qr.default_location === locVal;
    
    const row = document.getElementById(`qr-row-${qr.id}`);
    if (row) {
      if (matchesSearch && matchesDepot && matchesSales && matchesLoc) {
        row.style.display = '';
      } else {
        row.style.display = 'none';
      }
    }
  });
}

// Map the old search input event handler name to applyFilters
window.filterQRCodes = applyFilters;

// Populate Sales Team filter dropdown options dynamically
function populateTeamFilterDropdown() {
  const select = document.getElementById('filter-log-team');
  if (!select) return;
  
  const currentSelection = select.value;
  select.innerHTML = '<option value="">-- ទាំងអស់ --</option>';
  
  const uniqueTeams = [...new Set(scanLogs.map(log => log.qr_id.replace(/-copy(-\d+)?$/, '')).filter(Boolean))];
  uniqueTeams.sort().forEach(teamId => {
    const opt = document.createElement('option');
    opt.value = teamId;
    opt.textContent = teamId;
    select.appendChild(opt);
  });
  
  if (currentSelection && uniqueTeams.includes(currentSelection)) {
    select.value = currentSelection;
  }
}

// Populate Depot filter dropdown options dynamically
function populateDepotFilterDropdown() {
  const select = document.getElementById('filter-log-depot');
  if (!select) return;
  
  const currentSelection = select.value;
  select.innerHTML = '<option value="">-- ទាំងអស់ --</option>';
  
  const uniqueDepots = [...new Set(scanLogs.map(log => log.qr_name).filter(Boolean))];
  uniqueDepots.sort().forEach(depot => {
    const opt = document.createElement('option');
    opt.value = depot;
    opt.textContent = depot;
    select.appendChild(opt);
  });
  
  if (currentSelection && uniqueDepots.includes(currentSelection)) {
    select.value = currentSelection;
  }
}

// Populate Market filter dropdown options dynamically
function populateMarketFilterDropdown() {
  const select = document.getElementById('filter-log-market');
  if (!select) return;
  
  const currentSelection = select.value;
  select.innerHTML = '<option value="">-- ទាំងអស់ --</option>';
  
  const uniqueMarkets = [...new Set(scanLogs.map(log => log.location).filter(Boolean))];
  uniqueMarkets.sort().forEach(market => {
    const opt = document.createElement('option');
    opt.value = market;
    opt.textContent = market;
    select.appendChild(opt);
  });
  
  if (currentSelection && uniqueMarkets.includes(currentSelection)) {
    select.value = currentSelection;
  }
}

// Apply multi-filters: Search query, Date picker, Sales Team selector, Depot, Market
function applyLogFilters() {
  const query = document.getElementById('search-logs').value.toLowerCase().trim();
  const dateVal = document.getElementById('filter-log-date').value; // YYYY-MM-DD
  const teamVal = document.getElementById('filter-log-team').value;
  const depotVal = document.getElementById('filter-log-depot') ? document.getElementById('filter-log-depot').value : '';
  const marketVal = document.getElementById('filter-log-market') ? document.getElementById('filter-log-market').value : '';
  
  const rows = document.querySelectorAll('#logs-table-body tr');
  let visibleCount = 0;
  let hasActiveFilter = !!(query || dateVal || teamVal || depotVal || marketVal);
  
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    const rowDate = row.dataset.timestamp ? row.dataset.timestamp.slice(0, 10) : '';
    const rowTeam = row.dataset.qrId || '';
    const rowDepot = row.dataset.qrName || '';
    const rowMarket = row.dataset.location || '';
    
    // Check match for each filter
    const matchSearch = !query || text.includes(query);
    const matchDate = !dateVal || rowDate === dateVal;
    const matchTeam = !teamVal || rowTeam.replace(/-copy(-\d+)?$/, '') === teamVal;
    const matchDepot = !depotVal || rowDepot === depotVal;
    const matchMarket = !marketVal || rowMarket === marketVal;
    
    if (matchSearch && matchDate && matchTeam && matchDepot && matchMarket) {
      row.style.display = '';
      visibleCount++;
    } else {
      row.style.display = 'none';
      // If hidden, uncheck its selection box
      const cb = row.querySelector('.log-select');
      if (cb) cb.checked = false;
    }
  });
  
  // Reset select-all logs checkbox state
  const selectAllLogsCheckbox = document.getElementById('select-all-logs');
  if (selectAllLogsCheckbox) selectAllLogsCheckbox.checked = false;
  
  // Update bulk counters
  updateSelectedLogsCount();
  
  // Toggle delete-filtered button visibility
  const btnDeleteFiltered = document.getElementById('btn-delete-filtered-logs');
  if (btnDeleteFiltered) {
    if (hasActiveFilter && visibleCount > 0) {
      btnDeleteFiltered.classList.remove('hidden');
      document.getElementById('filtered-logs-count').textContent = visibleCount;
    } else {
      btnDeleteFiltered.classList.add('hidden');
    }
  }
}

// Clear all active log filters
function clearLogFilters() {
  document.getElementById('search-logs').value = '';
  document.getElementById('filter-log-date').value = '';
  document.getElementById('filter-log-team').value = '';
  if (document.getElementById('filter-log-depot')) document.getElementById('filter-log-depot').value = '';
  if (document.getElementById('filter-log-market')) document.getElementById('filter-log-market').value = '';
  applyLogFilters();
}

// Update the checkbox selection count and bulk-delete button visibility
function updateSelectedLogsCount() {
  const selectedCount = document.querySelectorAll('.log-select:checked').length;
  const btnDeleteSelected = document.getElementById('btn-delete-selected-logs');
  
  if (btnDeleteSelected) {
    if (selectedCount > 0) {
      btnDeleteSelected.classList.remove('hidden');
      document.getElementById('selected-logs-count').textContent = selectedCount;
    } else {
      btnDeleteSelected.classList.add('hidden');
    }
  }
}

// Delete single scan log by ID
async function deleteSingleLog(logId) {
  if (!confirm('តើអ្នកពិតជាចង់លុបទិន្នន័យស្កេននេះមែនទេ?')) return;
  
  try {
    const res = await fetch(`/api/scans/${logId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      }
    });
    
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'មិនអាចលុបទិន្នន័យស្កេននេះបានឡើយ!', 'error');
      return;
    }
    
    showToast('បានលុបទិន្នន័យស្កេនដោយជោគជ័យ!', 'success');
    fetchData(); // Reload scans list
  } catch (error) {
    console.error('Error deleting scan log:', error);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

// Delete selected logs by checkbox selection
async function deleteSelectedLogs() {
  const checkedBoxes = document.querySelectorAll('.log-select:checked');
  const ids = Array.from(checkedBoxes).map(cb => cb.dataset.id);
  
  if (ids.length === 0) return;
  
  if (!confirm(`តើអ្នកពិតជាចង់លុបទិន្នន័យស្កេនដែលបានជ្រើសរើសទាំង ${ids.length} នេះមែនទេ?`)) return;
  
  try {
    const res = await fetch('/api/scans/delete-batch', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      },
      body: JSON.stringify({ ids: ids })
    });
    
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'មិនអាចលុបទិន្នន័យដែលបានជ្រើសរើសឡើយ!', 'error');
      return;
    }
    
    showToast('បានលុបទិន្នន័យដែលបានជ្រើសរើសដោយជោគជ័យ!', 'success');
    
    // Reset Select All checkbox
    const selectAllLogsCheckbox = document.getElementById('select-all-logs');
    if (selectAllLogsCheckbox) selectAllLogsCheckbox.checked = false;
    
    fetchData(); // Reload
  } catch (error) {
    console.error('Batch delete error:', error);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

// Delete filtered scan logs (visible in table)
async function deleteFilteredLogs() {
  const rows = document.querySelectorAll('#logs-table-body tr');
  const ids = [];
  
  rows.forEach(row => {
    if (row.style.display !== 'none') {
      const cb = row.querySelector('.log-select');
      if (cb) ids.push(cb.dataset.id);
    }
  });
  
  if (ids.length === 0) return;
  
  if (!confirm(`តើអ្នកពិតជាចង់លុបទិន្នន័យស្កេនទាំងអស់ក្នុងលក្ខខណ្ឌចម្រុះទាំង ${ids.length} នេះមែនទេ?`)) return;
  
  try {
    const res = await fetch('/api/scans/delete-batch', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      },
      body: JSON.stringify({ ids: ids })
    });
    
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'មិនអាចលុបទិន្នន័យចម្រុះទាំងនេះឡើយ!', 'error');
      return;
    }
    
    showToast('បានលុបទិន្នន័យចម្រុះដោយជោគជ័យ!', 'success');
    
    // Reset Select All checkbox
    const selectAllLogsCheckbox = document.getElementById('select-all-logs');
    if (selectAllLogsCheckbox) selectAllLogsCheckbox.checked = false;
    
    // Clear filters
    clearLogFilters();
    fetchData(); // Reload
  } catch (error) {
    console.error('Filtered batch delete error:', error);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

// Align Right Panel height dynamically to match Left Panel (Create QR) height on desktop
window.alignDashboardHeights = function() {
  const aside = document.querySelector('.dashboard-grid > aside');
  const main = document.querySelector('.dashboard-grid > main');
  if (aside && main) {
    if (window.innerWidth > 1100) {
      main.style.height = `${aside.offsetHeight}px`;
    } else {
      main.style.height = 'auto';
    }
  }
};

// Tab switcher
window.switchTab = function(tabId) {
  const tabs = document.querySelectorAll('.tab-btn');
  const contents = document.querySelectorAll('.tab-content');
  
  tabs.forEach(tab => {
    tab.classList.remove('active');
    if (tab.getAttribute('onclick').includes(tabId)) {
      tab.classList.add('active');
    }
  });
  
  contents.forEach(content => {
    content.classList.remove('active');
    if (content.id === tabId) {
      content.classList.add('active');
    }
  });

  if (window.alignDashboardHeights) {
    window.alignDashboardHeights();
  }

  
  // Refresh layout
  if (tabId === 'qr-list-tab') {
    renderQRCodes();
  } else {
    renderScanLogs();
  }
}

// HTML Escaper
function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// Custom Toast Alerts
window.showToast = function(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  const icon = type === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation';
  
  toast.innerHTML = `
    <i class="fa-solid ${icon}"></i>
    <span>${message}</span>
  `;
  
  container.appendChild(toast);
  
  // Remove after 3.5 seconds
  setTimeout(() => {
    toast.style.animation = 'slideInRight 0.3s ease reverse';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3500);
}

async function handleLogin(e) {
  e.preventDefault();
  const input = document.getElementById('security-key-input');
  const key = input.value.trim();
  if (!key) return;
  
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const originalHtml = submitBtn.innerHTML;
  
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> កំពុងផ្ទៀងផ្ទាត់...`;
  
  const success = await validateAndLoad(key);
  
  submitBtn.disabled = false;
  submitBtn.innerHTML = originalHtml;
  
  if (success) {
    input.value = '';
    showToast('បានចូលប្រព័ន្ធដោយជោគជ័យ!', 'success');
  } else {
    showToast('លេខកូដសម្ងាត់មិនត្រឹមត្រូវឡើយ!', 'error');
  }
}

function getDisplayKey(key) {
    if (key.includes('***')) return key;
    if (key.includes('-')) {
      return key.split('-')[0] + '-***';
    }
    return key.length > 5 ? key.substring(0, 5) + '...' : key;
  }

async function loadKeysData() {
  if (currentUserRole !== 'admin' && currentUserRole !== 'moderator') return;
  
  try {
    const res = await fetch('/api/auth/keys', {
      headers: { 
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      }
    });
    const data = await res.json();
    if (!res.ok) return;
    
    // Render Admin keys
    const adminList = document.getElementById('admin-keys-list');
    const adminCard = document.getElementById('admin-keys-card');
    if (adminList && adminCard) {
      adminList.innerHTML = '';
      // Hide admin card entirely if no data (moderator gets empty list from API)
      if (!data.admin_keys || data.admin_keys.length === 0) {
        adminCard.style.display = 'none';
      } else {
        adminCard.style.display = 'block';
        data.admin_keys.forEach(item => {
          const isOnlyOne = data.admin_keys.length <= 1;
          const li = document.createElement('li');
          li.style.display = 'flex';
          li.style.flexDirection = 'column';
          li.style.padding = '8px 0';
          li.style.borderBottom = '1px solid rgba(0,0,0,0.06)';
          
          const deviceCount = item.devices ? item.devices.length : 0;
          const noteHtml = item.note
            ? `<span class="note-editable" data-note="${escapeHTML(item.note)}" onclick="updateKeyNote('${escapeHTML(item.key)}', 'admin', this)" style="color: #3b82f6; cursor: pointer; border-bottom: 1px dashed rgba(59,130,246,0.4); padding-bottom: 1px;" title="ចុចដើម្បីកែប្រែ">• ${escapeHTML(item.note)}</span>`
            : `<span class="note-editable" data-note="" onclick="updateKeyNote('${escapeHTML(item.key)}', 'admin', this)" style="color: var(--text-muted); opacity: 0.6; cursor: pointer; font-style: italic;" title="ចុចដើម្បីបន្ថែមឈ្មោះ">+ ឈ្មោះ</span>`;
          
          const displayKeyVal = getDisplayKey(item.key);
          const keyHtml = currentUserRole === 'admin'
            ? `<span class="key-editable" data-key="${escapeHTML(item.key)}" onclick="updateKeyValue('${escapeHTML(item.key)}', 'admin', this)" style="font-family: monospace; font-size: 0.85rem; color: #1e293b; cursor: pointer; border-bottom: 1px dashed rgba(0,0,0,0.25); padding-bottom: 1px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80px; display: inline-block;" title="ចុចដើម្បីប្តូរលេខសម្ងាត់">${escapeHTML(displayKeyVal)}</span>`
            : `<span style="font-family: monospace; font-size: 0.85rem; color: #1e293b; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80px; display: inline-block;">${escapeHTML(displayKeyVal)}</span>`;

          // Date formatting helper
          let dateStr = '';
          if (item.created_at) {
            try {
              const d = new Date(item.created_at);
              if (!isNaN(d.getTime())) {
                const day = String(d.getDate()).padStart(2, '0');
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const year = String(d.getFullYear()).slice(-2);
                const hours = String(d.getHours()).padStart(2, '0');
                const minutes = String(d.getMinutes()).padStart(2, '0');
                dateStr = `${day}/${month}/${year} ${hours}:${minutes}`;
              }
            } catch (err) {}
          }

          const deleteButton = isOnlyOne ? '<span style="font-size: 0.72rem; color: #64748b; font-weight: 600;">លំនាំដើម</span>' : `
            <button class="btn btn-danger btn-sm" onclick="deleteSecurityKey('${escapeHTML(item.key)}', 'admin')" style="padding: 0; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem;">
              <i class="fa-solid fa-trash"></i>
            </button>
          `;

          li.innerHTML = `
            <!-- Row 1: Key (Left) and Actions (Right) -->
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; min-width: 0;">
              ${keyHtml}
              <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
                <button class="btn btn-secondary btn-sm" onclick="copyTextToClipboard('${escapeHTML(item.key)}')" style="padding: 0; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem; border-color: rgba(0,0,0,0.12); background: #fff;" title="Copy Key">
                  <i class="fa-solid fa-copy"></i>
                </button>
                <button class="btn btn-secondary btn-sm" onclick="resetKeyDevices('${escapeHTML(item.key)}', 'admin')" style="padding: 0; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem; color: #ffb703; border-color: rgba(255,183,3,0.3); background: #fff;" title="Reset Devices">
                  <i class="fa-solid fa-rotate-left"></i>
                </button>
                ${deleteButton}
              </div>
            </div>
            <!-- Row 2: Note (Left) and Date (Right) -->
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: 6px; border-top: 1px dashed rgba(0,0,0,0.04); padding-top: 5px; font-size: 0.72rem; color: #64748b;">
              <div style="min-width: 0; flex: 1; display: flex; align-items: center; gap: 4px;">
                <i class="fa-regular fa-user" style="opacity: 0.7;"></i>
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px;">
                  ${noteHtml}
                </span>
              </div>
              <span style="font-size: 0.68rem; color: #94a3b8; font-family: monospace; flex-shrink: 0; margin-left: 6px;">
                ${dateStr ? dateStr.split(' ')[0] : ''}
              </span>
            </div>
            <!-- Row 3: Limit configuration -->
            <div style="display: flex; align-items: center; gap: 4px; font-size: 0.72rem; color: #64748b; margin-top: 4px;">
              <span>ឧបករណ៍៖ ${deviceCount} / </span>
              <input type="number" class="key-limit-input" value="${item.max_devices}" min="1" style="width: 35px; height: 18px; background: #eef4ff; border: 1px solid rgba(0,0,0,0.12); color: #1e293b; text-align: center; border-radius: 4px; padding: 0; font-size: 0.72rem; margin: 0;">
              <button class="btn btn-secondary btn-sm" onclick="updateKeyLimit('${escapeHTML(item.key)}', 'admin', this)" style="padding: 0; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.65rem; border-color: rgba(59,130,246,0.3); color: #3b82f6;" title="Update Limit">
                <i class="fa-solid fa-check"></i>
              </button>
            </div>
          `;
          adminList.appendChild(li);
        });
      }
    }

    // Render Moderator keys
    const modList = document.getElementById('moderator-keys-list');
    const modCard = document.getElementById('moderator-keys-card');
    if (modList && modCard) {
      modList.innerHTML = '';
      // Hide moderator card if no data
      if (!data.moderator_keys || data.moderator_keys.length === 0) {
        modCard.style.display = 'none';
      } else {
        modCard.style.display = 'block';
        data.moderator_keys.forEach(item => {
          const li = document.createElement('li');
          li.style.display = 'flex';
          li.style.flexDirection = 'column';
          li.style.padding = '8px 0';
          li.style.borderBottom = '1px solid rgba(0,0,0,0.06)';
          
          const deviceCount = item.devices ? item.devices.length : 0;
          // Only admin can edit moderator key notes
          const noteHtml = currentUserRole === 'admin'
            ? (item.note
                ? `<span class="note-editable" data-note="${escapeHTML(item.note)}" onclick="updateKeyNote('${escapeHTML(item.key)}', 'moderator', this)" style="color: #3b82f6; cursor: pointer; border-bottom: 1px dashed rgba(59,130,246,0.4); padding-bottom: 1px;" title="ចុចដើម្បីកែប្រែ">• ${escapeHTML(item.note)}</span>`
                : `<span class="note-editable" data-note="" onclick="updateKeyNote('${escapeHTML(item.key)}', 'moderator', this)" style="color: var(--text-muted); opacity: 0.6; cursor: pointer; font-style: italic;" title="ចុចដើម្បីបន្ថែមឈ្មោះ">+ ឈ្មោះ</span>`)
            : (item.note ? `<span style="color: #3b82f6;">• ${escapeHTML(item.note)}</span>` : '');
          
          // Moderators can see their keys but only admin can delete moderator keys
          const canDeleteMod = currentUserRole === 'admin';
          
          const displayKeyVal = getDisplayKey(item.key);
          const keyHtml = currentUserRole === 'admin'
            ? `<span class="key-editable" data-key="${escapeHTML(item.key)}" onclick="updateKeyValue('${escapeHTML(item.key)}', 'moderator', this)" style="font-family: monospace; font-size: 0.85rem; color: #1e293b; cursor: pointer; border-bottom: 1px dashed rgba(0,0,0,0.25); padding-bottom: 1px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80px; display: inline-block;" title="ចុចដើម្បីប្តូរលេខសម្ងាត់">${escapeHTML(displayKeyVal)}</span>`
            : `<span style="font-family: monospace; font-size: 0.85rem; color: #1e293b; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80px; display: inline-block;">${escapeHTML(displayKeyVal)}</span>`;

          // Date formatting helper
          let dateStr = '';
          if (item.created_at) {
            try {
              const d = new Date(item.created_at);
              if (!isNaN(d.getTime())) {
                const day = String(d.getDate()).padStart(2, '0');
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const year = String(d.getFullYear()).slice(-2);
                const hours = String(d.getHours()).padStart(2, '0');
                const minutes = String(d.getMinutes()).padStart(2, '0');
                dateStr = `${day}/${month}/${year} ${hours}:${minutes}`;
              }
            } catch (err) {}
          }

          const deleteButton = canDeleteMod ? `
            <button class="btn btn-danger btn-sm" onclick="deleteSecurityKey('${escapeHTML(item.key)}', 'moderator')" style="padding: 0; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem;">
              <i class="fa-solid fa-trash"></i>
            </button>
          ` : '';

          li.innerHTML = `
            <!-- Row 1: Key + Note (Left) and Actions (Right) -->
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; min-width: 0;">
              <div style="display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1;">
                ${keyHtml}
                <span style="font-size: 0.7rem; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 75px;" title="${escapeHTML(item.note || '')}">
                  ${noteHtml}
                </span>
              </div>
              <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
                <button class="btn btn-secondary btn-sm" onclick="copyTextToClipboard('${escapeHTML(item.key)}')" style="padding: 0; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem; border-color: rgba(0,0,0,0.12); background: #fff;" title="Copy Key">
                  <i class="fa-solid fa-copy"></i>
                </button>
                <button class="btn btn-secondary btn-sm" onclick="resetKeyDevices('${escapeHTML(item.key)}', 'moderator')" style="padding: 0; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem; color: #ffb703; border-color: rgba(255,183,3,0.3); background: #fff;" title="Reset Devices">
                  <i class="fa-solid fa-rotate-left"></i>
                </button>
                ${deleteButton}
              </div>
            </div>
            <!-- Row 2: Note (Left) and Date (Right) -->
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: 6px; border-top: 1px dashed rgba(0,0,0,0.04); padding-top: 5px; font-size: 0.72rem; color: #64748b;">
              <div style="min-width: 0; flex: 1; display: flex; align-items: center; gap: 4px;">
                <i class="fa-regular fa-user" style="opacity: 0.7;"></i>
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px;">
                  ${noteHtml}
                </span>
              </div>
              <span style="font-size: 0.68rem; color: #94a3b8; font-family: monospace; flex-shrink: 0; margin-left: 6px;">
                ${dateStr ? dateStr.split(' ')[0] : ''}
              </span>
            </div>
            <!-- Row 3: Limit configuration -->
            <div style="display: flex; align-items: center; gap: 4px; font-size: 0.72rem; color: #64748b; margin-top: 4px;">
              <span>ឧបករណ៍៖ ${deviceCount} / </span>
              <input type="number" class="key-limit-input" value="${item.max_devices}" min="1" style="width: 35px; height: 18px; background: #eef4ff; border: 1px solid rgba(0,0,0,0.12); color: #1e293b; text-align: center; border-radius: 4px; padding: 0; font-size: 0.72rem; margin: 0;">
              <button class="btn btn-secondary btn-sm" onclick="updateKeyLimit('${escapeHTML(item.key)}', 'moderator', this)" style="padding: 0; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.65rem; border-color: rgba(59,130,246,0.3); color: #3b82f6;" title="Update Limit">
                <i class="fa-solid fa-check"></i>
              </button>
            </div>
          `;
          modList.appendChild(li);
        });
      }
    }

    // Render User keys
    const userList = document.getElementById('user-keys-list');
    if (userList) {
      userList.innerHTML = '';
      data.user_keys.forEach(item => {
        const li = document.createElement('li');
        li.style.display = 'flex';
        li.style.flexDirection = 'column';
        li.style.padding = '8px 0';
        li.style.borderBottom = '1px solid rgba(0,0,0,0.06)';
        
        const deviceCount = item.devices ? item.devices.length : 0;
        const isMasked = item.key.includes('***');
        // Admin and moderator can edit user key notes
        const canEditNote = (currentUserRole === 'admin' || currentUserRole === 'moderator') && !isMasked;
        const noteHtml = isMasked ? ''
          : canEditNote
            ? (item.note
                ? `<span class="note-editable" data-note="${escapeHTML(item.note)}" onclick="updateKeyNote('${escapeHTML(item.key)}', 'user', this)" style="color: #3b82f6; cursor: pointer; border-bottom: 1px dashed rgba(59,130,246,0.4); padding-bottom: 1px;" title="ចុចដើម្បីកែប្រែ">• ${escapeHTML(item.note)}</span>`
                : `<span class="note-editable" data-note="" onclick="updateKeyNote('${escapeHTML(item.key)}', 'user', this)" style="color: var(--text-muted); opacity: 0.6; cursor: pointer; font-style: italic;">+ ឈ្មោះ</span>`)
            : (item.note ? `<span style="color: #3b82f6;">• ${escapeHTML(item.note)}</span>` : '');
        
        // Admin or Moderator can reset user keys
        const canReset = currentUserRole === 'admin' || currentUserRole === 'moderator';
        
        const deleteButton = (currentUserRole === 'admin' && !isMasked) ? `
          <button class="btn btn-danger btn-sm" onclick="deleteSecurityKey('${escapeHTML(item.key)}', 'user')" style="padding: 0; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem;">
            <i class="fa-solid fa-trash"></i>
          </button>
        ` : '';
        
        const displayKeyVal = getDisplayKey(item.key);
        const keyHtml = (!isMasked && (currentUserRole === 'admin' || currentUserRole === 'moderator'))
          ? `<span class="key-editable" data-key="${escapeHTML(item.key)}" onclick="updateKeyValue('${escapeHTML(item.key)}', 'user', this)" style="font-family: monospace; font-size: 0.85rem; color: #1e293b; cursor: pointer; border-bottom: 1px dashed rgba(0,0,0,0.25); padding-bottom: 1px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80px; display: inline-block;" title="ចុចដើម្បីប្តូរលេខសម្ងាត់">${escapeHTML(displayKeyVal)}</span>`
          : `<span style="font-family: monospace; font-size: 0.85rem; color: #1e293b; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80px; display: inline-block;">${escapeHTML(displayKeyVal)}</span>`;

        // Date formatting helper
        let dateStr = '';
        if (item.created_at) {
          try {
            const d = new Date(item.created_at);
            if (!isNaN(d.getTime())) {
              const day = String(d.getDate()).padStart(2, '0');
              const month = String(d.getMonth() + 1).padStart(2, '0');
              const year = String(d.getFullYear()).slice(-2);
              const hours = String(d.getHours()).padStart(2, '0');
              const minutes = String(d.getMinutes()).padStart(2, '0');
              dateStr = `${day}/${month}/${year} ${hours}:${minutes}`;
            }
          } catch (err) {}
        }

        if (isMasked) {
          li.innerHTML = `
            <!-- Masked key layout (Only 1 row) -->
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
              ${keyHtml}
              <span style="font-size: 0.72rem; color: #94a3b8; font-family: monospace;">${dateStr ? dateStr.split(' ')[0] : ''}</span>
            </div>
          `;
        } else {
          li.innerHTML = `
            <!-- Row 1: Key + Note (Left) and Actions (Right) -->
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; min-width: 0;">
              <div style="display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1;">
                ${keyHtml}
                <span style="font-size: 0.7rem; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 75px;" title="${escapeHTML(item.note || '')}">
                  ${noteHtml}
                </span>
              </div>
              <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
                <button class="btn btn-secondary btn-sm" onclick="copyTextToClipboard('${escapeHTML(item.key)}')" style="padding: 0; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem; border-color: rgba(0,0,0,0.12); background: #fff;" title="Copy Key">
                  <i class="fa-solid fa-copy"></i>
                </button>
                ${canReset ? `
                  <button class="btn btn-secondary btn-sm" onclick="resetKeyDevices('${escapeHTML(item.key)}', 'user')" style="padding: 0; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem; color: #ffb703; border-color: rgba(255,183,3,0.3); background: #fff;" title="Reset Devices">
                    <i class="fa-solid fa-rotate-left"></i>
                  </button>
                ` : ''}
                ${deleteButton}
              </div>
            </div>
            <!-- Row 2: Limit configuration (Left) and Date (Right) -->
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: 6px; border-top: 1px dashed rgba(0,0,0,0.04); padding-top: 5px;">
              <div style="display: flex; align-items: center; gap: 4px; font-size: 0.7rem; color: #64748b;">
                <span>ឧបករណ៍៖ ${deviceCount} / </span>
                <input type="number" class="key-limit-input" value="${item.max_devices}" min="1" style="width: 32px; height: 18px; background: #eef4ff; border: 1px solid rgba(0,0,0,0.12); color: #1e293b; text-align: center; border-radius: 4px; padding: 0; font-size: 0.7rem; margin: 0;">
                <button class="btn btn-secondary btn-sm" onclick="updateKeyLimit('${escapeHTML(item.key)}', 'user', this)" style="padding: 0; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.65rem; border-color: rgba(59,130,246,0.3); color: #3b82f6;" title="Update Limit">
                  <i class="fa-solid fa-check"></i>
                </button>
              </div>
              <span style="font-size: 0.68rem; color: #94a3b8; font-family: monospace;">${dateStr ? dateStr.split(' ')[0] : ''}</span>
            </div>
          `;
        }
        userList.appendChild(li);
      });
    }
    if (window.alignDashboardHeights) window.alignDashboardHeights();
  } catch (err) {
    console.error(err);
  }
}

async function handleAddKey(e) {
  e.preventDefault();
  const valueInput = document.getElementById('new-key-value');
  const roleSelect = document.getElementById('new-key-role');
  const maxDevInput = document.getElementById('new-key-max-devices');
  const noteInput = document.getElementById('new-key-note');
  
  const keyVal = valueInput.value.trim();
  const roleVal = roleSelect.value;
  const maxDevVal = parseInt(maxDevInput.value) || 1;
  const noteVal = noteInput.value.trim();
  
  if (!noteVal) {
    showToast('សូមបញ្ចូលឈ្មោះសម្គាល់ម្ចាស់ Key!', 'error');
    return;
  }
  
  try {
    const res = await fetch('/api/auth/keys/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      },
      body: JSON.stringify({ key: keyVal, role: roleVal, max_devices: maxDevVal, note: noteVal })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'មិនអាចបន្ថែម Key បានទេ!', 'error');
      return;
    }
    
    if (data.key && !keyVal) {
      showToast(`បានបន្ថែម Key ស្វ័យប្រវត្ត៖ ${data.key} ជោគជ័យ!`, 'success');
    } else {
      showToast('បានបន្ថែម Key ដោយជោគជ័យ!', 'success');
    }
    
    valueInput.value = '';
    maxDevInput.value = 1;
    noteInput.value = '';
    loadKeysData();
  } catch (err) {
    console.error(err);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

async function deleteSecurityKey(keyVal, roleVal) {
  if (!confirm(`តើអ្នកពិតជាចង់លុប ${roleVal} Key "${keyVal}" នេះមែនទេ?`)) return;
  
  try {
    const res = await fetch('/api/auth/keys/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      },
      body: JSON.stringify({ key: keyVal, role: roleVal })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'មិនអាចលុប Key បានទេ!', 'error');
      return;
    }
    
    showToast('បានលុប Key ដោយជោគជ័យ!', 'success');
    loadKeysData();
  } catch (err) {
    console.error(err);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

window.copyTextToClipboard = function(text) {
  if (text.includes('***')) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast('បានចម្លង Key ទៅកាន់ Clipboard!', 'success');
  }).catch(err => {
    console.error('Copy failed:', err);
    showToast('មិនអាចចម្លងបានឡើយ!', 'error');
  });
}

window.resetKeyDevices = async function(keyVal, roleVal) {
  if (keyVal.includes('***')) return;
  if (!confirm(`តើអ្នកពិតជាចង់សម្អាតឧបករណ៍ទាំងអស់សម្រាប់ Key "${keyVal}" នេះមែនទេ?`)) return;
  
  try {
    const res = await fetch('/api/auth/keys/reset-devices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      },
      body: JSON.stringify({ key: keyVal, role: roleVal })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'មិនអាចសម្អាតបានឡើយ!', 'error');
      return;
    }
    showToast('បានសម្អាតឧបករណ៍ទាំងអស់ដោយជោគជ័យ!', 'success');
    loadKeysData();
  } catch (err) {
    console.error(err);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

window.updateKeyLimit = async function(keyVal, roleVal, buttonEl) {
  if (keyVal.includes('***')) return;
  
  const container = buttonEl.parentElement;
  const inputEl = container.querySelector('.key-limit-input');
  if (!inputEl) return;
  
  const newLimit = parseInt(inputEl.value);
  if (isNaN(newLimit) || newLimit < 1) {
    showToast('ចំនួនឧបករណ៍ត្រូវតែធំជាង 0!', 'error');
    return;
  }
  
  const originalHtml = buttonEl.innerHTML;
  buttonEl.disabled = true;
  buttonEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  
  try {
    const res = await fetch('/api/auth/keys/update-limit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      },
      body: JSON.stringify({ key: keyVal, role: roleVal, max_devices: newLimit })
    });
    const data = await res.json();
    
    buttonEl.disabled = false;
    buttonEl.innerHTML = originalHtml;
    
    if (!res.ok) {
      showToast(data.error || 'មិនអាចធ្វើបច្ចុប្បន្នភាពបានឡើយ!', 'error');
      return;
    }
    showToast('បានកែប្រែចំនួនឧបករណ៍ដោយជោគជ័យ!', 'success');
    loadKeysData();
  } catch (err) {
    console.error(err);
    buttonEl.disabled = false;
    buttonEl.innerHTML = originalHtml;
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

window.updateKeyNote = async function(keyVal, roleVal, spanEl) {
  if (!spanEl) return;
  
  // Already in edit mode — avoid double-click creating nested inputs
  if (spanEl.querySelector('input')) return;
  
  const currentNote = spanEl.dataset.note || '';
  const originalHtml = spanEl.innerHTML;
  
  // Switch to inline edit mode
  spanEl.innerHTML = `
    <input type="text" value="${escapeHTML(currentNote)}"
      style="background: rgba(11,7,22,0.7); border: 1px solid rgba(0,229,255,0.4); color: #fff;
             border-radius: 4px; padding: 2px 6px; font-size: 0.72rem; width: 150px; outline: none;"
      class="note-inline-input"
    >
    <button style="background: transparent; border: none; color: #00e5ff; cursor: pointer; padding: 0 4px; font-size: 0.72rem;" title="រក្សាទុក" class="note-save-btn">
      <i class="fa-solid fa-check"></i>
    </button>
    <button style="background: transparent; border: none; color: var(--text-muted); cursor: pointer; padding: 0 4px; font-size: 0.72rem;" title="បោះបង់" class="note-cancel-btn">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;
  
  const input = spanEl.querySelector('.note-inline-input');
  const saveBtn = spanEl.querySelector('.note-save-btn');
  const cancelBtn = spanEl.querySelector('.note-cancel-btn');
  
  input.focus();
  input.select();
  
  async function saveNote() {
    const newNote = input.value.trim();
    if (!newNote) {
      showToast('ឈ្មោះមិនអាចទទេបាន!', 'error');
      return;
    }
    
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    
    try {
      const res = await fetch('/api/auth/keys/update-note', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': getAuthKey(),
          'X-Device-ID': getDeviceID()
        },
        body: JSON.stringify({ key: keyVal, role: roleVal, note: newNote })
      });
      const data = await res.json();
      
      if (!res.ok) {
        showToast(data.error || 'មិនអាចកែប្រែបានឡើយ!', 'error');
        spanEl.innerHTML = originalHtml;
        return;
      }
      showToast('បានកែប្រែឈ្មោះដោយជោគជ័យ!', 'success');
      loadKeysData();
    } catch (err) {
      console.error(err);
      spanEl.innerHTML = originalHtml;
      showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
    }
  }
  
  saveBtn.addEventListener('click', saveNote);
  cancelBtn.addEventListener('click', () => { spanEl.innerHTML = originalHtml; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveNote(); }
    if (e.key === 'Escape') { spanEl.innerHTML = originalHtml; }
  });
}

window.deleteSecurityKey = deleteSecurityKey;

// ── Sidebar Photo Frames Management ──────────────────────────────────────────

async function loadFramesData() {
  try {
    const res = await fetch('/api/frames', {
      headers: {
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      }
    });
    if (res.status === 401) {
      logout();
      return;
    }
    if (!res.ok) throw new Error('Failed to fetch frames');
    photoFrames = await res.json();
    renderFrames();
  } catch (err) {
    console.error('Error loading frames:', err);
  }
}

function renderFrames() {
  const listContainer = document.getElementById('sidebar-frames-list');
  if (!listContainer) return;
  
  listContainer.innerHTML = '';
  
  if (photoFrames.length === 0) {
    listContainer.innerHTML = `
      <div class="text-center" style="padding: 15px 0; color: var(--text-muted); font-size: 0.75rem;">
        <i class="fa-regular fa-image" style="font-size: 1.5rem; margin-bottom: 5px; opacity: 0.5; display: block;"></i>
        គ្មាន Frame ណាមួយឡើយ
      </div>
    `;
    return;
  }
  
  photoFrames.forEach(frame => {
    const row = document.createElement('div');
    row.className = 'sidebar-frame-row';
    row.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid ${frame.is_active ? 'rgba(220, 20, 30, 0.35)' : 'rgba(0, 0, 0, 0.08)'};
      background: ${frame.is_active ? 'rgba(220, 20, 30, 0.04)' : '#ffffff'};
      transition: all 0.2s ease;
    `;
    
    row.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
        <!-- Active Checkbox/Tick Button -->
        <button type="button" onclick="setActiveFrame(${frame.id})" style="background: none; border: none; cursor: pointer; color: ${frame.is_active ? '#ff3344' : 'var(--text-muted)'}; font-size: 1.05rem; padding: 2px 6px; display: flex; align-items: center; transition: color 0.2s ease;">
          <i class="${frame.is_active ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle'}"></i>
        </button>
        
        <!-- Image Thumbnail -->
        <img src="${frame.image_data}" style="width: 32px; height: 32px; object-fit: contain; background: rgba(0,0,0,0.02); border: 1px solid rgba(0,0,0,0.08); border-radius: 4px; flex-shrink: 0;">
        
        <!-- Filename -->
        <div style="font-size: 0.78rem; font-weight: 600; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;" title="${escapeHTML(frame.name)}">
          ${escapeHTML(frame.name)}
        </div>
      </div>
      
      <!-- Delete X Button -->
      <button type="button" onclick="deleteSingleFrame(${frame.id})" style="background: none; border: none; cursor: pointer; color: var(--color-danger); opacity: 0.8; font-size: 0.95rem; padding: 4px 6px; display: flex; align-items: center; justify-content: center;" title="លុប">
        <i class="fa-solid fa-xmark"></i>
      </button>
    `;
    listContainer.appendChild(row);
  });
  if (window.alignDashboardHeights) window.alignDashboardHeights();
}

async function handleSidebarFrameUpload(file) {
  const statusEl = document.getElementById('upload-status');
  const uploadIcon = document.getElementById('upload-icon');
  const uploadText = document.getElementById('upload-text');
  
  if (statusEl) statusEl.textContent = 'កំពុងបញ្ចូល...';
  if (uploadIcon) {
    uploadIcon.className = 'fa-solid fa-spinner fa-spin';
    uploadIcon.style.color = '#ff3344';
  }
  if (uploadText) uploadText.textContent = 'កំពុងបញ្ចូល...';
  
  const formData = new FormData();
  formData.append('frame_file', file);
  
  try {
    const res = await fetch('/api/frames', {
      method: 'POST',
      headers: {
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      },
      body: formData
    });
    
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'បញ្ចូល Frame បរាជ័យ!', 'error');
      return;
    }
    
    await loadFramesData();
  } catch (err) {
    console.error('Sidebar upload error:', err);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  } finally {
    const fileInput = document.getElementById('frame-file');
    if (fileInput) fileInput.value = '';
    
    if (statusEl) statusEl.textContent = '';
    if (uploadIcon) {
      uploadIcon.className = 'fa-solid fa-cloud-arrow-up';
      uploadIcon.style.color = '#ff3344';
    }
    if (uploadText) uploadText.textContent = 'ចុចទីនេះ ដើម្បី Upload Frame';
  }
}

async function deleteSingleFrame(id) {
  try {
    const res = await fetch(`/api/frames/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      }
    });
    
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'លុប Frame បរាជ័យ!', 'error');
      return;
    }
    
    await loadFramesData();
  } catch (err) {
    console.error('Delete frame error:', err);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

async function deleteAllFrames() {
  if (photoFrames.length === 0) return;
  if (!confirm('តើអ្នកពិតជាចង់លុប Photo Frames ទាំងអស់មែនទេ?')) return;
  
  try {
    const res = await fetch('/api/frames/delete-all', {
      method: 'POST',
      headers: {
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      }
    });
    
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'លុបបរាជ័យ!', 'error');
      return;
    }
    
    showToast('បានលុប Frame ទាំងអស់រួចរាល់!', 'success');
    await loadFramesData();
  } catch (err) {
    console.error('Delete all frames error:', err);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

async function setActiveFrame(id) {
  try {
    const res = await fetch(`/api/frames/active/${id}`, {
      method: 'POST',
      headers: {
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      }
    });
    
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'កំណត់មិនបានជោគជ័យ!', 'error');
      return;
    }
    
    await loadFramesData();
  } catch (err) {
    console.error('Set active frame error:', err);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

window.setActiveFrame = setActiveFrame;
window.deleteSingleFrame = deleteSingleFrame;
window.loadFramesData = loadFramesData;
window.handleSidebarFrameUpload = handleSidebarFrameUpload;

// ── Key Value Change & Recovery Helper ────────────────────────────────────────

async function loadRecoverySetting() {
  if (currentUserRole !== 'admin' && currentUserRole !== 'moderator') return;
  try {
    const res = await fetch('/api/settings/recovery');
    const data = await res.json();
    const textContainer = document.getElementById('recovery-text-container');
    if (textContainer) {
      textContainer.textContent = data.value || 'សូមទាក់ទង Admin តាមរយៈ Telegram: @admin ឬ លេខទូរស័ព្ទ: 096 000 0000';
    }
  } catch (err) {
    console.error('Error loading recovery setting:', err);
  }
}

let isEditingRecovery = false;
let originalRecoveryText = '';

window.startEditRecovery = function() {
  if (isEditingRecovery) return;
  isEditingRecovery = true;
  
  const textContainer = document.getElementById('recovery-text-container');
  const actionsContainer = document.getElementById('recovery-actions-container');
  if (!textContainer || !actionsContainer) return;
  
  originalRecoveryText = textContainer.textContent.trim();
  
  textContainer.innerHTML = `
    <input type="text" id="recovery-edit-input" value="${escapeHTML(originalRecoveryText)}" style="margin-bottom: 0; height: 32px; background: #ffffff; border: 1px solid rgba(0,0,0,0.15); color: #1e293b; font-size: 0.85rem; width: 100%; padding: 4px 8px; border-radius: 6px;">
  `;
  
  actionsContainer.innerHTML = `
    <button type="button" onclick="saveEditRecovery()" class="btn btn-secondary btn-sm" style="padding: 0; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.8rem; border-color: rgba(59,130,246,0.3); color: #3b82f6; background: #fff;" title="រក្សាទុក">
      <i class="fa-solid fa-check"></i>
    </button>
    <button type="button" onclick="cancelEditRecovery()" class="btn btn-secondary btn-sm" style="padding: 0; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.8rem; border-color: rgba(0,0,0,0.12); color: #64748b; background: #fff;" title="បោះបង់">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;
  
  const input = document.getElementById('recovery-edit-input');
  if (input) {
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveEditRecovery(); }
      if (e.key === 'Escape') { cancelEditRecovery(); }
    });
  }
};

window.cancelEditRecovery = function() {
  if (!isEditingRecovery) return;
  isEditingRecovery = false;
  
  const textContainer = document.getElementById('recovery-text-container');
  const actionsContainer = document.getElementById('recovery-actions-container');
  if (!textContainer || !actionsContainer) return;
  
  textContainer.textContent = originalRecoveryText;
  
  actionsContainer.innerHTML = `
    <button type="button" id="btn-edit-recovery" onclick="startEditRecovery()" class="btn btn-secondary btn-sm" style="padding: 0; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.8rem; border-color: rgba(0,0,0,0.12); background: #fff;" title="កែប្រែព័ត៌មានទំនាក់ទំនង">
      <i class="fa-solid fa-pen-to-square" style="color: #ffb703;"></i>
    </button>
  `;
};

window.saveEditRecovery = async function() {
  if (!isEditingRecovery) return;
  
  const input = document.getElementById('recovery-edit-input');
  if (!input) return;
  
  const newVal = input.value.trim();
  if (!newVal) {
    showToast('ព័ត៌មានទំនាក់ទំនងមិនអាចទទេបានទេ!', 'error');
    return;
  }
  
  const textContainer = document.getElementById('recovery-text-container');
  const actionsContainer = document.getElementById('recovery-actions-container');
  if (!textContainer || !actionsContainer) return;
  
  const tickBtn = actionsContainer.querySelector('button');
  const originalHtml = tickBtn.innerHTML;
  tickBtn.disabled = true;
  tickBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  
  try {
    const res = await fetch('/api/settings/recovery', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      },
      body: JSON.stringify({ value: newVal })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'រក្សាទុកបរាជ័យ!', 'error');
      tickBtn.disabled = false;
      tickBtn.innerHTML = originalHtml;
      return;
    }
    
    showToast('បានកែប្រែព័ត៌មានទំនាក់ទំនងជោគជ័យ!', 'success');
    originalRecoveryText = newVal;
    isEditingRecovery = false;
    textContainer.textContent = newVal;
    
    actionsContainer.innerHTML = `
      <button type="button" id="btn-edit-recovery" onclick="startEditRecovery()" class="btn btn-secondary btn-sm" style="padding: 0; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.8rem; border-color: rgba(0,0,0,0.12); background: #fff;" title="កែប្រែព័ត៌មានទំនាក់ទំនង">
        <i class="fa-solid fa-pen-to-square" style="color: #ffb703;"></i>
      </button>
    `;
  } catch (err) {
    console.error(err);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
    tickBtn.disabled = false;
    tickBtn.innerHTML = originalHtml;
  }
};

async function updateKeyValue(keyVal, roleVal, spanEl) {
  if (!spanEl) return;
  if (spanEl.querySelector('input')) return;
  
  const originalHtml = spanEl.innerHTML;
  
  spanEl.innerHTML = `
    <input type="text" value="${escapeHTML(keyVal)}"
      style="background: rgba(11,7,22,0.7); border: 1px solid rgba(0,229,255,0.4); color: #fff;
             font-family: monospace; border-radius: 4px; padding: 2px 6px; font-size: 0.85rem; width: 140px; outline: none; margin-bottom: 0;"
      class="key-inline-input"
    >
    <button style="background: transparent; border: none; color: #00e5ff; cursor: pointer; padding: 0 4px; font-size: 0.8rem;" title="រក្សាទុក" class="key-save-btn">
      <i class="fa-solid fa-check"></i>
    </button>
    <button style="background: transparent; border: none; color: var(--text-muted); cursor: pointer; padding: 0 4px; font-size: 0.8rem;" title="បោះបង់" class="key-cancel-btn">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;
  
  const input = spanEl.querySelector('.key-inline-input');
  const saveBtn = spanEl.querySelector('.key-save-btn');
  const cancelBtn = spanEl.querySelector('.key-cancel-btn');
  
  input.focus();
  input.select();
  
  async function saveKey() {
    const newKey = input.value.trim();
    if (!newKey) {
      showToast('លេខសម្ងាត់មិនអាចទទេបានទេ!', 'error');
      return;
    }
    
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    
    try {
      const res = await fetch('/api/auth/keys/update-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': getAuthKey(),
          'X-Device-ID': getDeviceID()
        },
        body: JSON.stringify({ old_key: keyVal, role: roleVal, new_key: newKey })
      });
      const data = await res.json();
      
      if (!res.ok) {
        showToast(data.error || 'មិនអាចកែប្រែបានឡើយ!', 'error');
        spanEl.innerHTML = originalHtml;
        return;
      }
      
      showToast('បានប្តូរលេខសម្ងាត់ដោយជោគជ័យ!', 'success');
      
      // Update session key in localStorage if we just changed our own logged-in key
      if (keyVal === getAuthKey()) {
        localStorage.setItem('ajc_security_key', newKey);
      }
      
      loadKeysData();
    } catch (err) {
      console.error(err);
      spanEl.innerHTML = originalHtml;
      showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
    }
  }
  
  saveBtn.addEventListener('click', saveKey);
  cancelBtn.addEventListener('click', () => { spanEl.innerHTML = originalHtml; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveKey(); }
    if (e.key === 'Escape') { spanEl.innerHTML = originalHtml; }
  });
}

// Edit QR Expiration modal handlers
window.openEditQRModal = function(id) {
  if (typeof qrCodes === 'undefined' || !qrCodes) return;
  const qr = qrCodes.find(item => item.id === id);
  if (!qr) return;

  const modal = document.getElementById('edit-qr-modal');
  if (!modal) return;
  
  document.getElementById('edit-qr-id').value = qr.id;
  document.getElementById('edit-qr-id-val').value = qr.id.replace(/-copy(-\d+)?$/, '');
  document.getElementById('edit-qr-name-val').value = qr.name;
  document.getElementById('edit-qr-hashtag').value = qr.hashtag || '';
  document.getElementById('edit-qr-default-location').value = qr.default_location || '';
  
  document.getElementById('edit-qr-cannot-edit-market').checked = qr.cannot_edit_market !== false;
  document.getElementById('edit-qr-start-date').value = qr.start_date ? qr.start_date.substring(0, 10) : '';
  document.getElementById('edit-qr-expires-at').value = qr.expires_at ? qr.expires_at.substring(0, 10) : '';
  
  document.getElementById('edit-qr-facebook-url').value = qr.facebook_url || '';
  document.getElementById('edit-qr-tiktok-url').value = qr.tiktok_url || '';
  document.getElementById('edit-qr-youtube-url').value = qr.youtube_url || '';
  
  document.getElementById('edit-qr-show-facebook').checked = qr.show_facebook !== false;
  document.getElementById('edit-qr-show-tiktok').checked = qr.show_tiktok !== false;
  document.getElementById('edit-qr-show-youtube').checked = qr.show_youtube !== false;
  document.getElementById('edit-qr-capture-location').checked = qr.capture_location === true;
  
  modal.classList.remove('hidden');
};

window.closeEditQRModal = function() {
  const modal = document.getElementById('edit-qr-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
};

window.previewQRCode = function(id) {
  if (typeof qrCodes === 'undefined' || !qrCodes) return;
  const qr = qrCodes.find(item => item.id === id);
  if (!qr) return;

  const modal = document.getElementById('preview-qr-modal');
  if (!modal) return;

  const container = document.getElementById('preview-qr-container');
  container.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: #ff3344;"></i>';

  document.getElementById('preview-qr-title').textContent = `Preview: Team ${qr.id.replace(/-copy(-\d+)?$/, '')}`;

  const scanUrl = getScanUrl(qr.id);
  const defaultLocation = qr.default_location || '';
  const expiresAt = qr.expires_at || '';
  const startDate = qr.start_date || '';

  // Generate canvas with text
  drawQRWithText(qr.id, qr.name, defaultLocation, expiresAt, startDate, scanUrl, function(finalCanvas) {
    if (!finalCanvas) {
      container.innerHTML = '<span style="color: #ff3366;">មិនអាចបង្កើតរូបភាព Preview បានទេ!</span>';
      return;
    }

    // Convert canvas to image tag so it displays and scales beautifully
    const img = document.createElement('img');
    img.src = finalCanvas.toDataURL('image/png');
    img.style.maxWidth = '100%';
    img.style.maxHeight = '55vh';
    img.style.height = 'auto';
    img.style.width = 'auto';
    img.style.objectFit = 'contain';
    img.style.borderRadius = '4px';

    container.innerHTML = '';
    container.appendChild(img);
  });

  modal.classList.remove('hidden');
};

window.closePreviewQRModal = function() {
  const modal = document.getElementById('preview-qr-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
};

window.updateKeyValue = updateKeyValue;
window.loadRecoverySetting = loadRecoverySetting;

// ── Excel and Duplicate Helpers ──
let uploadedExcelData = [];

async function downloadCheckedExcelDocuments() {
  const checkedCBs = document.querySelectorAll('.excel-doc-checkbox:checked');
  if (checkedCBs.length === 0) {
    showToast('សូមជ្រើសរើសឯកសារគំរូយ៉ាងហោចណាស់មួយដើម្បីទាញយក!', 'error');
    return;
  }
  
  showToast('កំពុងទាញយកឯកសារ...', 'info');
  
  try {
    if (checkedCBs.length === 1) {
      // Single file download directly
      const id = checkedCBs[0].dataset.id;
      const res = await fetch(`/api/excel-documents/${id}/rows`, {
        headers: {
          'Authorization': getAuthKey(),
          'X-Device-ID': getDeviceID()
        }
      });
      if (!res.ok) throw new Error('Failed to fetch document rows');
      const data = await res.json();
      
      const sheetRows = data.rows.map(row => ({
        "Sales Team (Unique ID)": row.teamId,
        "Depot": row.depot,
        "Market Name": row.market
      }));
      
      const ws = XLSX.utils.json_to_sheet(sheetRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Template");
      XLSX.writeFile(wb, data.filename);
      showToast('ទាញយកឯកសារជោគជ័យ!', 'success');
    } else {
      // Multiple files -> zip package
      const zip = new JSZip();
      const promises = Array.from(checkedCBs).map(async cb => {
        const id = cb.dataset.id;
        const res = await fetch(`/api/excel-documents/${id}/rows`, {
          headers: {
            'Authorization': getAuthKey(),
            'X-Device-ID': getDeviceID()
          }
        });
        if (!res.ok) throw new Error(`Failed to fetch rows for ${cb.dataset.filename}`);
        const data = await res.json();
        
        const sheetRows = data.rows.map(row => ({
          "Sales Team (Unique ID)": row.teamId,
          "Depot": row.depot,
          "Market Name": row.market
        }));
        
        const ws = XLSX.utils.json_to_sheet(sheetRows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Template");
        
        // Write to array buffer
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        zip.file(data.filename, wbout);
      });
      
      await Promise.all(promises);
      
      zip.generateAsync({ type: 'blob' }).then(content => {
        saveAs(content, "AJC_Excel_Templates.zip");
        showToast('ទាញយកឯកសារគំរូទាំងអស់ជោគជ័យ!', 'success');
      });
    }
  } catch (err) {
    console.error(err);
    showToast('ការទាញយកឯកសារមានបញ្ហា!', 'error');
  }
}

function downloadExcelTemplate() {
  const data = [
    {
      "Sales Team (Unique ID)": "Team-A",
      "Depot": "Phnom Penh Depot",
      "Market Name": "ផ្សារច្បារអំពៅ"
    },
    {
      "Sales Team (Unique ID)": "Team-B",
      "Depot": "Kandal Depot",
      "Market Name": "ផ្សារតាខ្មៅ"
    }
  ];
  
  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Template");
  XLSX.writeFile(workbook, "AJC_QR_Template.xlsx");
}

// Render the list of uploaded Excel template documents
function renderExcelDocuments(docs) {
  const container = document.getElementById('excel-docs-container');
  if (!container) return;
  
  if (!docs || docs.length === 0) {
    container.innerHTML = `<div style="color: var(--text-muted); font-style: italic; text-align: center;">គ្មានឯកសារត្រូវបាន Upload ឡើយ</div>`;
    return;
  }
  
  container.innerHTML = '';
  docs.forEach(doc => {
    const item = document.createElement('div');
    item.style.cssText = "display: flex; align-items: center; justify-content: space-between; background: #fff; padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.06); box-shadow: 0 1px 3px rgba(0,0,0,0.02); margin-bottom: 2px;";
    
    // Left side: Checkbox + Filename
    const left = document.createElement('div');
    left.style.cssText = "display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; margin-right: 8px;";
    
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'excel-doc-checkbox';
    cb.dataset.id = doc.id;
    cb.dataset.filename = doc.filename;
    cb.checked = doc.is_active;
    cb.style.cssText = "cursor: pointer; accent-color: #ff3344; width: 14px; height: 14px; margin: 0;";
    cb.addEventListener('change', (e) => {
      toggleExcelDocument(doc.id, e.target.checked);
    });
    
    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = "font-weight: 600; color: #334155; text-overflow: ellipsis; overflow: hidden;";
    nameSpan.textContent = doc.filename;
    nameSpan.title = doc.filename;
    
    left.appendChild(cb);
    left.appendChild(nameSpan);
    
    // Right side: Delete button
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.style.cssText = "border: none; background: transparent; cursor: pointer; color: #ff3344; padding: 2px 4px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.82rem; transition: transform 0.2s;";
    delBtn.innerHTML = `<i class="fa-solid fa-trash-can"></i>`;
    delBtn.addEventListener('click', () => {
      deleteExcelDocument(doc.id, doc.filename);
    });
    
    delBtn.addEventListener('mouseover', () => { delBtn.style.transform = 'scale(1.15)'; });
    delBtn.addEventListener('mouseout', () => { delBtn.style.transform = 'scale(1)'; });
    
    item.appendChild(left);
    item.appendChild(delBtn);
    container.appendChild(item);
  });
}

// Toggle an Excel document active/inactive
async function toggleExcelDocument(id, isActive) {
  try {
    const res = await fetch(`/api/excel-documents/${id}/toggle`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      },
      body: JSON.stringify({ is_active: isActive })
    });
    
    if (!res.ok) {
      const data = await res.json();
      showToast(data.error || 'ប្តូរស្ថានភាពបរាជ័យ!', 'error');
      fetchMarketTemplates(); // Revert UI check
      return;
    }
    
    showToast('បានកែប្រែស្ថានភាពឯកសារជោគជ័យ!', 'success');
    fetchMarketTemplates();
  } catch (err) {
    console.error(err);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
    fetchMarketTemplates();
  }
}

// Delete an Excel document
async function deleteExcelDocument(id, filename) {
  if (!confirm(`តើអ្នកពិតជាចង់លុបឯកសារគំរូ "${filename}" នេះមែនទេ? (ទិន្នន័យផ្សារទាំងអស់នៅក្នុង File នេះនឹងត្រូវបានលុបចេញពីប្រព័ន្ធ)`)) {
    return;
  }
  
  try {
    const res = await fetch(`/api/excel-documents/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      }
    });
    
    if (!res.ok) {
      const data = await res.json();
      showToast(data.error || 'លុបឯកសារបរាជ័យ!', 'error');
      return;
    }
    
    showToast('បានលុបឯកសារគំរូដោយជោគជ័យ!', 'success');
    fetchMarketTemplates();
  } catch (err) {
    console.error(err);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

// Fetch market templates and documents from server and rebuild datalists
async function fetchMarketTemplates() {
  try {
    // 1. Fetch documents list first
    const docsRes = await fetch('/api/excel-documents', {
      headers: {
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      }
    });
    if (docsRes.ok) {
      const docs = await docsRes.json();
      renderExcelDocuments(docs);
    }

    // 2. Fetch templates
    const res = await fetch('/api/market-templates', {
      headers: {
        'Authorization': getAuthKey(),
        'X-Device-ID': getDeviceID()
      }
    });
    if (!res.ok) return;
    
    uploadedExcelData = await res.json();
    
    // Rebuild Datalists
    let teamDatalist = document.getElementById('teams-list');
    if (!teamDatalist) {
      teamDatalist = document.createElement('datalist');
      teamDatalist.id = 'teams-list';
      document.body.appendChild(teamDatalist);
    }
    teamDatalist.innerHTML = '';
    
    let marketDatalist = document.getElementById('markets-list');
    if (!marketDatalist) {
      marketDatalist = document.createElement('datalist');
      marketDatalist.id = 'markets-list';
      document.body.appendChild(marketDatalist);
    }
    marketDatalist.innerHTML = '';
    
    // Unique teams (maintaining insertion order, newest on top)
    const uniqueTeams = [];
    uploadedExcelData.forEach(item => {
      if (item.teamId && !uniqueTeams.includes(item.teamId)) {
        uniqueTeams.push(item.teamId);
      }
    });
    uniqueTeams.forEach(teamId => {
      const option = document.createElement('option');
      option.value = teamId;
      teamDatalist.appendChild(option);
    });
    
    // Unique markets
    const uniqueMarkets = [];
    uploadedExcelData.forEach(item => {
      if (item.market && !uniqueMarkets.includes(item.market)) {
        uniqueMarkets.push(item.market);
      }
    });
    uniqueMarkets.forEach(market => {
      const option = document.createElement('option');
      option.value = market;
      marketDatalist.appendChild(option);
    });
    
    // Bind lists to inputs
    const qrIdInput = document.getElementById('qr-id');
    if (qrIdInput) qrIdInput.setAttribute('list', 'teams-list');
    
    const editQrIdVal = document.getElementById('edit-qr-id-val');
    if (editQrIdVal) editQrIdVal.setAttribute('list', 'teams-list');
    
    const qrDefaultLoc = document.getElementById('qr-default-location');
    if (qrDefaultLoc) qrDefaultLoc.setAttribute('list', 'markets-list');
    
    const editQrDefaultLoc = document.getElementById('edit-qr-default-location');
    if (editQrDefaultLoc) editQrDefaultLoc.setAttribute('list', 'markets-list');
    
  } catch (err) {
    console.error('Error fetching market templates:', err);
  }
}

function handleExcelUpload(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  
  const statusEl = document.getElementById('excel-upload-status');
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> កំពុងអាន និងរក្សាទុក ${files.length} ឯកសារ...`;
    statusEl.style.color = '#4CAF50';
  }

  const uploadPromises = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const promise = new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = function(evt) {
        try {
          const data = new Uint8Array(evt.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          const json = XLSX.utils.sheet_to_json(worksheet);
          
          const rows = json.map(row => {
            const teamId = (row["Sales Team (Unique ID)"] || row["Sales Team ID"] || row["Sales Team"] || row["ID"] || "").toString().trim();
            const depot = (row["Depot"] || row["Depot Name"] || row["Name"] || "").toString().trim();
            const market = (row["Market Name"] || row["Market"] || row["ឈ្មោះផ្សារ"] || row["ទីតាំង"] || "").toString().trim();
            const hashtag = (row["Text Hashtags"] || row["Text Hashtag"] || row["Hashtags"] || row["Hashtag"] || "").toString().trim();
            return { teamId, depot, market, hashtag };
          }).filter(item => item.teamId !== "");
          
          if (rows.length === 0) {
            resolve({ filename: file.name, success: false, error: 'គ្មានទិន្នន័យផ្សារត្រឹមត្រូវ' });
            return;
          }

          // Upload to server
          fetch('/api/excel-documents', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': getAuthKey(),
              'X-Device-ID': getDeviceID()
            },
            body: JSON.stringify({
              filename: file.name,
              rows: rows
            })
          })
          .then(async res => {
            const data = await res.json();
            if (!res.ok) {
              resolve({ filename: file.name, success: false, error: data.error || 'រក្សាទុកបរាជ័យ' });
            } else {
              resolve({ filename: file.name, success: true });
            }
          })
          .catch(err => {
            console.error(err);
            resolve({ filename: file.name, success: false, error: 'បញ្ហាតភ្ជាប់បណ្តាញ' });
          });

        } catch (err) {
          console.error(err);
          resolve({ filename: file.name, success: false, error: 'អានកំហុសឯកសារ' });
        }
      };
      reader.readAsArrayBuffer(file);
    });
    uploadPromises.push(promise);
  }

  Promise.all(uploadPromises)
  .then(results => {
    const succeeded = results.filter(r => r.success).map(r => r.filename);
    const failed = results.filter(r => !r.success);
    
    if (succeeded.length > 0) {
      showToast(`បានរក្សាទុកឯកសារចំនួន ${succeeded.length} ជោគជ័យ!`, 'success');
    }
    
    if (failed.length > 0) {
      const errMsgs = failed.map(r => `"${r.filename}": ${r.error}`).join(', ');
      showToast(`បរាជ័យចំនួន ${failed.length} ឯកសារ (${errMsgs})`, 'error');
    }
    
    if (statusEl) {
      statusEl.style.display = 'none';
    }
    
    // Reset file input value so same files can be re-uploaded
    e.target.value = '';
    
    // Refresh datalists and documents list
    fetchMarketTemplates();
  })
  .catch(err => {
    console.error(err);
    showToast('មានបញ្ហាក្នុងការដំណើរការ!', 'error');
    if (statusEl) statusEl.style.display = 'none';
  });
}

function duplicateQR(id) {
  if (typeof qrCodes === 'undefined' || !qrCodes) return;
  const qr = qrCodes.find(item => item.id === id);
  if (!qr) return;

  const cleanId = qr.id.replace(/-copy(-\d+)?$/, '');
  document.getElementById('qr-id').value = cleanId;
  document.getElementById('qr-name').value = qr.name;
  document.getElementById('qr-hashtag').value = qr.hashtag || '';
  document.getElementById('qr-default-location').value = qr.default_location || '';
  
  if (qr.expires_at) {
    document.getElementById('qr-expires-at').value = qr.expires_at.substring(0, 10);
  } else {
    document.getElementById('qr-expires-at').value = '';
  }

  if (qr.start_date) {
    document.getElementById('qr-start-date').value = qr.start_date.substring(0, 10);
  } else {
    document.getElementById('qr-start-date').value = new Date().toLocaleDateString('sv');
  }

  document.getElementById('fb-url').value = qr.facebook_url || 'https://www.facebook.com';
  document.getElementById('tt-url').value = qr.tiktok_url || 'https://www.tiktok.com';
  document.getElementById('yt-url').value = qr.youtube_url || 'https://www.youtube.com';

  document.querySelector('input[name="show_facebook"]').checked = qr.show_facebook !== false;
  document.querySelector('input[name="show_tiktok"]').checked = qr.show_tiktok !== false;
  document.querySelector('input[name="show_youtube"]').checked = qr.show_youtube !== false;
  document.querySelector('input[name="capture_location"]').checked = qr.capture_location === true;
  
  const cannotEditCheck = document.getElementById('qr-cannot-edit-market');
  if (cannotEditCheck) {
    cannotEditCheck.checked = qr.cannot_edit_market !== false;
  }

  showToast(`បានចម្លងព័ត៌មានពី Sales Team "${qr.id}" រួចរាល់!`, 'success');
  document.getElementById('create-qr-form').scrollIntoView({ behavior: 'smooth' });
}

window.duplicateQR = duplicateQR;

