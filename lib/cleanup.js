/**
 * Deletion engine for archived Sessions.
 *
 * The flow is deliberately staged so a failure can never leave a half-deleted
 * store: resolve and validate every target first, write the backup second, and
 * only then remove anything. A Session that is live, not archived, or already
 * gone is reported instead of touched.
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { serviceOf, warn } from './context.js'
import {
  copyInto,
  createBackupDir,
  findSessionDir,
  isInside,
  readWorkspaceRegistry,
  removeSessionArtifacts,
  sha256File,
  walkFiles,
  writeManifest,
} from './paths.js'

/** Upper bound on ids accepted in one request. */
export const MAX_TARGETS = 500

/**
 * Read every persisted Session header once so descendant subagent Sessions can
 * be removed together with their archived parent.
 * @param {object} ctx - plugin context.
 * @returns {Promise<{headers: Array<object>, available: boolean}>} headers plus availability.
 */
export async function readHeaders(ctx) {
  const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  if (query === undefined || typeof query.listSessions !== 'function') {
    return { headers: [], available: false }
  }
  try {
    const records = await query.listSessions()
    const headers = []
    for (const record of records ?? []) {
      const header = record?.header
      if (header && typeof header.id === 'string') headers.push(header)
    }
    return { headers, available: true }
  } catch (error) {
    warn(ctx, 'archived-cleanup: session list unavailable: %s', error)
    return { headers: [], available: false }
  }
}

/**
 * IDs of every stored Session that currently waits on `sessionId`, transitively.
 * @param {Array<object>} headers - all persisted headers.
 * @param {ReadonlySet<string>} roots - archived roots.
 * @returns {Map<string, string>} descendant id to its direct parent id.
 */
export function descendants(headers, roots) {
  const found = new Map()
  const parents = new Map()
  for (const header of headers) {
    if (typeof header.parentSession === 'string') parents.set(header.id, header.parentSession)
  }
  let grew = true
  while (grew) {
    grew = false
    for (const [child, parent] of parents) {
      if (found.has(child)) continue
      if (roots.has(parent) || found.has(parent)) {
        found.set(child, parent)
        grew = true
      }
    }
  }
  return found
}

/**
 * Build the complete, validated deletion plan.
 * @param {object} ctx - plugin context.
 * @param {object} paths - resolved store paths.
 * @param {Array<{sessionId: string, cwd?: string}>} targets - requested sessions.
 * @returns {Promise<{entries: Array<object>, mediaRoot: string}>} plan entries and the sessions root.
 */
export async function buildPlan(ctx, paths, targets) {
  const registry = serviceOf(ctx, 'workspaceRegistry')
  const archived = new Set(registry?.archivedSessionIds ?? [])
  const live = new Set()
  try {
    for (const session of ctx.get('sessions')?.list?.() ?? []) live.add(session.id)
  } catch {
    // A composition without the session store simply has no live sessions.
  }

  const { headers, available } = await readHeaders(ctx)
  const byId = new Map(headers.map(header => [header.id, header]))
  const workingDirectories = new Map()
  for (const header of headers) {
    if (typeof header.cwd === 'string') workingDirectories.set(header.id, header.cwd)
  }

  const roots = new Set()
  const skipped = []
  for (const target of targets) {
    if (!archived.has(target.sessionId)) {
      skipped.push({ sessionId: target.sessionId, reason: 'not-archived' })
      continue
    }
    if (live.has(target.sessionId)) {
      skipped.push({ sessionId: target.sessionId, reason: 'in-use' })
      continue
    }
    roots.add(target.sessionId)
    if (typeof target.cwd === 'string' && target.cwd.trim()) workingDirectories.set(target.sessionId, target.cwd)
    else if (byId.get(target.sessionId)?.cwd) workingDirectories.set(target.sessionId, byId.get(target.sessionId).cwd)
  }

  const children = descendants(headers, roots)
  const entries = []
  const seen = new Set()
  for (const sessionId of roots) {
    seen.add(sessionId)
    entries.push(await planEntry(paths, sessionId, workingDirectories, live, 'archived'))
  }
  for (const [sessionId, parentId] of children) {
    if (seen.has(sessionId)) continue
    seen.add(sessionId)
    if (live.has(sessionId)) {
      skipped.push({ sessionId, reason: 'in-use' })
      continue
    }
    entries.push(await planEntry(paths, sessionId, workingDirectories, live, 'subagent', parentId))
  }

  return {
    entries,
    skipped,
    descendantScan: available ? 'complete' : 'unavailable',
    sessionsRoot: paths.sessionsRoot,
  }
}

