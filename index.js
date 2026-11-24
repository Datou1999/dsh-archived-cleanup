/**
 * Host half of the archived-cleanup bundle.
 *
 * Archiving a Session only hides it from the grouping surfaces; the log keeps
 * living in `$DSH_HOME/sessions`. DeepSeek Harness exposes no delete API, so
 * this bundle removes the artifacts for Sessions the user explicitly picked in
 * the Settings page, after copying them into `$DSH_HOME/cleanup-backups/`.
 *
 * The bundle declares no hard service dependency: every service it needs is
 * looked up lazily, so it keeps working in compositions without a Web server or
 * without a workspace registry.
 */

import { info } from './lib/context.js'
import { registerRoutes } from './lib/routes.js'
import { resolvePaths } from './lib/paths.js'

export const name = 'archived-cleanup'

/**
 * Register the bundle's HTTP routes.
 * @param {object} ctx - plugin context.
 * @param {object} config - plugin config.
 */
export function apply(ctx, config = {}) {
  const paths = resolvePaths(config)
  registerRoutes(ctx, paths, config)
  info(ctx, 'archived-cleanup: routes under /archived-cleanup (sessions in %s)', paths.sessionsRoot)
}
