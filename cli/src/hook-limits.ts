/**
 * The time limits of every subprocess a hook starts, and the worst path of
 * each hook event. `test/hooks/manifest.test.ts` adds each path's limits and
 * fails when a sum reaches the `timeout` of its hook in `../hooks/hooks.json`,
 * so a hook cannot outlast its timeout because its children hang.
 *
 * Every limit that the code passes to `run()` comes from here. Each step of a
 * path lists how many calls the code can make on that path.
 */

/** A local git call (`rev-parse`, `status`, `add`, `commit`): it takes milliseconds. */
export const LOCAL_GIT_MS = 250;

/** The fetch and fast-forward limits at session start, local and cloud. */
export const START_GIT_MS = { fetch: 3_000, merge: 2_000 };

/** The fetch, merge, and push limits at Stop. */
export const STOP_GIT_MS = { fetch: 5_000, merge: 3_000, push: 5_000 };

/**
 * The reindex at Stop, first `llmos reindex --no-embed` and then, if that
 * fails without a timeout, `qmd update`: both share this one budget. A timed-out
 * reindex keeps the dirty flag, and the next Stop retries it.
 */
export const REINDEX_BUDGET_MS = 10_000;

/** The most sibling repositories a cloud session-start links; each costs one local git call. */
export const MAX_CLOUD_REPOSITORIES = 8;

export interface Step {
  step: string;
  /** The limit of one call, in ms. */
  limitMs: number;
  /** The most calls of that step on the path. */
  calls: number;
}

const LOCATE_PROJECT: Step = {
  step: "git rev-parse of a session folder (project.ts checkoutAt)",
  limitMs: LOCAL_GIT_MS,
  calls: 1,
};

/** Each hook event and its paths: the steps that run one after another on the worst case of that path. */
export const HOOK_PATHS: Record<string, Record<string, Step[]>> = {
  SessionStart: {
    "local session": [
      {
        step: "sync gate: rev-parse, remote get-url, symbolic-ref",
        limitMs: LOCAL_GIT_MS,
        calls: 3,
      },
      { step: "sync update: rev-parse x2, rev-list x2", limitMs: LOCAL_GIT_MS, calls: 4 },
      { step: "sync update: fetch", limitMs: START_GIT_MS.fetch, calls: 1 },
      { step: "sync update: merge --ff-only", limitMs: START_GIT_MS.merge, calls: 1 },
      {
        ...LOCATE_PROJECT,
        step: "project lookups: auto-memory check, links, memory scope",
        calls: 3,
      },
    ],
    "cloud session": [
      {
        step: "vault locate, then update: rev-parse x2, rev-list x2",
        limitMs: LOCAL_GIT_MS,
        calls: 5,
      },
      { step: "vault update: fetch", limitMs: START_GIT_MS.fetch, calls: 1 },
      { step: "vault update: merge --ff-only", limitMs: START_GIT_MS.merge, calls: 1 },
      {
        ...LOCATE_PROJECT,
        step: "project lookups: auto-memory check, sibling repositories, the session folder, memory scope x2",
        calls: MAX_CLOUD_REPOSITORIES + 4,
      },
    ],
  },
  PreToolUse: { "any tool": [] },
  PostToolUse: { "any tool": [] },
  Stop: {
    "reindex and sync": [
      { step: "reindex, and its qmd update fallback", limitMs: REINDEX_BUDGET_MS, calls: 1 },
      {
        step: "sync gate: rev-parse, remote get-url, symbolic-ref",
        limitMs: LOCAL_GIT_MS,
        calls: 3,
      },
      { step: "changed paths, unpushed check, add, commit", limitMs: LOCAL_GIT_MS, calls: 4 },
      { step: "publish: rev-parse x2, rev-list x2", limitMs: LOCAL_GIT_MS, calls: 4 },
      {
        step: "publish: merge-tree, commit-tree, change check x2",
        limitMs: LOCAL_GIT_MS,
        calls: 4,
      },
      { step: "publish: fetch", limitMs: STOP_GIT_MS.fetch, calls: 1 },
      { step: "publish: merge --ff-only", limitMs: STOP_GIT_MS.merge, calls: 1 },
      { step: "publish: push", limitMs: STOP_GIT_MS.push, calls: 1 },
    ],
  },
};
