/**
 * Entry point of the bundled plugin hooks that run once a session or rarely
 * (`dist/hooks.js`): `session-start`, `post-tool-use`, and `stop`. The hooks
 * that run on every tool call are in `pre-tool-use.ts`
 * (`dist/pre-tool-use.js`), a bundle without the memory, YAML, and vault code.
 *
 * `hooks/hooks.json` runs `bun dist/hooks.js <event>` with the harness
 * payload on stdin. Each event keeps the output channel its harness reads
 * (see `emit` in `runtime.ts`):
 *
 * - `session-start`: plain stdout, which becomes session context. When
 *   `LLMOS_ROOT` is set but names no vault, it is one warning line. In a cloud
 *   session it first pulls the vault and links each attached repository
 *   (`src/hooks/cloud.ts`); in a local session it first pulls the vault's
 *   shared project memory (`src/hooks/sync.ts`). In every session it links the project's agent
 *   folders (`src/hooks/links.ts`). It then records a heartbeat for
 *   `llmos doctor` (`src/heartbeat.ts`).
 * - `post-tool-use`: `hookSpecificOutput.additionalContext` JSON on stdout.
 * - `stop`: diagnostics on stderr only. It reindexes, then commits and pushes
 *   changed shared project memory (`src/hooks/sync.ts`).
 */

import { cloudAttachHint, cloudSetup } from "./cloud.ts";
import { brokenRootWarning, pathFrom, payloadCwd, resolvedRoot } from "./common.ts";
import { beat } from "./heartbeat.ts";
import { hasAutoMemoryDir, linkAgentDirs } from "./links.ts";
import { type Handlers, runHook } from "./runtime.ts";
import { sessionContext, sessionStart } from "./session-context.ts";
import { stop, warn } from "./stop.ts";
import { syncOnStart, syncOnStop } from "./sync.ts";

const handlers: Handlers<"session-start" | "post-tool-use" | "stop"> = {
  "session-start": ({ data }) => {
    const root = resolvedRoot();
    const project = pathFrom(process.env.CLAUDE_PROJECT_DIR, process.cwd()) ?? payloadCwd(data);
    const claudeAutoMemoryReady =
      root !== null && project !== null ? hasAutoMemoryDir(project, root) : false;
    // Before the context: the pull makes the injected MEMORY.md fresh, and the
    // links let sessionStart see the project.
    let syncNote: string | null = null;
    try {
      syncNote = root === null ? null : syncOnStart(root, process.env);
    } catch {}
    const cloud =
      root === null
        ? (cloudAttachHint(process.env, Bun.main) ?? brokenRootWarning())
        : cloudSetup(root);
    const linked = root && project ? linkAgentDirs(project, root).join("\n") : null;
    // A cloud session's working folder holds several repositories, so the
    // vault context applies even when the cwd itself is not linked.
    // Hermes's llmos memory provider puts the index in the system prompt itself.
    const memoryIndexLoaded = process.env.LLMOS_MEMORY_INDEX_LOADED === "1";
    const options = { claudeAutoMemoryReady, memoryIndexLoaded };
    const processCwd = pathFrom(process.cwd());
    const vault =
      sessionStart(data, { ...options, processCwd }) ??
      (cloud && root ? sessionContext(root, null, { data, ...options, cwd: project }) : null);
    const context = [vault, cloud, syncNote, linked].filter(Boolean).join("\n");
    // `llmos doctor` reads this record to prove the hooks run for this agent;
    // a failure never changes the result.
    try {
      beat(data);
    } catch {}
    return { event: "session-start", context: context || null };
  },
  "post-tool-use": async ({ data }) => ({
    event: "post-tool-use",
    // Loaded only here: the frontmatter and vault code costs startup time.
    context: await (await import("./stamp.ts")).postToolUse(data),
  }),
  stop: () => {
    try {
      stop();
    } catch (error) {
      warn(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const root = resolvedRoot();
      if (root !== null) syncOnStop(root, process.env);
    } catch (error) {
      warn(`sync failure: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { event: "stop" };
  },
};

await runHook(process.argv[2], handlers);
