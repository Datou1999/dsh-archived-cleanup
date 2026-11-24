// Fixture-based self test for the archived-cleanup Host half.
// Every path lives under a fresh temp directory; ~/.dsh is never touched.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlan, executePlan, MAX_TARGETS, summarize } from '../lib/cleanup.js'
import { encodeSegment, projectKey, resolvePaths } from '../lib/paths.js'
import { revealBackup, resolveRevealTarget } from '../lib/shell.js'
import { connectionRoute, fallbackRejection, guardRoute, normalizeTargets, send } from '../lib/routes.js'

const CWD = 'C:\\fixture'
const PROJECT = projectKey(CWD)
const PARENT = 'session-parent'
const CHILD = 'session-child'
const GRANDCHILD = 'session-grandchild'
const LONE = 'session-lone'

const failures = []
let passed = 0

async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log('ok   ' + name)
  } catch (error) {
    failures.push({ name, error })
    console.log('FAIL ' + name + '\n     ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error))
  }
}

const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A throwaway DSH home with two archived roots and their descendants. */
async function makeStore() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cleanup-'))
  const paths = resolvePaths({ dshHome: home })
  const project = join(paths.sessionsRoot, PROJECT)
  const ids = [PARENT, CHILD, GRANDCHILD, LONE]
  for (const id of ids) {
    const dir = join(project, encodeSegment(id))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x'.repeat(120) + id)
  }
  await mkdir(paths.projectionCacheRoot, { recursive: true })
  await writeFile(join(paths.projectionCacheRoot, PARENT + '.json'), '{"cache":true}')
  const workspace = {
    version: 2,
    global: { archivedSessionIds: [PARENT] },
    tables: { workspaces: { 'ws-1': { path: CWD, title: 'Fixture', sessionIds: [PARENT, LONE] } } },
  }
  await mkdir(paths.storagesRoot, { recursive: true })
  await writeFile(paths.workspaceFile, JSON.stringify(workspace, null, 2))
  return { home, paths, project, ids }
}

const HEADERS = [
  { id: PARENT, cwd: CWD },
  { id: CHILD, cwd: CWD, parentSession: PARENT },
  { id: GRANDCHILD, cwd: CWD, parentSession: CHILD },
  { id: LONE, cwd: CWD },
]

function makeCtx({ archived = [PARENT], live = [], headers = HEADERS, workspaces = [PARENT, LONE] } = {}) {
  const bag = [...archived]
  const calls = { detach: [], unarchive: [] }
  const entities = workspaces.map(() => ({
    id: 'ws-1',
    detachSession: async (sessionId) => { calls.detach.push(sessionId) },
  }))
  const registry = {
    get archivedSessionIds() { return [...bag] },
    list: () => entities,
    unarchiveSession: async (sessionId) => {
      calls.unarchive.push(sessionId)
      const at = bag.indexOf(sessionId)
      if (at >= 0) bag.splice(at, 1)
    },
  }
  const ctx = {
    workspaceRegistry: registry,
    logger: { warn() {}, info() {}, error() {} },
    get(name) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessionQuery') return { listSessions: async () => headers.map(header => ({ header })) }
      if (name === 'sessions') return { list: () => live.map(id => ({ id })) }
      return undefined
    },
  }
  return { ctx, calls, bag }
}

await test('plan covers an archived root and its subagent chain', async () => {
  const store = await makeStore()
  const { ctx } = makeCtx()
  const plan = await buildPlan(ctx, store.paths, [{ sessionId: PARENT }])
  assert.equal(plan.entries.length, 3)
  assert.deepEqual(plan.entries.map(entry => entry.kind), ['archived', 'subagent', 'subagent'])
  assert.ok(plan.entries.every(entry => entry.status === 'delete'))
  const summary = summarize(plan)
  assert.deepEqual(summary.totals, { sessions: 3, archived: 1, subagents: 2, bytes: summary.totals.bytes })
  assert.equal(summary.descendantScan, 'complete')
  await rm(store.home, { recursive: true, force: true })
})

