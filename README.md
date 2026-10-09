# PexyDrop

PexyDrop is a private file-transfer web app for moving files between a phone and a laptop. On a local install, the laptop hosts the transfer service and the phone joins through a QR code. Files move directly over the local network; there is no account or cloud relay.

## Features

- QR pairing and a copyable device link
- Phone-to-laptop and laptop-to-phone transfers
- Drag-and-drop and multi-file uploads with progress
- Disk-backed uploads and streamed individual or ZIP downloads
- File search, storage totals, and removal controls
- A random session key, plus a required passphrase when hosted publicly
- Responsive phone and desktop layouts

## Run Locally

```powershell
npm install
npm run dev
```

Open `http://localhost:5174` on the laptop. Scan the QR code with a phone on the same Wi-Fi. If Windows Firewall asks, allow Node.js on private networks. The production-style local server can be run with `npm run build` followed by `npm start`.

Received files are staged in the operating system's temporary directory by default. Remove files from the app when finished; temporary files may also remain until the OS cleans that directory. Set `TRANSFER_STORAGE` to choose another location.

## Deploy on Render

This repository includes a Render Blueprint. Push it to GitHub, then create a new Blueprint in Render from the repository. During setup, Render asks for `TRANSFER_PASSWORD`; choose a strong passphrase and share it only with the people transferring files. The deployed URL uses the hosted server as a relay, rather than a direct LAN connection.

The included free service uses temporary storage and may sleep when idle. Files can disappear when the service restarts, and the hosting plan or proxy can impose upload-size and duration limits. For very large or sensitive corporate transfers, run PexyDrop on the laptop over a trusted local network or use a deployment with reviewed limits, persistent storage, and an appropriate security policy. Local HTTP is not encrypted; public Render traffic is served through HTTPS.

## Stack

- React 19, TypeScript, and Vite 7
- Node.js 24 and Express 5
- Multer 2 for disk-backed multipart uploads
- Archiver 7 for streamed ZIP downloads
- `qrcode.react` for QR codes
- Lucide React for interface icons

## Portfolio Summary

**PexyDrop** is a QR-paired file-transfer app that moves files between phones and computers. It supports multi-file uploads, large disk-backed transfers, streamed downloads, and private LAN operation, with an optional password gate for hosted deployments.