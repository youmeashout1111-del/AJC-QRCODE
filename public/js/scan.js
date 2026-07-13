// State Variables
let qrId = null;
let qrConfig = null;
let videoStream = null;
let capturedImageBlob = null;
let capturedImageSrc = null;
let userLatitude = null;
let userLongitude = null;

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
    
    // Update shop name and subtitle
    document.getElementById('shop-name').textContent = qrConfig.name;
    document.getElementById('preview-hashtag').innerHTML = `<i class="fa-solid fa-hashtag"></i> ${qrConfig.hashtag || 'គ្មាន'}`;
    
    // Pre-fill default location if preset by admin
    if (qrConfig.default_location) {
      document.getElementById('scanner-location').value = qrConfig.default_location;
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
    
    // Request GPS Location only if enabled by admin
    if (qrConfig.capture_location === true) {
      requestGPSLocation();
      
      // Show secure context alert if Geolocation will be blocked by browser
      const isSecure = window.isSecureContext || window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      if (!isSecure) {
        const alertBox = document.getElementById('secure-context-alert');
        if (alertBox) alertBox.classList.remove('hidden');
      }
    }
    
    // Fetch active frame mask from server (global active frame)
    let frameSrc = '';
    try {
      const frameRes = await fetch('/api/frames/active');
      if (frameRes.ok) {
        const activeFrame = await frameRes.json();
        frameSrc = activeFrame.image_data;
      }
    } catch (e) {
      console.error('Error fetching active frame:', e);
    }
    
    // Fallback if no active frame is set
    if (!frameSrc) {
      frameSrc = 'uploads/default_frame.svg';
    }
    
    document.getElementById('camera-frame-mask').src = frameSrc;
    
  } catch (error) {
    console.error(error);
    showToast('មានបញ្ហាក្នុងការទាញយកទិន្នន័យពី Server!', 'error');
    showError();
  }
}

// Display error card if QR ID is invalid
function showError() {
  document.getElementById('stepper-container').classList.add('hidden');
  document.getElementById('error-card').classList.remove('hidden');
}

// Setup listeners for buttons
function setupEventListeners() {
  // Step 1 Form
  const form = document.getElementById('scan-info-form');
  form.addEventListener('submit', handleStep1Submit);

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
    const payload = {
      qr_id: qrId,
      name: name,
      phone: phone,
      location: location,
      latitude: userLatitude,
      longitude: userLongitude
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
        enableHighAccuracy: true,
        timeout: 3000,
        maximumAge: 0
      }
    );
  } else {
    await submitForm();
  }
}

// Step 2: Camera Stream Activation
async function startCameraFlow() {
  document.getElementById('photo-source-selector').classList.add('hidden');
  document.getElementById('camera-section').classList.remove('hidden');
  
  try {
    let stream;
    try {
      // First try front-facing user camera with basic constraints
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false
      });
    } catch (e) {
      console.warn("Front camera constraints failed, trying generic camera constraints:", e);
      // Fallback: request any available camera feed
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false
      });
    }
    
    videoStream = stream;
    const video = document.getElementById('video-stream');
    video.srcObject = videoStream;
    video.play();
  } catch (error) {
    console.error('Camera access error:', error);
    showToast('មិនអាចបើកកាមេរ៉ាបានទេ! សូមពិនិត្យ Permission ឬប្រើការបញ្ចូលរូបភាពជំនួស!', 'error');
    stopCameraFlow();
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

// Download final merged canvas photo
// Download final merged canvas photo
function downloadFramedPhoto() {
  const canvas = document.getElementById('result-canvas');
  if (!canvas) return;
  const scannerName = document.getElementById('scanner-name').value.trim() || 'photo';
  const safeName = scannerName.replace(/[\/\\?%*:|"<>\s]/g, '_') + '.jpg';
  
  // Detect if running on iOS (iPhone, iPad, iPod)
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  
  if (isIOS) {
    // For iOS, display the image in the long-press modal
    const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
    const iosModal = document.getElementById('ios-download-modal');
    const iosImg = document.getElementById('ios-download-image');
    
    if (iosModal && iosImg) {
      iosImg.src = dataUrl;
      iosModal.classList.add('active');
    }
    return;
  }
  
  // For non-iOS (Android, Windows, Mac), trigger normal file download
  canvas.toBlob((blob) => {
    if (!blob) {
      showToast('មានបញ្ហាក្នុងការបង្កើតរូបភាព!', 'error');
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = safeName;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Revoke the object URL after download is triggered
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 100);
    
    // Show success popup briefly (centered)
    showCenteredAlert('ទាញយករូបភាពបានជោគជ័យ!<br>Download Success');
  }, 'image/jpeg', 0.95);
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
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  } else {
    console.warn("Geolocation is not supported by this browser.");
  }
}
