---
name: verify-llmos-service
description: Model-check with TLA+ that concurrent `llmos service serve` starts, idle stops, and crashes leave exactly one reachable llmOS service and never delete a live service's socket or a held start lock. Use when a change touches withStartLock, serveService, or close() in cli/src/service.ts, servicePaths or startService in cli/src/service-client.ts, or when `just verify-llmos-service` fails.
---

# Verify the llmOS service start

## The rules

- `MutualExclusion`: at most one starter is between taking the start lock
  and releasing it.
- `NoOrphan`: every service that listens is the one bound at `service.sock`.
  So at most one service is live, and no service holds its models where no
  client can reach it.
- `NoLiveLockBroken`: no process removes a start lock that its creator still
  holds.
- `NoLiveSocketDeleted`: no process removes the socket file of another
  service that still listens.

Harm when one breaks: two services each hold the qmd models (gigabytes of
memory) for 30 idle minutes. The orphaned one, when it stops, unlinks the
live service's socket, so the next client starts yet another service, and
the cascade repeats.

## Run it

From `cli/`:

```sh
just verify-llmos-service
```

The recipe runs `scripts/check.ts`. It exits 0 only when all of these hold:

- every invariant holds on the model of the code (`Lock = "kernel"`,
  `CloseRemoves = FALSE`);
- an invariant breaks on each mutant, so the check can still fail:
  - the code before the fix (`Lock = "file"`, `CloseRemoves = TRUE`);
  - the pid lock file alone (`Lock = "file"`, `CloseRemoves = FALSE`);
  - the extra socket removal in `close()` alone (`Lock = "kernel"`,
    `CloseRemoves = TRUE`);
- `cli/src/service.ts` still has each line in `GUARDS` in
  `scripts/check.ts`, `cli/src/lock.ts` still has each line in
  `LOCK_GUARDS`, `cli/src/service.ts` has no `rmSync(paths.lock`, and has exactly one
  `rmSync(paths.socket` (the one before the bind).

The first run installs Java and the pinned TLC jar with mise, and needs the
network. Set `TLA2TOOLS` and `JAVA` to use another TLC. A run takes a few
seconds; the model of the code has about 240 distinct states.

## What the model covers

`LlmosService.tla`, with `LlmosService.cfg` (3 starters, 1 crash):

| Model | Code |
| --- | --- |
| `KernelAcquire` | `withStartLock`: `tryLock(paths.lock)` (`cli/src/lock.ts`: `db.exec("BEGIN EXCLUSIVE")` on `service.lock.db`); `null` (`SQLITE_BUSY`) means wait 50 ms and try again |
| `Probe` | `serveService`: `if (await socketLive(paths.socket))`, under the lock |
| `RemoveSocket` | `serveService`: `rmSync(paths.socket, { force: true })` before the bind |
| `Bind` | `server.listen(paths.socket)`, which fails with `EADDRINUSE` when any file is at the path |
| `Release` | the end of `withStartLock`: `held.release()` (`db.close()`) ends the transaction |
| `Close` | `close()`: `server.close()`, which unlinks the socket path by name (Bun and libuv both do this) and stops the listen |
| `Crash` | SIGKILL or a crash at any step: files stay, the listen stops, the kernel drops the SQLite lock |
| `FileCreate`, `FileWrite`, `FileRead`, `FileBreak` | mutant only: the pid lock file before the fix (`writeFileSync(lock, pid, { flag: "wx" })`, and `rmSync(lock)` for an empty, dead, or old holder) |
| `CloseRemove` | mutant only: the `rmSync(paths.socket)` that `close()` ran after `server.close()` before the fix |

Assumptions, which the check does not cover:

- `socketLive` is accurate: a connect succeeds exactly when a process
  listens. A Unix-socket connect completes in the kernel, so a busy service
  still answers it. A full listen backlog would make it a false "down"; the
  starter would then replace a live socket and orphan that service.
- `server.listen` is one step. In the code, bind and listen are two
  syscalls; only a starter under the lock looks at the socket in between.
- Each process starts once. Three starters and one crash cover the
  interleavings of a host where clients start services again and again.
- Safety only: the model does not check that a start ever succeeds. A
  starter that waits more than 5 s for the lock gives up and exits with an
  error; the client runs its work in process.
- `close()`'s own `service.close()` (the qmd store) is not modeled; it runs
  after the socket is gone.

Sync commit: `ee06f0f` (refactor(lock): take every lock from the kernel
through one module). At that commit, the model describes the code.

## When a change touches the covered code

1. Run `just verify-llmos-service` before and after the change.
2. Read the code change against the table above. When a step changed shape,
   such as a new lock, a socket removal, or a step moved out of
   `withStartLock`, change `LlmosService.tla` to describe the new code first.
   Do not shape the model to make the check pass.
3. Read a failure with the `statechart` skill: run it on `LlmosService.tla`
   with `LlmosService.cfg`. It gives the shortest path to the broken rule in
   plain words. Replay each step of that path against the code, for example
   with real `llmos service serve` processes as in the test "starts that race
   end as one service" in `cli/test/service.test.ts`.
   - A step that cannot happen in the code: the model is wrong. Fix the model.
   - Every step can happen: it is a bug in the code. Report it. Never weaken
     an invariant to make it pass.
4. When a guard line moved or changed, update `GUARDS`, `ABSENT`, or `ONCE`
   in `scripts/check.ts`, and keep the model in step.
5. After you confirm that the model describes the code, set the sync commit
   above to the commit you checked.
