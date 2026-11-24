/**
 * File-manager hand-off for the backup directory.
 *
 * The Settings page can only show paths; opening the folder is a Host action.
 * Everything here stays inside `$DSH_HOME/cleanup-backups`: a request may name
 * one existing backup directory, never an arbitrary path on the machine.
 */

import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { isInside } from './paths.js'

/** A backup directory name this bundle itself creates. */
const BACKUP_NAME = /^cleanup-backup-[0-9A-Za-z._-]{1,120}$/

/**
 * Build an error carrying the HTTP status the route should answer with.
 * @param {number} status - HTTP status.
 * @param {string} code - machine-readable error code.
 * @param {string} message - human-readable explanation.
 * @returns {Error} error with `status` and `code`.
 */
function requestError(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/**
 * Resolve the folder a reveal request may open.
 * @param {object} paths - resolved store paths.
 * @param {unknown} name - optional backup directory name from the request.
 * @returns {Promise<string>} absolute directory inside the backup root.
 */
export async function resolveRevealTarget(paths, name) {
  const root = resolve(paths.backupRoot)

  if (name === undefined || name === null || name === '') {
    // The entry must work before the first cleanup, so the root is created.
    await mkdir(root, { recursive: true })
    return root
  }

  if (typeof name !== 'string' || !BACKUP_NAME.test(name)) {
    throw requestError(400, 'invalid-backup', 'not a backup directory name')
  }

  const target = resolve(join(root, name))
  if (!isInside(root, target) || target === root) {
    throw requestError(400, 'invalid-backup', 'backup directory is outside the backup root')
  }

  let facts
  try {
    facts = await stat(target)
  } catch {
    throw requestError(404, 'backup-missing', 'backup directory does not exist')
  }
  if (!facts.isDirectory()) throw requestError(404, 'backup-missing', 'backup entry is not a directory')

  return target
}

/**
 * Open a directory in the platform file manager, detached from this process.
 * @param {string} dir - absolute directory to show.
 * @param {object} options - overrides for tests.
 * @param {string} options.platform - `process.platform` override.
 * @param {Function} options.spawnImpl - `child_process.spawn` override.
 * @returns {Promise<void>} resolves once the helper process started.
 */
export function openInFileManager(dir, options = {}) {
  const platform = options.platform ?? process.platform
  const spawnImpl = options.spawnImpl ?? spawn
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open'

  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawnImpl(command, [dir], { detached: true, stdio: 'ignore' })
    } catch (error) {
      rejectPromise(error)
      return
    }
    child.once('error', rejectPromise)
    child.once('spawn', () => {
      try {
        child.unref()
      } catch {
        // A child that already exited has nothing to detach.
      }
      resolvePromise()
    })
  })
}

/**
 * Reveal the backup root, or one named backup inside it.
 * @param {object} paths - resolved store paths.
 * @param {unknown} name - optional backup directory name.
 * @param {object} options - `openFolder(dir)` seam for tests, plus the
 *   `platform`/`spawnImpl` overrides for {@link openInFileManager}.
 * @returns {Promise<string>} the directory the file manager was pointed at.
 */
export async function revealBackup(paths, name, options = {}) {
  const target = await resolveRevealTarget(paths, name)
  if (typeof options.openFolder === 'function') {
    await options.openFolder(target)
  } else {
    await openInFileManager(target, options)
  }
  return target
}
