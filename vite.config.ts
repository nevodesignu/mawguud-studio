import { defineConfig, type Plugin, type Connect } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const designsDir = path.join(root, 'designs')
const userFontsDir = path.join(root, 'public', 'fonts', 'user')

// Designs and uploaded fonts are stored as real files in the repo - browser
// storage (especially inside embedded preview panes) can be wiped at any time.
function fileStore(): Plugin {
  const sendJson = (res: import('http').ServerResponse, code: number, data: unknown) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(data))
  }
  const readBody = (req: import('http').IncomingMessage) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })

  const attach = (middlewares: Connect.Server) => {
    fs.mkdirSync(designsDir, { recursive: true })
    fs.mkdirSync(userFontsDir, { recursive: true })

    middlewares.use('/api/designs', (req, res) => {
      void (async () => {
        const id = (req.url ?? '/').slice(1).split('?')[0]
        if (id && !/^[a-z0-9]{1,32}$/.test(id)) return sendJson(res, 400, { error: 'bad id' })
        const file = id ? path.join(designsDir, `${id}.json`) : ''
        if (req.method === 'GET' && !id) {
          const all = fs
            .readdirSync(designsDir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => {
              try {
                return JSON.parse(fs.readFileSync(path.join(designsDir, f), 'utf8'))
              } catch {
                return null
              }
            })
            .filter(Boolean)
          return sendJson(res, 200, all)
        }
        if (req.method === 'GET') {
          if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' })
          res.setHeader('Content-Type', 'application/json')
          return res.end(fs.readFileSync(file))
        }
        if (req.method === 'PUT') {
          const body = await readBody(req)
          try {
            JSON.parse(body.toString('utf8'))
          } catch {
            return sendJson(res, 400, { error: 'bad json' })
          }
          // atomic: a crash mid-write must never truncate a customer's design
          // file - write beside it, then rename over it
          const tmp = `${file}.tmp`
          fs.writeFileSync(tmp, body)
          fs.renameSync(tmp, file)
          return sendJson(res, 200, { ok: true })
        }
        if (req.method === 'DELETE') {
          if (fs.existsSync(file)) fs.unlinkSync(file)
          return sendJson(res, 200, { ok: true })
        }
        sendJson(res, 405, { error: 'method' })
      })().catch((err) => sendJson(res, 500, { error: String(err) }))
    })

    middlewares.use('/api/fonts', (req, res) => {
      void (async () => {
        const raw = decodeURIComponent((req.url ?? '/').slice(1).split('?')[0])
        const safe = raw.replace(/[^\w.-]+/g, '_')
        if (raw && (safe !== raw || raw.includes('..'))) return sendJson(res, 400, { error: 'bad name' })
        if (req.method === 'GET') {
          const files = fs.readdirSync(userFontsDir).filter((f) => /\.(ttf|otf)$/i.test(f))
          return sendJson(res, 200, files)
        }
        if (req.method === 'POST' && raw) {
          const body = await readBody(req)
          if (body.length < 100) return sendJson(res, 400, { error: 'empty font' })
          fs.writeFileSync(path.join(userFontsDir, raw), body)
          return sendJson(res, 200, { ok: true, file: raw })
        }
        if (req.method === 'DELETE' && raw) {
          const p = path.join(userFontsDir, raw)
          if (fs.existsSync(p)) fs.unlinkSync(p)
          return sendJson(res, 200, { ok: true })
        }
        sendJson(res, 405, { error: 'method' })
      })().catch((err) => sendJson(res, 500, { error: String(err) }))
    })
  }

  return {
    name: 'mawguud-file-store',
    configureServer(server) {
      attach(server.middlewares)
    },
    configurePreviewServer(server) {
      attach(server.middlewares)
    },
  }
}

export default defineConfig({
  plugins: [react(), fileStore()],
  server: { port: 5173 },
})
