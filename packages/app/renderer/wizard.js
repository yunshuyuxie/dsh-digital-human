/**
 * The first-run wizard: check the environment, install the bridge, choose
 * preferences, finish.
 *
 * The whole flow lives inside the 360x560 window, so only the body scrolls and
 * nothing is wider than the panel. Every command goes through the callbacks the
 * host passed in: this module never touches `window.digitalHuman` itself and
 * never assumes a callback exists — a missing one renders as "unavailable"
 * instead of throwing at click time.
 *
 * No data-derived text (paths, installer output, versions) ever reaches
 * `innerHTML`: everything is a text node.
 */
import { t } from './locales.js';

/** The four steps, in order. Labels come from `t()`. */
export const WIZARD_STEPS = ['env', 'install', 'prefs', 'done'];

/** Per-step status colors. */
const STATUS_CLASS = {
  ok: 'dh-wizard-status-ok',
  warn: 'dh-wizard-status-warn',
  bad: 'dh-wizard-status-bad',
};

/**
 * Build an element.
 * @param tag - tag name.
 * @param props - `class`, `text`, `attrs`, `children` are understood.
 * @param children - child nodes appended after `props.children`.
 * @returns the new element.
 */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  if (props.class !== undefined) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value !== null && value !== undefined) el.setAttribute(name, String(value));
  }
  const all = [...(props.children ?? []), ...children];
  for (const child of all) if (child !== null && child !== undefined) el.append(child);
  return el;
}

/**
 * `window.digitalHuman` commands resolve to `{ ok, value }`; a caller may also
 * hand back the bare value. Both shapes are accepted.
 */
function unwrap(result) {
  if (result !== null && typeof result === 'object' && !Array.isArray(result) && 'ok' in result && 'value' in result) {
    return result.value;
  }
  return result;
}

/** A string, or `''`. */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/** A finite number, or `0`. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A list of non-empty strings from wire data. */
function strList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : [];
}

/**
 * Join the parts that carry text, so a missing profile list leaves no stray dot.
 * @param parts - already-built strings.
 * @returns the joined detail line, or `''`.
 */
function detail(...parts) {
  return parts.filter((part) => part !== '').join(' · ');
}

/**
 * Create the wizard.
 *
 * @param options - `{ onFinish, onError, api }`.
 *   - `api`: `{ wizardState, wizardPickPackage, wizardInstallBridge, wizardFinish }`.
 *     A method the preload does not expose is unavailable, not fatal.
 *   - `onFinish`: called once the preferences are written.
 *   - `onError`: called with anything thrown along the way.
 * @returns `{ el, update(snapshot), show(), hide(), step() }`.
 */
