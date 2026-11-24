#!/usr/bin/env node
/**
 * End-to-end check of the Host half's HTTP surface.
 *
 * Registers the real routes on a stub plugin context, serves them through
 * node:http exactly the way the Host's webServer does, and drives them with
 * fetch against a throwaway $DSH_HOME. Nothing here touches the real store.
 *
 *   node tools/route-smoke.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { projectKey, resolvePaths } from '../lib/paths.js'
import { registerRoutes } from '../lib/routes.js'

let server
const home = await mkdtemp(join(tmpdir(), 'dsh-cleanup-route-'))
const cwd = join(home, 'work')
const sessionId = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const paths = resolvePaths({ dshHome: home })
const sessionDir = join(paths.sessionsRoot, projectKey(cwd), sessionId)
const projcacheFile = join(paths.projectionCacheRoot, sessionId + '.json')

try {
  await mkdir(cwd, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  await mkdir(paths.projectionCacheRoot, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'log-bytes')
  await writeFile(projcacheFile, '{"cache":true}')
  await writeFile(paths.workspaceFile, JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: [sessionId], pinnedSessionIds: [] },
    tables: { workspaces: { w1: { path: cwd, title: 'Fixture', sessionIds: [sessionId] } } },
  }, null, 2))

  /* ------------------------------------------------------ stub plugin ctx */

  const registry = {
    archivedSessionIds: [sessionId],
    detachCalls: [],
    unarchiveCalls: [],
    list() {
      return [{
        detachSession: id => registry.detachCalls.push(id),
      }]
    },
    unarchiveSession(id) {
      registry.unarchiveCalls.push(id)
      registry.archivedSessionIds = registry.archivedSessionIds.filter(entry => entry !== id)
    },
  }

  const services = {
    workspaceRegistry: registry,
    sessionQuery: { listSessions: async () => [{ header: { id: sessionId, cwd }, live: false, persisted: true }] },
    sessions: { list: () => [] },
  }

  const routes = new Map()
  const disposed = []
  const ctx = {
    workspaceRegistry: registry,
    logger: { warn() {} },
    get(name) {
      return services[name]
    },
    inject(deps, callback) {
      const inner = {
        get: name => services[name],
        effect(fn) {
          const dispose = fn()
          disposed.push(dispose)
          return dispose
        },
      }
      callback(inner)
    },
  }
  services.webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }

  const opened = []
  registerRoutes(ctx, paths, { openFolder: async dir => opened.push(dir) })
  assert.deepEqual([...routes.keys()].sort(), [
    '/archived-cleanup/backup-hash',
    '/archived-cleanup/delete',
    '/archived-cleanup/info',
    '/archived-cleanup/reveal',
  ])

  /* --------------------------------------------------------- http carrier */

  server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    const route = routes.get(pathname)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no route')
      return
    }
    void route.handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const call = (path, init) => fetch(origin + path, init)

  /* ---------------------------------------------------------------- facts */

  const infoResponse = await call('/archived-cleanup/info')
  assert.equal(infoResponse.status, 200)
  const info = await infoResponse.json()
  assert.equal(info.ok, true)
  assert.deepEqual(info.archivedSessionIds, [sessionId])
  const row = info.sessions.find(entry => entry.sessionId === sessionId)
  assert.ok(row, 'lists the archived Session')
  assert.equal(row.found, true)
  assert.equal(row.bytes, 9)
  assert.equal(info.totals.bytes, 9)
  assert.equal(info.home, home)

  const hash = await (await call('/archived-cleanup/backup-hash')).json()
  assert.match(hash.workspaceJsonSha256, /^[0-9a-f]{64}$/)

  /* ------------------------------------------------------- reveal folder */

  const revealRoot = await call('/archived-cleanup/reveal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(revealRoot.status, 200, 'revealing the root succeeds')
  const rootBody = await revealRoot.json()
  assert.equal(rootBody.ok, true)
  assert.equal(rootBody.path, paths.backupRoot)
  assert.deepEqual(opened, [paths.backupRoot])

  const traversal = await call('/archived-cleanup/reveal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '../../elsewhere' }),
  })
  assert.equal(traversal.status, 400)
  assert.equal((await traversal.json()).error, 'invalid-backup')

  const missing = await call('/archived-cleanup/reveal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'cleanup-backup-1999-01-01T00-00-00' }),
  })
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error, 'backup-missing')
  assert.equal((await call('/archived-cleanup/reveal', { method: 'GET' })).status, 405)

  /* --------------------------------------------------------- guard rails */

  const crossSite = await call('/archived-cleanup/info', { headers: { origin: 'http://evil.example' } })
  assert.equal(crossSite.status, 403, 'rejects a cross-origin read')
  assert.equal((await crossSite.json()).error, 'forbidden')

  assert.equal((await call('/archived-cleanup/info', { method: 'POST' })).status, 405)
  assert.equal((await call('/archived-cleanup/delete', { method: 'GET' })).status, 405)

  const badBody = await call('/archived-cleanup/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  })
  assert.equal(badBody.status, 400)

  const badTargets = await call('/archived-cleanup/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targets: [] }),
  })
  assert.equal(badTargets.status, 400)
  assert.equal((await badTargets.json()).error, 'invalid-targets')

  /* ------------------------------------------------------------ dry run */

  const dry = await call('/archived-cleanup/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targets: [{ sessionId, cwd }], dryRun: true }),
  })
  assert.equal(dry.status, 200)
  const dryBody = await dry.json()
  assert.equal(dryBody.dryRun, true)
  assert.equal(dryBody.plan.deletable.length, 1)
  await stat(join(sessionDir, 'session.v4.jsonl.zstd'))

  /* -------------------------------------------------------------- delete */

  const deleted = await call('/archived-cleanup/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targets: [{ sessionId, cwd }] }),
  })
  assert.equal(deleted.status, 200)
  const result = await deleted.json()
  assert.equal(result.ok, true)
  assert.deepEqual(result.deleted.map(entry => entry.sessionId), [sessionId])
  assert.equal(result.freedBytes, 9)
  assert.match(result.backupDir, /cleanup-backups[\\/]cleanup-backup-/)
  assert.deepEqual(registry.detachCalls, [sessionId])
  assert.deepEqual(registry.unarchiveCalls, [sessionId])

  await assert.rejects(stat(sessionDir), 'removes the Session directory')
  await assert.rejects(stat(projcacheFile), 'removes the projection cache')

  const manifest = JSON.parse(await readFile(join(result.backupDir, 'manifest.json'), 'utf8'))
  assert.ok(Array.isArray(manifest.sessions) || Array.isArray(manifest.entries), 'manifest lists what was saved')
  await stat(join(result.backupDir, 'workspace.json'))
  await stat(join(result.backupDir, 'sessions', projectKey(cwd), sessionId, 'session.v4.jsonl.zstd'))

  /* -------------------------------------------------- a second run is safe */

  const again = await (await call('/archived-cleanup/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targets: [{ sessionId, cwd }] }),
  })).json()
  assert.equal(again.ok, true)
  assert.equal(again.deleted.length, 0)
  assert.equal(again.skipped.length, 1)

  /* Unarchived ids never delete anything. */
  const notArchived = await call('/archived-cleanup/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targets: ['session-other'] }),
  })
  assert.equal(notArchived.status, 200)
  const notArchivedBody = await notArchived.json()
  assert.equal(notArchivedBody.deleted.length, 0)
  assert.equal(notArchivedBody.skipped[0].reason, 'not-archived')

  for (const dispose of disposed) dispose?.()

  console.log('route smoke: info / guard / dryRun / delete / idempotency / reveal all ok')
} finally {
  if (server !== undefined) {
    await new Promise(resolve => server.close(resolve))
    server.closeAllConnections?.()
  }
  await rm(home, { recursive: true, force: true })
}