await test('execute backs up, deletes, and clears registry state', async () => {
  const store = await makeStore()
  const { ctx, calls, bag } = makeCtx()
  const plan = await buildPlan(ctx, store.paths, [{ sessionId: PARENT }])
  const result = await executePlan(ctx, store.paths, plan)

  assert.equal(result.ok, true)
  assert.equal(result.deleted.length, 3)
  assert.ok(result.freedBytes > 0)
  assert.ok(result.backupDir && await exists(result.backupDir))

  const backupProject = join(result.backupDir, 'sessions', PROJECT)
  assert.ok(await exists(join(backupProject, encodeSegment(PARENT), 'session.v4.jsonl.zstd')))
  assert.ok(await exists(join(backupProject, encodeSegment(GRANDCHILD), 'session.v4.jsonl.zstd')))
  const manifest = JSON.parse(await readFile(join(result.backupDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.sessions.length, 3)
  assert.equal(manifest.projectionCache.length, 1)
  assert.ok(await exists(join(result.backupDir, 'workspace.json')))

  assert.equal(await exists(join(store.project, encodeSegment(PARENT))), false)
  assert.equal(await exists(join(store.project, encodeSegment(CHILD))), false)
  assert.equal(await exists(join(store.paths.projectionCacheRoot, PARENT + '.json')), false)
  assert.equal(await exists(join(store.project, encodeSegment(LONE))), true)

  assert.deepEqual([...bag], [])
  assert.equal(calls.unarchive.length, 3)
  assert.deepEqual([...new Set(calls.detach)].sort(), [CHILD, GRANDCHILD, PARENT].sort())
  await rm(store.home, { recursive: true, force: true })
})

await test('unarchived targets are skipped, not deleted', async () => {
  const store = await makeStore()
  const { ctx } = makeCtx()
  const plan = await buildPlan(ctx, store.paths, [{ sessionId: LONE }])
  assert.equal(plan.entries.length, 0)
  assert.deepEqual(plan.skipped, [{ sessionId: LONE, reason: 'not-archived' }])
  const result = await executePlan(ctx, store.paths, plan)
  assert.equal(result.ok, true)
  assert.equal(result.backupDir, null)
  assert.ok(await exists(join(store.project, encodeSegment(LONE))))
  await rm(store.home, { recursive: true, force: true })
})

await test('live sessions are refused, and their subagents are kept', async () => {
  const store = await makeStore()
  const { ctx } = makeCtx({ live: [PARENT] })
  const plan = await buildPlan(ctx, store.paths, [{ sessionId: PARENT }])
  assert.deepEqual(plan.skipped, [{ sessionId: PARENT, reason: 'in-use' }])
  assert.equal(plan.entries.length, 0)
  const result = await executePlan(ctx, store.paths, plan)
  assert.equal(result.deleted.length, 0)
  assert.ok(await exists(join(store.project, encodeSegment(CHILD))))
  await rm(store.home, { recursive: true, force: true })
})

await test('a missing session directory is reported, not invented', async () => {
  const store = await makeStore()
  const { ctx } = makeCtx({ archived: ['session-nowhere'], headers: [] })
  const plan = await buildPlan(ctx, store.paths, [{ sessionId: 'session-nowhere' }])
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.entries[0].status, 'skip')
  assert.equal(plan.entries[0].reason, 'missing')
  const result = await executePlan(ctx, store.paths, plan)
  assert.equal(result.deleted.length, 0)
  assert.deepEqual(result.skipped, [{ sessionId: 'session-nowhere', reason: 'missing' }])
  await rm(store.home, { recursive: true, force: true })
})

await test('the backup directory never lands below the sessions root and is timestamped', async () => {
  const store = await makeStore()
  const { ctx } = makeCtx()
  const plan = await buildPlan(ctx, store.paths, [{ sessionId: PARENT }])
  const result = await executePlan(ctx, store.paths, plan)
  assert.ok(result.backupDir.startsWith(store.paths.backupRoot))
  assert.match(result.backupDir.slice(store.paths.backupRoot.length), /cleanup-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/)
  await rm(store.home, { recursive: true, force: true })
})

await test('normalizeTargets accepts the documented shapes and bounds the count', async () => {
  assert.deepEqual(normalizeTargets(['a', 'b'], {}), [{ sessionId: 'a' }, { sessionId: 'b' }])
  assert.deepEqual(normalizeTargets([{ sessionId: 'a', cwd: 'C:\\x' }], {}), [{ sessionId: 'a', cwd: 'C:\\x' }])
  assert.deepEqual(normalizeTargets(undefined, { sessionIds: ['a'] }), [{ sessionId: 'a' }])
  assert.deepEqual(normalizeTargets(['a', 'a'], {}), [{ sessionId: 'a' }])
  assert.equal(normalizeTargets([], {}), null)
  assert.equal(normalizeTargets('nope', {}), null)
  assert.equal(normalizeTargets([{ sessionId: '' }], {}), null)
  assert.equal(normalizeTargets([{ sessionId: 'x'.repeat(513) }], {}), null)
  assert.equal(normalizeTargets(Array.from({ length: MAX_TARGETS + 1 }, (_, i) => 's' + i), {}), null)
})

await test('fallbackRejection refuses cross-site, foreign origin, and non-loopback hosts', () => {
  assert.equal(fallbackRejection({ headers: { 'sec-fetch-site': 'cross-site' } }), 403)
  assert.equal(fallbackRejection({ headers: { host: '127.0.0.1:10360', origin: 'http://evil.test' } }), 403)
  assert.equal(fallbackRejection({ headers: { host: '192.168.1.9:10360' } }), 403)
  assert.equal(fallbackRejection({ headers: { host: '127.0.0.1:10360' } }), undefined)
  assert.equal(fallbackRejection({ headers: { host: 'localhost:3000', origin: 'http://localhost:3000' } }), undefined)
  assert.equal(fallbackRejection({ headers: { host: '[::1]:3000' } }), undefined)
})

await test('guardRoute writes a JSON 403 and otherwise calls through', async () => {
  const route = { kind: 'exact', path: '/archived-cleanup/info', handler: (req, res) => send(res, 200, { ok: true }) }
  const guarded = guardRoute(route, () => undefined)

  const blocked = capture()
  await guarded.handler({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }, blocked.res)
  assert.equal(blocked.status, 403)
  assert.deepEqual(JSON.parse(blocked.body), { ok: false, error: 'forbidden' })

  const allowed = capture()
  await guarded.handler({ method: 'GET', headers: { host: '127.0.0.1:10360' } }, allowed.res)
  assert.equal(allowed.status, 200)
  assert.deepEqual(JSON.parse(allowed.body), { ok: true })
})

await test('connectionRoute carries a request into the legacy handler and back', async () => {
  const route = {
    kind: 'exact',
    path: '/archived-cleanup/echo',
    handler: async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      send(res, 200, { method: req.method, body: Buffer.concat(chunks).toString('utf8') })
    },
  }
  const response = await connectionRoute(route).fetch(new Request('http://127.0.0.1:10360/api/archived-cleanup/echo?x=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: '世界' }),
  }))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  assert.deepEqual(await response.json(), { method: 'POST', body: JSON.stringify({ hello: '世界' }) })
})

