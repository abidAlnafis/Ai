/* ==========================================================================
   Local Connect — Serverless WebRTC PeerConnection, DataChannel & Media Calls
   - Zero STUN/TURN servers (strictly local host/mDNS candidates)
   - Complete ICE candidate collection for QR pairing
   - In-band RTCDataChannel signaling for calls + Perfect Negotiation glare handling
   ========================================================================== */

(function (global) {
  'use strict';

  var ICE_GATHER_TIMEOUT_MS = 6500;
  var CONNECT_TIMEOUT_MS = 25000;
  var HEARTBEAT_INTERVAL_MS = 4000;
  var HEARTBEAT_TIMEOUT_MS = 13000;
  var MAX_CHAT_TEXT_BYTES = 8192;

  function LocalConnectRTC(callbacks) {
    this.cb = callbacks || {};
    this.pc = null;
    this.dc = null;
    this.sessionId = null;
    this.localName = 'Device';
    this.remoteName = 'Connected Peer';

    // Perfect negotiation state (Offerer = false, Answerer = true)
    this.isPolite = false;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;

    // Connection tracking
    this.connectedNotified = false;
    this.connectTimer = null;
    this.heartbeatTimer = null;
    this.lastPongTs = 0;
    this.localIceStats = null;
    this.remoteIceStats = null;

    // Active call state: 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active'
    this.callState = 'idle';
    this.activeCallId = null;
    this.activeCallMedia = null; // 'audio' | 'video'
    this.pendingIncomingCall = null;
    this.localStream = null;
    this.remoteStream = new MediaStream();
    this.audioSender = null;
    this.videoSender = null;
    this.facingMode = 'user';
    this.isMicMuted = false;
    this.isCamOff = false;
  }

  LocalConnectRTC.prototype.checkCompatibility = function () {
    if (typeof global.RTCPeerConnection !== 'function') {
      throw new Error('WebRTC (RTCPeerConnection) is not supported by this browser.');
    }
    if (typeof global.RTCDataChannel !== 'function' && !('createDataChannel' in global.RTCPeerConnection.prototype)) {
      throw new Error('WebRTC DataChannels are not supported by this browser.');
    }
  };

  LocalConnectRTC.prototype.createPeerConnection = function () {
    this.checkCompatibility();

    // STRICT REQUIREMENT: No external STUN or TURN servers.
    var config = {
      iceServers: [],
      iceCandidatePoolSize: 0
    };

    var pc = new RTCPeerConnection(config);
    this.pc = pc;
    this.connectedNotified = false;
    var self = this;

    pc.oniceconnectionstatechange = function () {
      var iceState = pc.iceConnectionState;
      self._emitState('ICE: ' + iceState);
      if (iceState === 'checking' && !self.connectedNotified && !self.connectTimer) {
        self._startConnectTimeout();
      } else if (iceState === 'connected' || iceState === 'completed') {
        self._checkFullyConnected();
      } else if (iceState === 'failed') {
        self._handleConnectionFailure(self._buildFailureDiagnostics('ICE connectivity check failed.'));
      } else if (iceState === 'disconnected') {
        self._emitState('Connection interrupted…');
      }
    };

    pc.onconnectionstatechange = function () {
      var st = pc.connectionState;
      self._emitState('Peer: ' + st);
      if (st === 'connecting' && !self.connectedNotified && !self.connectTimer) {
        self._startConnectTimeout();
      } else if (st === 'connected') {
        self._checkFullyConnected();
      } else if (st === 'failed') {
        self._handleConnectionFailure(self._buildFailureDiagnostics('WebRTC connection failed.'));
      } else if (st === 'closed') {
        self._handleDisconnected('Connection closed.');
      }
    };

    pc.onicecandidate = function (event) {
      // Once initial QR pairing is connected, trickle any renegotiation candidates over the DataChannel
      if (self.connectedNotified && self.dc && self.dc.readyState === 'open' && event.candidate) {
        self._sendEnvelope({
          kind: 'rtc-ice',
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate
        });
      }
    };

    // Perfect negotiation: renegotiate over open DataChannel when tracks are added/removed
    pc.onnegotiationneeded = async function () {
      if (!self.connectedNotified || !self.dc || self.dc.readyState !== 'open') {
        return;
      }
      try {
        self.makingOffer = true;
        await pc.setLocalDescription();
        self._sendEnvelope({
          kind: 'rtc-signal',
          description: {
            type: pc.localDescription.type,
            sdp: pc.localDescription.sdp
          }
        });
      } catch (err) {
        self._emitError('Media negotiation error: ' + (err && err.message ? err.message : String(err)));
      } finally {
        self.makingOffer = false;
      }
    };

    pc.ontrack = function (event) {
      var track = event.track;
      var existing = self.remoteStream.getTracks().some(function (t) { return t.id === track.id; });
      if (!existing) {
        self.remoteStream.addTrack(track);
      }
      track.onended = function () {
        self.remoteStream.removeTrack(track);
        if (self.cb.onRemoteStreamUpdated) self.cb.onRemoteStreamUpdated(self.remoteStream);
      };
      if (self.cb.onRemoteStreamUpdated) {
        self.cb.onRemoteStreamUpdated(self.remoteStream);
      }
    };

    return pc;
  };

  LocalConnectRTC.prototype._attachDataChannel = function (channel) {
    this.dc = channel;
    var self = this;

    channel.onopen = function () {
      self.lastPongTs = Date.now();
      self._sendEnvelope({ kind: 'peer-info', name: self.localName, sid: self.sessionId });
      self._startHeartbeat();
      self._checkFullyConnected();
    };

    channel.onclose = function () {
      self._handleDisconnected('Peer disconnected (DataChannel closed).');
    };

    channel.onerror = function (event) {
      var msg = event && event.error && event.error.message ? event.error.message : 'DataChannel transport error.';
      self._emitError('Data channel failure: ' + msg);
    };

    channel.onmessage = function (event) {
      self._handleIncomingData(event.data);
    };
  };

  LocalConnectRTC.prototype._checkFullyConnected = function () {
    if (this.connectedNotified || !this.pc) return;
    var transportReady =
      this.pc.connectionState === 'connected' ||
      (this.pc.connectionState === undefined &&
        (this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed'));

    if (transportReady && this.dc && this.dc.readyState === 'open') {
      this.connectedNotified = true;
      this._clearConnectTimeout();
      if (this.cb.onConnected) {
        this.cb.onConnected({
          sessionId: this.sessionId,
          remoteName: this.remoteName
        });
      }
    }
  };

  // Browsers obfuscate local LAN IPs into mDNS ".local" candidates until getUserMedia
  // permission has been granted on this origin. Probing camera/mic on Device A reveals
  // real local IPv4 host candidates (e.g. 192.168.x.x), avoiding cross-device mDNS failures.
  LocalConnectRTC.prototype._unlockLocalIpDiscovery = async function () {
    if (!global.isSecureContext || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return;
    }
    var attempts = [{ video: true, audio: false }, { audio: true, video: false }];
    for (var i = 0; i < attempts.length; i++) {
      try {
        var stream = await navigator.mediaDevices.getUserMedia(attempts[i]);
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      } catch (_err) {
        // Continue to next fallback or proceed with mDNS if denied/unavailable
      }
    }
  };

  LocalConnectRTC.prototype._analyzeSdpAndCandidates = function (sdp, extraCandidates) {
    var stats = { host: 0, hostIpv4: 0, hostIpv6: 0, mdns: 0, other: 0, total: 0, ipv4List: [] };
    var seen = new Set();

    function inspectLine(candLine) {
      if (!candLine) return;
      var normalized = candLine.replace(/^a=/, '').trim();
      if (normalized.indexOf('candidate:') !== 0 || seen.has(normalized)) return;
      seen.add(normalized);

      var parts = normalized.split(/\s+/);
      var ip = parts[4] || '';
      var typeIdx = parts.indexOf('typ');
      var candType = typeIdx !== -1 ? parts[typeIdx + 1] : '';

      stats.total++;
      if (candType === 'host') {
        if (ip.indexOf('.local') !== -1) {
          stats.mdns++;
        } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
          stats.host++;
          stats.hostIpv4++;
          if (stats.ipv4List.indexOf(ip) === -1) stats.ipv4List.push(ip);
        } else {
          stats.host++;
          stats.hostIpv6++;
        }
      } else {
        stats.other++;
      }
    }

    if (typeof sdp === 'string') {
      sdp.split(/\r?\n/).forEach(function (line) {
        if (line.indexOf('a=candidate:') === 0) inspectLine(line);
      });
    }
    if (Array.isArray(extraCandidates)) {
      extraCandidates.forEach(function (c) {
        if (c && c.candidate) inspectLine(c.candidate);
      });
    }
    return stats;
  };

  LocalConnectRTC.prototype._buildFailureDiagnostics = function (prefix) {
    var local = this.localIceStats;
    var remote = this.remoteIceStats;

    if (local && remote) {
      if ((local.hostIpv4 === 0 && local.mdns > 0) || (remote.hostIpv4 === 0 && remote.mdns > 0)) {
        return prefix + ' Browser hid direct LAN IPv4 addresses behind mDNS (.local), which failed to resolve across devices. Grant camera permission on both devices and retry, or check if mDNS (UDP 5353) is blocked.';
      }
      if (local.ipv4List.length > 0 && remote.ipv4List.length > 0) {
        var shareSubnet = local.ipv4List.some(function (a) {
          var prefixA = a.split('.').slice(0, 3).join('.');
          return remote.ipv4List.some(function (b) {
            return b.split('.').slice(0, 3).join('.') === prefixA;
          });
        });
        if (!shareSubnet) {
          return prefix + ' Devices reported non-matching local subnets (' + local.ipv4List[0] + ' vs ' + remote.ipv4List[0] + '). Ensure both are on the same Wi-Fi/hotspot and disable VPNs.';
        }
        return prefix + ' Both devices exchanged local LAN IPs (' + local.ipv4List[0] + ' ↔ ' + remote.ipv4List[0] + '), so UDP traffic was blocked by a firewall (e.g. Windows Public Network Firewall) or Wi-Fi router AP/client isolation.';
      }
    }

    return prefix + ' Devices must share the same local Wi-Fi or hotspot without AP/client isolation or blocking firewalls.';
  };

  // Attach ICE listeners BEFORE calling setLocalDescription so no early candidates are missed
  LocalConnectRTC.prototype._prepareIceGathering = function (pc) {
    var collected = [];
    var seen = new Set();
    var finished = false;
    var resolveFn = null;
    var prevOnIce = pc.onicecandidate;
    var timeoutId = null;

    var promise = new Promise(function (resolve) {
      resolveFn = resolve;
    });

    function recordCandidate(cand) {
      if (!cand || !cand.candidate) return;
      if (seen.has(cand.candidate)) return;
      seen.add(cand.candidate);
      collected.push({
        candidate: cand.candidate,
        sdpMid: cand.sdpMid || null,
        sdpMLineIndex: typeof cand.sdpMLineIndex === 'number' ? cand.sdpMLineIndex : null
      });
    }

    function finish() {
      if (finished) return;
      finished = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      pc.removeEventListener('icegatheringstatechange', onStateChange);
      pc.onicecandidate = prevOnIce;
      resolveFn(collected);
    }

    function onStateChange() {
      if (pc.iceGatheringState === 'complete') {
        finish();
      }
    }

    pc.addEventListener('icegatheringstatechange', onStateChange);
    pc.onicecandidate = function (ev) {
      if (ev.candidate) {
        recordCandidate(ev.candidate);
      } else {
        finish();
      }
    };

    return {
      wait: function () {
        if (pc.iceGatheringState === 'complete') {
          finish();
        } else {
          timeoutId = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
        }
        return promise;
      }
    };
  };

  // STEP 1 & 2 (Device A): Create Offer + Complete ICE Gathering
  LocalConnectRTC.prototype.createOfferPayload = async function (localName, sessionId) {
    this.reset();
    this.localName = localName || 'Device-A';
    this.sessionId = sessionId;
    this.isPolite = false;

    await this._unlockLocalIpDiscovery();

    var pc = this.createPeerConnection();
    var dc = pc.createDataChannel('local-connect', { ordered: true });
    this._attachDataChannel(dc);

    var gatherer = this._prepareIceGathering(pc);
    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    var collected = await gatherer.wait();
    var localSdp = pc.localDescription.sdp;
    var extraIce = collected.filter(function (c) {
      return localSdp.indexOf(c.candidate) === -1;
    });

    var stats = this._analyzeSdpAndCandidates(localSdp, extraIce);
    this.localIceStats = stats;

    if (stats.total === 0) {
      throw new Error(
        'ICE gathering produced 0 local candidates. Verify Wi-Fi or hotspot is connected and browser local-network access is permitted.'
      );
    }

    return {
      payload: {
        v: 1,
        sid: this.sessionId,
        type: 'O',
        peer: this.localName,
        sdp: localSdp,
        ice: extraIce
      },
      stats: stats
    };
  };

  // STEP 3 (Device B): Accept Offer + Gather Answer ICE
  LocalConnectRTC.prototype.acceptOfferAndCreateAnswer = async function (offerPayload, localName) {
    this.reset();
    this.localName = localName || 'Device-B';
    this.sessionId = offerPayload.sid;
    this.remoteName = offerPayload.peer || 'Device-A';
    this.isPolite = true;
    this.remoteIceStats = this._analyzeSdpAndCandidates(offerPayload.sdp, offerPayload.ice);

    var self = this;
    var pc = this.createPeerConnection();
    pc.ondatachannel = function (ev) {
      if (ev.channel) {
        self._attachDataChannel(ev.channel);
      }
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: offerPayload.sdp });
    for (var i = 0; i < offerPayload.ice.length; i++) {
      try {
        await pc.addIceCandidate(offerPayload.ice[i]);
      } catch (_candErr) {
        // Ignore unsupported candidate family
      }
    }
    try { await pc.addIceCandidate(null); } catch (_endErr) {}

    var gatherer = this._prepareIceGathering(pc);
    var answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    var collected = await gatherer.wait();
    var localSdp = pc.localDescription.sdp;
    var extraIce = collected.filter(function (c) {
      return localSdp.indexOf(c.candidate) === -1;
    });

    var stats = this._analyzeSdpAndCandidates(localSdp, extraIce);
    this.localIceStats = stats;

    if (stats.total === 0) {
      throw new Error(
        'ICE gathering produced 0 local candidates on this device. Verify Wi-Fi or hotspot is active.'
      );
    }

    // Do NOT start connect timeout yet on Device B: wait until Device A scans Answer QR
    // and ICE/DTLS checks actually begin (handled in statechange listeners).
    return {
      payload: {
        v: 1,
        sid: this.sessionId,
        type: 'A',
        peer: this.localName,
        sdp: localSdp,
        ice: extraIce
      },
      stats: stats
    };
  };

  // STEP 4 (Device A): Apply Scanned Answer + Wait for Actual WebRTC Connection
  LocalConnectRTC.prototype.acceptAnswerPayload = async function (answerPayload) {
    if (!this.pc || this.pc.signalingState !== 'have-local-offer') {
      throw new Error('No pending connection offer exists. Create a connection first.');
    }
    if (answerPayload.sid !== this.sessionId) {
      throw new Error('Duplicate or mismatched pairing session ID.');
    }

    this.remoteName = answerPayload.peer || 'Device-B';
    this.remoteIceStats = this._analyzeSdpAndCandidates(answerPayload.sdp, answerPayload.ice);

    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerPayload.sdp });

    for (var i = 0; i < answerPayload.ice.length; i++) {
      try {
        await this.pc.addIceCandidate(answerPayload.ice[i]);
      } catch (_candErr) {
        // Non-fatal candidate skip
      }
    }
    try { await this.pc.addIceCandidate(null); } catch (_endErr) {}

    this._startConnectTimeout();
    this._checkFullyConnected();
  };

  LocalConnectRTC.prototype._startConnectTimeout = function () {
    this._clearConnectTimeout();
    var self = this;
    this.connectTimer = setTimeout(function () {
      if (!self.connectedNotified) {
        self._handleConnectionFailure(
          self._buildFailureDiagnostics('WebRTC connection timed out.')
        );
      }
    }, CONNECT_TIMEOUT_MS);
  };

  LocalConnectRTC.prototype._clearConnectTimeout = function () {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  };

  LocalConnectRTC.prototype._startHeartbeat = function () {
    this._stopHeartbeat();
    var self = this;
    this.heartbeatTimer = setInterval(function () {
      if (!self.dc || self.dc.readyState !== 'open') return;
      if (Date.now() - self.lastPongTs > HEARTBEAT_TIMEOUT_MS) {
        self._handleDisconnected('Peer timed out (no response on local network).');
        return;
      }
      self._sendEnvelope({ kind: 'ping', ts: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  };

  LocalConnectRTC.prototype._stopHeartbeat = function () {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  };

  LocalConnectRTC.prototype._sendEnvelope = function (obj) {
    if (!this.dc || this.dc.readyState !== 'open') {
      return false;
    }
    try {
      this.dc.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      this._emitError('Failed to send data over DataChannel: ' + (err && err.message ? err.message : String(err)));
      return false;
    }
  };

  // ========================================================================
  // Text Messaging
  // ========================================================================

  LocalConnectRTC.prototype.sendTextMessage = function (text) {
    if (!this.connectedNotified || !this.dc || this.dc.readyState !== 'open') {
      throw new Error('Cannot send message: peer connection is not open.');
    }
    var trimmed = String(text || '').trim();
    if (!trimmed) return null;
    if (new TextEncoder().encode(trimmed).length > MAX_CHAT_TEXT_BYTES) {
      throw new Error('Message exceeds maximum length (8 KB).');
    }

    var msg = {
      kind: 'chat',
      id: global.LocalConnectQR.generateSecureId(6),
      sender: this.localName,
      text: trimmed,
      ts: Date.now()
    };

    var ok = this._sendEnvelope(msg);
    if (!ok) {
      throw new Error('Failed to transmit message over DataChannel.');
    }
    return msg;
  };

  // ========================================================================
  // In-Band Signaling & Perfect Negotiation
  // ========================================================================

  LocalConnectRTC.prototype._handleIncomingData = async function (raw) {
    if (typeof raw !== 'string' || raw.length > 65536) return;
    var msg;
    try {
      msg = JSON.parse(raw);
    } catch (_e) {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') return;

    this.lastPongTs = Date.now();

    switch (msg.kind) {
      case 'ping':
        this._sendEnvelope({ kind: 'pong', ts: msg.ts });
        break;

      case 'pong':
        break;

      case 'peer-info':
        if (typeof msg.name === 'string' && msg.name.trim()) {
          this.remoteName = msg.name.trim().slice(0, 32);
          if (this.cb.onPeerInfo) this.cb.onPeerInfo(this.remoteName);
        }
        break;

      case 'chat':
        if (typeof msg.text === 'string' && msg.text.length > 0 && msg.text.length <= 4500) {
          if (this.cb.onChatMessage) {
            this.cb.onChatMessage({
              id: typeof msg.id === 'string' ? msg.id : '',
              sender: typeof msg.sender === 'string' ? msg.sender.slice(0, 32) : this.remoteName,
              text: msg.text,
              ts: typeof msg.ts === 'number' ? msg.ts : Date.now()
            });
          }
        }
        break;

      case 'rtc-signal':
        await this._handleRtcSignal(msg.description);
        break;

      case 'rtc-ice':
        await this._handleRtcIce(msg.candidate);
        break;

      case 'call-invite':
        this._handleCallInvite(msg);
        break;

      case 'call-accept':
        this._handleCallAccept(msg);
        break;

      case 'call-reject':
        this._handleCallReject(msg);
        break;

      case 'call-end':
        this._handleCallEnd(msg);
        break;
    }
  };

  LocalConnectRTC.prototype._handleRtcSignal = async function (description) {
    if (!this.pc || !description || typeof description.type !== 'string') return;
    try {
      var readyForOffer =
        !this.makingOffer &&
        (this.pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
      var offerCollision = description.type === 'offer' && !readyForOffer;

      this.ignoreOffer = !this.isPolite && offerCollision;
      if (this.ignoreOffer) {
        return;
      }

      this.isSettingRemoteAnswerPending = description.type === 'answer';
      await this.pc.setRemoteDescription(description);
      this.isSettingRemoteAnswerPending = false;

      if (description.type === 'offer') {
        await this.pc.setLocalDescription();
        this._sendEnvelope({
          kind: 'rtc-signal',
          description: {
            type: this.pc.localDescription.type,
            sdp: this.pc.localDescription.sdp
          }
        });
      }
    } catch (err) {
      this.isSettingRemoteAnswerPending = false;
      this._emitError('Call renegotiation failed: ' + (err && err.message ? err.message : String(err)));
    }
  };

  LocalConnectRTC.prototype._handleRtcIce = async function (candidate) {
    if (!this.pc || !candidate) return;
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      if (!this.ignoreOffer) {
        // Ignore benign out-of-order candidate errors during rollback
      }
    }
  };

  // ========================================================================
  // Voice & Video Calls
  // ========================================================================

  LocalConnectRTC.prototype._acquireMedia = async function (mediaType) {
    if (!global.isSecureContext) {
      throw new Error('Microphone and camera access require HTTPS or localhost.');
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('MediaDevices API is not supported in this browser.');
    }

    var wantVideo = mediaType === 'video';
    var constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: wantVideo
        ? { facingMode: this.facingMode, width: { ideal: 1280 }, height: { ideal: 720 } }
        : false
    };

    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      var name = err && err.name ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        throw new Error(
          wantVideo
            ? 'Camera or microphone permission was denied.'
            : 'Microphone permission was denied.'
        );
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        throw new Error(
          wantVideo
            ? 'No camera or microphone found on this device.'
            : 'No microphone found on this device.'
        );
      }
      if (name === 'NotReadableError' || name === 'TrackStartError') {
        throw new Error('Microphone or camera is busy in another application.');
      }
      throw new Error(err && err.message ? err.message : 'Unable to capture media.');
    }
  };

  LocalConnectRTC.prototype._attachLocalStream = function (stream) {
    this._stopLocalMediaTracks();
    this.localStream = stream;
    this.isMicMuted = false;
    this.isCamOff = false;

    var audioTracks = stream.getAudioTracks();
    var videoTracks = stream.getVideoTracks();

    if (audioTracks.length > 0) {
      this.audioSender = this.pc.addTrack(audioTracks[0], stream);
    }
    if (videoTracks.length > 0) {
      this.videoSender = this.pc.addTrack(videoTracks[0], stream);
    }
  };

  LocalConnectRTC.prototype._stopLocalMediaTracks = function () {
    if (this.pc) {
      if (this.audioSender) {
        try { this.pc.removeTrack(this.audioSender); } catch (_e) {}
        this.audioSender = null;
      }
      if (this.videoSender) {
        try { this.pc.removeTrack(this.videoSender); } catch (_e) {}
        this.videoSender = null;
      }
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(function (t) { t.stop(); });
      this.localStream = null;
    }
    this.remoteStream.getTracks().forEach(function (t) {
      this.remoteStream.removeTrack(t);
    }.bind(this));
  };

  LocalConnectRTC.prototype.startCall = async function (mediaType) {
    if (!this.connectedNotified || !this.dc || this.dc.readyState !== 'open') {
      throw new Error('Cannot start call: peer is not connected.');
    }
    if (this.callState !== 'idle') {
      throw new Error('A call is already in progress. End the current call before starting another.');
    }

    this.facingMode = 'user';
    var stream = await this._acquireMedia(mediaType);
    this.callState = 'outgoing';
    this.activeCallMedia = mediaType;
    this.activeCallId = global.LocalConnectQR.generateSecureId(6);
    this._attachLocalStream(stream);

    this._sendEnvelope({
      kind: 'call-invite',
      callId: this.activeCallId,
      media: mediaType
    });

    if (this.cb.onCallStateChanged) {
      this.cb.onCallStateChanged({
        state: 'outgoing',
        media: mediaType,
        localStream: this.localStream,
        remoteStream: this.remoteStream
      });
    }
  };

  LocalConnectRTC.prototype._handleCallInvite = function (msg) {
    var media = msg.media === 'video' ? 'video' : 'audio';
    var callId = typeof msg.callId === 'string' ? msg.callId : '';
    if (!callId) return;

    // Already in an active or connecting call -> reject busy
    if (this.callState === 'active' || this.callState === 'connecting' || this.callState === 'incoming') {
      this._sendEnvelope({ kind: 'call-reject', callId: callId, reason: 'busy' });
      return;
    }

    // Glare: both peers started calling simultaneously
    if (this.callState === 'outgoing') {
      if (this.isPolite) {
        // Polite peer yields its outgoing call and switches to incoming invite
        this._stopLocalMediaTracks();
        this.callState = 'idle';
        this.activeCallId = null;
      } else {
        // Impolite peer keeps its outgoing call and notifies remote busy
        this._sendEnvelope({ kind: 'call-reject', callId: callId, reason: 'glare' });
        return;
      }
    }

    this.callState = 'incoming';
    this.pendingIncomingCall = { callId: callId, media: media };
    if (this.cb.onIncomingCall) {
      this.cb.onIncomingCall({ callId: callId, media: media, remoteName: this.remoteName });
    }
  };

  LocalConnectRTC.prototype.acceptIncomingCall = async function () {
    if (this.callState !== 'incoming' || !this.pendingIncomingCall) {
      throw new Error('No incoming call to accept.');
    }
    var invite = this.pendingIncomingCall;
    this.pendingIncomingCall = null;
    this.facingMode = 'user';

    var stream;
    try {
      stream = await this._acquireMedia(invite.media);
    } catch (err) {
      this.callState = 'idle';
      this._sendEnvelope({ kind: 'call-reject', callId: invite.callId, reason: 'permission-denied' });
      throw err;
    }

    this.callState = 'active';
    this.activeCallId = invite.callId;
    this.activeCallMedia = invite.media;
    this._attachLocalStream(stream);

    this._sendEnvelope({
      kind: 'call-accept',
      callId: invite.callId,
      media: invite.media
    });

    if (this.cb.onCallStateChanged) {
      this.cb.onCallStateChanged({
        state: 'active',
        media: invite.media,
        localStream: this.localStream,
        remoteStream: this.remoteStream
      });
    }
  };

  LocalConnectRTC.prototype.rejectIncomingCall = function (reason) {
    if (this.callState !== 'incoming' || !this.pendingIncomingCall) return;
    var invite = this.pendingIncomingCall;
    this.pendingIncomingCall = null;
    this.callState = 'idle';
    this._sendEnvelope({
      kind: 'call-reject',
      callId: invite.callId,
      reason: reason || 'declined'
    });
  };

  LocalConnectRTC.prototype._handleCallAccept = function (msg) {
    if (this.callState !== 'outgoing' || msg.callId !== this.activeCallId) return;
    this.callState = 'active';
    if (this.cb.onCallStateChanged) {
      this.cb.onCallStateChanged({
        state: 'active',
        media: this.activeCallMedia,
        localStream: this.localStream,
        remoteStream: this.remoteStream
      });
    }
  };

  LocalConnectRTC.prototype._handleCallReject = function (msg) {
    if (this.callState !== 'outgoing' || msg.callId !== this.activeCallId) return;
    this._stopLocalMediaTracks();
    this.callState = 'idle';
    this.activeCallId = null;
    this.activeCallMedia = null;

    var reasonText = 'Call declined by ' + this.remoteName + '.';
    if (msg.reason === 'busy') reasonText = this.remoteName + ' is already in another call.';
    if (msg.reason === 'permission-denied') reasonText = this.remoteName + ' could not access microphone/camera.';

    if (this.cb.onCallEnded) {
      this.cb.onCallEnded(reasonText);
    }
  };

  LocalConnectRTC.prototype._handleCallEnd = function (msg) {
    if (this.callState === 'idle') return;
    if (this.callState === 'incoming' && this.pendingIncomingCall && msg.callId === this.pendingIncomingCall.callId) {
      this.pendingIncomingCall = null;
      this.callState = 'idle';
      if (this.cb.onCallEnded) this.cb.onCallEnded('Missed call from ' + this.remoteName + '.');
      return;
    }
    if (msg.callId && this.activeCallId && msg.callId !== this.activeCallId) return;

    this._stopLocalMediaTracks();
    this.callState = 'idle';
    this.activeCallId = null;
    this.activeCallMedia = null;
    if (this.cb.onCallEnded) {
      this.cb.onCallEnded('Call ended by ' + this.remoteName + '.');
    }
  };

  LocalConnectRTC.prototype.endCall = function () {
    if (this.callState === 'idle') return;
    var cid = this.activeCallId || (this.pendingIncomingCall && this.pendingIncomingCall.callId);
    if (cid) {
      this._sendEnvelope({ kind: 'call-end', callId: cid });
    }
    this._stopLocalMediaTracks();
    this.callState = 'idle';
    this.activeCallId = null;
    this.activeCallMedia = null;
    this.pendingIncomingCall = null;
    if (this.cb.onCallEnded) {
      this.cb.onCallEnded('Call ended.');
    }
  };

  LocalConnectRTC.prototype.toggleMute = function () {
    if (!this.localStream) return false;
    this.isMicMuted = !this.isMicMuted;
    var muted = this.isMicMuted;
    this.localStream.getAudioTracks().forEach(function (track) {
      track.enabled = !muted;
    });
    return this.isMicMuted;
  };

  LocalConnectRTC.prototype.toggleCamera = function () {
    if (!this.localStream) return false;
    this.isCamOff = !this.isCamOff;
    var off = this.isCamOff;
    this.localStream.getVideoTracks().forEach(function (track) {
      track.enabled = !off;
    });
    return this.isCamOff;
  };

  LocalConnectRTC.prototype.switchCamera = async function () {
    if (!this.localStream || !this.videoSender) {
      throw new Error('No active video track to switch.');
    }
    var nextFacing = this.facingMode === 'user' ? 'environment' : 'user';
    var newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { exact: nextFacing }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
    } catch (_exactErr) {
      // Fallback for desktop webcams or single-camera devices
      var devices = await navigator.mediaDevices.enumerateDevices();
      var cams = devices.filter(function (d) { return d.kind === 'videoinput'; });
      if (cams.length < 2) {
        throw new Error('Only one camera is available on this device.');
      }
      var currentTrack = this.localStream.getVideoTracks()[0];
      var currentId = currentTrack && currentTrack.getSettings ? currentTrack.getSettings().deviceId : '';
      var currentIdx = cams.findIndex(function (d) { return d.deviceId === currentId; });
      var nextCam = cams[(currentIdx + 1) % cams.length];
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: nextCam.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
    }

    var newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) throw new Error('Failed to capture switched camera track.');
    newTrack.enabled = !this.isCamOff;

    await this.videoSender.replaceTrack(newTrack);

    var oldTracks = this.localStream.getVideoTracks();
    oldTracks.forEach(function (t) {
      this.localStream.removeTrack(t);
      t.stop();
    }.bind(this));
    this.localStream.addTrack(newTrack);
    this.facingMode = nextFacing;

    return {
      facingMode: this.facingMode,
      localStream: this.localStream
    };
  };

  // ========================================================================
  // Lifecycle / Cleanup
  // ========================================================================

  LocalConnectRTC.prototype._emitState = function (label) {
    if (this.cb.onStateUpdate) this.cb.onStateUpdate(label);
  };

  LocalConnectRTC.prototype._emitError = function (message) {
    if (this.cb.onError) this.cb.onError(message);
  };

  LocalConnectRTC.prototype._handleConnectionFailure = function (message) {
    this._clearConnectTimeout();
    this._stopHeartbeat();
    var wasConnected = this.connectedNotified;
    this.reset();
    if (this.cb.onFailed) {
      this.cb.onFailed(message, wasConnected);
    }
  };

  LocalConnectRTC.prototype._handleDisconnected = function (reason) {
    this._clearConnectTimeout();
    this._stopHeartbeat();
    var wasConnected = this.connectedNotified;
    this.reset();
    if (wasConnected && this.cb.onDisconnected) {
      this.cb.onDisconnected(reason);
    }
  };

  LocalConnectRTC.prototype.reset = function () {
    this._clearConnectTimeout();
    this._stopHeartbeat();
    this._stopLocalMediaTracks();

    if (this.dc) {
      try {
        this.dc.onopen = null;
        this.dc.onclose = null;
        this.dc.onerror = null;
        this.dc.onmessage = null;
        this.dc.close();
      } catch (_e) {}
      this.dc = null;
    }

    if (this.pc) {
      try {
        this.pc.onicecandidate = null;
        this.pc.oniceconnectionstatechange = null;
        this.pc.onconnectionstatechange = null;
        this.pc.onnegotiationneeded = null;
        this.pc.ondatachannel = null;
        this.pc.ontrack = null;
        this.pc.close();
      } catch (_e) {}
      this.pc = null;
    }

    this.connectedNotified = false;
    this.localIceStats = null;
    this.remoteIceStats = null;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;
    this.callState = 'idle';
    this.activeCallId = null;
    this.activeCallMedia = null;
    this.pendingIncomingCall = null;
    this.isMicMuted = false;
    this.isCamOff = false;
  };

  global.LocalConnectRTC = LocalConnectRTC;
})(window);
