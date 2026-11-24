/**
 * HTTP surface for the archived-cleanup bundle.
 *
 * Two transports are registered with the same routes, exactly like the
 * dsh-remote bundle: the Web server (browser) and the Connection fetch carrier
 * (Desktop's portless IPC). Both wrap every request in DeepSeek Harness's own
 * browser trust fence so a cross-site page cannot reach a destructive route.
 */

import { Readable } from 'node:stream'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { buildPlan, executePlan, MAX_TARGETS, messageOf, summarize } from './cleanup.js'
import { serviceOf, warn } from './context.js'
import { sha256File } from './paths.js'
import { revealBackup } from './shell.js'

/** Largest accepted JSON body, in bytes. */
const MAX_BODY_BYTES = 1024 * 1024

/** Route prefix shared by both transports. */
const PREFIX = '/archived-cleanup'

/**
 * Register the bundle's exact routes on whichever transports the composition offers.
 * @param {object} ctx - plugin context.
 * @param {object} paths - resolved store paths.
 * @param {object} config - validated plugin config.
 */
export function registerRoutes(ctx, paths, config) {
  const routes = createRoutes(ctx, paths, config)

  ctx.inject(['webServer'], (inner) => {
    const webServer = inner.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return
    const guarded = routes.map(route => guardRoute(route, () => ctx.get('connection')))
    const disposers = []
    for (const route of guarded) {
      try {
        disposers.push(webServer.register(route))
      } catch (error) {
        warn(ctx, 'archived-cleanup: web route %s failed: %s', route.path, messageOf(error))
      }
    }
    inner.effect(() => () => disposers.forEach(dispose => dispose?.()), 'archived-cleanup.web-routes')
  })

  ctx.inject(['connection'], (inner) => {
    const connection = inner.get('connection')
    if (typeof connection?.fetch?.register !== 'function') return
    const disposers = []
    for (const route of routes) {
      try {
        disposers.push(connection.fetch.register(connectionRoute(route)))
      } catch (error) {
        warn(ctx, 'archived-cleanup: fetch route %s failed: %s', route.path, messageOf(error))
      }
    }
    inner.effect(() => () => Promise.all(disposers.map(dispose => dispose?.())), 'archived-cleanup.fetch-routes')
  })
}

/**
 * Build the route table.
 * @param {object} ctx - plugin context.
 * @param {object} paths - resolved store paths.
 * @param {object} config - validated plugin config.
 * @returns {Array<object>} exact webServer routes with legacy handlers.
 */
function createRoutes(ctx, paths, config) {
  return [
    {
      kind: 'exact',
      path: PREFIX + '/info',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method-not-allowed' })
          return send(res, 200, await info(ctx, paths, config))
        } catch (error) {
          return send(res, statusOf(error), { ok: false, error: 'info-failed', message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: PREFIX + '/delete',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method-not-allowed' })
          const body = await readJson(req)
          const targets = normalizeTargets(body?.targets ?? body?.sessionIds, body)
          if (targets === null) return send(res, 400, { ok: false, error: 'invalid-targets' })
          const plan = await buildPlan(ctx, paths, targets)
          if (body?.dryRun === true) {
            return send(res, 200, { ok: true, dryRun: true, plan: summarize(plan) })
          }
          const result = await executePlan(ctx, paths, plan)
          return send(res, result.ok === false && result.error === 'backup-failed' ? 500 : 200, {
            ...result,
            plan: summarize(plan),
          })
        } catch (error) {
          return send(res, statusOf(error), { ok: false, error: 'delete-failed', message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: PREFIX + '/reveal',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method-not-allowed' })
          const body = await readJson(req)
          const path = await revealBackup(paths, body?.name, {
            openFolder: typeof config?.openFolder === 'function' ? config.openFolder : undefined,
          })
          return send(res, 200, { ok: true, path })
        } catch (error) {
          return send(res, statusOf(error), {
            ok: false,
            error: error?.code ?? 'reveal-failed',
            message: messageOf(error),
          })
        }
      },
    },
    {
      kind: 'exact',
      path: PREFIX + '/backup-hash',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method-not-allowed' })
          return send(res, 200, {
            ok: true,
            workspaceJsonSha256: await sha256File(paths.workspaceFile),
            backupRoot: paths.backupRoot,
          })
        } catch (error) {
          return send(res, statusOf(error), { ok: false, error: 'hash-failed', message: messageOf(error) })
        }
      },
    },
  ]
}

