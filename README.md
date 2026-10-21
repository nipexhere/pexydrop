# PexyDrop

PexyDrop sends files between nearby phones and computers over Wi-Fi, straight from one device to the other. Open it on two devices on the same network, tap the device you want to send to, and the other person taps **Accept**. No accounts, no app install, no passwords, and files are never uploaded to a server.

## How it works

- **Discovery.** Devices on the same Wi-Fi share a public address, so the server groups them and they see each other automatically.
- **Direct, encrypted transfer.** Files travel over a WebRTC data channel, which is encrypted end to end with DTLS. The server only relays the short handshake messages and never sees file contents. No relay (TURN) server is configured, so file data cannot pass through a third party.
- **Wi-Fi only (on by default).** Each connection checks whether it runs over the local network. If it would go over the internet or mobile data, the transfer is refused. Phones on mobile data also show a warning.
- **Consent.** Every incoming transfer needs the receiver's approval, so a stranger on the same café Wi-Fi can see your device name but can't push files to you.
- **Pairing codes.** If automatic discovery misses a device (guest networks, VPNs, mixed IPv4/IPv6), scan the QR code or type the 6-character code. Codes are random, expire two minutes after the last device leaves, and repeated wrong guesses disconnect the client.

## Features

- Send files in either direction, any type and size, with live progress and speed
- Send text and links, with Copy and Open buttons on arrival
- Drag and drop onto a device, or paste files or text anywhere on the page
- Image thumbnails, Save, Save all, and the phone share sheet ("Save to Photos")
- Device names you can rename, which survive reloads and brief disconnects
- Installable as an app. On Android, the installed app appears in the share sheet, so you can share photos straight from the gallery to PexyDrop.
- Light and dark themes, phone and desktop layouts

## Run locally

```powershell
npm install
npm run dev
```

Open `http://localhost:5174` on the laptop, then scan the QR code with your phone. If Windows Firewall asks, allow Node.js on private networks.

To run the production build on your laptop so other devices on your Wi-Fi can use it:

```powershell
npm run build
npm start
```

The terminal prints the `http://192.168.x.x:4173` address to open on other devices. Installing the app and the share sheet need HTTPS, so they only work on the hosted version.

## Deploy on Render

Push to GitHub and create a Blueprint in Render from the repository. There is nothing to configure. Because the server only introduces devices and doesn't store files, the free plan works well. It may sleep when idle, so the first visit can take a few seconds to wake it up.

## Limits

- Both devices must keep the page open during a transfer.
- Received files are held in the browser until you save them, so very large transfers (several GB) depend on the receiving device's memory.
- Some networks (guest Wi-Fi, "client isolation") block devices from reaching each other. Use a different network or turn off Wi-Fi only to connect over the internet.

## Stack

React 19, TypeScript and Vite 7 on the client. Node.js 24, Express 5 and `ws` for signaling. WebRTC data channels for transfers.
