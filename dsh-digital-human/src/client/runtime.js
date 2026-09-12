/**
 * The one module-scoped handoff between the plugin body and its React tree.
 *
 * A separate module (rather than an import from `plugin.js`) keeps the overlay
 * from depending on the entry that mounts it, which would be a require cycle
 * inside the loader bundle.
 */

let current = null;

/** Publish the plugin runtime for the overlay to read. */
function setRuntime(runtime) {
  current = runtime;
}

/** Read the published runtime. */
function getRuntime() {
  if (current === null) throw new Error('dsh-digital-human: the overlay rendered before apply() published its runtime');
  return current;
}

module.exports = { getRuntime, setRuntime };
