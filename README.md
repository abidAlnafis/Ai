# Local Connect

**Local Connect** is a 100% serverless, offline-capable, peer-to-peer communication web application built with HTML5, CSS3, and vanilla JavaScript.

It supports:
- QR-code-based device pairing (with complete ICE candidate exchange and automatic multi-part QR segmentation)
- Direct text messaging over `RTCDataChannel`
- Real voice calling (`getUserMedia` audio)
- Real video calling (`getUserMedia` audio + video, camera on/off, mic mute/unmute, and front/rear camera switching via `RTCRtpSender.replaceTrack`)

No Node.js server, no Express server, no WebSocket server, no Firebase, no external STUN/TURN servers, and no external CDNs are used or required.

---

## Project Structure

```text
local-connect/
├── index.html
├── style.css
├── app.js
├── webrtc.js
├── qr.js
├── libs/
│   ├── qrcode-generator.js   (MIT — bundled locally)
│   └── qr-scanner.js         (Apache-2.0 — jsQR bundled locally)
└── README.md
```

---

## How to Open & Connect Two Devices

### 1. Network Preparation
- Connect **Device A** and **Device B** to the **same local Wi-Fi network** or connect one device to the other's **mobile hotspot**.
- Internet access is **not** required once the app files are loaded on both devices.

### 2. Opening the App (Important Browser Security Context Note)
Modern browsers strictly require a **secure context** (`https://` on a trusted origin or `http://localhost`) for `navigator.mediaDevices.getUserMedia()` (QR camera scanning, microphone, and video camera).
- Opening `index.html` directly via `file://` or over a plain unencrypted `http://<LAN-IP>` URL will generally **block camera and microphone access** in Chrome, Edge, Safari, and Android browsers.
- To run on two separate devices offline/locally:
  - Serve the `local-connect/` folder over **HTTPS** on your local network (for example using a trusted local TLS certificate on your machine), **or**
  - Host the static `local-connect/` files on any static HTTPS origin, load them on both phones/laptops, and optionally disconnect the internet afterward, **or**
  - For single-machine testing (e.g., two browser tabs on the same Windows PC), `http://localhost` is treated as a secure context by browsers.

### 3. Pairing Two Devices via QR Codes
1. **Device A (Initiator)**:
   - Open Local Connect and tap **Create Connection**.
   - Wait briefly while WebRTC gathers local-network (`host` / mDNS) ICE candidates.
   - An **Offer QR code** appears. If the SDP + ICE payload exceeds one QR frame, it automatically splits into numbered parts (`Part 1 of N`) with **Previous / Next / Auto-cycle** controls.
2. **Device B (Receiver)**:
   - Open Local Connect and tap **Scan QR Code**.
   - Scan Device A's Offer QR code(s). As each part scans, progress chips check off automatically.
   - Once complete, Device B validates the payload, applies the offer, gathers its own ICE candidates, and displays an **Answer QR code**.
3. **Device A (Complete Pairing)**:
   - Tap **Scan Device B's Answer QR** (or **Scan QR Code**).
   - Scan Device B's Answer QR code(s).
   - Both devices wait until `RTCPeerConnection.connectionState === "connected"` and the `RTCDataChannel` opens before displaying **Connected Successfully** and opening the messaging screen.

### 4. Messaging, Voice, and Video Calls
- Once connected, type in the message box and press **Enter** or tap **Send**.
- Tap **Voice** or **Video** in the chat header to call your peer.
- Call signaling (`call-invite`, `call-accept`, `call-reject`, `call-end`, and WebRTC SDP/ICE renegotiation with Perfect Negotiation glare handling) travels directly over the already-open `RTCDataChannel`—**no QR rescanning is required between calls**.

---

## Browser, Networking & PWA Limitations (Honest Notes)

1. **No Public STUN/TURN Servers**:
   - `RTCPeerConnection` is configured with `{ iceServers: [] }`.
   - Connections rely exclusively on local host / mDNS `.local` ICE candidates.
2. **Router / Hotspot Client Isolation**:
   - Not every Wi-Fi network allows peer-to-peer traffic. Many public Wi-Fi routers, enterprise networks, and some mobile hotspots enable **AP / client isolation**, which drops packets between two clients on the same subnet.
   - Windows Defender Firewall or strict browser mDNS privacy policies can also block direct UDP connections. If a connection times out or fails with *"No common local network route found"*, verify both devices are on a private Wi-Fi/hotspot without client isolation.
3. **PWA Installation**:
   - Installing Local Connect as an offline Progressive Web App requires serving it from a valid **HTTPS** origin (or `localhost`) together with a Web App Manifest and Service Worker that caches these static files locally. Because this distribution contains only the core serverless files without a server or build pipeline, browser PWA install prompts will only activate if you deploy the folder on a secure HTTPS origin with a manifest and service worker.

---

## Privacy & Security

- **DTLS-SRTP & SCTP-over-DTLS**: WebRTC encrypts all voice/video media streams end-to-end between peers using DTLS-SRTP, and encrypts `RTCDataChannel` text & signaling messages over DTLS.
- **Zero Persistence**: No `localStorage`, `IndexedDB`, cookies, or backend databases are used. Session IDs (`crypto.getRandomValues`), peer names, and chat messages exist only in volatile RAM and vanish when the tab closes.
- **Strict Input Validation**: Every scanned QR segment is checked for protocol version (`LC1`), session ID match, CRC-32 checksum integrity, bounded payload size, and valid SDP/ICE schema. Peer chat text is rendered exclusively via `.textContent` to prevent HTML/script injection.

---

## Verification Matrix (Design & Implementation Check)

- **QR Offer & Answer Exchange**: Implemented with `LC1` chunked protocol, CRC-32 verification, `CompressionStream('deflate-raw')` (with raw JSON fallback), and `QRChunkCollector` reassembly.
- **Complete ICE Candidate Exchange**: `webrtc.js` awaits `iceGatheringState === 'complete'` (up to 6.5s timeout), records candidate types (`host`, `mDNS`, `other`), embeds complete SDP + any non-embedded candidates, and warns if 0 candidates are gathered.
- **Cross-Device Compatibility Target**: Built with standard WebRTC (`RTCPeerConnection`, `RTCDataChannel`), `MediaDevices.getUserMedia`, `playsinline` + `autoplay` video attributes, and `RTCRtpSender.replaceTrack` targeting Android Chrome and Windows Chrome/Edge.
- **Testing Status Note**: Static syntax and build verification were performed in the development environment; physical multi-device testing across separate Android hardware and Windows browsers over an isolated offline Wi-Fi router was not physically executed in this workspace.
