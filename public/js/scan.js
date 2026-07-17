// State Variables
let qrId = null;
let qrConfig = null;
let videoStream = null;
let capturedImageBlob = null;
let capturedImageSrc = null;
let userLatitude = null;
let userLongitude = null;

// Helper to format YYYY-MM-DD to DD/MM/YYYY
function formatDateDMY(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
}

// Image editing state (Zoom & Drag/Pan)
let loadedUserImg = null;
let loadedFrameImg = null;
let imageZoom = 1.0;
let imagePanX = 0.0;
let imagePanY = 0.0;

// DOM Elements
document.addEventListener('DOMContentLoaded', () => {
  parseQueryParams();
  setupEventListeners();
  setupImageEditorListeners();
  requestGPSLocation(); // Pre-fetch GPS location on page load to eliminate delay
});


// Parse query params to get QR ID
async function parseQueryParams() {
  const urlParams = new URLSearchParams(window.location.search);
  qrId = urlParams.get('qr_id');

  if (!qrId) {
    showError();
    return;
  }

  // Fetch configs from server
  await fetchQRConfig();
}

// Fetch specific QR config from API
async function fetchQRConfig() {
  try {
    const res = await fetch('/api/qrcodes/public/' + qrId);
    if (!res.ok) throw new Error('Cannot load QR code settings');
    
    qrConfig = await res.json();
    
    // Support a mock TEST QR code for debugging if list is empty
    if (!qrConfig && qrId === 'test_qr') {
      qrConfig = {
        id: 'test_qr',
        name: 'តូបតេស្តសាកល្បង',
        hashtag: '#AJCQRCode #DefaultHashtag',
        facebook_url: 'https://facebook.com',
        tiktok_url: 'https://tiktok.com',
        youtube_url: 'https://youtube.com',
        frame_image: 'default_frame.svg',
        frame_image_data: ''
      };
    }
    
    if (!qrConfig) {
      showError();
      return;
    }
    
    // Check if start date is in the future
    const nowStr = new Date().toLocaleDateString('sv');
    if (qrConfig.start_date) {
      if (nowStr < qrConfig.start_date) {
        const formattedStart = formatDateDMY(qrConfig.start_date);
        showError('មិនទាន់ដល់ថ្ងៃកំណត់ប្រើប្រាស់ឡើយ! (ចាប់ផ្តើមពីថ្ងៃទី ' + formattedStart + ')');
        return;
      }
    }

    // Check if QR code is expired
    if (qrConfig.expires_at) {
      if (nowStr > qrConfig.expires_at) {
        const formattedExpiry = formatDateDMY(qrConfig.expires_at);
        showError('QR Code នេះបានហួសកំណត់ប្រើប្រាស់ហើយ! (ផុតកំណត់ត្រឹមថ្ងៃទី ' + formattedExpiry + ')');
        return;
      }
    }
    
    // Update shop name and subtitle
    document.getElementById('shop-name').textContent = qrConfig.name;
    document.getElementById('preview-hashtag').innerHTML = `<i class="fa-solid fa-hashtag"></i> ${qrConfig.hashtag || 'គ្មាន'}`;
    
    // Pre-fill default location if preset by admin
    if (qrConfig.default_location) {
      document.getElementById('scanner-location').value = qrConfig.default_location;
    }
    
    // Check if market edit is locked
    const cannotEdit = qrConfig.cannot_edit_market !== false;
    const locInput = document.getElementById('scanner-location');
    if (locInput) {
      if (cannotEdit) {
        locInput.readOnly = true;
        locInput.style.background = '#f1f5f9';
        locInput.style.color = '#64748b';
        locInput.style.cursor = 'not-allowed';
      } else {
        locInput.readOnly = false;
        locInput.style.background = '';
        locInput.style.color = '';
        locInput.style.cursor = '';
      }
    }
    
    // Toggle social share buttons visibility
    const showFb = qrConfig.show_facebook !== false;
    const showTt = qrConfig.show_tiktok !== false;
    const showYt = qrConfig.show_youtube !== false;

    document.getElementById('share-btn-fb').classList.toggle('hidden', !showFb);
    document.getElementById('share-btn-tt').classList.toggle('hidden', !showTt);
    document.getElementById('share-btn-yt').classList.toggle('hidden', !showYt);

    const shareBlock = document.getElementById('social-share-block');
    if (shareBlock) {
      shareBlock.classList.toggle('hidden', !showFb && !showTt && !showYt);
    }
    
    // Request GPS Location only if enabled by admin (postponed until form submission)
    if (qrConfig.capture_location === true) {
      // Show secure context alert if Geolocation will be blocked by browser
      const isSecure = window.isSecureContext || window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      if (!isSecure) {
        const alertBox = document.getElementById('secure-context-alert');
        if (alertBox) alertBox.classList.remove('hidden');
      }
    }
    
    // Fetch active frame mask from server (global active frame) in the background asynchronously
    fetch('/api/frames/active')
      .then(res => res.ok ? res.json() : null)
      .then(activeFrame => {
        const frameSrc = (activeFrame && activeFrame.image_data) ? activeFrame.image_data : 'uploads/default_frame.svg';
        document.getElementById('camera-frame-mask').src = frameSrc;
      })
      .catch(e => {
        console.error('Error fetching active frame in background:', e);
        document.getElementById('camera-frame-mask').src = 'uploads/default_frame.svg';
      });
    
  } catch (error) {
    console.error(error);
    showToast('មានបញ្ហាក្នុងការទាញយកទិន្នន័យពី Server!', 'error');
    showError();
  }
}