export function createWizard(options = {}) {
  const api = options.api !== null && typeof options.api === 'object' ? options.api : {};
  const onFinish = typeof options.onFinish === 'function' ? options.onFinish : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  /** Whether the preload exposes one wizard method. */
  function has(name) {
    return typeof api[name] === 'function';
  }

  /** Run one wizard command, funnelling every failure into the host error line. */
  async function invoke(name, args, fallback) {
    if (!has(name)) {
      onError(new Error(t('wizard.unavailable', { method: name })));
      return fallback;
    }
    try {
      return unwrap(await api[name](...args));
    } catch (error) {
      onError(error);
      return fallback;
    }
  }

  // ---------------------------------------------------------------- state
  let snapshot = null;
  let checking = false;
  let installing = false;
  let finishing = false;
  let step = 0;
  /** Local completion flags, so the indicator never claims work that was not done. */
  let envDone = false;
  let bridgeDone = false;
  let prefsDone = false;
  /** Diagnostics the user can act on, from the last wizard-state call. */
  let diag = null;
  let diagError = '';
  /** The chosen offline package, or `''`. */
  let packagePath = '';
  let profile = 'web';
  /** Installer output, verbatim. */
  let outputLines = [];
  let outputRendered = 0;
  let installOk = false;
  let installError = '';
  /** Whether the wizard was ever shown; `hide()` is a no-op until then. */
  let everShown = false;
  /** Whether this step was entered with a failed diagnosis, so it is drawn once. */
  let diagRan = false;

  /** Preference controls, seeded from `snapshot.runtime` once. */
  const startWithWindows = h('input', { attrs: { type: 'checkbox' } });
  const alwaysOnTop = h('input', { attrs: { type: 'checkbox' } });
  const notifyOnApproval = h('input', { attrs: { type: 'checkbox' } });
  let prefsSeeded = false;

  const stepsList = h('ol', { class: 'dh-wizard-steps', attrs: { 'aria-label': t('wizard.progress') } });
  const body = h('div', { class: 'dh-wizard-body' });
  const backButton = h('button', { class: 'dh-btn dh-btn-ghost dh-wizard-back', text: t('wizard.back'), attrs: { type: 'button' } });
  const nextButton = h('button', { class: 'dh-btn dh-wizard-next', attrs: { type: 'button' } });
  const el = h(
    'section',
    { class: 'dh-wizard', attrs: { 'aria-label': t('wizard.title'), hidden: '' } },
    h('div', { class: 'dh-wizard-head' }, h('h1', { class: 'dh-wizard-title', text: t('wizard.title') }), stepsList),
    body,
    h('div', { class: 'dh-wizard-foot' }, backButton, nextButton),
  );

  /** The install output area; reused across renders so its scroll position sticks. */
  const outputPre = h('pre', { class: 'dh-wizard-output', attrs: { tabindex: '0', 'aria-label': t('wizard.install.output') } });

  // ------------------------------------------------------------ selectors
  /** The steps actually shown: 安装桥接 disappears once the bridge is present. */
  function visibleNames() {
    return WIZARD_STEPS.filter((name) => name !== 'install' || !bridgeReady());
  }

  /** The visible index of the current step, or `-1` when it is folded away. */
  function visibleIndex() {
    return visibleNames().indexOf(WIZARD_STEPS[step] ?? '');
  }

  /** The bridge version the app is talking to, when the snapshot knows it. */
  function runtimeBridgeVersion() {
    return str(snapshot?.status?.bridgeVersion);
  }

  /** The bridge version seen on disk, when `diagnose()` reported one. */
  function diagBridgeVersion() {
    return str(diag?.bridgeVersion);
  }

  /** Prefer the live peer's version; fall back to the reported one. */
  function bridgeVersion() {
    return runtimeBridgeVersion() || diagBridgeVersion();
  }

  /** Whether the bridge is installed and usable, from any trustworthy signal. */
  function bridgeReady() {
    if (installOk) return true;
    if (diag !== null && diag.bridgeInstalled === true) return true;
    return snapshot?.status?.phase === 'connected';
  }

  /** Whether the environment check passed, so step 2 may be entered. */
  function envReady() {
    if (snapshot?.status?.phase === 'connected') return true;
    return diag !== null && diag.dshHomeExists === true;
  }

  /** `[{ level, text }]` from one install answer. */
  function readSteps(value) {
    const list = Array.isArray(value?.steps) ? value.steps : [];
    return list
      .filter((line) => line !== null && typeof line === 'object')
      .map((line) => ({ level: str(line.level) === 'error' ? 'error' : 'info', text: str(line.text) }))
      .filter((line) => line.text !== '');
  }

  /** A `<select>` of profile names. */
  function buildProfileSelect() {
    const select = h('select', { class: 'dh-model-select dh-wizard-select', attrs: { 'aria-label': t('wizard.install.profile') } });
    const names = strList(diag?.profiles);
    for (const name of names) select.append(h('option', { text: name, attrs: { value: name } }));
    if (names.length === 0) {
      // No profile exists yet; the installer may still create `web`.
      select.append(h('option', { text: t('wizard.install.profileDefault'), attrs: { value: 'web' } }));
      profile = 'web';
    } else {
      profile = names.includes(profile) ? profile : (names.includes('web') ? 'web' : names[0]);
    }
    select.value = profile;
    select.addEventListener('change', () => {
      profile = select.value;
    });
    return select;
  }

  /** One check row: a mark, a title, and an optional detail line. */
  function checkRow(state, title, text) {
    const mark = state === 'ok' ? '✓' : state === 'pending' ? '…' : '✕';
    return h(
      'li',
      { class: 'dh-wizard-check', attrs: { 'data-state': state } },
      h('span', { class: 'dh-wizard-mark', text: mark, attrs: { 'aria-hidden': 'true' } }),
      h(
        'div',
        { class: 'dh-wizard-check-body' },
        h('p', { class: 'dh-wizard-check-title', text: title }),
        text === undefined || text === '' ? null : h('p', { class: 'dh-wizard-check-detail', text }),
      ),
    );
  }

  /** A colored line under a pane. */
  function statusLine(state, text) {
    return h('p', { class: `dh-wizard-status ${STATUS_CLASS[state] ?? ''}`, text });
  }

  /** A row that holds one button without stretching it. */
  function buttonRow(...buttons) {
    return h('div', { class: 'dh-wizard-row' }, ...buttons);
  }

  // ------------------------------------------------------- step 1: 环境检查
  function renderEnv() {
    const box = h('div', { class: 'dh-wizard-pane' });
    body.append(box);
    if (checking) box.append(h('p', { class: 'dh-wizard-loading', text: t('wizard.env.checking') }));
    if (!has('wizardState')) box.append(statusLine('warn', t('wizard.unavailable', { method: 'wizardState' })));
    if (diagError !== '') box.append(statusLine('bad', diagError));

    const list = h('ul', { class: 'dh-wizard-checks' });
    const d = diag;
    if (d === null) {
      list.append(checkRow('pending', t('wizard.env.homeTitle')));
      list.append(checkRow('pending', t('wizard.env.profilesTitle', { count: 0 })));
      list.append(checkRow('pending', t('wizard.env.bridgeTitle')));
      list.append(checkRow('pending', t('wizard.env.runningTitle')));
    } else {
      const home = str(d.dshHome);
      list.append(checkRow(
        d.dshHomeExists === true ? 'ok' : 'bad',
        t('wizard.env.homeTitle'),
        d.dshHomeExists === true ? home : detail(home, t('wizard.env.homeMissing')),
      ));
      const profiles = strList(d.profiles);
      list.append(checkRow(
        profiles.length > 0 ? 'ok' : 'bad',
        t('wizard.env.profilesTitle', { count: profiles.length }),
        profiles.length > 0 ? profiles.join(' · ') : t('wizard.env.profilesNone'),
      ));
      list.append(checkRow(
        d.bridgeInstalled === true ? 'ok' : 'bad',
        t('wizard.env.bridgeTitle'),
        d.bridgeInstalled === true ? strList(d.profilesWithBridge).join(' · ') : t('wizard.env.bridgeMissing'),
      ));
      const version = bridgeVersion();
      const running = d.running === true || snapshot?.status?.phase === 'connected';
      list.append(checkRow(
        running ? 'ok' : 'pending',
        t('wizard.env.runningTitle'),
        running
          ? t('wizard.env.runningDetail', { count: num(d.endpointCount), version: version === '' ? t('wizard.unknown') : version })
          : t('wizard.env.runningNone'),
      ));
    }
    box.append(list);

    if (d !== null && d.bridgeInstalled === true && d.fullFeature === false) {
      const version = bridgeVersion() === '' ? t('wizard.unknown') : bridgeVersion();
      box.append(statusLine('warn', t('wizard.env.olderBridge', { version })));
    }
    if (d !== null && d.dshHomeExists !== true) box.append(statusLine('bad', t('wizard.env.nextBlocked')));

    const again = h('button', {
      class: 'dh-btn dh-btn-ghost dh-wizard-recheck',
      text: t('wizard.env.recheck'),
      attrs: { type: 'button', disabled: checking ? '' : null },
    });
    again.addEventListener('click', () => {
      void runDiagnose();
    });
    box.append(buttonRow(again));
  }

  // ------------------------------------------------------- step 2: 安装桥接
  function renderInstall() {
    const box = h('div', { class: 'dh-wizard-pane' });
    body.append(box);
    if (bridgeReady() && !installing && !installOk) {
      box.append(statusLine('ok', t('wizard.install.already')));
      box.append(h('p', { class: 'dh-wizard-hint', text: t('wizard.install.alreadyHint') }));
      return;
    }
    if (!has('wizardInstallBridge')) box.append(statusLine('warn', t('wizard.unavailable', { method: 'wizardInstallBridge' })));

    box.append(h('p', { class: 'dh-wizard-label', text: t('wizard.install.package') }));
    const pick = h('button', { class: 'dh-btn dh-btn-ghost dh-wizard-pick', text: t('wizard.install.pick'), attrs: { type: 'button' } });
    pick.addEventListener('click', () => {
      void choosePackage();
    });
    box.append(buttonRow(pick));
    box.append(h('p', { class: 'dh-wizard-path', text: packagePath === '' ? t('wizard.install.packageNone') : packagePath }));

    box.append(h('p', { class: 'dh-wizard-label', text: t('wizard.install.profile') }));
    box.append(buildProfileSelect());

    const install = h('button', {
      class: 'dh-btn dh-btn-send dh-wizard-install',
      text: installing ? t('wizard.install.installing') : t('wizard.install.run'),
      attrs: { type: 'button', disabled: installing || packagePath === '' ? '' : null },
    });
    install.addEventListener('click', () => {
      void runInstall();
    });
    box.append(buttonRow(install));

    if (installing || outputLines.length > 0) {
      box.append(h('p', { class: 'dh-wizard-label', text: t('wizard.install.output') }));
      box.append(outputPre);
      paintOutput();
    }
    if (installError !== '') box.append(statusLine('bad', t('wizard.install.failed', { message: installError })));
    else if (installOk) box.append(statusLine('ok', t('wizard.install.ok')));
  }

  /** Append only the new installer lines, so a long install is not re-rendered. */
  function paintOutput() {
    if (outputRendered > outputLines.length) {
      outputPre.replaceChildren();
      outputRendered = 0;
    }
    for (let index = outputRendered; index < outputLines.length; index += 1) {
      const line = outputLines[index];
      outputPre.append(h('span', {
        class: line.level === 'error' ? 'dh-wizard-output-line dh-wizard-output-error' : 'dh-wizard-output-line',
        text: line.text,
      }));
      outputPre.append(document.createTextNode('\n'));
    }
    if (outputLines.length !== outputRendered) {
      outputRendered = outputLines.length;
      outputPre.scrollTop = outputPre.scrollHeight;
    }
  }

  // ----------------------------------------------------------- step 3: 偏好
  function renderPrefs() {
    const box = h('div', { class: 'dh-wizard-pane' });
    body.append(box);
    const rows = [
      ['wizard.prefs.startWithWindows', startWithWindows],
      ['wizard.prefs.alwaysOnTop', alwaysOnTop],
      ['wizard.prefs.notify', notifyOnApproval],
    ];
    for (const [key, input] of rows) {
      const id = `dh-wizard-${key.replace(/\./gu, '-')}`;
      input.id = id;
      box.append(h(
        'label',
        { class: 'dh-wizard-pref', attrs: { for: id } },
        input,
        h('span', { class: 'dh-wizard-pref-text', text: t(key) }),
      ));
    }
    box.append(h('p', { class: 'dh-wizard-hint', text: t('wizard.prefs.hint') }));
  }

  // ----------------------------------------------------------- step 4: 完成
  function renderDone() {
    const box = h('div', { class: 'dh-wizard-pane' });
    body.append(box);
    const home = str(diag?.dshHome);
    const summary = [
      home === '' ? t('wizard.done.homeUnknown') : t('wizard.done.home', { path: home }),
      t('wizard.done.bridge', { bridge: t(bridgeReady() ? 'wizard.done.yes' : 'wizard.done.no') }),
      t(notifyOnApproval.checked ? 'wizard.done.notifyYes' : 'wizard.done.notifyNo'),
      t('wizard.done.prefs', {
        start: t(startWithWindows.checked ? 'wizard.done.yes' : 'wizard.done.no'),
        top: t(alwaysOnTop.checked ? 'wizard.done.yes' : 'wizard.done.no'),
      }),
    ];
    box.append(h('p', { class: 'dh-wizard-summary', text: summary.join(' ') }));
    box.append(h('p', { class: 'dh-wizard-hint', text: t('wizard.done.hint') }));
    for (const name of ['wizardState', 'wizardInstallBridge', 'wizardFinish']) {
      if (!has(name)) box.append(statusLine('warn', t('wizard.unavailable', { method: name })));
    }
  }

  // ---------------------------------------------------------------- paint
  /** Repaint the step indicator from the local completion flags. */
  function paintSteps() {
    stepsList.replaceChildren();
    const names = visibleNames();
    const current = visibleIndex();
    names.forEach((name, index) => {
      const done = name === 'env' ? envDone : name === 'install' ? (bridgeDone || bridgeReady()) : prefsDone;
      const classes = ['dh-wizard-step'];
      if (done && index < current) classes.push('dh-wizard-step-done');
      if (index === current) classes.push('dh-wizard-step-current');
      stepsList.append(h(
        'li',
        { class: classes.join(' '), attrs: { 'data-step': name } },
        h('span', {
          class: 'dh-wizard-step-no',
          text: done && index < current ? '✓' : String(index + 1),
          attrs: { 'aria-hidden': 'true' },
        }),
        h('span', { class: 'dh-wizard-step-text', text: t(`wizard.step.${name}`) }),
      ));
    });
  }

  /** Whether 「下一步」 is allowed on the current step. */
  function canAdvance() {
    if (step === 0) return envReady();
    if (step === 1) return bridgeReady();
    if (step === 2) return true;
    return !finishing;
  }

  /** The step a 「下一步」 press moves to, skipping 安装桥接 when it is done. */
  function nextStep() {
    if (step === 0) return envReady() ? (bridgeReady() ? 2 : 1) : 0;
    if (step === 1) return 2;
    return Math.min(step + 1, WIZARD_STEPS.length - 1);
  }

  /** Repaint the whole wizard. */
  function paint() {
    // The install output element carries live scroll state; keep it across renders.
    if (outputPre.parentNode !== null) outputPre.remove();
    paintSteps();
    body.replaceChildren();
    if (step === 0) renderEnv();
    else if (step === 1) renderInstall();
    else if (step === 2) renderPrefs();
    else renderDone();

    backButton.hidden = step === 0;
    backButton.disabled = step <= 0;
    if (step === WIZARD_STEPS.length - 1) {
      nextButton.textContent = t('wizard.finish');
      nextButton.disabled = finishing;
    } else {
      nextButton.textContent = t('wizard.next');
      nextButton.disabled = !canAdvance();
    }
  }

  // -------------------------------------------------------------- actions
  /** Re-run the diagnosis and repaint step 1. */
  async function runDiagnose() {
    if (checking) return;
    checking = true;
    diagError = '';
    paint();
    const value = await invoke('wizardState', [], null);
    checking = false;
    diagRan = true;
    if (value !== null && typeof value === 'object') {
      diag = value;
      envDone = envReady();
      const profiles = strList(value.profiles);
      if (!profiles.includes(profile)) profile = profiles.includes('web') ? 'web' : (profiles[0] ?? 'web');
    } else {
      // A missing method already reported itself; only announce a genuine failure.
      diagError = has('wizardState') ? t('wizard.env.checkFailed') : '';
    }
    paint();
  }

  /** Open the native picker and record the chosen package. */
  async function choosePackage() {
    const value = await invoke('wizardPickPackage', [], null);
    const picked = str(value?.path);
    if (picked !== '') {
      packagePath = picked;
      installError = '';
    }
    paint();
  }

  /** Run the installer against the chosen package and profile. */
  async function runInstall() {
    if (installing || installOk) return;
    installing = true;
    installError = '';
    outputLines = [];
    outputRendered = 0;
    paint();
    const value = await invoke('wizardInstallBridge', [packagePath, profile], null);
    installing = false;
    const lines = readSteps(value);
    if (lines.length > 0) outputLines = lines;
    installOk = value !== null && typeof value === 'object' && value.ok === true;
    if (installOk) {
      bridgeDone = true;
      installError = '';
    } else {
      const failure = str(value?.error);
      installError = failure !== '' ? failure : t('wizard.install.noAnswer');
    }
    paint();
  }

  /** Write the preferences and hand control back to the host. */
  async function finish() {
    if (finishing) return;
    finishing = true;
    paint();
    const prefs = {
      startWithWindows: startWithWindows.checked,
      alwaysOnTop: alwaysOnTop.checked,
      notifyOnApproval: notifyOnApproval.checked,
    };
    const value = await invoke('wizardFinish', [prefs], null);
    finishing = false;
    // `null` means "unavailable" or "rejected": stay put and let the user retry.
    if (value === null) {
      paint();
      return;
    }
    prefsDone = true;
    onFinish();
  }

  backButton.addEventListener('click', () => {
    if (step <= 0) return;
    step -= 1;
    paint();
  });
  nextButton.addEventListener('click', () => {
    if (step === WIZARD_STEPS.length - 1) {
      void finish();
      return;
    }
    const target = nextStep();
    if (target === step) return;
    if (step === 0) envDone = envReady() || envDone;
    if (step === 2) prefsDone = true;
    step = target;
    paint();
  });

  // ----------------------------------------------------------------- API
  /** Seed the preference boxes from the runtime snapshot, once. */
  function seedPrefs() {
    if (prefsSeeded) return;
    const runtime = snapshot?.runtime;
    if (runtime === null || typeof runtime !== 'object') return;
    startWithWindows.checked = runtime.startWithWindows === true;
    // The app's own defaults are "on" for both of these; a snapshot that does
    // not mention them (an older main process) must not silently turn them off.
    alwaysOnTop.checked = runtime.alwaysOnTop === undefined ? true : runtime.alwaysOnTop === true;
    notifyOnApproval.checked = runtime.notifyOnApproval === undefined ? true : runtime.notifyOnApproval === true;
    prefsSeeded = true;
  }

  /** Keep the chosen profile inside the reported list. */
  function syncProfileChoice() {
    const profiles = strList(diag?.profiles);
    if (profiles.length === 0) return;
    if (!profiles.includes(profile)) profile = profiles.includes('web') ? 'web' : profiles[0];
  }

  /** Render one host snapshot; safe with `undefined` and on every step. */
  function update(next) {
    if (next === null || typeof next !== 'object') return;
    snapshot = next;
    seedPrefs();
    syncProfileChoice();
    if (everShown) paint();
  }

  /** Show the wizard; the first show runs the diagnosis. */
  function show() {
    const first = !everShown;
    everShown = true;
    el.hidden = false;
    seedPrefs();
    paint();
    if (first && !diagRan) void runDiagnose();
  }

  return {
    el,
    update,
    show,
    /** Hide without losing state, so reshowing keeps the user's place. */
    hide() {
      el.hidden = true;
    },
    /** The current step index, for the host's own bookkeeping. */
    step: () => step,
  };
}
