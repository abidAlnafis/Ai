/* ==========================================================================
   Local Connect — QR Payload Encoding, Segmentation, Validation & Scanning
   Depends strictly on locally bundled libs/qrcode-generator.js & libs/qr-scanner.js
   ========================================================================== */

(function (global) {
  'use strict';

  var PROTOCOL_PREFIX = 'LC1';
  var MAX_PAYLOAD_BYTES = 32768;
  var MAX_CHUNKS = 64;
  var CHUNK_DATA_LENGTH = 560;

  // Build CRC32 lookup table once
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function generateSecureId(byteLength) {
    var len = byteLength || 4;
    if (!global.crypto || typeof global.crypto.getRandomValues !== 'function') {
      throw new Error('Cryptographically secure random generator is unavailable in this browser.');
    }
    var bytes = new Uint8Array(len);
    global.crypto.getRandomValues(bytes);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  function crc32Hex(str) {
    var bytes = new TextEncoder().encode(str);
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
  }

  function uint8ToBase64Url(bytes) {
    var binary = '';
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var slice = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, slice);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToUint8(str) {
    if (!/^[A-Za-z0-9\-_]+$/.test(str)) {
      throw new Error('Malformed base64url QR segment.');
    }
    var padded = str.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4 !== 0) {
      padded += '=';
    }
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function compressString(plainText) {
    var rawBytes = new TextEncoder().encode(plainText);
    if (typeof CompressionStream === 'function') {
      try {
        var cs = new CompressionStream('deflate-raw');
        var writer = cs.writable.getWriter();
        writer.write(rawBytes);
        writer.close();
        var compressedBuf = await new Response(cs.readable).arrayBuffer();
        var compressedBytes = new Uint8Array(compressedBuf);
        if (compressedBytes.length < rawBytes.length) {
          return 'z:' + uint8ToBase64Url(compressedBytes);
        }
      } catch (_err) {
        // Fallback to raw encoding if stream compression fails
      }
    }
    return 'j:' + uint8ToBase64Url(rawBytes);
  }

  async function decompressString(packed) {
    if (typeof packed !== 'string' || packed.length < 3) {
      throw new Error('Invalid QR payload encoding.');
    }
    var mode = packed.slice(0, 2);
    var body = packed.slice(2);
    var bytes = base64UrlToUint8(body);

    if (mode === 'j:') {
      return new TextDecoder().decode(bytes);
    }
    if (mode === 'z:') {
      if (typeof DecompressionStream !== 'function') {
        throw new Error('This browser lacks DecompressionStream needed to decode compressed QR payloads.');
      }
      var ds = new DecompressionStream('deflate-raw');
      var writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      var outBuf = await new Response(ds.readable).arrayBuffer();
      return new TextDecoder().decode(outBuf);
    }
    throw new Error('Unsupported QR payload encoding mode.');
  }

  function validateSignalingPayload(obj) {
    if (!obj || typeof obj !== 'object') {
      throw new Error('Invalid QR payload: expected signaling object.');
    }
    if (obj.v !== 1) {
      throw new Error('Unsupported QR version: v' + String(obj.v));
    }
    if (typeof obj.sid !== 'string' || !/^[0-9a-f]{8}$/i.test(obj.sid)) {
      throw new Error('Invalid QR payload: malformed session identifier.');
    }
    if (obj.type !== 'O' && obj.type !== 'A') {
      throw new Error('Invalid QR payload: unknown signaling type.');
    }
    if (typeof obj.peer !== 'string' || obj.peer.length === 0 || obj.peer.length > 48) {
      throw new Error('Invalid QR payload: invalid peer name.');
    }
    if (typeof obj.sdp !== 'string' || obj.sdp.indexOf('v=0') === -1 || obj.sdp.indexOf('m=') === -1) {
      throw new Error('Invalid QR payload: malformed SDP description.');
    }
    if (!Array.isArray(obj.ice)) {
      throw new Error('Invalid QR payload: missing ICE candidate list.');
    }
    for (var i = 0; i < obj.ice.length; i++) {
      var cand = obj.ice[i];
      if (!cand || typeof cand.candidate !== 'string') {
        throw new Error('Invalid QR payload: malformed ICE candidate entry.');
      }
    }
    return obj;
  }

  async function encodeSignalingPayload(payload) {
    validateSignalingPayload(payload);
    var json = JSON.stringify(payload);
    var packed = await compressString(json);

    if (packed.length > MAX_PAYLOAD_BYTES) {
      throw new Error('QR payload too large (' + packed.length + ' chars). Maximum supported size is ' + MAX_PAYLOAD_BYTES + ' chars.');
    }

    var total = Math.max(1, Math.ceil(packed.length / CHUNK_DATA_LENGTH));
    if (total > MAX_CHUNKS) {
      throw new Error('QR payload too large (requires ' + total + ' QR segments; max is ' + MAX_CHUNKS + ').');
    }

    var qrStrings = [];
    for (var i = 0; i < total; i++) {
      var slice = packed.slice(i * CHUNK_DATA_LENGTH, (i + 1) * CHUNK_DATA_LENGTH);
      var checksum = crc32Hex(slice);
      qrStrings.push(
        PROTOCOL_PREFIX + '|' +
        payload.sid + '|' +
        payload.type + '|' +
        (i + 1) + '/' + total + '|' +
        checksum + '|' +
        slice
      );
    }
    return {
      chunks: qrStrings,
      packedBytes: packed.length,
      rawBytes: json.length
    };
  }

  function parseQRChunk(rawText) {
    if (typeof rawText !== 'string' || rawText.length === 0) {
      throw new Error('Empty QR payload.');
    }
    if (rawText.length > 4096) {
      throw new Error('QR payload segment too large.');
    }

    var parts = rawText.split('|');
    if (parts.length !== 6) {
      throw new Error('Invalid QR payload: not a Local Connect pairing code.');
    }

    var prefix = parts[0];
    if (/^LC\d+$/.test(prefix) && prefix !== PROTOCOL_PREFIX) {
      throw new Error('Unsupported QR version (' + prefix + '). Both devices must run compatible versions of Local Connect.');
    }
    if (prefix !== PROTOCOL_PREFIX) {
      throw new Error('Invalid QR payload: unrecognized protocol header.');
    }

    var sid = parts[1];
    var type = parts[2];
    var seq = parts[3];
    var checksum = parts[4];
    var data = parts[5];

    if (!/^[0-9a-f]{8}$/i.test(sid)) {
      throw new Error('Invalid QR payload: corrupted session ID.');
    }
    if (type !== 'O' && type !== 'A') {
      throw new Error('Invalid QR payload: unknown message type.');
    }

    var seqMatch = /^(\d+)\/(\d+)$/.exec(seq);
    if (!seqMatch) {
      throw new Error('Invalid QR payload: malformed sequence counter.');
    }
    var index = parseInt(seqMatch[1], 10);
    var total = parseInt(seqMatch[2], 10);
    if (total < 1 || total > MAX_CHUNKS || index < 1 || index > total) {
      throw new Error('Invalid QR payload: out-of-range segment index.');
    }

    if (!/^[0-9a-f]{8}$/i.test(checksum) || crc32Hex(data) !== checksum.toLowerCase()) {
      throw new Error('Corrupted QR segment (checksum mismatch). Try scanning again.');
    }

    return {
      sid: sid.toLowerCase(),
      type: type,
      index: index,
      total: total,
      data: data
    };
  }

  function QRChunkCollector(expectedType, expectedSid) {
    this.expectedType = expectedType || null; // 'O' or 'A' or null
    this.expectedSid = expectedSid ? expectedSid.toLowerCase() : null;
    this.activeSid = null;
    this.activeType = null;
    this.total = 0;
    this.parts = new Map();
    this.completed = false;
  }

  QRChunkCollector.prototype.addRawScan = async function (rawText) {
    if (this.completed) {
      return { status: 'already-complete' };
    }

    var chunk = parseQRChunk(rawText);

    if (this.expectedType && chunk.type !== this.expectedType) {
      var expectedLabel = this.expectedType === 'O' ? 'Offer' : 'Answer';
      var gotLabel = chunk.type === 'O' ? 'Offer' : 'Answer';
      throw new Error('Expected a connection ' + expectedLabel + ' QR code, but scanned an ' + gotLabel + ' QR code.');
    }

    if (this.expectedSid && chunk.sid !== this.expectedSid) {
      throw new Error('Session ID mismatch. This Answer QR belongs to a different pairing session.');
    }

    if (this.activeSid && chunk.sid !== this.activeSid) {
      throw new Error('Scanned QR belongs to a different pairing session (' + chunk.sid + '). Reset to pair with a new device.');
    }

    if (this.total && chunk.total !== this.total) {
      throw new Error('Inconsistent multi-part QR count.');
    }

    this.activeSid = chunk.sid;
    this.activeType = chunk.type;
    this.total = chunk.total;

    var isNew = !this.parts.has(chunk.index);
    this.parts.set(chunk.index, chunk.data);

    if (this.parts.size < this.total) {
      return {
        status: 'progress',
        isNew: isNew,
        index: chunk.index,
        receivedCount: this.parts.size,
        total: this.total,
        receivedIndices: Array.from(this.parts.keys())
      };
    }

    // Reassemble all parts in order
    var combined = '';
    for (var i = 1; i <= this.total; i++) {
      var segment = this.parts.get(i);
      if (typeof segment !== 'string') {
        throw new Error('Missing QR segment ' + i + ' during reassembly.');
      }
      combined += segment;
    }

    if (combined.length > MAX_PAYLOAD_BYTES) {
      throw new Error('Reassembled QR payload exceeds maximum allowed size.');
    }

    var jsonStr = await decompressString(combined);
    var parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (_e) {
      throw new Error('Invalid QR payload: corrupted JSON data.');
    }

    var validated = validateSignalingPayload(parsed);
    if (validated.sid.toLowerCase() !== this.activeSid) {
      throw new Error('Invalid QR payload: inner session ID mismatch.');
    }

    this.completed = true;
    return {
      status: 'complete',
      payload: validated
    };
  };

  function renderQRToCanvas(canvas, text) {
    if (typeof global.qrcode !== 'function') {
      throw new Error('Local QR generator library is not loaded.');
    }

    var qr;
    var primaryLevel = text.length > 400 ? 'L' : 'M';
    try {
      qr = global.qrcode(0, primaryLevel);
      qr.addData(text, 'Byte');
      qr.make();
    } catch (_errPrimary) {
      qr = global.qrcode(0, 'L');
      qr.addData(text, 'Byte');
      qr.make();
    }

    var count = qr.getModuleCount();
    var quietZone = 4;
    var totalModules = count + quietZone * 2;
    var targetSize = 520;
    var cellSize = Math.max(4, Math.floor(targetSize / totalModules));
    var canvasSize = totalModules * cellSize;

    canvas.width = canvasSize;
    canvas.height = canvasSize;

    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    ctx.fillStyle = '#000000';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(
            (c + quietZone) * cellSize,
            (r + quietZone) * cellSize,
            cellSize,
            cellSize
          );
        }
      }
    }
  }

  function QRScannerController(options) {
    this.videoEl = options.videoEl;
    this.onDecode = options.onDecode;
    this.onError = options.onError;
    this.onCamerasDetected = options.onCamerasDetected || function () {};
    this.stream = null;
    this.rafId = null;
    this.running = false;
    this.offscreen = document.createElement('canvas');
    this.ctx = this.offscreen.getContext('2d', { willReadFrequently: true });
    this.lastScanTs = 0;
    this.frameCount = 0;
    this.videoDevices = [];
    this.activeDeviceIndex = 0;
    this.handlingDecode = false;
  }

  QRScannerController.prototype.start = async function (deviceId) {
    this.stop();

    if (!global.isSecureContext) {
      throw new Error('Camera access requires HTTPS or localhost. Current context is not secure.');
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('This browser does not support camera access (MediaDevices API unavailable).');
    }
    if (typeof global.jsQR !== 'function') {
      throw new Error('Local QR scanner library failed to load.');
    }

    var constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      throw mapCameraError(err);
    }

    this.videoEl.srcObject = this.stream;
    this.videoEl.setAttribute('playsinline', 'true');
    await this.videoEl.play();

    // Populate camera list after permission is granted
    try {
      var devices = await navigator.mediaDevices.enumerateDevices();
      this.videoDevices = devices.filter(function (d) { return d.kind === 'videoinput'; });
      var activeTrack = this.stream.getVideoTracks()[0];
      var activeId = activeTrack && activeTrack.getSettings ? activeTrack.getSettings().deviceId : null;
      if (activeId) {
        var foundIdx = this.videoDevices.findIndex(function (d) { return d.deviceId === activeId; });
        if (foundIdx >= 0) this.activeDeviceIndex = foundIdx;
      }
      this.onCamerasDetected(this.videoDevices.length);
    } catch (_enumErr) {
      this.onCamerasDetected(0);
    }

    this.running = true;
    var self = this;
    var loop = function (timestamp) {
      if (!self.running) return;
      self.rafId = requestAnimationFrame(loop);

      // Scan ~12 frames per second to preserve battery & CPU on mobile
      if (timestamp - self.lastScanTs < 80) return;
      self.lastScanTs = timestamp;

      if (self.handlingDecode) return;
      if (self.videoEl.readyState < 2 || !self.videoEl.videoWidth || !self.videoEl.videoHeight) return;

      var vw = self.videoEl.videoWidth;
      var vh = self.videoEl.videoHeight;
      var maxDim = 640;
      var scale = Math.min(1, maxDim / Math.max(vw, vh));
      var sw = Math.max(1, Math.floor(vw * scale));
      var sh = Math.max(1, Math.floor(vh * scale));

      if (self.offscreen.width !== sw || self.offscreen.height !== sh) {
        self.offscreen.width = sw;
        self.offscreen.height = sh;
      }

      self.ctx.drawImage(self.videoEl, 0, 0, sw, sh);
      var imageData = self.ctx.getImageData(0, 0, sw, sh);

      self.frameCount++;
      var inversionMode = (self.frameCount % 4 === 0) ? 'attemptBoth' : 'dontInvert';
      var code = global.jsQR(imageData.data, sw, sh, { inversionAttempts: inversionMode });

      if (code && code.data) {
        self.handlingDecode = true;
        Promise.resolve(self.onDecode(code.data))
          .catch(function (err) {
            if (self.onError) self.onError(err);
          })
          .finally(function () {
            self.handlingDecode = false;
          });
      }
    };

    this.rafId = requestAnimationFrame(loop);
  };

  QRScannerController.prototype.switchCamera = async function () {
    if (this.videoDevices.length < 2) return;
    this.activeDeviceIndex = (this.activeDeviceIndex + 1) % this.videoDevices.length;
    var nextDevice = this.videoDevices[this.activeDeviceIndex];
    await this.start(nextDevice.deviceId);
  };

  QRScannerController.prototype.stop = function () {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(function (track) {
        track.stop();
      });
      this.stream = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
  };

  function mapCameraError(err) {
    var name = err && err.name ? err.name : '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return new Error('Camera permission denied. Allow camera access in your browser settings to scan QR codes.');
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return new Error('No camera was found on this device.');
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return new Error('Camera is currently in use by another application.');
    }
    if (name === 'SecurityError') {
      return new Error('Camera blocked by browser security policy. Open the app over HTTPS or localhost.');
    }
    return new Error(err && err.message ? err.message : 'Unable to access camera.');
  }

  global.LocalConnectQR = {
    generateSecureId: generateSecureId,
    encodeSignalingPayload: encodeSignalingPayload,
    parseQRChunk: parseQRChunk,
    QRChunkCollector: QRChunkCollector,
    renderQRToCanvas: renderQRToCanvas,
    QRScannerController: QRScannerController
  };
})(window);