// Display error card if QR ID is invalid
function showError(msg) {
  document.getElementById('stepper-container').classList.add('hidden');
  const errCard = document.getElementById('error-card');
  if (errCard) {
    if (msg) {
      const p = errCard.querySelector('p');
      if (p) p.textContent = msg;
    }
    
    // Dynamically change button to "បិទកម្មវិធី"
    const btn = errCard.querySelector('a, button');
    if (btn) {
      btn.textContent = 'បិទកម្មវិធី';
      btn.removeAttribute('href');
      btn.style.cursor = 'pointer';
      
      const newBtn = btn.cloneNode(true);
      newBtn.addEventListener('click', (e) => {
        e.preventDefault();
        window.close();
        if (typeof WeixinJSBridge !== 'undefined') {
          WeixinJSBridge.call('closeWindow');
        }
        setTimeout(() => {
          window.location.href = "about:blank";
        }, 200);
      });
      btn.parentNode.replaceChild(newBtn, btn);
    }
    
    errCard.classList.remove('hidden');
  }
}

// Setup listeners for buttons
function setupEventListeners() {
  // Step 1 Form
  const form = document.getElementById('scan-info-form');
  form.addEventListener('submit', handleStep1Submit);

  // Close App Button
  const btnCloseApp = document.getElementById('btn-close-app');
  if (btnCloseApp) {
    btnCloseApp.addEventListener('click', () => {
      window.close();
      if (typeof WeixinJSBridge !== 'undefined') {
        WeixinJSBridge.call('closeWindow');
      }
      setTimeout(() => {
        window.location.href = "about:blank";
      }, 200);
    });
  }

  // Step 2 Selectors
  const btnCamera = document.getElementById('btn-use-camera');
  const btnUpload = document.getElementById('btn-use-upload');
  
  btnCamera.addEventListener('click', startCameraFlow);
  btnUpload.addEventListener('click', startUploadFlow);

  // Camera Actions
  document.getElementById('btn-capture').addEventListener('click', capturePhoto);
  document.getElementById('btn-cancel-camera').addEventListener('click', stopCameraFlow);

  // Upload Actions
  document.getElementById('user-photo-file').addEventListener('change', handleFileUpload);
  document.getElementById('btn-cancel-upload').addEventListener('click', stopUploadFlow);

  // Step 3 Actions
  document.getElementById('btn-download-result').addEventListener('click', downloadFramedPhoto);
  document.getElementById('btn-retake').addEventListener('click', retakePhotoFlow);

  // Hashtag manual copy action on click
  const hashtagContainer = document.getElementById('hashtag-container');
  if (hashtagContainer) {
    hashtagContainer.addEventListener('click', () => {
      const hashtagText = (qrConfig && qrConfig.hashtag) ? qrConfig.hashtag : "";
      if (hashtagText) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(hashtagText).then(() => {
            showToast('បានចម្លង Hashtag ដោយជោគជ័យ!', 'success');
          }).catch(err => {
            copyTextFallback(hashtagText);
            showToast('បានចម្លង Hashtag ដោយជោគជ័យ!', 'success');
          });
        } else {
          copyTextFallback(hashtagText);
          showToast('បានចម្លង Hashtag ដោយជោគជ័យ!', 'success');
        }
      }
    });
  }

  // Guide Modal Actions
  document.getElementById('btn-close-guide').addEventListener('click', () => {
    document.getElementById('guide-overlay').style.display = 'none';
  });

  // iOS Download Modal Actions
  const btnCloseIosModal = document.getElementById('btn-close-ios-modal');
  const iosModal = document.getElementById('ios-download-modal');
  if (btnCloseIosModal && iosModal) {
    btnCloseIosModal.addEventListener('click', () => {
      iosModal.classList.remove('active');
    });
    iosModal.addEventListener('click', (e) => {
      if (e.target === iosModal) {
        iosModal.classList.remove('active');
      }
    });
  }
}

