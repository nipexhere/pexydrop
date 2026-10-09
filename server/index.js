import archiver from 'archiver'
import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import multer from 'multer'

const root = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(root, '..')
const storagePath = process.env.TRANSFER_STORAGE || path.join(os.tmpdir(), 'pexydrop-files')
const port = Number(process.env.PORT || 4173)
const pairingKey = crypto.randomBytes(24).toString('hex')
const transferPassword = process.env.TRANSFER_PASSWORD || ''
const publicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ''
const isHosted = Boolean(publicUrl || process.env.RENDER)
const app = express()

await mkdir(storagePath, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, storagePath),
    filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.data`),
  }),
})

function listFiles() {
  return readdir(storagePath).then(async (names) => {
    const files = await Promise.all(names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          return JSON.parse(await readFile(path.join(storagePath, name), 'utf8'))
        } catch {
          return null
        }
      }))
    return files.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })
}

app.use('/api', (req, res, next) => {
  if (req.path === '/info') return next()
  if (req.get('x-transfer-key') !== pairingKey && req.query.key !== pairingKey) {
    return res.status(401).json({ error: 'This device is not paired. Scan the current QR code and try again.' })
  }
  next()
})

app.get('/api/info', (req, res) => {
  const addresses = Object.entries(os.networkInterfaces())
    .flatMap(([name, interfaces]) => (interfaces ?? []).map((address) => ({ name, address })))
    .filter(({ address }) => address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'))
    .sort((first, second) => Number(/wi-?fi|wireless|wlan/i.test(second.name)) - Number(/wi-?fi|wireless|wlan/i.test(first.name)))
    .map(({ address }) => address.address)
  const forwardedAddress = process.env.NODE_ENV === 'development'
    ? req.get('x-nearby-client-address')
    : undefined
  const clientAddress = forwardedAddress || req.socket.remoteAddress || ''
  const isLocalClient = clientAddress === '::1'
    || clientAddress === '127.0.0.1'
    || clientAddress.startsWith('::ffff:127.')
  const sessionKeyMatches = req.get('x-transfer-key') === pairingKey
  const passwordMatches = Boolean(transferPassword) && req.get('x-transfer-password') === transferPassword
  const requiresPassword = (isHosted || Boolean(transferPassword)) && !sessionKeyMatches && !passwordMatches
  const canPair = requiresPassword ? false : sessionKeyMatches || passwordMatches || isLocalClient
  res.json({
    addresses: isHosted ? [] : addresses,
    pairingKey: canPair ? pairingKey : null,
    port,
    publicUrl: publicUrl || null,
    requiresPassword,
    setupRequired: isHosted && !transferPassword,
  })
})

app.get('/api/files', async (_req, res, next) => {
  try {
    res.json(await listFiles())
  } catch (error) {
    next(error)
  }
})

app.post('/api/files', upload.array('files'), async (req, res, next) => {
  try {
    const uploaded = await Promise.all((req.files ?? []).map(async (file) => {
      const entry = {
        id: path.basename(file.filename, '.data'),
        name: file.originalname,
        size: file.size,
        type: file.mimetype,
        createdAt: new Date().toISOString(),
      }
      await writeFile(path.join(storagePath, `${entry.id}.json`), JSON.stringify(entry))
      return entry
    }))
    res.status(201).json(uploaded)
  } catch (error) {
    next(error)
  }
})

app.get('/api/archive', async (_req, res, next) => {
  try {
    const files = await listFiles()
    if (!files.length) return res.status(404).json({ error: 'There are no files to download.' })
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', 'attachment; filename="pexydrop.zip"')
    const archive = archiver('zip', { zlib: { level: 0 } })
    archive.on('error', (error) => {
      if (res.headersSent) res.destroy(error)
      else next(error)
    })
    archive.pipe(res)
    for (const file of files) {
      archive.append(createReadStream(path.join(storagePath, `${file.id}.data`)), {
        name: path.basename(file.name.replaceAll('\\', '/')),
      })
    }
    await archive.finalize()
  } catch (error) {
    next(error)
  }
})

app.get('/api/files/:id/download', async (req, res, next) => {
  try {
    if (!/^[\da-f-]+$/i.test(req.params.id)) return res.sendStatus(404)
    const metadata = JSON.parse(await readFile(path.join(storagePath, `${req.params.id}.json`), 'utf8'))
    const filePath = path.join(storagePath, `${req.params.id}.data`)
    await stat(filePath)
    res.download(filePath, path.basename(metadata.name), (error) => {
      if (error && !res.headersSent) next(error)
    })
  } catch (error) {
    if (error.code === 'ENOENT') return res.sendStatus(404)
    next(error)
  }
})

app.delete('/api/files/:id', async (req, res, next) => {
  try {
    if (!/^[\da-f-]+$/i.test(req.params.id)) return res.sendStatus(404)
    await Promise.all([
      unlink(path.join(storagePath, `${req.params.id}.data`)).catch(() => {}),
      unlink(path.join(storagePath, `${req.params.id}.json`)).catch(() => {}),
    ])
    res.sendStatus(204)
  } catch (error) {
    next(error)
  }
})

const distPath = path.join(appRoot, 'dist')
app.use(express.static(distPath))
app.get('*path', (_req, res, next) => {
  res.sendFile(path.join(distPath, 'index.html'), (error) => error && next(error))
})

app.use((error, _req, res, _next) => {
  console.error(error)
  const status = error instanceof multer.MulterError ? 400 : 500
  res.status(status).json({ error: status === 400 ? error.message : 'The transfer could not be completed.' })
})

app.listen(port, process.env.NODE_ENV === 'development' ? '127.0.0.1' : '0.0.0.0', () => {
  console.log(`PexyDrop API ready on port ${port}`)
  console.log(`Files are stored temporarily in ${storagePath}`)
})