/**
 * Resolve one session's directory and on-disk footprint.
 * @param {object} paths - resolved store paths.
 * @param {string} sessionId - target session.
 * @param {Map<string, string>} workingDirectories - known cwd per session id.
 * @param {Set<string>} live - live session ids.
 * @param {'archived'|'subagent'} kind - why this session is included.
 * @param {string} [parentSessionId] - owning archived session for subagents.
 * @returns {Promise<object>} one plan entry.
 */
async function planEntry(paths, sessionId, workingDirectories, live, kind, parentSessionId) {
  const cwd = workingDirectories.get(sessionId)
  const dir = await findSessionDir(paths, sessionId, cwd)
  if (dir === null) {
    return {
      sessionId,
      kind,
      parentSessionId,
      cwd,
      status: 'skip',
      reason: 'missing',
      bytes: 0,
      files: 0,
    }
  }
  if (!isInside(paths.sessionsRoot, dir)) {
    return { sessionId, kind, parentSessionId, cwd, status: 'skip', reason: 'outside-root', bytes: 0, files: 0 }
  }
  const files = await walkFiles(dir)
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
  if (live.has(sessionId)) {
    return { sessionId, kind, parentSessionId, cwd, dir, status: 'skip', reason: 'in-use', bytes, files: files.length }
  }
  return {
    sessionId,
    kind,
    parentSessionId,
    cwd,
    dir,
    status: 'delete',
    bytes,
    files: files.length,
    fileList: files,
  }
}

/**
 * Summary of what a plan would remove, for the confirm step.
 * @param {object} plan - result of {@link buildPlan}.
 * @returns {object} portable summary without absolute directories.
 */
export function summarize(plan) {
  const deletable = plan.entries.filter(entry => entry.status === 'delete')
  return {
    deletable: deletable.map(entry => ({
      sessionId: entry.sessionId,
      kind: entry.kind,
      parentSessionId: entry.parentSessionId,
      cwd: entry.cwd,
      bytes: entry.bytes,
      files: entry.files,
      directory: entry.dir,
    })),
    skipped: plan.skipped,
    totals: {
      sessions: deletable.length,
      archived: deletable.filter(entry => entry.kind === 'archived').length,
      subagents: deletable.filter(entry => entry.kind === 'subagent').length,
      bytes: deletable.reduce((sum, entry) => sum + entry.bytes, 0),
    },
    descendantScan: plan.descendantScan,
  }
}

/**
 * Execute a plan: backup first, then remove files, then drop registry state.
 * @param {object} ctx - plugin context.
 * @param {object} paths - resolved store paths.
 * @param {object} plan - validated plan.
 * @returns {Promise<object>} per-session outcome.
 */