// Step 1: Submit user details to Server
async function handleStep1Submit(e) {
  e.preventDefault();
  
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const originalBtnHtml = submitBtn.innerHTML;
  
  // Set loading state
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> កំពុងស្វែងរកទីតាំង...`;
  
  const name = document.getElementById('scanner-name').value.trim();
  const phone = document.getElementById('scanner-phone').value.trim();
  const location = document.getElementById('scanner-location').value.trim();
  const submitForm = async () => {
    const resolvedModel = await getDeviceModelAsync();
    const payload = {
      qr_id: qrId,
      name: name,
      phone: phone,
      location: location,
      latitude: userLatitude,
      longitude: userLongitude,
      device_model: resolvedModel
    };
    
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        showToast(data.error || 'មានបញ្ហាក្នុងការបញ្ជូនទិន្នន័យ!', 'error');
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnHtml;
        return;
      }
      
      showToast('កត់ត្រាទិន្នន័យបានសម្រេច!', 'success');
      
      // Move to step 2
      document.getElementById('step-1').classList.add('hidden');
      document.getElementById('step-2').classList.remove('hidden');
      updateProgressBar(2);
      
    } catch (error) {
      console.error(error);
      showToast('មានបញ្ហាជាមួយបណ្តាញតភ្ជាប់!', 'error');
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnHtml;
    }
  };

  // If capture_location is enabled and coordinates are missing, try capturing them again with a 3-second timeout before sending
  if (qrConfig.capture_location === true && navigator.geolocation && (userLatitude === null || userLongitude === null)) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        userLatitude = position.coords.latitude;
        userLongitude = position.coords.longitude;
        submitForm();
      },
      (error) => {
        console.warn("Geolocation wait failed:", error.message);
        submitForm(); // Proceed without coordinates
      },
      {
        enableHighAccuracy: false, // Disables active hardware GPS query (saves 15s)
        timeout: 2000,              // 2 seconds max wait
        maximumAge: 300000          // Uses location cache up to 5 minutes old
      }
    );
  } else {
    await submitForm();
  }
}

// Track current facing mode (start with front camera)
let currentFacingMode = 'user';

// Start camera with specified facing mode
async function startCameraWithFacing(facingMode) {
  // Stop existing stream first
  if (videoStream) {
    videoStream.getTracks().forEach(track => track.stop());
    videoStream = null;
  }

  const constraintsList = [
    { video: { facingMode: { ideal: facingMode } }, audio: false },
    { video: { facingMode: facingMode }, audio: false },
    { video: true, audio: false }
  ];

  let stream = null;
  let lastError = null;

  for (const constraints of constraintsList) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (e) {
      lastError = e;
      console.warn('Camera attempt failed:', e.name, e.message);
    }
  }

  if (!stream) {
    if (lastError && (lastError.name === 'NotAllowedError' || lastError.name === 'PermissionDeniedError')) {
      showToast('គ្មានសិទ្ធិចូលប្រើកាមេរ៉ា! សូមចូល Settings → Safari → Camera → Allow', 'error');
    } else if (lastError && lastError.name === 'NotFoundError') {
      showToast('រកមិនឃើញកាមេរ៉ានៅលើឧបករណ៍នេះ!', 'error');
    } else {
      showToast('មិនអាចបើកកាមេរ៉ាបានទេ! សូមប្រើ "ជ្រើសរើសរូបភាព" ជំនួស!', 'error');
    }
    return false;
  }

  videoStream = stream;
  const video = document.getElementById('video-stream');
  video.srcObject = videoStream;
  try {
    await video.play();
  } catch (playErr) {
    console.warn('video.play() warning (non-fatal on iOS):', playErr.message);
  }
  return true;
}

// Step 2: Camera Stream Activation
async function startCameraFlow() {
  document.getElementById('photo-source-selector').classList.add('hidden');
  document.getElementById('camera-section').classList.remove('hidden');

  // Always start with front camera (user)
  currentFacingMode = 'user';
  const ok = await startCameraWithFacing(currentFacingMode);
  if (!ok) {
    stopCameraFlow();
  }
}

// Flip between Front and Back camera
async function flipCamera() {
  const btn = document.getElementById('btn-flip-camera');
  if (btn) {
    btn.style.transform = 'rotate(180deg)';
    btn.disabled = true;
  }

  // Toggle facing mode
  currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';

  await startCameraWithFacing(currentFacingMode);

  if (btn) {
    setTimeout(() => {
      btn.style.transform = 'rotate(0deg)';
      btn.disabled = false;
    }, 300);
  }
}


// Stop Camera Stream
function stopCameraFlow() {
  if (videoStream) {
    videoStream.getTracks().forEach(track => track.stop());
    videoStream = null;
  }
  document.getElementById('video-stream').srcObject = null;
  document.getElementById('camera-section').classList.add('hidden');
  document.getElementById('photo-source-selector').classList.remove('hidden');
}

// Capture photo from video stream
function capturePhoto() {
  const video = document.getElementById('video-stream');
  
  // Create virtual canvas to capture raw frame
  const canvas = document.createElement('canvas');
  const size = Math.min(video.videoWidth, video.videoHeight);
  canvas.width = size;
  canvas.height = size;
  
  const ctx = canvas.getContext('2d');
  
  // Crop centered square from landscape/portrait camera feed
  const sx = (video.videoWidth - size) / 2;
  const sy = (video.videoHeight - size) / 2;
  
  // Mirror frame capture if using front camera (standard camera look)
  ctx.translate(size, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, sx, sy, size, size, 0, 0, size, size);
  ctx.setTransform(1, 0, 0, 1, 0, 0); // reset transform
  
  capturedImageSrc = canvas.toDataURL('image/jpeg', 0.95);
  
  // Stop camera feed
  stopCameraFlow();
  
  // Render and go to Step 3
  compileFramedPhoto();
}

// Step 2: Upload File Flow
function startUploadFlow() {
  document.getElementById('photo-source-selector').classList.add('hidden');
  document.getElementById('upload-section').classList.remove('hidden');
}

function stopUploadFlow() {
  document.getElementById('user-photo-file').value = '';
  document.getElementById('upload-section').classList.add('hidden');
  document.getElementById('photo-source-selector').classList.remove('hidden');
}

// Handle file uploaded from photo gallery
function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(event) {
    capturedImageSrc = event.target.result;
    stopUploadFlow();
    compileFramedPhoto();
  };
  reader.readAsDataURL(file);
}

// Setup mouse and touch listeners for interactive dragging and zooming
function setupImageEditorListeners() {
  const canvas = document.getElementById('result-canvas');
  if (canvas) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    
    const getCanvasScale = () => {
      const rect = canvas.getBoundingClientRect();
      return 800 / (rect.width || 800);
    };
    
    const dragStart = (x, y) => {
      isDragging = true;
      startX = x;
      startY = y;
    };
    
    const dragMove = (x, y) => {
      if (!isDragging || !loadedUserImg) return;
      const dx = x - startX;
      const dy = y - startY;
      const scale = getCanvasScale();
      
      // Update pan offset relative to zoom factor
      imagePanX += (dx * scale) / imageZoom;
      imagePanY += (dy * scale) / imageZoom;
      
      startX = x;
      startY = y;
      
      redrawCanvas();
    };
    
    const dragEnd = () => {
      isDragging = false;
    };
    
    // Mouse listeners
    canvas.addEventListener('mousedown', (e) => dragStart(e.clientX, e.clientY));
    canvas.addEventListener('mousemove', (e) => dragMove(e.clientX, e.clientY));
    canvas.addEventListener('mouseup', dragEnd);
    canvas.addEventListener('mouseleave', dragEnd);
    
    // Touch listeners
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        dragStart(e.touches[0].clientX, e.touches[0].clientY);
      }
    });
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        e.preventDefault(); // Prevent scrolling on mobile while adjusting image placement
        dragMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: false });
    canvas.addEventListener('touchend', dragEnd);
  }
  
  // Set up zoom range slider listener
  const slider = document.getElementById('zoom-slider');
  if (slider) {
    slider.addEventListener('input', (e) => {
      imageZoom = parseFloat(e.target.value);
      redrawCanvas();
    });
  }
}

// Redraw composite canvas with current zoom and pan values
function redrawCanvas() {
  const canvas = document.getElementById('result-canvas');
  if (!canvas || !loadedUserImg || !loadedFrameImg) return;
  const ctx = canvas.getContext('2d');
  
  // Clear canvas
  ctx.clearRect(0, 0, 800, 800);
  
  // Draw user image with zoom and pan transform
  ctx.save();
  ctx.translate(400, 400); // Translate origin to canvas center
  ctx.scale(imageZoom, imageZoom); // Scale around center
  ctx.translate(imagePanX, imagePanY); // Apply translation offset
  
  const iw = loadedUserImg.width;
  const ih = loadedUserImg.height;
  const scaleX = 800 / iw;
  const scaleY = 800 / ih;
  const defaultScale = Math.max(scaleX, scaleY);
  
  const nw = iw * defaultScale;
  const nh = ih * defaultScale;
  
  // Draw centered
  ctx.drawImage(loadedUserImg, -nw / 2, -nh / 2, nw, nh);
  ctx.restore();
  
  // Draw frame mask overlay on top
  ctx.drawImage(loadedFrameImg, 0, 0, 800, 800);
}

// Step 3: Draw Canvas layering (Photo + Frame template overlay + Hashtag text watermark)
function compileFramedPhoto() {
  // Reset image adjustment variables
  imageZoom = 1.0;
  imagePanX = 0.0;
  imagePanY = 0.0;
  
  const slider = document.getElementById('zoom-slider');
  if (slider) slider.value = 1.0;

  const userImg = new Image();
  userImg.onload = function() {
    loadedUserImg = userImg;
    
    const frameImg = new Image();
    frameImg.onload = function() {
      loadedFrameImg = frameImg;
      
      // Perform initial composite render
      redrawCanvas();
      
      // Unlock Step 3 preview section
      document.getElementById('step-2').classList.add('hidden');
      document.getElementById('step-3').classList.remove('hidden');
      updateProgressBar(3);
      showToast('រូបភាពបង្កើតរួចរាល់!', 'success');
    };
    
    frameImg.crossOrigin = 'Anonymous';
    // Use the exact same frame overlay shown on the camera preview
    frameImg.src = document.getElementById('camera-frame-mask').src;
  };
  
  userImg.src = capturedImageSrc;
}

// Trigger dynamic download via backend form post (fully compatible with iOS Safari / iPhone)
function triggerSecureDownload(dataUrl, filename, mimetype = 'image/jpeg') {
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

// Download final merged canvas photo
function downloadFramedPhoto() {
  const canvas = document.getElementById('result-canvas');
  if (!canvas) return;
  const scannerName = document.getElementById('scanner-name').value.trim() || 'photo';
  const safeName = scannerName.replace(/[\/\\?%*:|"<>\s]/g, '_') + '.jpg';
  
  // Try Web Share API first (highly interactive and allows direct saving to Photos Gallery on iPhone)
  if (navigator.share && navigator.canShare) {
    canvas.toBlob((blob) => {
      if (!blob) {
        // Fallback if blob creation fails
        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        triggerSecureDownload(dataUrl, safeName, 'image/jpeg');
        showCenteredAlert('ទាញយករូបភាពបានជោគជ័យ!<br>Download Success');
        return;
      }
      
      const file = new File([blob], safeName, { type: 'image/jpeg' });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({
          files: [file],
          title: 'រូបថតរបស់ខ្ញុំ',
          text: 'រូបថត Ajinomoto'
        })
        .then(() => {
          showCenteredAlert('រក្សាទុកបានជោគជ័យ!<br>Save Success');
        })
        .catch((err) => {
          // If user cancels or share fails, fallback to attachment download
          console.warn('Share cancelled/failed, using fallback download:', err.message);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
          triggerSecureDownload(dataUrl, safeName, 'image/jpeg');
          showCenteredAlert('ទាញយករូបភាពបានជោគជ័យ!<br>Download Success');
        });
      } else {
        // Fallback if sharing files is not supported
        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        triggerSecureDownload(dataUrl, safeName, 'image/jpeg');
        showCenteredAlert('ទាញយករូបភាពបានជោគជ័យ!<br>Download Success');
      }
    }, 'image/jpeg', 0.95);
  } else {
    // Fallback for browsers that don't support Web Share API (desktop, older devices)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
    triggerSecureDownload(dataUrl, safeName, 'image/jpeg');
    showCenteredAlert('ទាញយករូបភាពបានជោគជ័យ!<br>Download Success');
  }
}

// Show a beautiful centered alert popup that disappears after 1.5s automatically
function showCenteredAlert(message) {
  const alertDiv = document.createElement('div');
  alertDiv.style.position = 'fixed';
  alertDiv.style.top = '50%';
  alertDiv.style.left = '50%';
  alertDiv.style.transform = 'translate(-50%, -50%)';
  alertDiv.style.background = 'rgba(11, 7, 22, 0.95)';
  alertDiv.style.border = '1px solid #00f2fe';
  alertDiv.style.boxShadow = '0 0 20px rgba(0, 242, 254, 0.6)';
  alertDiv.style.borderRadius = '16px';
  alertDiv.style.padding = '20px 30px';
  alertDiv.style.color = '#fff';
  alertDiv.style.zIndex = '99999';
  alertDiv.style.textAlign = 'center';
  alertDiv.style.fontSize = '1.1rem';
  alertDiv.style.fontWeight = 'bold';
  alertDiv.style.pointerEvents = 'none';
  alertDiv.style.transition = 'opacity 0.3s ease';
  alertDiv.style.opacity = '0';
  
  alertDiv.innerHTML = `
    <i class="fa-solid fa-circle-check" style="color: #00f2fe; font-size: 2.2rem; display: block; margin-bottom: 10px;"></i>
    <span>${message}</span>
  `;
  
  document.body.appendChild(alertDiv);
  
  // Trigger reflow
  alertDiv.offsetHeight;
  alertDiv.style.opacity = '1';
  
  // Hide and remove after 1.5 seconds
  setTimeout(() => {
    alertDiv.style.opacity = '0';
    setTimeout(() => {
      alertDiv.remove();
    }, 300);
  }, 1500);
}

function copyTextFallback(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.position = "fixed";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand('copy');
  } catch (err) {
    console.error('Fallback copy failed:', err);
  }
  document.body.removeChild(textArea);
}

// Share click: redirect directly to social media platforms
window.shareToSocial = function(platform) {
  let redirectUrl = "";
  
  if (platform === 'facebook') {
    redirectUrl = qrConfig.facebook_url || "https://www.facebook.com";
  } else if (platform === 'tiktok') {
    redirectUrl = qrConfig.tiktok_url || "https://www.tiktok.com";
  } else if (platform === 'youtube') {
    redirectUrl = qrConfig.youtube_url || "https://www.youtube.com";
  }
  
  if (redirectUrl) {
    window.open(redirectUrl, '_blank');
  }
}

// Retake flow: reset to step 2 selection
function retakePhotoFlow() {
  capturedImageSrc = null;
  document.getElementById('step-3').classList.add('hidden');
  document.getElementById('step-2').classList.remove('hidden');
  document.getElementById('photo-source-selector').classList.remove('hidden');
  updateProgressBar(2);
}

// Helper Toast Alerts
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
  
  setTimeout(() => {
    toast.style.animation = 'slideInRight 0.3s ease reverse';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3500);
}

// Helper to update visual step progress bar
function updateProgressBar(step) {
  const steps = [1, 2, 3];
  steps.forEach(s => {
    const stepEl = document.getElementById(`prog-step-${s}`);
    const lineEl = document.getElementById(`prog-line-${s - 1}`);
    
    if (stepEl) {
      stepEl.classList.remove('active', 'completed');
      if (s < step) {
        stepEl.classList.add('completed');
      } else if (s === step) {
        stepEl.classList.add('active');
      }
    }
    
    if (lineEl) {
      lineEl.classList.remove('active', 'completed');
      if (s - 1 < step - 1) {
        lineEl.classList.add('completed');
      } else if (s - 1 === step - 1) {
        lineEl.classList.add('active');
      }
    }
  });
}

// Request GPS Coordinates on load
function requestGPSLocation() {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        userLatitude = position.coords.latitude;
        userLongitude = position.coords.longitude;
        console.log("GPS Location captured successfully:", userLatitude, userLongitude);
      },
      (error) => {
        console.warn("Geolocation warning:", error.message);
      },
      {
        enableHighAccuracy: false, // Disables active hardware GPS query (saves 15s)
        timeout: 4000,              // 4 seconds max wait
        maximumAge: 300000          // Uses location cache up to 5 minutes old
      }
    );
  } else {
    console.warn("Geolocation is not supported by this browser.");
  }
}

// iPhone Model Numbers Mapping List
const iphoneModelNumbers = {
  'iPhone 16 Pro Max': 'A3084, A3295, A3296, A3297',
  'iPhone 16 Pro': 'A3083, A3292, A3293, A3294',
  'iPhone 16 Plus': 'A3082, A3289, A3290, A3291',
  'iPhone 16': 'A3081, A3286, A3287, A3288',
  'iPhone 15 Pro Max': 'A2849, A3105, A3106, A3108',
  'iPhone 15 Pro': 'A2848, A3101, A3102, A3104',
  'iPhone 15 Plus': 'A2847, A3093, A3094, A3096',
  'iPhone 15': 'A2846, A3089, A3090, A3092',
  'iPhone 14 Pro Max': 'A2651, A2893, A2894, A2895, A2896',
  'iPhone 14 Pro': 'A2650, A2889, A2890, A2891, A2892',
  'iPhone 14 Plus': 'A2632, A2885, A2886, A2887, A2888',
  'iPhone 14': 'A2649, A2881, A2882, A2883, A2884',
  'iPhone 13 Pro Max': 'A2484, A2641, A2643, A2644, A2645',
  'iPhone 13 Pro': 'A2483, A2636, A2638, A2639, A2640',
  'iPhone 13': 'A2482, A2631, A2633, A2634, A2635',
  'iPhone 13 Mini': 'A2481, A2626, A2628, A2629, A2630',
  'iPhone 12 Pro Max': 'A2342, A2410, A2411, A2412',
  'iPhone 12 Pro': 'A2341, A2406, A2407, A2408',
  'iPhone 12': 'A2172, A2402, A2403, A2404',
  'iPhone 12 Mini': 'A2176, A2398, A2399, A2400',
  'iPhone 11 Pro Max': 'A2161, A2220, A2218',
  'iPhone 11 Pro': 'A2160, A2217, A2215',
  'iPhone 11': 'A2111, A2221, A2223',
  'iPhone XS Max': 'A1921, A2101, A2102, A2103, A2104',
  'iPhone XS': 'A1920, A2097, A2098, A2099, A2100',
  'iPhone XR': 'A1984, A2105, A2106, A2107, A2108',
  'iPhone X': 'A1865, A1901, A1902',
  'iPhone SE (3rd Gen)': 'A2595, A2782, A2783, A2784, A2785',
  'iPhone SE (2nd Gen)': 'A2275, A2296, A2298',
  'iPhone 8 Plus': 'A1864, A1897, A1898',
  'iPhone 8': 'A1863, A1905, A1906',
  'iPhone 7 Plus': 'A1661, A1784, A1785',
  'iPhone 7': 'A1660, A1778, A1779',
  'iPhone 6S Plus': 'A1634, A1687, A1699',
  'iPhone 6S': 'A1633, A1688, A1700',
  'iPhone 6 Plus': 'A1522, A1524, A1593',
  'iPhone 6': 'A1549, A1586, A1589'
};

// Detect Device Model (Android and iOS mapping)
async function getDeviceModelAsync() {
  const userAgent = navigator.userAgent;
  
  // 1. Check if iOS Device
  const isIOS = /iPad|iPhone|iPod/.test(userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  
  if (isIOS) {
    let gpu = 'Unknown';
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
          gpu = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '';
        }
      }
    } catch (e) {
      console.warn("WebGL query blocked or failed:", e);
    }
    
    const width = Math.min(window.screen.width, window.screen.height);
    const height = Math.max(window.screen.width, window.screen.height);
    const dpr = window.devicePixelRatio;
    
    let modelName = 'iPhone';
    
    // Screen size mapping table
    if (width === 440 && height === 956) {
      modelName = 'iPhone 16 Pro Max';
    } else if (width === 402 && height === 874) {
      modelName = 'iPhone 16 Pro';
    } else if (width === 430 && height === 932) {
      if (gpu.includes('A17') || gpu.includes('A18') || gpu.includes('Apple GPU')) {
        modelName = 'iPhone 15 Pro Max';
      } else {
        modelName = 'iPhone 14 Pro Max / 15 Plus';
      }
    } else if (width === 393 && height === 852) {
      if (gpu.includes('A17') || gpu.includes('A18') || gpu.includes('Apple GPU')) {
        modelName = 'iPhone 15 Pro';
      } else {
        modelName = 'iPhone 14 Pro / 15';
      }
    } else if (width === 428 && height === 926) {
      modelName = 'iPhone 12 Pro Max / 13 Pro Max / 14 Plus';
    } else if (width === 390 && height === 844) {
      modelName = 'iPhone 12 / 12 Pro / 13 / 13 Pro / 14';
    } else if (width === 414 && height === 896) {
      modelName = dpr === 3 ? 'iPhone XS Max / 11 Pro Max' : 'iPhone XR / 11';
    } else if (width === 375 && height === 812) {
      modelName = 'iPhone X / XS / 11 Pro';
    } else if (width === 360 && height === 780) {
      modelName = 'iPhone 12 Mini / 13 Mini';
    } else if (width === 414 && height === 736) {
      modelName = 'iPhone 6 Plus / 6S Plus / 7 Plus / 8 Plus';
    } else if (width === 375 && height === 667) {
      modelName = dpr === 3 ? 'iPhone 12 Mini / 13 Mini (scaled)' : 'iPhone 6 / 6S / 7 / 8 / SE (2nd/3rd Gen)';
    } else if (width === 320 && height === 568) {
      modelName = 'iPhone 5 / 5S / 5C / SE (1st Gen)';
    } else {
      modelName = 'iPhone (Unknown Model)';
    }
    
    const numbers = iphoneModelNumbers[modelName];
    return numbers ? `${modelName} (${numbers})` : modelName;
  }
  
  // 2. Check if Android Device
  if (/Android/.test(userAgent)) {
    // Try modern User-Agent Client Hints first to bypass UA reduction (which freezes model to "K")
    if (navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function') {
      try {
        const hints = await navigator.userAgentData.getHighEntropyValues(['model']);
        if (hints && hints.model && hints.model !== 'K') {
          return hints.model;
        }
      } catch (err) {
        console.warn("Failed to get high-entropy client hints:", err);
      }
    }
    
    // Fallback to parsing User-Agent
    const match = userAgent.match(/\bAndroid\s+[^;]+;\s*([^;\)]+)/);
    if (match && match[1]) {
      let model = match[1].trim();
      model = model.replace(/\s+Build\/.+$/i, '');
      if (model && model !== 'K') {
        return model;
      }
    }
    return 'Android Device';
  }
  
  // 3. Fallbacks
  if (/Macintosh/.test(userAgent)) return 'Mac';
  if (/Windows/.test(userAgent)) return 'Windows PC';
  if (/Linux/.test(userAgent)) return 'Linux PC';
  
  return 'Unknown Device';
}