await test('send works through the writeHead adapter too', () => {
  const output = { status: 0, headers: {}, body: '' }
  send({
    writeHead: (status, headers) => { output.status = status; output.headers = headers },
    end: (body) => { output.body = body },
  }, 201, { ok: true })
  assert.equal(output.status, 201)
  assert.equal(output.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(output.body), { ok: true })
})

await test('the session store walk stays inside the project directory', async () => {
  const store = await makeStore()
  const entries = await readdir(store.project)
  assert.deepEqual(entries.sort(), [CHILD, GRANDCHILD, LONE, PARENT].sort())
  // A sibling project directory must never be scanned as this session's home.
  await mkdir(join(store.paths.sessionsRoot, '--C-other--', encodeSegment(LONE)), { recursive: true })
  const { ctx } = makeCtx()
  const plan = await buildPlan(ctx, store.paths, [{ sessionId: LONE, cwd: 'C:\\other' }])
  assert.equal(plan.entries.length, 0)
  assert.deepEqual(plan.skipped, [{ sessionId: LONE, reason: 'not-archived' }])
  await rm(store.home, { recursive: true, force: true })
})

await test('a cordis-style context is read through get(), never properties', async () => {
  const store = await makeStore()
  const { ctx } = makeCtx()
  // Mirror the Context proxy: reading any service property without `inject`
  // throws, which is exactly how a user request failed before this guard.
  const strict = new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === 'get') return Reflect.get(target, prop, receiver)
      throw new Error('cannot get property "' + String(prop) + '" without inject')
    },
  })
  const plan = await buildPlan(strict, store.paths, [{ sessionId: PARENT }])
  assert.equal(plan.entries.length, 3)
  const result = await executePlan(strict, store.paths, plan)
  assert.equal(result.ok, true)
  assert.equal(result.deleted.length, 3)
  await rm(store.home, { recursive: true, force: true })
})