export async function executePlan(ctx, paths, plan) {
  const deletable = plan.entries.filter(entry => entry.status === 'delete')
  if (deletable.length === 0) {
    return {
      ok: true,
      deleted: [],
      skipped: [...plan.skipped, ...plan.entries.filter(entry => entry.status === 'skip').map(entry => ({ sessionId: entry.sessionId, reason: entry.reason }))],
      errors: [],
      freedBytes: 0,
      backupDir: null,
    }
  }

  const workspaceBefore = await readWorkspaceRegistry(paths.workspaceFile)
  const workspaceJsonSha256 = await sha256File(paths.workspaceFile)
  const backupDir = await createBackupDir(paths.backupRoot)

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    dshHome: paths.home,
    sessionsRoot: paths.sessionsRoot,
    workspaceJsonSha256,
    archivedSessionIdsBefore: Array.isArray(registryArchived(ctx)) ? [...registryArchived(ctx)] : [],
    restore:
      'Copy each entry below back over its recorded path, restore workspace.json, then restart DeepSeek Harness. '
      + 'Nothing in the registry was rewritten except the archive set and each workspace account list.',
    sessions: [],
    projectionCache: [],
  }

  // Phase 1 — backup. Any failure here aborts before a single byte is removed.
  const backedUp = []
  try {
    for (const entry of deletable) {
      const relative = entry.dir.slice(paths.sessionsRoot.length + 1)
      const target = join(backupDir, 'sessions', relative)
      const files = []
      for (const file of entry.fileList) {
        const destination = join(target, file.relative)
        await copyInto(file.path, destination)
        files.push({ path: file.relative, bytes: file.bytes })
      }
      manifest.sessions.push({
        sessionId: entry.sessionId,
        kind: entry.kind,
        parentSessionId: entry.parentSessionId,
        cwd: entry.cwd,
        directory: 'sessions/' + relative.split('\\').join('/'),
        absolutePath: entry.dir,
        bytes: entry.bytes,
        files,
      })
      backedUp.push(entry)
    }
    for (const entry of deletable) {
      const cache = join(paths.projectionCacheRoot, entry.sessionId + '.json')
      if (await exists(cache)) {
        manifest.projectionCache.push({
          sessionId: entry.sessionId,
          path: 'session_projcache/' + entry.sessionId + '.json',
          absolutePath: cache,
        })
        await copyInto(cache, join(backupDir, 'session_projcache', entry.sessionId + '.json'))
      }
    }
    await writeManifest(backupDir, manifest, paths.workspaceFile)
    if (workspaceBefore === null && workspaceJsonSha256 === null) {
      manifest.workspaceJsonSha256 = null
    }
  } catch (error) {
    return {
      ok: false,
      error: 'backup-failed',
      message: `backup failed, nothing was deleted: ${messageOf(error)}`,
      backupDir,
      deleted: [],
      skipped: [],
      errors: [],
      freedBytes: 0,
    }
  }

  // Phase 2 — remove files, then registry state. Each session is independent.
  const deleted = []
  const errors = []
  for (const entry of backedUp) {
    try {
      await removeSessionArtifacts(paths, entry.dir, entry.sessionId)
      await dropRegistryState(ctx, entry.sessionId)
      deleted.push({
        sessionId: entry.sessionId,
        kind: entry.kind,
        parentSessionId: entry.parentSessionId,
        bytes: entry.bytes,
        files: entry.files,
      })
    } catch (error) {
      errors.push({ sessionId: entry.sessionId, message: messageOf(error) })
    }
  }

  // Rewrite the manifest so it lists which sessions were actually removed.
  try {
    await writeManifest(backupDir, manifest, paths.workspaceFile)
  } catch {
    // The manifest is advisory; a rewrite failure does not undo the backup.
  }

  const skipped = [
    ...plan.skipped,
    ...plan.entries
      .filter(entry => entry.status === 'skip' && !plan.skipped.some(item => item.sessionId === entry.sessionId))
      .map(entry => ({ sessionId: entry.sessionId, reason: entry.reason })),
  ]

  return {
    ok: errors.length === 0,
    backupDir,
    deleted,
    skipped,
    errors,
    freedBytes: deleted.reduce((sum, entry) => sum + entry.bytes, 0),
  }
}

/** Current archive set, tolerant of a composition without a registry. */
function registryArchived(ctx) {
  return serviceOf(ctx, 'workspaceRegistry')?.archivedSessionIds ?? []
}

/**
 * Detach a removed Session from workspace accounting and drop its archive entry.
 * Both calls are idempotent, and neither inspects the deleted log.
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - removed session.
 */
async function dropRegistryState(ctx, sessionId) {
  const registry = serviceOf(ctx, 'workspaceRegistry')
  if (registry === undefined) return
  try {
    for (const workspace of registry.list()) {
      try {
        await workspace.detachSession(sessionId)
      } catch (error) {
        warn(ctx, 'archived-cleanup: detach %s failed: %s', sessionId, error)
      }
    }
  } catch (error) {
    warn(ctx, 'archived-cleanup: workspace list failed: %s', error)
  }
  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    // The log is already gone; a registry hiccup must not mask that success.
    warn(ctx, 'archived-cleanup: unarchive %s failed: %s', sessionId, error)
  }
}

/** Whether a path exists; never throws. */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Stable message text for an unknown thrown value. */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
