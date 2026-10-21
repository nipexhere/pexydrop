# PexyDrop

PexyDrop sends files between nearby phones and computers over Wi-Fi, straight from one device to the other. Open it on two devices on the same network, tap the device you want to send to, and the other person taps **Accept**. No accounts, no app install, no passwords, and files are never uploaded to a server.

## How it works

- **Discovery.** Devices on the same Wi-Fi share a public address, so the server groups them and they see each other automatically.
- **Direct, encrypted transfer.** Files travel over a WebRTC data channel, which is encrypted end to end with DTLS. The server only relays the short handshake messages and never sees file contents.
- **Hotspot mode.** No shared Wi-Fi? Turn on the phone's hotspot and connect the laptop to it. Traffic between the two never leaves the devices, so it doesn't use mobile data. If the devices don't appear automatically, pair them with the code.
- **Ask before using data (on by default).** Each connection checks whether its path stays on the local network. If a transfer would go over the internet, the sender is asked first and shown the size, and the receiver sees a warning before accepting.
- **Consent.** Every incoming transfer needs the receiver's approval, so a stranger on the same café Wi-Fi can see your device name but can't push files to you. You can tick "accept automatically" for a device you trust, until the page closes.
- **Pairing codes.** If automatic discovery misses a device (guest networks, VPNs, hotspots, mixed IPv4/IPv6), scan the QR code or type the 6-character code. Codes are random, expire two minutes after the last device leaves, and repeated wrong guesses disconnect the client.

## Features

- Send files in either direction, any type and size, with live progress and speed
- Queue more batches while one is still sending
- Send text and links, with Copy and Open buttons on arrival
- Drag and drop onto a device, or paste files or text anywhere on the page
- On Chrome and Edge for desktop, pick a folder and received files stream straight into it, so multi-gigabyte files don't fill memory
- Auto-save received files (on by default for computers)
- Image thumbnails, Save, Save all, and the phone share sheet ("Save to Photos")
- Transfer history on each device (names and sizes only, stored locally)
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

Push to GitHub and create a Blueprint in Render from the repository. No settings are required, and because the server only introduces devices and doesn't store files, the free plan works well. Pushes to `main` redeploy automatically.

### Keep it awake

The free plan sleeps after 15 idle minutes, and the next visit then takes up to a minute. The included GitHub Actions workflow (`.github/workflows/keep-awake.yml`) pings the site every 10 minutes so that doesn't happen. One always-on free service uses about 744 of the 750 free instance hours Render gives each month. If your site isn't at `https://pexydrop.onrender.com`, add a repository variable named `PEXYDROP_URL` (Settings → Secrets and variables → Actions → Variables). GitHub pauses scheduled workflows in repositories with no activity for 60 days.

### Optional: connect across different networks

Without a relay, devices on different networks (for example a phone on mobile data and a laptop on home Wi-Fi) often can't reach each other, because mobile carriers usually block direct incoming connections. A TURN relay fixes that by forwarding the data, which stays end-to-end encrypted so the relay can't read it. Relayed transfers count against the phone's data plan, and PexyDrop asks before using one.

To use Cloudflare's relay:

1. In the Cloudflare dashboard, open **Realtime → TURN Server** and create a TURN key.
2. Copy the **Turn Token ID** and **API Token**.
3. In Render, open the service, go to **Environment**, and add `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`. Save, and Render redeploys.

Check Cloudflare's current TURN pricing; it includes a free monthly allowance. Any other TURN provider works too: set `TURN_URLS` (comma-separated), `TURN_USERNAME` and `TURN_CREDENTIAL` instead. The server log says whether a relay is enabled.

Relay credentials are given to every device that connects, so someone could use your relay allowance. Cloudflare's credentials expire after a day, which limits that.

## Limits

- Both devices must keep the page open during a transfer.
- Without a save folder (phones, Safari, Firefox), received files are held in the browser until saved, so very large transfers (several GB) depend on the receiving device's memory.
- Some networks (guest Wi-Fi, "client isolation") block devices from reaching each other. Use a hotspot instead, or set up a relay.

## Stack

React 19, TypeScript and Vite 7 on the client. Node.js 24, Express 5 and `ws` for signaling. WebRTC data channels for transfers.
