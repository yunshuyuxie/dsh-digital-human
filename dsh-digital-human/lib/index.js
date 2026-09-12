/**
 * dsh-digital-human — host half.
 *
 * The digital human is a browser-surface plugin: its avatar, monitor panel, and
 * approval card all live in the Web client half, which ships through
 * `exports["./client"]` and is discovered from the `dsh.client` declaration in
 * this package's manifest.
 *
 * This host function exists so the plugin has a real row in the Cordis tree.
 * The empty body is deliberate: v1 adds no host service, no model-visible
 * prompt text, and no host-side event listener.
 *
 * @module dsh-digital-human
 */

/** Host plugin body — no host-side behavior in v1. */
export function apply() {}
