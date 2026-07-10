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
        loadFramesData()
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
  const framesTabBtn = document.getElementById('tab-btn-frames');
  const dashboardGrid = document.querySelector('.dashboard-grid');
  
  if (currentUserRole === 'user') {
    if (createFormAside) createFormAside.classList.add('hidden');
    if (settingsTabBtn) settingsTabBtn.classList.add('hidden');
    if (framesTabBtn) framesTabBtn.classList.add('hidden');
    if (dashboardGrid) dashboardGrid.classList.add('full-width');
    
    const selectAllQrs = document.getElementById('select-all-qrs');
    if (selectAllQrs) selectAllQrs.parentElement.classList.add('hidden');
  } else {
    if (createFormAside) createFormAside.classList.remove('hidden');
    if (settingsTabBtn) settingsTabBtn.classList.remove('hidden');
    if (framesTabBtn) framesTabBtn.classList.remove('hidden');
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
  const frameTemplateInput = document.getElementById('frame-template');
  const frameOptions = document.querySelectorAll('.frame-option');

  frameTrigger.addEventListener('click', () => {
    frameFileInput.click();
  });

  frameFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      const file = e.target.files[0];
      // Highlight custom frame selection
      frameOptions.forEach(opt => opt.classList.remove('selected'));
      frameTrigger.classList.add('selected');
      
      // Update badge
      const badge = document.getElementById('custom-frame-badge');
      badge.textContent = `បានជ្រើសរើស៖ ${file.name}`;
      badge.classList.remove('hidden');
      
      // Set value in hidden input to indicate custom file
      frameTemplateInput.value = 'custom';
    }
  });

  // Handle preset frame template selection
  frameOptions.forEach(option => {
    if (option.id === 'upload-custom-trigger') return;
    
    option.addEventListener('click', () => {
      frameOptions.forEach(opt => opt.classList.remove('selected'));
      option.classList.add('selected');
      frameTrigger.classList.remove('selected');
      
      // Clear file input
      frameFileInput.value = '';
      document.getElementById('custom-frame-badge').classList.add('hidden');
      
      // Update template hidden input
      frameTemplateInput.value = option.dataset.template;
    });
  });

  // Search input events (instant filtering)
  document.getElementById('search-qr').addEventListener('input', filterQRCodes);
  document.getElementById('search-logs').addEventListener('input', applyLogFilters);
  document.getElementById('filter-log-date').addEventListener('change', applyLogFilters);
  document.getElementById('filter-log-team').addEventListener('change', applyLogFilters);
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

  // Upload Frame form submission
  const uploadFrameForm = document.getElementById('upload-frame-form');
  if (uploadFrameForm) {
    uploadFrameForm.addEventListener('submit', handleUploadFrame);
  }

  // Delete all frames button
  const deleteAllFramesBtn = document.getElementById('btn-delete-all-frames');
  if (deleteAllFramesBtn) {
    deleteAllFramesBtn.addEventListener('click', deleteAllFrames);
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
      ${isAdmin ? '<col style="width:36px">' : ''}
      <col style="width:54px">
      <col style="min-width:80px">
      <col style="min-width:70px">
      <col style="min-width:100px">
      <col style="min-width:80px">
      <col style="width:60px">
      <col style="width:${isAdmin ? '110px' : '90px'}">
    </colgroup>
    <thead>
      <tr>
        ${isAdmin ? '<th style="text-align:center;padding:10px 6px;"></th>' : ''}
        <th style="text-align:center;padding:10px 6px;">QR</th>
        <th style="padding:10px 8px;">Depot</th>
        <th style="padding:10px 8px;">Sales Team</th>
        <th style="padding:10px 8px;">Hashtag</th>
        <th style="padding:10px 8px;">Location</th>
        <th style="text-align:center;padding:10px 6px;">Scans</th>
        <th style="text-align:center;padding:10px 6px;">Actions</th>
      </tr>
    </thead>
    <tbody id="qr-table-body"></tbody>
  `;

  tableWrapper.appendChild(table);
  container.appendChild(tableWrapper);

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
      <td style="font-weight:700;vertical-align:middle;color:#fff;padding:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
          title="${escapeHTML(qr.name)}">${escapeHTML(qr.name)}</td>
      <td style="vertical-align:middle;padding:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
          title="${escapeHTML(qr.id)}">
        <span class="badge-id" style="font-size:0.78rem;">${escapeHTML(qr.id)}</span>
      </td>
      <td style="vertical-align:middle;padding:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
          title="${hashLabel}">
        <span style="font-size:0.78rem;color:#00f2fe;"><i class="fa-solid fa-hashtag" style="opacity:.6;"></i> ${hashLabel}</span>
      </td>
      <td style="vertical-align:middle;padding:8px;">${locLabel}</td>
      <td style="text-align:center;vertical-align:middle;font-weight:700;color:#00e5ff;padding:8px 4px;">${qr.scan_count || 0}</td>
      <td style="text-align:center;vertical-align:middle;padding:8px 4px;">
        <div style="display:flex;gap:4px;justify-content:center;flex-wrap:nowrap;">
          <button class="btn btn-secondary btn-sm"
            style="padding:5px 8px;font-size:0.75rem;min-width:0;"
            onclick="downloadSingleQR('${qr.id}','${escapeHTML(qr.name)}','png')"
            title="Download PNG">
            <i class="fa-solid fa-file-image"></i><span class="btn-label"> PNG</span>
          </button>
          <button class="btn btn-secondary btn-sm"
            style="padding:5px 8px;font-size:0.75rem;min-width:0;"
            onclick="downloadSingleQR('${qr.id}','${escapeHTML(qr.name)}','svg')"
            title="Download SVG">
            <i class="fa-solid fa-file-code"></i><span class="btn-label"> SVG</span>
          </button>
          ${isAdmin ? `
          <button class="btn btn-danger btn-sm"
            style="padding:5px 8px;font-size:0.75rem;min-width:0;"
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
  
  // Populate the team filter dropdown options based on current logs
  populateTeamFilterDropdown();
  
  scanLogs.forEach(log => {
    const row = document.createElement('tr');
    row.id = `log-row-${log.id}`;
    // Save details as data attributes for easier filtering
    row.dataset.timestamp = log.timestamp;
    row.dataset.qrId = log.qr_id;
    
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
      <td style="vertical-align: middle;"><span class="badge-id">${escapeHTML(log.qr_id)}</span></td>
      <td style="font-weight: 700; vertical-align: middle;">${escapeHTML(log.qr_name)}</td>
      <td style="color: #fff; font-weight: 600; vertical-align: middle;">${escapeHTML(log.name)}</td>
      <td style="vertical-align: middle;"><a href="tel:${log.phone}" style="color: #00e5ff; text-decoration: none;"><i class="fa-solid fa-phone"></i> ${escapeHTML(log.phone)}</a></td>
      <td style="vertical-align: middle;">
        <i class="fa-solid fa-location-dot" style="color: #ff3366;"></i> ${escapeHTML(log.location)}
        ${(log.latitude && log.longitude) ? `
          <a href="https://www.google.com/maps/search/?api=1&query=${log.latitude},${log.longitude}" target="_blank" class="btn btn-secondary btn-sm" style="padding: 4px 8px; margin-left: 8px; font-size: 0.75rem; border-radius: 6px; box-shadow: 0 0 10px rgba(0, 242, 254, 0.15); border-color: rgba(0, 242, 254, 0.3);" title="មើលលើ Google Maps">
            <i class="fa-solid fa-map-location-dot" style="color: #00e5ff; margin-right: 0;"></i> Map
          </a>
        ` : ''}
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
    
    // Reset Preset Selection
    const frameOptions = document.querySelectorAll('.frame-option');
    frameOptions.forEach(opt => opt.classList.remove('selected'));
    document.querySelector('[data-template="default_frame.svg"]').classList.add('selected');
    document.getElementById('frame-template').value = 'default_frame.svg';
    document.getElementById('custom-frame-badge').classList.add('hidden');
    
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

// Helper to draw QR Code with Text Header (Team & Location) on canvas
function drawQRWithText(qrId, qrName, defaultLocation, scanUrl, callback) {
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
    
    // Create final canvas with extra height at the top for headers
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = 600;
    finalCanvas.height = 750;
    const ctx = finalCanvas.getContext('2d');
    
    // Fill background with white
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 600, 750);
    
    // Format top line
    const cleanName = qrName.replace(/^Team[-:]\s*/i, '');
    let line1 = `Team: ${qrName}`;
    if (qrName.toLowerCase().includes('team')) {
      line1 = `Team: ${cleanName}`;
    } else if (/\d+/.test(qrId)) {
      line1 = `Team: ${qrId}`;
    }
    
    // Draw top line
    ctx.font = "bold 32px 'Kantumruy Pro', Arial, sans-serif";
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.fillText(line1, 300, 55);
    
    // Format bottom line
    const line2 = `ឈ្មោះផ្សារ៖ ${defaultLocation || ''}`;
    
    // Draw bottom line
    ctx.font = "bold 26px 'Kantumruy Pro', Arial, sans-serif";
    ctx.fillText(line2, 300, 105);
    
    // Draw the QR Code canvas (600x600) onto the final canvas
    ctx.drawImage(qrCanvas, 0, 150, 600, 600);
    
    callback(finalCanvas);
  });
}

