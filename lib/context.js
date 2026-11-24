/**
 * Context helpers for a bundle that must stay loadable in every composition.
 *
 * A service read as a property (`ctx.webServer`) is a declared dependency: the
 * Context proxy throws "cannot get property … without inject" when the calling
 * fiber did not inject it. This bundle is loaded before the services it uses
 * exist, so it resolves them through `ctx.get()` instead and only registers
 * work inside `ctx.inject(...)` scopes.
 */

/**
 * Resolve an optional service without declaring a hard dependency.
 * @param {object} ctx - plugin context (or a test double).
 * @param {string} name - service name.
 * @returns {any} the service, or undefined when the composition lacks it.
 */
export function serviceOf(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(name)
    } catch {
      // A composition that cannot answer for the name simply has no service.
      return undefined
    }
  }
  // Plain objects (tests, hand-built contexts) keep the unguarded property face.
  return ctx[name]
}

/**
 * Log a warning without letting a logging failure change an outcome. `ctx.logger`
 * is itself a service, so an unguarded read would throw in a composition that
 * never injected it — exactly where this bundle is called from.
 * @param {object} ctx - plugin context.
 * @param {...any} args - printf-style arguments for `logger.warn`.
 */
export function warn(ctx, ...args) {
  try {
    const logger = ctx.logger
    if (typeof logger?.warn === 'function') logger.warn(...args)
  } catch {
    // Diagnostics are never load-bearing.
  }
}

/**
 * Log an informational line, guarded the same way as {@link warn}.
 * @param {object} ctx - plugin context.
 * @param {...any} args - printf-style arguments for `logger.info`.
 */
export function info(ctx, ...args) {
  try {
    const logger = ctx.logger
    if (typeof logger?.info === 'function') logger.info(...args)
  } catch {
    // Diagnostics are never load-bearing.
  }
}
