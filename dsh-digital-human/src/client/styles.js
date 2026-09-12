/**
 * Digital-human styles. One `<style data-plugin>` tag per page, injected on
 * apply, mirroring how the shipped client plugins ship their CSS.
 *
 * Colors lean on the shell's own theme variables where they exist and fall back
 * to self-contained values, so the widget reads correctly in both themes.
 */

const TAG_ID = 'dsh-digital-human/overlay.css';

const CSS = `
.dh-root {
  --dh-accent: #4c8dff;
  --dh-surface: var(--dsw-specific-menu, rgba(28, 29, 32, 0.96));
  --dh-label: var(--dsw-alias-label-primary, #f2f3f5);
  --dh-label-soft: var(--dsw-alias-label-secondary, #a9adb6);
  --dh-label-faint: var(--dsw-alias-label-tertiary, #7d838d);
  --dh-border: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.12));
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: auto;
  font-size: 13px;
  line-height: 18px;
  color: var(--dh-label);
}
.dh-root[data-face="offline"] { --dh-accent: #7a7f87; }
.dh-root[data-face="idle"] { --dh-accent: #4c8dff; }
.dh-root[data-face="thinking"] { --dh-accent: #7c6cff; }
.dh-root[data-face="working"] { --dh-accent: #17b8a6; }
.dh-root[data-face="waiting"] { --dh-accent: #f0a020; }
.dh-root[data-face="error"] { --dh-accent: #f0524d; }
.dh-root[data-face="done"] { --dh-accent: #35b96a; }

.dh-bubble {
  box-sizing: border-box;
  max-width: 268px;
  padding: 8px 12px;
  border-radius: 14px 14px 4px 14px;
  background: var(--dh-surface);
  border: 1px solid var(--dh-border);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  color: var(--dh-label);
  animation: dh-pop 0.18s ease-out;
  word-break: break-word;
}
.dh-bubble::after {
  content: "";
  display: block;
  height: 2px;
  margin-top: 6px;
  border-radius: 2px;
  background: var(--dh-accent);
  opacity: 0.85;
}

.dh-face-wrap { position: relative; }
.dh-face {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.24));
}
.dh-face:focus-visible { outline: 2px solid var(--dh-accent); outline-offset: 3px; border-radius: 50%; }
.dh-head { fill: var(--dh-surface); stroke: var(--dh-accent); stroke-width: 2; }
.dh-eye { fill: var(--dh-accent); transform-box: fill-box; transform-origin: center; animation: dh-blink 5.4s infinite; }
.dh-eye-stroke { fill: none; stroke: var(--dh-accent); stroke-width: 2.2; stroke-linecap: round; }
.dh-mouth { fill: none; stroke: var(--dh-accent); stroke-width: 2.4; stroke-linecap: round; }
.dh-mouth-open { fill: var(--dh-accent); stroke: none; }
.dh-ring { fill: none; stroke: var(--dh-accent); stroke-width: 2; opacity: 0.45; stroke-dasharray: 22 12; transform-origin: 32px 36px; }
.dh-antenna { stroke: var(--dh-accent); stroke-width: 2; }
.dh-antenna-tip { fill: var(--dh-accent); animation: dh-pulse 2.2s ease-in-out infinite; }

.dh-root[data-face="working"] .dh-ring { animation: dh-spin 2.6s linear infinite; opacity: 0.7; }
.dh-root[data-face="thinking"] .dh-ring { animation: dh-spin 4.5s linear infinite; stroke-dasharray: 6 18; }
.dh-root[data-face="waiting"] .dh-ring { animation: dh-pulse 1s ease-in-out infinite; opacity: 1; stroke-dasharray: none; }
.dh-root[data-face="waiting"] .dh-face { animation: dh-hop 1.1s ease-in-out infinite; }
.dh-root[data-face="error"] .dh-face { animation: dh-shake 2.6s ease-in-out infinite; }
.dh-root[data-face="done"] .dh-antenna-tip { animation: dh-pulse 0.7s ease-in-out infinite; }

.dh-badge {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: #f0a020;
  color: #1b1c1f;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  box-shadow: 0 0 0 2px var(--dh-surface);
}

.dh-panel {
  box-sizing: border-box;
  width: 328px;
  max-width: calc(100vw - 36px);
  max-height: min(60vh, 520px);
  overflow: auto;
  padding: 12px;
  border-radius: 16px;
  background: var(--dh-surface);
  border: 1px solid var(--dh-border);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
  animation: dh-pop 0.16s ease-out;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dh-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dh-title { font-weight: 600; }
.dh-icon-btn {
  border: 1px solid var(--dh-border);
  background: transparent;
  color: var(--dh-label-soft);
  border-radius: 8px;
  padding: 2px 8px;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dh-icon-btn:hover { color: var(--dh-label); border-color: var(--dh-accent); }
.dh-section { display: flex; flex-direction: column; gap: 6px; }
.dh-section-title { color: var(--dh-label-faint); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }
.dh-empty { color: var(--dh-label-faint); }
.dh-row { display: flex; align-items: center; gap: 8px; min-height: 22px; }
.dh-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dh-label-faint); }
.dh-dot[data-state="ongoing"] { background: #17b8a6; animation: dh-pulse 1.6s ease-in-out infinite; }
.dh-dot[data-state="done"] { background: #35b96a; }
.dh-dot[data-state="warning"] { background: #f0a020; }
.dh-dot[data-state="error"] { background: #f0524d; }
.dh-kind {
  flex: none;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, 0.08));
  color: var(--dh-label-soft);
  font-size: 11px;
}
.dh-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: 12px;
}
.dh-meta { flex: none; color: var(--dh-label-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.dh-current { display: flex; align-items: center; gap: 6px; }
.dh-err { color: #f0524d; word-break: break-word; font-size: 12px; }

.dh-approval {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid rgba(240, 160, 32, 0.55);
  background: rgba(240, 160, 32, 0.12);
}
.dh-approval-title { font-weight: 600; color: #f0a020; }
.dh-approval-tool { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; }
.dh-approval-reason { color: var(--dh-label-soft); font-size: 12px; word-break: break-word; }
.dh-actions { display: flex; gap: 8px; }
.dh-btn {
  flex: 1;
  padding: 6px 10px;
  border-radius: 9px;
  border: 1px solid var(--dh-border);
  background: transparent;
  color: var(--dh-label);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dh-btn-allow { border-color: rgba(53, 185, 106, 0.6); background: rgba(53, 185, 106, 0.16); color: #35b96a; font-weight: 600; }
.dh-btn-allow:hover { background: rgba(53, 185, 106, 0.26); }
.dh-btn-reject { border-color: rgba(240, 82, 77, 0.55); background: rgba(240, 82, 77, 0.12); color: #f0524d; }
.dh-btn-reject:hover { background: rgba(240, 82, 77, 0.22); }
.dh-foot { color: var(--dh-label-faint); font-size: 11px; }

@keyframes dh-pop { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes dh-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
@keyframes dh-spin { to { transform: rotate(360deg); } }
@keyframes dh-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
@keyframes dh-hop { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes dh-shake { 0%, 100% { transform: translateX(0); } 12% { transform: translateX(-2px); } 24% { transform: translateX(2px); } 36% { transform: translateX(0); } }

@media (prefers-reduced-motion: reduce) {
  .dh-root .dh-face, .dh-root .dh-ring, .dh-root .dh-eye, .dh-root .dh-antenna-tip, .dh-root .dh-dot { animation: none !important; }
}
`;

/** Inject the plugin stylesheet once per page. */
function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG_ID)}]`) !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-digital-human';
  tag.dataset.pluginCss = TAG_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

module.exports = { CSS, TAG_ID, ensureStyles };
