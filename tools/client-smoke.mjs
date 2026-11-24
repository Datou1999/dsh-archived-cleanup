// Smoke test for the browser half: loads client.js the way the shell does, runs
// `apply` against a fake slot registry, then renders the Settings section with a
// tiny React stand-in. Catches typos and dead references without the app.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/* ---------------------------------------------------------------- React stub */

let hooks = null

const React = {
  createElement(type, props, ...children) {
    return { el: true, type, props: { ...(props ?? {}), children } }
  },
  useState(initial) {
    const slot = hooks.next()
    if (slot.value === undefined) slot.value = typeof initial === 'function' ? initial() : initial
    slot.set = (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next
    }
    return [slot.value, slot.set]
  },
  useMemo(factory) { return factory() },
  useCallback(fn) { return fn },
  useEffect(effect) { hooks.effects.push(effect) },
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
}

function resetHooks() {
  const slots = []
  let cursor = 0
  const frame = { effects: [] }
  frame.next = () => {
    if (cursor >= slots.length) slots.push({ value: undefined })
    return slots[cursor++]
  }
  hooks = frame
  return frame
}

/** Render one function component in its own hook frame, then run its effects. */
function renderComponent(component, props) {
  const previous = hooks
  const frame = resetHooks()
  const rendered = component(props)
  hooks = previous
  for (const effect of frame.effects) effect()
  return rendered
}

/* ------------------------------------------------------- shell environment */

const requests = []
const respond = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const info = {
  ok: true,
  home: 'C:\\fake\\.dsh',
  backupRoot: 'C:\\fake\\.dsh\\cleanup-backups',
  sessions: [
    { sessionId: 's-a', live: false, found: true, bytes: 2048, files: 1, directory: 'C:\\fake\\sessions\\p\\s-a' },
  ],
  totals: { archived: 1, found: 1, bytes: 2048 },
  backups: [{ name: 'cleanup-backup-2026-11-24T06-57-15', createdAt: '2026-11-24T06:57:15.000Z' }],
}

const context = vm.createContext({
  console,
  URL,
  Date,
  setTimeout,
  navigator: { language: 'zh-CN' },
  document: { baseURI: 'http://127.0.0.1:10360/' },
  Response,
  fetch: async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET' })
    if (String(url).endsWith('/delete')) {
      return respond({ ok: true, deleted: [{ sessionId: 's-a', kind: 'archived', bytes: 2048, files: 1 }], skipped: [], errors: [], freedBytes: 2048, backupDir: 'C:\\fake\\.dsh\\cleanup-backups\\cleanup-backup-x' })
    }
    return respond(info)
  },
  window: {
    location: { protocol: 'http:', href: 'http://127.0.0.1:10360/' },
    __ModuleLoader__: { load(entry) { context.loaded.push(entry) } },
  },
})
context.loaded = []

vm.runInContext(source, context, { filename: 'client.js' })
assert.equal(context.loaded.length, 1, 'client.js registers exactly one module')
const entry = context.loaded[0]
assert.equal(entry.id, 'dsh-archived-cleanup')

const client = entry.factory(name => {
  assert.equal(name, 'react', 'the browser half only requires react')
  return React
})
assert.ok(Array.isArray(client.inject), 'module declares inject')
assert.equal(typeof client.apply, 'function')

/* ------------------------------------------------------- fake host context */

const registered = new Map()
const disposers = []

function renderSlot(spec, component) {
  registered.set(spec.name + ':' + spec.id, { spec, component })
  const dispose = () => registered.delete(spec.name + ':' + spec.id)
  disposers.push(dispose)
  return dispose
}

const workspacesSnapshot = {
  archivedSessionIds: ['s-a'],
  items: [{ workspaceId: 'w1', title: '默认工作区', path: 'C:\\work', sessionIds: ['s-a'] }],
}
const sessionsSnapshot = {
  ids: ['s-a', 's-b'],
  byId: {
    's-a': { id: 's-a', title: '修复登录 bug', displayTitle: '修复登录 bug', updatedAt: Date.now() - 120000, running: false, cwd: 'C:\\work' },
    's-b': { id: 's-b', title: '子任务', displayTitle: '子任务', updatedAt: Date.now(), parentId: 's-a', running: false },
  },
}

const listOf = (snapshot) => ({
  subscribe() { return () => {} },
  getSnapshot() { return snapshot },
})

const inner = {
  get(name) {
    if (name === 'sessions') return { list: listOf(sessionsSnapshot), refresh: async () => { requests.push({ url: 'refresh' }) } }
    if (name === 'workspaces') return { list: listOf(workspacesSnapshot) }
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
}

const slotsService = {
  inject(name, register) {
    assert.equal(typeof name, 'string')
    return register()
  },
  register(spec, component) {
    return renderSlot(spec, component)
  },
}

const ctx = {
  get(name) {
    return name === 'slots' ? slotsService : undefined
  },
  inject(deps, callback) {
    assert.equal(Array.from(deps).join(','), 'sessions,workspaces')
    callback(inner)
  },
}

client.apply(ctx)

/* The Settings section must appear before the optional services do. */
{
  const earlyRegistered = new Map()
  const earlyClient = entry.factory(() => React)
  earlyClient.apply({
    get: name => (name === 'slots' ? {
      inject(slotName, register) { return register() },
      register(spec, component) { earlyRegistered.set(spec.name + ':' + spec.id, { spec, component }) },
    } : undefined),
    inject() { /* the section must already be registered; the callback may never run */ },
  })
  assert.ok(earlyRegistered.has('settings.section:archived-cleanup'), 'registers the section without the Session service')
}

const section = registered.get('settings.section:archived-cleanup')
assert.ok(section, 'registers the settings.section entry')
assert.equal(section.spec.order, 45)
assert.equal(typeof section.spec.label, 'function')
assert.equal(section.spec.label(), '归档会话清理')
assert.ok(registered.has('settings.section.icon:archived-cleanup'), 'registers the section icon')

/* ------------------------------------------------------------ render pass */

function flatten(node, out) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (typeof node.type === 'function') {
    flatten(renderComponent(node.type, node.props), out)
    return out
  }
  flatten(node.props?.children, out)
  return out
}

const Page = section.component
const tree = renderComponent(Page, { close() {} })
const text = flatten(tree, []).join('|')

assert.match(text, /打开备份文件夹/, 'offers the backup-folder entry')
assert.match(text, /归档只会把会话从侧栏隐藏/)
assert.match(text, /修复登录 bug/, 'shows the archived Session title')
assert.match(text, /1 个子会话/, 'counts the sub-Session')
assert.match(text, /永久删除所选/, 'offers the delete action')
assert.match(text, /默认工作区/, 'groups by workspace title')

await new Promise(resolve => setTimeout(resolve, 0))
assert.ok(requests.some(request => request.url === '/archived-cleanup/info' && request.method === 'GET'), 'reads Host facts through the web route')

console.log('client smoke: ' + text.length + ' chars rendered, ' + requests.length + ' request(s) issued')
console.log('client smoke: ok')