await test('reveal resolves the backup root, creating it on first use', async () => {
  const store = await makeStore()
  await rm(store.paths.backupRoot, { recursive: true, force: true })
  const target = await resolveRevealTarget(store.paths, undefined)
  assert.equal(target, store.paths.backupRoot)
  assert.equal(await exists(store.paths.backupRoot), true)
  await rm(store.home, { recursive: true, force: true })
})

await test('reveal refuses traversal and names outside the backup root', async () => {
  const store = await makeStore()
  await mkdir(join(store.paths.backupRoot, 'cleanup-backup-2026-11-24T06-57-15'), { recursive: true })
  await writeFile(join(store.paths.backupRoot, 'cleanup-backup-note.txt'), 'x')

  const ok = await resolveRevealTarget(store.paths, 'cleanup-backup-2026-11-24T06-57-15')
  assert.equal(ok, join(store.paths.backupRoot, 'cleanup-backup-2026-11-24T06-57-15'))

  for (const name of ['../../etc', 'C:\\Windows', 'cleanup-backup-..\\x', 'other-dir']) {
    await assert.rejects(resolveRevealTarget(store.paths, name), error => error.status === 400 && error.code === 'invalid-backup')
  }
  await assert.rejects(
    resolveRevealTarget(store.paths, 'cleanup-backup-missing'),
    error => error.status === 404 && error.code === 'backup-missing',
  )
  await assert.rejects(
    resolveRevealTarget(store.paths, 'cleanup-backup-note.txt'),
    error => error.status === 404 && error.code === 'backup-missing',
  )
  await rm(store.home, { recursive: true, force: true })
})

await test('reveal hands the folder to the injected file-manager seam', async () => {
  const store = await makeStore()
  await mkdir(join(store.paths.backupRoot, 'cleanup-backup-2026-11-24T06-57-15'), { recursive: true })
  const opened = []
  const target = await revealBackup(store.paths, 'cleanup-backup-2026-11-24T06-57-15', {
    openFolder: async dir => opened.push(dir),
  })
  assert.deepEqual(opened, [target])
  await rm(store.home, { recursive: true, force: true })
})

function capture() {
  const state = { status: 200, body: '', headers: {} }
  return {
    get status() { return state.status },
    get body() { return state.body },
    get headers() { return state.headers },
    res: {
      get statusCode() { return state.status },
      set statusCode(value) { state.status = value },
      setHeader(key, value) { state.headers[String(key).toLowerCase()] = value },
      end(body) { state.body = String(body) },
    },
  }
}

console.log('')
if (failures.length > 0) {
  console.error(failures.length + ' failing, ' + passed + ' passing')
  process.exit(1)
}
console.log(passed + ' passing')