/**
 * Current store facts for the page: which archived ids the registry holds, how
 * large each footprint is, whether it is live, and where backups live.
 * @param {object} ctx - plugin context.
 * @param {object} paths - resolved store paths.
 * @param {object} config - validated plugin config.
 * @returns {Promise<object>} info payload.
 */
async function info(ctx, paths, config) {
  const registry = serviceOf(ctx, 'workspaceRegistry')
  const archivedSessionIds = registry?.archivedSessionIds ?? []
  const live = new Set()
  try {
    for (const session of ctx.get('sessions')?.list?.() ?? []) live.add(session.id)
  } catch {
    // No session store in this composition: nothing is live.
  }

  // One plan for the whole archive set keeps header reads and the descendant
  // scan to a single pass, however many archived Sessions the registry holds.
  const plan = archivedSessionIds.length === 0
    ? { entries: [] }
    : await buildPlan(ctx, paths, archivedSessionIds.map(sessionId => ({ sessionId })))
  const byId = new Map(plan.entries.map(entry => [entry.sessionId, entry]))

  const sessions = []
  for (const sessionId of archivedSessionIds) {
    const entry = byId.get(sessionId)
    sessions.push({
      sessionId,
      live: live.has(sessionId),
      found: entry?.status === 'delete',
      bytes: entry?.bytes ?? 0,
      files: entry?.files ?? 0,
      directory: entry?.dir ?? null,
      reason: entry?.reason ?? null,
    })
  }

  const known = new Set(sessions.map(session => session.sessionId))
  for (const sessionId of live) {
    if (!known.has(sessionId)) continue
    const row = sessions.find(session => session.sessionId === sessionId)
    if (row !== undefined) row.live = true
  }

  return {
    ok: true,
    home: paths.home,
    sessionsRoot: paths.sessionsRoot,
    storagesRoot: paths.storagesRoot,
    backupRoot: paths.backupRoot,
    workspaceFile: paths.workspaceFile,
    archivedSessionIds,
    liveSessionIds: [...live],
    sessions,
    totals: {
      archived: archivedSessionIds.length,
      found: sessions.filter(session => session.found).length,
      bytes: sessions.reduce((sum, session) => sum + session.bytes, 0),
    },
    backups: await listBackups(paths.backupRoot),
  }
}

/**
 * Summarize existing backup directories, newest first.
 * @param {string} backupRoot - directory holding `cleanup-backup-*` entries.
 * @returns {Promise<Array<object>>} backups.
 */
async function listBackups(backupRoot) {
  let entries
  try {
    entries = await readdir(backupRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const backups = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('cleanup-backup-')) continue
    const dir = join(backupRoot, entry.name)
    const info = await stat(dir)
    backups.push({ name: entry.name, createdAt: info.mtime.toISOString(), directory: dir })
  }
  backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return backups.slice(0, 20)
}

/**
 * Accept either `{targets:[{sessionId,cwd}]}`, `{targets:[id,...]}` or `{sessionIds:[id,...]}`.
 * @param {unknown} raw - request-supplied targets.
 * @param {object} body - full request body.
 * @returns {Array<{sessionId: string, cwd?: string}>|null} normalized targets, or null when invalid.
 */
export function normalizeTargets(raw, body) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(body?.sessionIds)
      ? body.sessionIds
      : null
  if (list === null || list.length === 0 || list.length > MAX_TARGETS) return null
  const out = []
  const seen = new Set()
  for (const item of list) {
    const sessionId = typeof item === 'string' ? item : item?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) return null
    if (seen.has(sessionId)) continue
    seen.add(sessionId)
    const cwd = typeof item === 'object' && item !== null && typeof item.cwd === 'string' ? item.cwd : undefined
    out.push(cwd === undefined ? { sessionId } : { sessionId, cwd })
  }
  return out
}