// Download Single QR Code (PNG or SVG)
function downloadSingleQR(qrId, qrName, format) {
  const scanUrl = getScanUrl(qrId);
  const qr = qrCodes.find(q => q.id === qrId) || {};
  const defaultLocation = qr.default_location || '';
  
  if (format === 'png') {
    drawQRWithText(qrId, qrName, defaultLocation, scanUrl, function(finalCanvas) {
      if (!finalCanvas) {
        showToast('មានបញ្ហាក្នុងការទាញយក!', 'error');
        return;
      }
      const dataUrl = finalCanvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = `${qrName.replace(/\s+/g, '_')}_${qrId}.png`;
      link.href = dataUrl;
      link.click();
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
      const line2 = `ឈ្មោះផ្សារ៖ ${defaultLocation || ''}`;
      
      const qrSvgContent = svgString.replace(/<svg[^>]*>/i, '').replace(/<\/svg>/i, '');
      const finalSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="600" height="750" viewBox="0 0 600 750">
          <rect width="600" height="750" fill="#ffffff"/>
          <text x="300" y="55" font-family="'Kantumruy Pro', Arial, sans-serif" font-weight="bold" font-size="32" fill="#000000" text-anchor="middle">${line1}</text>
          <text x="300" y="105" font-family="'Kantumruy Pro', Arial, sans-serif" font-weight="bold" font-size="26" fill="#000000" text-anchor="middle">${line2}</text>
          <g transform="translate(0, 150)">
            ${qrSvgContent}
          </g>
        </svg>
      `;
      
      const blob = new Blob([finalSvg], { type: 'image/svg+xml' });
      saveAs(blob, `${qrName.replace(/\s+/g, '_')}_${qrId}.svg`);
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
    const scanUrl = getScanUrl(qrId);
    
    const promise = new Promise((resolve) => {
      drawQRWithText(qrId, qrName, defaultLocation, scanUrl, function(finalCanvas) {
        if (!finalCanvas) {
          resolve();
          return;
        }
        
        finalCanvas.toBlob((blob) => {
          if (blob) {
            const fileName = `${qrName.replace(/\s+/g, '_')}_${qrId}.png`;
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

// Filter/Search QR Codes
function filterQRCodes(e) {
  const query = e.target.value.toLowerCase().trim();
  const cards = document.querySelectorAll('.qr-card');
  
  cards.forEach(card => {
    const text = card.querySelector('.qr-info').textContent.toLowerCase();
    if (text.includes(query)) {
      card.style.display = 'block';
    } else {
      card.style.display = 'none';
    }
  });
}

// Populate Sales Team filter dropdown options dynamically
function populateTeamFilterDropdown() {
  const select = document.getElementById('filter-log-team');
  if (!select) return;
  
  const currentSelection = select.value;
  select.innerHTML = '<option value="">-- ទាំងអស់ --</option>';
  
  // Extract unique qr_ids
  const uniqueTeams = [...new Set(scanLogs.map(log => log.qr_id).filter(Boolean))];
  uniqueTeams.sort().forEach(teamId => {
    const opt = document.createElement('option');
    opt.value = teamId;
    opt.textContent = teamId;
    select.appendChild(opt);
  });
  
  // Restore selection
  if (currentSelection && uniqueTeams.includes(currentSelection)) {
    select.value = currentSelection;
  }
}

// Apply multi-filters: Search query, Date picker, Sales Team selector
function applyLogFilters() {
  const query = document.getElementById('search-logs').value.toLowerCase().trim();
  const dateVal = document.getElementById('filter-log-date').value; // YYYY-MM-DD
  const teamVal = document.getElementById('filter-log-team').value;
  
  const rows = document.querySelectorAll('#logs-table-body tr');
  let visibleCount = 0;
  let hasActiveFilter = !!(query || dateVal || teamVal);
  
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    const rowDate = row.dataset.timestamp ? row.dataset.timestamp.slice(0, 10) : '';
    const rowTeam = row.dataset.qrId || '';
    
    // Check match for each filter
    const matchSearch = !query || text.includes(query);
    const matchDate = !dateVal || rowDate === dateVal;
    const matchTeam = !teamVal || rowTeam === teamVal;
    
    if (matchSearch && matchDate && matchTeam) {
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
          li.style.justifyContent = 'space-between';
          li.style.alignItems = 'center';
          li.style.padding = '8px 0';
          li.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
          
          const deviceCount = item.devices ? item.devices.length : 0;
          const noteHtml = item.note
            ? `<span class="note-editable" data-note="${escapeHTML(item.note)}" onclick="updateKeyNote('${escapeHTML(item.key)}', 'admin', this)" style="color: #00e5ff; cursor: pointer; border-bottom: 1px dashed rgba(0,229,255,0.4); padding-bottom: 1px;" title="ចុចដើម្បីកែប្រែ">• ម្ចាស់៖ ${escapeHTML(item.note)}</span>`
            : `<span class="note-editable" data-note="" onclick="updateKeyNote('${escapeHTML(item.key)}', 'admin', this)" style="color: rgba(255,255,255,0.25); cursor: pointer; font-style: italic;" title="ចុចដើម្បីបន្ថែមឈ្មោះ">+ បន្ថែមឈ្មោះ</span>`;
          
          li.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 4px;">
              <span style="font-family: monospace; font-size: 0.95rem; color: #fff;">${escapeHTML(item.key)}</span>
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <div style="display: flex; align-items: center; gap: 4px; font-size: 0.72rem; color: var(--text-muted);">
                  <span>ឧបករណ៍៖ ${deviceCount} / </span>
                  <input type="number" class="key-limit-input" value="${item.max_devices}" min="1" style="width: 45px; height: 20px; background: rgba(11,7,22,0.6); border: 1px solid rgba(255,255,255,0.1); color: #fff; text-align: center; border-radius: 4px; padding: 0; font-size: 0.72rem;">
                  <button class="btn btn-secondary btn-sm" onclick="updateKeyLimit('${escapeHTML(item.key)}', 'admin', this)" style="padding: 2px 6px; font-size: 0.65rem; border-color: rgba(0,229,255,0.3); color: #00e5ff; height: 20px; display: inline-flex; align-items: center; justify-content: center;" title="Update Limit">
                    <i class="fa-solid fa-check"></i>
                  </button>
                </div>
                ${noteHtml}
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 5px;">
              <button class="btn btn-secondary btn-sm" onclick="copyTextToClipboard('${escapeHTML(item.key)}')" style="padding: 6px 10px; font-size: 0.8rem;" title="Copy Key">
                <i class="fa-solid fa-copy"></i>
              </button>
              <button class="btn btn-secondary btn-sm" onclick="resetKeyDevices('${escapeHTML(item.key)}', 'admin')" style="padding: 6px 10px; font-size: 0.8rem; color: #ffb703; border-color: rgba(255,183,3,0.3);" title="Reset Devices">
                <i class="fa-solid fa-rotate-left"></i>
              </button>
              ${isOnlyOne ? '<span style="font-size: 0.72rem; color: var(--text-muted);">លំដើម</span>' : `
                <button class="btn btn-danger btn-sm" onclick="deleteSecurityKey('${escapeHTML(item.key)}', 'admin')" style="padding: 6px 10px; font-size: 0.8rem;">
                  <i class="fa-solid fa-trash"></i>
                </button>
              `}
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
          li.style.justifyContent = 'space-between';
          li.style.alignItems = 'center';
          li.style.padding = '8px 0';
          li.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
          
          const deviceCount = item.devices ? item.devices.length : 0;
          // Only admin can edit moderator key notes
          const noteHtml = currentUserRole === 'admin'
            ? (item.note
                ? `<span class="note-editable" data-note="${escapeHTML(item.note)}" onclick="updateKeyNote('${escapeHTML(item.key)}', 'moderator', this)" style="color: #00e5ff; cursor: pointer; border-bottom: 1px dashed rgba(0,229,255,0.4); padding-bottom: 1px;" title="ចុចដើម្បីកែប្រែ">• ម្ចាស់៖ ${escapeHTML(item.note)}</span>`
                : `<span class="note-editable" data-note="" onclick="updateKeyNote('${escapeHTML(item.key)}', 'moderator', this)" style="color: rgba(255,255,255,0.25); cursor: pointer; font-style: italic;" title="ចុចដើបន្ថែមឈ្មោះ">+ បន្ថែមឈ្មោះ</span>`)
            : (item.note ? `<span style="color: #00e5ff;">• ម្ចាស់៖ ${escapeHTML(item.note)}</span>` : '');
          
          // Moderators can see their keys but only admin can delete moderator keys
          const canDeleteMod = currentUserRole === 'admin';
          
          li.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 4px;">
              <span style="font-family: monospace; font-size: 0.95rem; color: #fff;">${escapeHTML(item.key)}</span>
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <div style="display: flex; align-items: center; gap: 4px; font-size: 0.72rem; color: var(--text-muted);">
                  <span>ឧបករណ៍៖ ${deviceCount} / </span>
                  <input type="number" class="key-limit-input" value="${item.max_devices}" min="1" style="width: 45px; height: 20px; background: rgba(11,7,22,0.6); border: 1px solid rgba(255,255,255,0.1); color: #fff; text-align: center; border-radius: 4px; padding: 0; font-size: 0.72rem;">
                  <button class="btn btn-secondary btn-sm" onclick="updateKeyLimit('${escapeHTML(item.key)}', 'moderator', this)" style="padding: 2px 6px; font-size: 0.65rem; border-color: rgba(0,229,255,0.3); color: #00e5ff; height: 20px; display: inline-flex; align-items: center; justify-content: center;" title="Update Limit">
                    <i class="fa-solid fa-check"></i>
                  </button>
                </div>
                ${noteHtml}
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 5px;">
              <button class="btn btn-secondary btn-sm" onclick="copyTextToClipboard('${escapeHTML(item.key)}')" style="padding: 6px 10px; font-size: 0.8rem;" title="Copy Key">
                <i class="fa-solid fa-copy"></i>
              </button>
              <button class="btn btn-secondary btn-sm" onclick="resetKeyDevices('${escapeHTML(item.key)}', 'moderator')" style="padding: 6px 10px; font-size: 0.8rem; color: #ffb703; border-color: rgba(255,183,3,0.3);" title="Reset Devices">
                <i class="fa-solid fa-rotate-left"></i>
              </button>
              ${canDeleteMod ? `
                <button class="btn btn-danger btn-sm" onclick="deleteSecurityKey('${escapeHTML(item.key)}', 'moderator')" style="padding: 6px 10px; font-size: 0.8rem;">
                  <i class="fa-solid fa-trash"></i>
                </button>
              ` : ''}
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
        li.style.justifyContent = 'space-between';
        li.style.alignItems = 'center';
        li.style.padding = '8px 0';
        li.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
        
        const deviceCount = item.devices ? item.devices.length : 0;
        const isMasked = item.key.includes('***');
        // Admin and moderator can edit user key notes
        const canEditNote = (currentUserRole === 'admin' || currentUserRole === 'moderator') && !isMasked;
        const noteHtml = isMasked ? ''
          : canEditNote
            ? (item.note
                ? `<span class="note-editable" data-note="${escapeHTML(item.note)}" onclick="updateKeyNote('${escapeHTML(item.key)}', 'user', this)" style="color: #00e5ff; cursor: pointer; border-bottom: 1px dashed rgba(0,229,255,0.4); padding-bottom: 1px;" title="ចុចដើម្បីកែប្រែ">• ម្ចាស់៖ ${escapeHTML(item.note)}</span>`
                : `<span class="note-editable" data-note="" onclick="updateKeyNote('${escapeHTML(item.key)}', 'user', this)" style="color: rgba(255,255,255,0.25); cursor: pointer; font-style: italic;">+ បន្ថែមឈ្មោះ</span>`)
            : (item.note ? `<span style="color: #00e5ff;">• ម្ចាស់៖ ${escapeHTML(item.note)}</span>` : '');
        
        // Admin or Moderator can reset user keys
        const canReset = currentUserRole === 'admin' || currentUserRole === 'moderator';
        
        const deleteButton = currentUserRole === 'admin' ? `
          <button class="btn btn-danger btn-sm" onclick="deleteSecurityKey('${escapeHTML(item.key)}', 'user')" style="padding: 6px 10px; font-size: 0.8rem;">
            <i class="fa-solid fa-trash"></i>
          </button>
        ` : '';
        
        // Device limit configuration widget HTML
        let limitWidgetHtml = '';
        if (isMasked) {
          limitWidgetHtml = '';
        } else {
          limitWidgetHtml = `
            <div style="display: flex; align-items: center; gap: 4px; font-size: 0.72rem; color: var(--text-muted);">
              <span>ឧបករណ៍៖ ${deviceCount} / </span>
              <input type="number" class="key-limit-input" value="${item.max_devices}" min="1" style="width: 45px; height: 20px; background: rgba(11,7,22,0.6); border: 1px solid rgba(255,255,255,0.1); color: #fff; text-align: center; border-radius: 4px; padding: 0; font-size: 0.72rem;">
              <button class="btn btn-secondary btn-sm" onclick="updateKeyLimit('${escapeHTML(item.key)}', 'user', this)" style="padding: 2px 6px; font-size: 0.65rem; border-color: rgba(0,229,255,0.3); color: #00e5ff; height: 20px; display: inline-flex; align-items: center; justify-content: center;" title="Update Limit">
                <i class="fa-solid fa-check"></i>
              </button>
            </div>
          `;
        }
        
        li.innerHTML = `
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <span style="font-family: monospace; font-size: 0.95rem; color: #fff;">${escapeHTML(item.key)}</span>
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              ${limitWidgetHtml}
              ${noteHtml}
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 5px;">
            ${isMasked ? '' : `
              <button class="btn btn-secondary btn-sm" onclick="copyTextToClipboard('${escapeHTML(item.key)}')" style="padding: 6px 10px; font-size: 0.8rem;" title="Copy Key">
                <i class="fa-solid fa-copy"></i>
              </button>
            `}
            ${(canReset && !isMasked) ? `
              <button class="btn btn-secondary btn-sm" onclick="resetKeyDevices('${escapeHTML(item.key)}', 'user')" style="padding: 6px 10px; font-size: 0.8rem; color: #ffb703; border-color: rgba(255,183,3,0.3);" title="Reset Devices">
                <i class="fa-solid fa-rotate-left"></i>
              </button>
            ` : ''}
            ${deleteButton}
          </div>
        `;
        userList.appendChild(li);
      });
    }
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
  const maxDevVal = parseInt(maxDevInput.value) || 5;
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
    maxDevInput.value = 5;
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

// ── Photo Frames Management Functions ────────────────────────────────────────

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
    showToast('មានបញ្ហាក្នុងការទាញយក Photo Frames!', 'error');
  }
}

function renderFrames() {
  const grid = document.getElementById('frames-gallery-grid');
  const emptyState = document.getElementById('frames-empty-state');
  
  if (!grid) return;
  grid.innerHTML = '';
  
  if (photoFrames.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  
  emptyState.classList.add('hidden');
  
  photoFrames.forEach(frame => {
    const card = document.createElement('div');
    card.className = `glass-panel ${frame.is_active ? 'active-frame-card' : ''}`;
    card.style.cssText = `
      padding: 15px; 
      text-align: center; 
      position: relative; 
      border-color: ${frame.is_active ? '#00f2fe' : 'rgba(255,255,255,0.08)'};
      box-shadow: ${frame.is_active ? '0 0 15px rgba(0, 242, 254, 0.2)' : 'none'};
      transition: all 0.3s ease;
    `;
    
    card.innerHTML = `
      <img src="${frame.image_data}" style="width: 100%; aspect-ratio: 1; object-fit: contain; background: rgba(255,255,255,0.05); border-radius: 10px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.1);">
      <div style="font-size: 0.85rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff; margin-bottom: 12px;" title="${escapeHTML(frame.name)}">
        ${escapeHTML(frame.name)}
      </div>
      <div style="display: flex; gap: 8px; justify-content: center;">
        <button class="btn ${frame.is_active ? 'btn-success' : 'btn-secondary'} btn-sm" onclick="setActiveFrame(${frame.id})" style="font-size: 0.75rem; padding: 6px 12px; font-weight: 600; display: flex; align-items: center; gap: 4px;">
          ${frame.is_active ? '<i class="fa-solid fa-circle-check"></i> កំពុងប្រើ' : '<i class="fa-solid fa-play"></i> ជ្រើសរើស'}
        </button>
        <button class="btn btn-danger btn-sm" onclick="deleteSingleFrame(${frame.id})" style="font-size: 0.75rem; padding: 6px 10px;" title="លុប Frame នេះ">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    `;
    grid.appendChild(card);
  });
}

async function handleUploadFrame(e) {
  e.preventDefault();
  
  const form = e.target;
  const fileInput = document.getElementById('new-frame-file');
  if (fileInput.files.length === 0) return;
  
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalHtml = submitBtn.innerHTML;
  
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> កំពុងបញ្ចូល...`;
  
  const formData = new FormData();
  formData.append('frame_file', fileInput.files[0]);
  
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
    
    showToast('បានបញ្ចូល Photo Frame ដោយជោគជ័យ!', 'success');
    form.reset();
    await loadFramesData();
  } catch (err) {
    console.error('Upload frame error:', err);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalHtml;
  }
}

async function deleteSingleFrame(id) {
  if (!confirm('តើអ្នកពិតជាចង់លុប Photo Frame នេះមែនទេ?')) return;
  
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
    
    showToast('បានលុប Frame រួចរាល់!', 'success');
    await loadFramesData();
  } catch (err) {
    console.error('Delete frame error:', err);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

async function deleteAllFrames() {
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
    
    showToast('បានកំណត់យក Frame នេះមកប្រើប្រាស់!', 'success');
    await loadFramesData();
  } catch (err) {
    console.error('Set active frame error:', err);
    showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
  }
}

window.setActiveFrame = setActiveFrame;
window.deleteSingleFrame = deleteSingleFrame;
window.loadFramesData = loadFramesData;
