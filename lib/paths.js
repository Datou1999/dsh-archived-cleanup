/**
 * Filesystem view of the session store for the archived-cleanup bundle.
 *
 * DeepSeek Harness keeps every Session as a directory below
 * `$DSH_HOME/sessions/<project-key>/<session-id>/session.v4.jsonl.zstd`, and
 * the workspace registry in `$DSH_HOME/storages/workspace.json`. Nothing in
 * the Host exposes a "delete this session" call, so the only way to reclaim
 * the space is to remove those artifacts ourselves — carefully, with a
 * backup, and only after the caller proved the Session is archived.
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'

/** Maximum directory depth walked inside one session directory. */
const MAX_WALK_DEPTH = 6

/** Stamp format for backup directories; the earlier manual cleanup used the same shape. */
const BACKUP_PREFIX = 'cleanup-backup-'

/**
 * Resolve every path this bundle touches from the plugin config and the
 * harness home, following `@deepseek-ai/dsh-home-paths` precedence.
 * @param {object} config - validated plugin config.
 * @returns {{home: string, sessionsRoot: string, storagesRoot: string, workspaceFile: string, projectionCacheRoot: string, backupRoot: string}}
 */
export function resolvePaths(config = {}) {
  const home = resolveHome(config.dshHome)
  const sessionsRoot = typeof config.sessionsRoot === 'string' && config.sessionsRoot.trim()
    ? resolve(config.sessionsRoot)
    : join(home, 'sessions')
  const storagesRoot = join(home, 'storages')
  return {
    home,
    sessionsRoot,
    storagesRoot,
    workspaceFile: join(storagesRoot, 'workspace.json'),
    projectionCacheRoot: join(storagesRoot, 'session_projcache'),
    backupRoot: join(home, 'cleanup-backups'),
  }
}

/**
 * Resolve the harness home: an explicit config value, then `$DSH_HOME`, then `~/.dsh`.
 * @param {unknown} configured - explicit override from plugin config.
 * @returns {string} absolute home directory.
 */
export function resolveHome(configured) {
  if (typeof configured === 'string' && configured.trim()) return resolve(configured)
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return env ? resolve(env) : join(homedir(), '.dsh')
}

/**
 * Encode an arbitrary id as one safe path segment.
 * Mirrors the persistence backend so we address exactly the directory it wrote,
 * and neutralizes separators and traversal before any filesystem use.
 * @param {string} raw - session id.
 * @returns {string} safe single segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Build the readable project directory key for a cwd.
 * @param {string} cwd - session working directory.
 * @returns {string} one filesystem-safe project directory name.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** One session's directory name, independent of its project directory. */
export function sessionDirName(sessionId) {
  return encodeSegment(sessionId)
}

/**
 * Prove a directory really lives below the sessions root before touching it.
 * @param {string} root - configured sessions root.
 * @param {string} dir - candidate directory.
 * @returns {boolean} whether the candidate is a strict descendant of root.
 */
export function isInside(root, dir) {
  const rootResolved = resolve(root)
  const dirResolved = resolve(dir)
  return dirResolved.startsWith(rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep)
}

/**
 * Locate one session directory: the exact computed path first, then a shallow
 * scan for the same directory name (covers a stale or unknown cwd).
 * @param {{sessionsRoot: string}} paths - resolved store paths.
 * @param {string} sessionId - target session.
 * @param {string} [cwd] - known working directory, when the caller has one.
 * @returns {Promise<string|null>} the directory, or null when it is absent.
 */
export async function findSessionDir(paths, sessionId, cwd) {
  const name = sessionDirName(sessionId)
  const candidates = []
  if (typeof cwd === 'string' && cwd.trim()) {
    candidates.push(join(paths.sessionsRoot, projectKey(cwd), name))
  }
  for (const candidate of candidates) {
    if (!isInside(paths.sessionsRoot, candidate)) continue
    if (await isDirectory(candidate)) return candidate
  }
  let entries
  try {
    entries = await readdir(paths.sessionsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(paths.sessionsRoot, entry.name, name)
    if (await isDirectory(candidate)) return candidate
  }
  return null
}

/** Whether a path is an existing directory; never throws. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Enumerate every regular file below one session directory.
 * @param {string} dir - session directory.
 * @returns {Promise<Array<{path: string, relative: string, bytes: number}>>} files in walk order.
 */
export async function walkFiles(dir) {
  const files = []
  const walk = async (current, depth) => {
    if (depth > MAX_WALK_DEPTH) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(child, depth + 1)
      } else if (entry.isFile()) {
        try {
          const info = await stat(child)
          files.push({ path: child, relative: child.slice(dir.length + 1), bytes: info.size })
        } catch {
          // A file that vanished mid-walk simply is not part of the backup.
        }
      }
    }
  }
  await walk(dir, 0)
  return files
}

/**
 * Copy one file, creating its backup parent first.
 * @param {string} from - source file.
 * @param {string} to - destination file.
 */
export async function copyInto(from, to) {
  await mkdir(dirname(to), { recursive: true, mode: 0o700 })
  await copyFile(from, to)
}

/**
 * Read and parse the workspace registry; absent or invalid files degrade to null.
 * @param {string} file - workspace.json path.
 * @returns {Promise<object|null>} parsed registry.
 */
export async function readWorkspaceRegistry(file) {
  try {
    const text = await readFile(file, 'utf8')
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * Hash a file's bytes, or return null when it is unreadable.
 * @param {string} file - file path.
 * @returns {Promise<string|null>} lowercase sha256 hex.
 */
export async function sha256File(file) {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex')
  } catch {
    return null
  }
}

/**
 * Create a fresh backup directory for this deletion run.
 * @param {string} backupRoot - parent directory for backups.
 * @returns {Promise<string>} created directory.
 */
export async function createBackupDir(backupRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = join(backupRoot, BACKUP_PREFIX + stamp)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * Write the backup manifest and the pre-change registry copy.
 * @param {string} backupDir - destination backup directory.
 * @param {object} manifest - manifest payload.
 * @param {string} workspaceFile - current workspace.json path.
 */
export async function writeManifest(backupDir, manifest, workspaceFile) {
  await mkdir(backupDir, { recursive: true, mode: 0o700 })
  await writeFile(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  try {
    await copyFile(workspaceFile, join(backupDir, 'workspace.json'))
  } catch {
    // A registry file that does not exist yet needs no backup copy.
  }
}

/**
 * Remove one session directory and its projection cache entry.
 * @param {object} paths - resolved store paths.
 * @param {string} dir - session directory to remove.
 * @param {string} sessionId - session id, for the cache file.
 * @returns {Promise<void>}
 */
export async function removeSessionArtifacts(paths, dir, sessionId) {
  if (!isInside(paths.sessionsRoot, dir)) {
    throw new Error('refusing to delete a directory outside the sessions root')
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  const names = [sessionId + '.json', sessionDirName(sessionId) + '.json']
  for (const name of names) {
    try {
      await rm(join(paths.projectionCacheRoot, name), { force: true })
    } catch {
      // A cache entry that is absent or locked is not a deletion failure.
    }
  }
}
