/* ==========================================================================
   Local Connect — Single-Page Application Controller
   Manages the 3 UI sections: Connection/QR, Text Messaging, Voice/Video Calling
   ========================================================================== */

(function () {
  'use strict';

  var QR = window.LocalConnectQR;
  var RTC = window.LocalConnectRTC;

  // DOM References
  var screens = {
    connect: document.getElementById('screen-connect'),
    chat: document.getElementById('screen-chat'),
    call: document.getElementById('screen-call')
  };

  var stages = {
    idle: document.getElementById('stage-idle'),
    loading: document.getElementById('stage-loading'),
    qrDisplay: document.getElementById('stage-qr-display'),
    qrScanner: document.getElementById('stage-qr-scanner')
  };

  var els = {
    globalStatusBar: document.getElementById('global-status-bar'),
    globalStatusText: document.getElementById('global-status-text'),
    btnResetGlobal: document.getElementById('btn-reset-global'),

    alertBanner: document.getElementById('alert-banner'),
    alertTitle: document.getElementById('alert-title'),
    alertMessage: document.getElementById('alert-message'),
    btnDismissAlert: document.getElementById('btn-dismiss-alert'),

    secureContextNotice: document.getElementById('secure-context-notice'),
    inputLocalName: document.getElementById('input-local-name'),
    btnCreateConnection: document.getElementById('btn-create-connection'),
    btnScanQr: document.getElementById('btn-scan-qr'),
    connectStateLabel: document.getElementById('connect-state-label'),
    connectSessionId: document.getElementById('connect-session-id'),
    connectIceSummary: document.getElementById('connect-ice-summary'),

    loadingTitle: document.getElementById('loading-title'),
    loadingSubtitle: document.getElementById('loading-subtitle'),

    qrDisplayTitle: document.getElementById('qr-display-title'),
    qrDisplaySubtitle: document.getElementById('qr-display-subtitle'),
    qrChunkCounter: document.getElementById('qr-chunk-counter'),
    qrOutputCanvas: document.getElementById('qr-output-canvas'),
    qrPagination: document.getElementById('qr-pagination'),
    btnQrPrev: document.getElementById('btn-qr-prev'),
    btnQrNext: document.getElementById('btn-qr-next'),
    btnQrAutocycle: document.getElementById('btn-qr-autocycle'),
    btnScanAnswer: document.getElementById('btn-scan-answer'),
    btnCancelOffer: document.getElementById('btn-cancel-offer'),

    scannerTitle: document.getElementById('scanner-title'),
    scannerSubtitle: document.getElementById('scanner-subtitle'),
    scannerProgress: document.getElementById('scanner-progress'),
    scannerVideo: document.getElementById('qr-scanner-video'),
    scannerChunkDots: document.getElementById('scanner-chunk-dots'),
    btnSwitchScannerCam: document.getElementById('btn-switch-scanner-cam'),
    btnStopScanner: document.getElementById('btn-stop-scanner'),

    chatPeerAvatar: document.getElementById('chat-peer-avatar'),
    chatPeerName: document.getElementById('chat-peer-name'),
    chatStatusDot: document.getElementById('chat-status-dot'),
    chatStatusText: document.getElementById('chat-status-text'),
    btnStartVoice: document.getElementById('btn-start-voice'),
    btnStartVideo: document.getElementById('btn-start-video'),
    chatMessages: document.getElementById('chat-messages'),
    chatEmptyState: document.getElementById('chat-empty-state'),
    chatForm: document.getElementById('chat-form'),
    inputChatMessage: document.getElementById('input-chat-message'),
    btnSendMessage: document.getElementById('btn-send-message'),

    remoteVideo: document.getElementById('remote-video'),
    localVideoWrap: document.getElementById('local-video-wrap'),
    localVideo: document.getElementById('local-video'),
    callAudioPlaceholder: document.getElementById('call-audio-placeholder'),
    callPeerAvatar: document.getElementById('call-peer-avatar'),
    callPeerName: document.getElementById('call-peer-name'),
    callStatusText: document.getElementById('call-status-text'),
    callDuration: document.getElementById('call-duration'),
    callHudName: document.getElementById('call-hud-name'),
    callHudState: document.getElementById('call-hud-state'),
    callHudTimer: document.getElementById('call-hud-timer'),
    btnToggleMic: document.getElementById('btn-toggle-mic'),
    iconMicOn: document.getElementById('icon-mic-on'),
    iconMicOff: document.getElementById('icon-mic-off'),
    labelMic: document.getElementById('label-mic'),
    btnToggleCam: document.getElementById('btn-toggle-cam'),
    iconCamOn: document.getElementById('icon-cam-on'),
    iconCamOff: document.getElementById('icon-cam-off'),
    labelCam: document.getElementById('label-cam'),
    btnSwitchCallCam: document.getElementById('btn-switch-call-cam'),
    btnEndCall: document.getElementById('btn-end-call'),

    incomingCallModal: document.getElementById('incoming-call-modal'),
    incomingCallType: document.getElementById('incoming-call-type'),
    incomingCallTitle: document.getElementById('incoming-call-title'),
    btnAcceptCall: document.getElementById('btn-accept-call'),
    btnRejectCall: document.getElementById('btn-reject-call')
  };

  // In-memory session state (never persisted to storage)
  var state = {
    activeScreen: 'connect',
    awaitingAnswer: false,
    currentSessionId: null,
    qrChunks: [],
    qrChunkIndex: 0,
    autoCycleTimer: null,
    collector: null,
    scanner: null,
    callTimerId: null,
    callStartTs: 0,
    lastScanErrorTs: 0
  };

  // Initialize RTC Manager
  var rtc = new RTC({
    onStateUpdate: function (label) {
      els.connectStateLabel.textContent = label;
    },
    onPeerInfo: function (remoteName) {
      updatePeerLabels(remoteName);
    },
    onConnected: function (info) {
      stopQRWorkflows();
      clearAlert();
      setGlobalStatus('connected', 'Connected Successfully');
      els.connectStateLabel.textContent = 'Connected Successfully';
      els.chatStatusDot.classList.remove('disconnected');
      els.chatStatusText.textContent = 'Connected · Direct P2P';
      updatePeerLabels(info.remoteName);
      showScreen('chat');
    },
    onDisconnected: function (reason) {
      endCallTimer();
      hideIncomingCallModal();
      clearMediaElements();
      setGlobalStatus('error', 'Disconnected');
      els.chatStatusDot.classList.add('disconnected');
      els.chatStatusText.textContent = 'Disconnected';
      appendSystemEvent(reason || 'Peer disconnected.');
      showScreen('chat');
      showAlert('Disconnected', reason || 'Peer connection closed. Tap Reset to pair again.', 'error');
    },
    onFailed: function (message, wasConnected) {
      stopQRWorkflows();
      endCallTimer();
      hideIncomingCallModal();
      clearMediaElements();
      setGlobalStatus('error', 'Connection failed');
      els.connectStateLabel.textContent = 'Connection failed';
      if (wasConnected) {
        appendSystemEvent(message);
      } else {
        setStage('idle');
      }
      showAlert('Connection Failed', message, 'error');
    },
    onError: function (message) {
      showAlert('Error', message, 'error');
    },
    onChatMessage: function (msg) {
      appendChatMessage(msg, false);
    },
    onIncomingCall: function (invite) {
      els.incomingCallType.textContent = invite.media === 'video' ? 'Incoming Video Call' : 'Incoming Voice Call';
      els.incomingCallTitle.textContent = invite.remoteName + ' is calling…';
      els.incomingCallModal.classList.remove('hidden');
    },
    onCallStateChanged: function (callInfo) {
      hideIncomingCallModal();
      enterCallScreen(callInfo);
    },
    onRemoteStreamUpdated: function (stream) {
      attachRemoteStream(stream);
    },
    onCallEnded: function (reason) {
      hideIncomingCallModal();
      endCallTimer();
      clearMediaElements();
      if (rtc.connectedNotified) {
        showScreen('chat');
        appendSystemEvent(reason);
      }
    }
  });

  // ========================================================================
  // Initialization
  // ========================================================================

  function init() {
    var defaultName = 'Device-' + QR.generateSecureId(2).toUpperCase();
    els.inputLocalName.value = defaultName;

    if (!window.isSecureContext) {
      els.secureContextNotice.classList.remove('hidden');
    }

    try {
      rtc.checkCompatibility();
    } catch (err) {
      showAlert('Browser Unsupported', err.message, 'error');
      els.btnCreateConnection.disabled = true;
      els.btnScanQr.disabled = true;
    }

    state.scanner = new QR.QRScannerController({
      videoEl: els.scannerVideo,
      onDecode: handleDecodedQRChunk,
      onError: function (err) {
        var now = Date.now();
        if (now - state.lastScanErrorTs > 1500) {
          state.lastScanErrorTs = now;
          showAlert('QR Scan Error', err.message, 'warning');
        }
      },
      onCamerasDetected: function (count) {
        if (count > 1) {
          els.btnSwitchScannerCam.classList.remove('hidden');
        } else {
          els.btnSwitchScannerCam.classList.add('hidden');
        }
      }
    });

    bindEvents();
    setGlobalStatus('idle', 'Disconnected');
  }

  function bindEvents() {
    els.btnDismissAlert.addEventListener('click', clearAlert);
    els.btnResetGlobal.addEventListener('click', resetAll);
    els.btnCancelOffer.addEventListener('click', resetAll);

    els.btnCreateConnection.addEventListener('click', handleCreateConnection);
    els.btnScanQr.addEventListener('click', function () {
      if (state.awaitingAnswer && state.currentSessionId) {
        startScannerFor('A', state.currentSessionId);
      } else {
        startScannerFor('O', null);
      }
    });
    els.btnScanAnswer.addEventListener('click', function () {
      startScannerFor('A', state.currentSessionId);
    });

    els.btnQrPrev.addEventListener('click', function () {
      stopAutoCycle();
      showQRChunk(state.qrChunkIndex - 1);
    });
    els.btnQrNext.addEventListener('click', function () {
      stopAutoCycle();
      showQRChunk(state.qrChunkIndex + 1);
    });
    els.btnQrAutocycle.addEventListener('click', toggleAutoCycle);

    els.btnStopScanner.addEventListener('click', function () {
      stopScannerOnly();
      if (state.awaitingAnswer && state.qrChunks.length > 0) {
        setStage('qrDisplay');
      } else {
        setStage('idle');
      }
    });
    els.btnSwitchScannerCam.addEventListener('click', function () {
      state.scanner.switchCamera().catch(function (err) {
        showAlert('Camera Switch Failed', err.message, 'warning');
      });
    });

    // Messaging
    els.chatForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      handleSendMessage();
    });

    // Call Triggers
    els.btnStartVoice.addEventListener('click', function () {
      startCallFlow('audio');
    });
    els.btnStartVideo.addEventListener('click', function () {
      startCallFlow('video');
    });

    // Incoming Call Modal
    els.btnAcceptCall.addEventListener('click', handleAcceptCall);
    els.btnRejectCall.addEventListener('click', function () {
      hideIncomingCallModal();
      rtc.rejectIncomingCall('declined');
    });

    // In-Call Controls
    els.btnToggleMic.addEventListener('click', handleToggleMic);
    els.btnToggleCam.addEventListener('click', handleToggleCam);
    els.btnSwitchCallCam.addEventListener('click', handleSwitchCallCamera);
    els.btnEndCall.addEventListener('click', function () {
      rtc.endCall();
    });

    // Clean up media & connection on tab close
    window.addEventListener('beforeunload', function () {
      stopQRWorkflows();
      rtc.reset();
    });
  }

  // ========================================================================
  // Screen & Stage Navigation
  // ========================================================================

  function showScreen(name) {
    state.activeScreen = name;
    Object.keys(screens).forEach(function (k) {
      screens[k].classList.toggle('active', k === name);
    });
  }

  function setStage(name) {
    Object.keys(stages).forEach(function (k) {
      stages[k].classList.toggle('active', k === name);
    });
  }

  function setGlobalStatus(level, text) {
    els.globalStatusBar.setAttribute('data-state', level);
    els.globalStatusText.textContent = text;
  }

  function showAlert(title, message, level) {
    els.alertTitle.textContent = title;
    els.alertMessage.textContent = message;
    els.alertBanner.setAttribute('data-level', level || 'error');
    els.alertBanner.classList.remove('hidden');
  }

  function clearAlert() {
    els.alertBanner.classList.add('hidden');
  }

  function getLocalName() {
    var raw = (els.inputLocalName.value || '').trim();
    return raw ? raw.slice(0, 24) : 'Device';
  }

  function updatePeerLabels(name) {
    var display = name || 'Connected Peer';
    var initial = display.charAt(0).toUpperCase() || 'P';
    els.chatPeerName.textContent = display;
    els.chatPeerAvatar.textContent = initial;
    els.callPeerName.textContent = display;
    els.callPeerAvatar.textContent = initial;
    els.callHudName.textContent = display;
  }

  // ========================================================================
  // Pairing Workflows (Device A Offer & Device B Answer)
  // ========================================================================

  async function handleCreateConnection() {
    clearAlert();
    stopQRWorkflows();

    if (rtc.connectedNotified) {
      showAlert('Already Connected', 'Reset the current connection before starting a new pairing.', 'warning');
      return;
    }

    var sessionId = QR.generateSecureId(4);
    state.currentSessionId = sessionId;
    state.awaitingAnswer = true;

    els.connectSessionId.textContent = sessionId;
    els.connectIceSummary.textContent = 'Gathering…';
    els.connectStateLabel.textContent = 'Creating offer…';
    setGlobalStatus('connecting', 'Preparing offer…');

    els.loadingTitle.textContent = 'Creating connection offer…';
    els.loadingSubtitle.textContent = 'Gathering local Wi-Fi / hotspot ICE candidates (no external servers).';
    setStage('loading');

    try {
      var result = await rtc.createOfferPayload(getLocalName(), sessionId);
      els.connectIceSummary.textContent = formatIceStats(result.stats);

      var encoded = await QR.encodeSignalingPayload(result.payload);
      state.qrChunks = encoded.chunks;
      state.qrChunkIndex = 0;

      els.qrDisplayTitle.textContent = 'Offer QR Code (Device A)';
      els.qrDisplaySubtitle.textContent = 'Scan with Device B, then tap "Scan Device B\'s Answer QR" below.';
      els.btnScanAnswer.classList.remove('hidden');
      els.connectStateLabel.textContent = 'Waiting for Device B to scan';
      setGlobalStatus('connecting', 'Waiting for Answer');

      renderCurrentQR();
      setStage('qrDisplay');
    } catch (err) {
      state.awaitingAnswer = false;
      rtc.reset();
      setStage('idle');
      setGlobalStatus('error', 'Offer failed');
      els.connectStateLabel.textContent = 'Failed';
      showAlert('Cannot Create Connection', err.message, 'error');
    }
  }

  async function startScannerFor(expectedType, expectedSid) {
    clearAlert();
    stopAutoCycle();

    if (rtc.connectedNotified) {
      showAlert('Already Connected', 'Reset the current connection before scanning a new device.', 'warning');
      return;
    }

    state.collector = new QR.QRChunkCollector(expectedType, expectedSid);
    els.scannerTitle.textContent = expectedType === 'A' ? 'Scan Answer QR (Device B)' : 'Scan Offer QR (Device A)';
    els.scannerSubtitle.textContent = expectedType === 'A'
      ? 'Point your camera at Device B\'s Answer QR code.'
      : 'Point your camera at Device A\'s Offer QR code.';
    els.scannerProgress.textContent = 'Waiting…';
    els.scannerChunkDots.innerHTML = '';
    els.scannerChunkDots.classList.add('hidden');
    setStage('qrScanner');

    try {
      await state.scanner.start();
    } catch (err) {
      setStage(state.awaitingAnswer && state.qrChunks.length > 0 ? 'qrDisplay' : 'idle');
      showAlert('Camera Error', err.message, 'error');
    }
  }

  async function handleDecodedQRChunk(rawText) {
    if (!state.collector) return;
    var outcome = await state.collector.addRawScan(rawText);

    if (outcome.status === 'already-complete') {
      return;
    }

    if (outcome.status === 'progress') {
      els.scannerProgress.textContent = 'Part ' + outcome.receivedCount + ' / ' + outcome.total;
      renderScannerChunkDots(outcome.total, outcome.receivedIndices);
      return;
    }

    if (outcome.status === 'complete') {
      stopScannerOnly();
      var payload = outcome.payload;

      if (payload.type === 'O') {
        await processScannedOffer(payload);
      } else if (payload.type === 'A') {
        await processScannedAnswer(payload);
      }
    }
  }

  async function processScannedOffer(offerPayload) {
    state.awaitingAnswer = false;
    state.currentSessionId = offerPayload.sid;
    els.connectSessionId.textContent = offerPayload.sid;
    els.connectIceSummary.textContent = 'Gathering…';
    els.connectStateLabel.textContent = 'Generating answer…';
    setGlobalStatus('connecting', 'Creating Answer…');

    els.loadingTitle.textContent = 'Processing Device A offer…';
    els.loadingSubtitle.textContent = 'Gathering local ICE candidates and generating Answer QR code.';
    setStage('loading');

    try {
      var result = await rtc.acceptOfferAndCreateAnswer(offerPayload, getLocalName());
      els.connectIceSummary.textContent = formatIceStats(result.stats);

      var encoded = await QR.encodeSignalingPayload(result.payload);
      state.qrChunks = encoded.chunks;
      state.qrChunkIndex = 0;

      els.qrDisplayTitle.textContent = 'Answer QR Code (Device B)';
      els.qrDisplaySubtitle.textContent = 'Have Device A scan this Answer QR code to finish pairing.';
      els.btnScanAnswer.classList.add('hidden');
      els.connectStateLabel.textContent = 'Waiting for Device A to scan answer';
      setGlobalStatus('connecting', 'Connecting…');

      renderCurrentQR();
      setStage('qrDisplay');
    } catch (err) {
      rtc.reset();
      setStage('idle');
      setGlobalStatus('error', 'Answer failed');
      els.connectStateLabel.textContent = 'Failed';
      showAlert('Pairing Error', err.message, 'error');
    }
  }

  async function processScannedAnswer(answerPayload) {
    els.loadingTitle.textContent = 'Establishing direct peer link…';
    els.loadingSubtitle.textContent = 'Verifying ICE connectivity over your local Wi-Fi or hotspot.';
    setStage('loading');
    els.connectStateLabel.textContent = 'Connecting…';
    setGlobalStatus('connecting', 'Connecting…');

    try {
      await rtc.acceptAnswerPayload(answerPayload);
    } catch (err) {
      setStage('qrDisplay');
      setGlobalStatus('error', 'Answer error');
      showAlert('Cannot Apply Answer', err.message, 'error');
    }
  }

  function renderCurrentQR() {
    var total = state.qrChunks.length;
    if (total === 0) return;
    var idx = Math.max(0, Math.min(state.qrChunkIndex, total - 1));
    state.qrChunkIndex = idx;

    els.qrChunkCounter.textContent = 'Part ' + (idx + 1) + ' of ' + total;
    QR.renderQRToCanvas(els.qrOutputCanvas, state.qrChunks[idx]);

    if (total > 1) {
      els.qrPagination.classList.remove('hidden');
    } else {
      els.qrPagination.classList.add('hidden');
      stopAutoCycle();
    }
  }

  function showQRChunk(nextIndex) {
    var total = state.qrChunks.length;
    if (total === 0) return;
    state.qrChunkIndex = ((nextIndex % total) + total) % total;
    renderCurrentQR();
  }

  function toggleAutoCycle() {
    if (state.autoCycleTimer !== null) {
      stopAutoCycle();
    } else {
      els.btnQrAutocycle.setAttribute('aria-pressed', 'true');
      els.btnQrAutocycle.textContent = 'Auto-cycle: On';
      state.autoCycleTimer = setInterval(function () {
        showQRChunk(state.qrChunkIndex + 1);
      }, 1100);
    }
  }

  function stopAutoCycle() {
    if (state.autoCycleTimer !== null) {
      clearInterval(state.autoCycleTimer);
      state.autoCycleTimer = null;
    }
    els.btnQrAutocycle.setAttribute('aria-pressed', 'false');
    els.btnQrAutocycle.textContent = 'Auto-cycle: Off';
  }

  function renderScannerChunkDots(total, receivedList) {
    els.scannerChunkDots.classList.remove('hidden');
    els.scannerChunkDots.innerHTML = '';
    var receivedSet = new Set(receivedList);
    for (var i = 1; i <= total; i++) {
      var chip = document.createElement('span');
      chip.className = 'chunk-step' + (receivedSet.has(i) ? ' received' : '');
      chip.textContent = (receivedSet.has(i) ? '✓ ' : '') + i + '/' + total;
      els.scannerChunkDots.appendChild(chip);
    }
  }

  function stopScannerOnly() {
    if (state.scanner) {
      state.scanner.stop();
    }
    state.collector = null;
  }

  function stopQRWorkflows() {
    stopAutoCycle();
    stopScannerOnly();
  }

  function formatIceStats(stats) {
    if (!stats) return 'None';
    var parts = [];
    if (stats.host > 0) parts.push(stats.host + ' host');
    if (stats.mdns > 0) parts.push(stats.mdns + ' mDNS');
    if (stats.other > 0) parts.push(stats.other + ' other');
    return parts.length > 0 ? parts.join(' · ') : '0 candidates';
  }

  // ========================================================================
  // Text Messaging Screen
  // ========================================================================

  function handleSendMessage() {
    var text = els.inputChatMessage.value;
    if (!text.trim()) return;

    try {
      var msg = rtc.sendTextMessage(text);
      if (msg) {
        appendChatMessage(msg, true);
        els.inputChatMessage.value = '';
        els.inputChatMessage.focus();
      }
    } catch (err) {
      showAlert('Send Failed', err.message, 'error');
    }
  }

  function appendChatMessage(msg, isSent) {
    if (els.chatEmptyState) {
      els.chatEmptyState.classList.add('hidden');
    }

    var row = document.createElement('div');
    row.className = 'message-row ' + (isSent ? 'sent' : 'received');

    var meta = document.createElement('div');
    meta.className = 'message-meta';

    var senderSpan = document.createElement('span');
    senderSpan.textContent = isSent ? 'You' : msg.sender;

    var sepSpan = document.createElement('span');
    sepSpan.setAttribute('aria-hidden', 'true');
    sepSpan.textContent = '·';

    var timeSpan = document.createElement('span');
    timeSpan.className = 'mono';
    timeSpan.textContent = formatTime(msg.ts);

    meta.appendChild(senderSpan);
    meta.appendChild(sepSpan);
    meta.appendChild(timeSpan);

    var bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = msg.text; // Safe against XSS

    row.appendChild(meta);
    row.appendChild(bubble);
    els.chatMessages.appendChild(row);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  }

  function appendSystemEvent(text) {
    if (els.chatEmptyState) {
      els.chatEmptyState.classList.add('hidden');
    }
    var div = document.createElement('div');
    div.className = 'system-event';
    div.textContent = text + ' · ' + formatTime(Date.now());
    els.chatMessages.appendChild(div);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  }

  function formatTime(ts) {
    var d = new Date(ts || Date.now());
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  // ========================================================================
  // Voice & Video Calling Screen
  // ========================================================================

  async function startCallFlow(mediaType) {
    clearAlert();
    try {
      await rtc.startCall(mediaType);
    } catch (err) {
      showAlert('Cannot Start Call', err.message, 'error');
    }
  }

  async function handleAcceptCall() {
    clearAlert();
    hideIncomingCallModal();
    try {
      await rtc.acceptIncomingCall();
    } catch (err) {
      showAlert('Cannot Accept Call', err.message, 'error');
    }
  }

  function hideIncomingCallModal() {
    els.incomingCallModal.classList.add('hidden');
  }

  function enterCallScreen(callInfo) {
    var isVideo = callInfo.media === 'video';
    showScreen('call');

    // Local preview
    if (isVideo && callInfo.localStream) {
      els.localVideo.srcObject = callInfo.localStream;
      els.localVideo.classList.add('mirrored');
      els.localVideoWrap.classList.remove('hidden');
      els.localVideo.play().catch(function () {});
    } else {
      els.localVideo.srcObject = null;
      els.localVideoWrap.classList.add('hidden');
    }

    // Remote media
    attachRemoteStream(callInfo.remoteStream);

    // Controls visibility
    els.btnToggleCam.classList.toggle('hidden', !isVideo);
    els.btnSwitchCallCam.classList.toggle('hidden', !isVideo);
    updateMicUi(false);
    updateCamUi(false);

    if (callInfo.state === 'outgoing') {
      els.callStatusText.textContent = isVideo ? 'Video calling…' : 'Voice calling…';
      els.callHudState.textContent = 'Calling…';
      els.callDuration.textContent = '00:00';
      els.callHudTimer.textContent = '00:00';
      endCallTimer();
    } else if (callInfo.state === 'active') {
      els.callStatusText.textContent = isVideo ? 'Video call active' : 'Voice call active';
      els.callHudState.textContent = 'Connected';
      startCallTimer();
    }
  }

  function attachRemoteStream(stream) {
    if (!stream) return;
    if (els.remoteVideo.srcObject !== stream) {
      els.remoteVideo.srcObject = stream;
    }
    els.remoteVideo.play().catch(function () {});

    var hasLiveVideo = stream.getVideoTracks().some(function (t) {
      return t.readyState === 'live' && t.enabled;
    });
    els.callAudioPlaceholder.classList.toggle('hidden', hasLiveVideo);
  }

  function handleToggleMic() {
    var muted = rtc.toggleMute();
    updateMicUi(muted);
  }

  function updateMicUi(muted) {
    els.btnToggleMic.setAttribute('aria-pressed', muted ? 'true' : 'false');
    els.iconMicOn.classList.toggle('hidden', muted);
    els.iconMicOff.classList.toggle('hidden', !muted);
    els.labelMic.textContent = muted ? 'Unmute' : 'Mute';
  }

  function handleToggleCam() {
    var off = rtc.toggleCamera();
    updateCamUi(off);
    els.localVideoWrap.classList.toggle('hidden', off);
  }

  function updateCamUi(off) {
    els.btnToggleCam.setAttribute('aria-pressed', off ? 'true' : 'false');
    els.iconCamOn.classList.toggle('hidden', off);
    els.iconCamOff.classList.toggle('hidden', !off);
    els.labelCam.textContent = off ? 'Cam Off' : 'Camera';
  }

  async function handleSwitchCallCamera() {
    try {
      var res = await rtc.switchCamera();
      els.localVideo.srcObject = res.localStream;
      els.localVideo.classList.toggle('mirrored', res.facingMode === 'user');
      els.localVideo.play().catch(function () {});
    } catch (err) {
      showAlert('Camera Switch', err.message, 'warning');
    }
  }

  function startCallTimer() {
    if (state.callTimerId !== null) return;
    state.callStartTs = Date.now();
    var update = function () {
      var sec = Math.floor((Date.now() - state.callStartTs) / 1000);
      var mm = String(Math.floor(sec / 60)).padStart(2, '0');
      var ss = String(sec % 60).padStart(2, '0');
      var formatted = mm + ':' + ss;
      els.callDuration.textContent = formatted;
      els.callHudTimer.textContent = formatted;
    };
    update();
    state.callTimerId = setInterval(update, 1000);
  }

  function endCallTimer() {
    if (state.callTimerId !== null) {
      clearInterval(state.callTimerId);
      state.callTimerId = null;
    }
  }

  function clearMediaElements() {
    els.remoteVideo.srcObject = null;
    els.localVideo.srcObject = null;
    els.localVideoWrap.classList.add('hidden');
    els.callAudioPlaceholder.classList.remove('hidden');
  }

  // ========================================================================
  // Reset Connection
  // ========================================================================

  function resetAll() {
    stopQRWorkflows();
    endCallTimer();
    hideIncomingCallModal();
    clearMediaElements();
    clearAlert();
    rtc.reset();

    state.awaitingAnswer = false;
    state.currentSessionId = null;
    state.qrChunks = [];
    state.qrChunkIndex = 0;

    els.connectSessionId.textContent = '—';
    els.connectIceSummary.textContent = 'None gathered';
    els.connectStateLabel.textContent = 'Ready to pair';
    els.btnScanAnswer.classList.add('hidden');

    // Clear volatile session messages from DOM
    Array.from(els.chatMessages.children).forEach(function (child) {
      if (child !== els.chatEmptyState) {
        els.chatMessages.removeChild(child);
      }
    });
    if (els.chatEmptyState) {
      els.chatEmptyState.classList.remove('hidden');
    }
    els.inputChatMessage.value = '';

    setGlobalStatus('idle', 'Disconnected');
    setStage('idle');
    showScreen('connect');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
