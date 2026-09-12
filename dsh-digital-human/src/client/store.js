/**
 * Digital-human state: a tiny observable store plus the pure projection that
 * turns the client session mirror into one avatar snapshot.
 *
 * The store keeps `useSyncExternalStore` honest — `getSnapshot` returns the
 * previous object whenever nothing the UI shows has changed, so the one-second
 * duration tick never re-renders an idle avatar.
 */

/** Avatar faces, in the projection's priority order. */
const FACE = {
  WAITING: 'waiting',
  ERROR: 'error',
  WORKING: 'working',
  THINKING: 'thinking',
  DONE: 'done',
  OFFLINE: 'offline',
  IDLE: 'idle',
};

/** Wire statuses whose work is still in flight. */
const LIVE_STATUSES = ['running', 'stopping'];

/** How long a finished turn keeps the celebratory face. */
const DONE_HOLD_MS = 6000;

/** Whether one job is still running (and therefore ticks). */
function isLive(job) {
  return LIVE_STATUSES.includes(job.status);
}

/**
 * Create one immutable-snapshot observable store.
 * @param initial - the first snapshot.
 * @returns `{ getSnapshot, subscribe, set }`.
 */
function createStore(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      if (Object.is(next, snapshot)) return;
      snapshot = next;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.error('[digital-human] store listener failed', error);
        }
      }
    },
  };
}

/** Count the jobs a session's mirror still holds open. */
function countLive(jobs) {
  let live = 0;
  for (const job of jobs) if (isLive(job)) live += 1;
  return live;
}

/**
 * Project the session mirror into one avatar snapshot.
 * @param input - `{ list, approvals, voice, now, doneAt }`.
 * @returns the snapshot the overlay renders.
 */
function project(input) {
  const list = input.list ?? {};
  const byId = list.byId ?? {};
  const ids = Array.isArray(list.ids) ? list.ids : [];
  const currentId = list.current;
  const summary = currentId === undefined ? undefined : byId[currentId];
  const jobsBySession = list.jobsBySession ?? {};
  const jobs = currentId !== undefined && Array.isArray(jobsBySession[currentId]) ? [...jobsBySession[currentId]] : [];
  const liveJobs = countLive(jobs);
  const failedJobs = jobs.filter((job) => job.status === 'failed').length;
  const approvals = Array.isArray(input.approvals) ? input.approvals : [];
  const siblings = ids
    .map((id) => byId[id])
    .filter((row) => row !== undefined && row.running === true && row.id !== currentId)
    .map((row) => ({ id: row.id, title: row.displayTitle ?? row.title ?? row.id }));
  const agentError = summary?.lastAgentError ?? null;
  const currentRunning = summary?.running === true;
  const recentDone = input.doneAt !== undefined && input.now - input.doneAt < DONE_HOLD_MS;

  let face = FACE.IDLE;
  let message = { key: 'state.idle' };
  if (approvals.length > 0) {
    face = FACE.WAITING;
    message = {
      key: approvals.length === 1 ? 'state.waiting.one' : 'state.waiting.other',
      params: { count: approvals.length },
    };
  } else if (agentError !== null && agentError !== '') {
    face = FACE.ERROR;
    message = { key: 'state.error.agent', params: { detail: agentError } };
  } else if (failedJobs > 0 && !recentDone) {
    face = FACE.ERROR;
    message = { key: 'state.error.jobs', params: { count: failedJobs } };
  } else if (liveJobs > 0) {
    face = FACE.WORKING;
    message = { key: 'state.working.jobs', params: { count: liveJobs } };
  } else if (siblings.length > 0 && !currentRunning) {
    face = FACE.WORKING;
    message = { key: 'state.working.sessions', params: { count: siblings.length + (currentRunning ? 1 : 0) + (liveJobs > 0 ? 1 : 0) } };
  } else if (currentRunning) {
    face = FACE.THINKING;
    message = { key: 'state.thinking' };
  } else if (recentDone) {
    face = FACE.DONE;
    message = { key: 'state.done' };
  } else if (currentId === undefined && ids.length === 0) {
    face = FACE.OFFLINE;
    message = { key: 'state.offline' };
  }

  return {
    face,
    message,
    now: input.now,
    voice: input.voice === true,
    approvals,
    jobs,
    sessions: siblings,
    current: summary === undefined
      ? null
      : {
        id: summary.id,
        title: summary.displayTitle ?? summary.title ?? summary.id,
        running: currentRunning,
        error: agentError,
      },
    counts: {
      approvals: approvals.length,
      liveJobs,
      jobs: jobs.length,
      failedJobs,
      sessions: siblings.length,
    },
  };
}

/**
 * Everything the UI shows except ticking durations. Two snapshots with the same
 * signature differ only in `now`, which matters only while a live row ticks.
 */
function signature(snapshot) {
  return [
    snapshot.face,
    snapshot.message.key,
    JSON.stringify(snapshot.message.params ?? {}),
    snapshot.voice ? 'voice' : 'mute',
    snapshot.counts.approvals,
    snapshot.counts.liveJobs,
    snapshot.counts.jobs,
    snapshot.counts.failedJobs,
    snapshot.counts.sessions,
    snapshot.current === null
      ? '-'
      : `${snapshot.current.id}:${String(snapshot.current.running)}:${snapshot.current.title}:${snapshot.current.error ?? ''}`,
    snapshot.jobs.map((job) => `${job.id}:${job.status}:${job.label}`).join(','),
    snapshot.sessions.map((session) => session.id).join(','),
    snapshot.approvals.map((approval) => approval.key).join(','),
  ].join('|');
}

/**
 * Re-project, reusing the previous snapshot object when nothing changed and no
 * live row needs its duration to tick.
 * @param previous - the snapshot currently published.
 * @param input - projection input.
 * @returns the snapshot to publish.
 */
function projectInto(previous, input) {
  const next = project(input);
  if (previous !== undefined && signature(previous) === signature(next) && next.counts.liveJobs === 0) return previous;
  return next;
}

module.exports = { FACE, DONE_HOLD_MS, createStore, isLive, project, projectInto, signature };