/**
 * Read and parse a bounded JSON request body from either carrier.
 * @param {object} req - legacy request stream.
 * @returns {Promise<object>} parsed body, or an empty object when the body is empty.
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks, size).toString('utf8')
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    const error = new Error('invalid JSON body')
    error.status = 400
    throw error
  }
}

/** HTTP status carried by a thrown request error, defaulting to 500. */
function statusOf(error) {
  const status = error?.status
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500
}

/**
 * Write one JSON response through the legacy response adapter.
 * @param {object} res - response adapter.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON payload.
 */
export function send(res, status, body) {
  const text = JSON.stringify(body)
  if (typeof res.writeHead === 'function') {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
    return
  }
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/**
 * Forward one legacy route into the Connection fetch carrier.
 * Mirrors dsh-remote's adapter, but accepts any exact plugin path (its copy
 * hard-codes a `/dsh-remote/` prefix).
 * @param {object} route - route definition.
 * @returns {object} Connection fetch route.
 */
export function connectionRoute(route) {
  return {
    path: '/api' + route.path,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const chunks = []
      let size = 0
      const reader = request.body?.getReader()
      try {
        if (reader) {
          while (true) {
            request.signal.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_BODY_BYTES) {
              await reader.cancel()
              return Response.json({ ok: false, error: 'request body too large' }, { status: 413 })
            }
            chunks.push(Buffer.from(value))
          }
        }
      } finally {
        reader?.releaseLock()
      }
      request.signal.throwIfAborted()
      const url = new URL(request.url)
      const req = Readable.from(size ? [Buffer.concat(chunks, size)] : [])
      req.method = request.method
      req.url = route.path + url.search
      req.headers = Object.fromEntries(request.headers)
      const headers = new Headers()
      let response
      const res = {
        statusCode: 200,
        setHeader(key, value) { headers.set(key, value) },
        end(body) { response = new Response(body, { status: this.statusCode, headers }) },
      }
      try {
        await route.handler(req, res)
        if (!response) throw new Error('JSON handler did not finish its response')
        return response
      } finally {
        // Nothing to release: the buffer is already in memory.
      }
    },
  }
}

/**
 * Wrap a route so every request passes DeepSeek Harness's browser trust fence.
 * The Connection service is read per request, so a late-arriving authenticator
 * still counts.
 * @param {object} route - route definition.
 * @param {() => object|undefined} connectionOf - resolves the live Connection service.
 * @returns {object} guarded route.
 */
export function guardRoute(route, connectionOf) {
  const inner = route.handler
  return {
    ...route,
    handler: async (req, res) => {
      const connection = connectionOf()
      const rejection = typeof connection?.requestRejection === 'function'
        ? connection.requestRejection(req)
        : fallbackRejection(req)
      if (rejection !== undefined) {
        send(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
        return
      }
      return inner(req, res)
    },
  }
}

/**
 * Fail-closed browser fence used when no Connection service is present:
 * reject cross-site requests, foreign Origins, and non-loopback Hosts.
 * @param {object} req - legacy request.
 * @returns {number|undefined} rejection status.
 */
export function fallbackRejection(req) {
  const headers = req && req.headers
  if (!headers || typeof headers !== 'object') return undefined
  const header = (name) => {
    const value = headers[name]
    return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
  }
  if (header('sec-fetch-site') === 'cross-site') return 403
  const host = header('host')
  const origin = header('origin')
  if (origin !== undefined && host !== undefined) {
    try {
      if (new URL(origin).host !== host) return 403
    } catch {
      return 403
    }
  }
  if (host !== undefined) {
    const hostname = host.replace(/:\d+$/, '').toLowerCase()
    const loopback = hostname === 'localhost' || hostname === '[::1]'
      || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    if (!loopback) return 403
  }
  return undefined
}
