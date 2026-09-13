# @pify/shell-background

[![CI](https://github.com/pifydev/shell-background/actions/workflows/ci.yml/badge.svg)](https://github.com/pifydev/shell-background/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@pify/shell-background)](https://www.npmjs.com/package/@pify/shell-background) [![npm downloads](https://img.shields.io/npm/dm/@pify/shell-background)](https://www.npmjs.com/package/@pify/shell-background)

Long-running bash goes async in [pi](https://github.com/earendil-works/pi). Pass `background: true` to launch a command detached and get its id back immediately — and any foreground command still running after 30 seconds is **automatically moved to the background**, so a build, a test run, or a dev server never eats the agent's turn while it waits.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install shell-background`](https://github.com/pifydev/cli) or `pi install npm:@pify/shell-background`.

## Why

pi's bash tool waits for the command to finish. That is right for `ls` and wrong for `npm run build`: the agent sits blocked for a minute with nothing to do, and a `npm run dev` that never exits blocks it forever. The fix is to let a long command keep running in the background while the agent gets on with something else, and to hand back the result when it lands.

## What it does

It re-registers the `bash` tool with the same shell, working directory and environment — nothing about how a command runs changes — but a different lifecycle:

| Situation | What happens |
|---|---|
| Command finishes quickly | Returns normally, exactly like before. |
| Command still running after 30s | Moved to the background: the tool returns `moved to background, id=bg-1`, and the result is delivered into the conversation when the command finishes. |
| `background: true` | Launched detached from the start; returns the id immediately. |
| `timeout: N` | Killed (whole process tree) if it runs past N seconds. |

```
bash { command: "npm run build" }        # returns when done, or auto-backgrounds at 30s
bash { command: "npm run dev", background: true }   # → "bg-2 started in the background"
shell_status { id: "bg-2" }              # status + output so far
shell_status                             # list every background command this session
shell_kill { id: "bg-2" }                # stop it and its whole process tree
```

`/shell-bg` lists the jobs; `/shell-bg kill bg-2` stops one.

## Delivery, and the headless caveat

When a backgrounded command finishes in an **interactive** session, its result is pushed into the conversation as the next turn — you do not have to poll. Under headless `pi -p` there is nothing to deliver into (the session tears down when the prompt resolves), so **auto-background is disabled there** and only explicit `background: true` applies; collect it with `shell_status` inside the same turn. This is the same delivery rule the rest of the suite lives by.

## How it works

Each command is spawned with its stdout and stderr piped into a single log file, drained on every chunk so nothing is lost no matter how much it prints, and finalized only after the pipes end (with a short grace so a daemonized grandchild that holds a handle open cannot truncate the tail). The process is spawned detached (POSIX) and `unref`'d so a running job never holds the host open, and killed as a whole process tree — `taskkill /T` on Windows, a process-group signal on POSIX — on timeout, abort, `shell_kill`, or session shutdown.

Shell resolution reuses pi's own `getShellConfig` (Git Bash on Windows, `/bin/bash` then `sh` on Unix), so a backgrounded command behaves identically to a foreground one. Jobs are tracked in memory and mirrored to a per-session sidecar under the temp dir, so `shell_status` still answers after a `/reload` and a job whose process has died is reconciled rather than shown as forever-running.

There are **no runtime dependencies**, and it works on Linux, macOS and Windows.

## Settings

Put these in `.pi/shell-background.json` (project) or `<agentDir>/shell-background.json` (global):

```json
{
  "autoBackgroundMs": 30000,
  "tailBytes": 65536
}
```

`autoBackgroundMs` is how long a foreground command may run before it auto-backgrounds; set it to `0` to disable auto-background (explicit `background: true` still works). `PIFY_SHELL_BG_MS` overrides it for one run or in CI. `tailBytes` bounds how much of a job's log a status result shows. Bad values fall back to the defaults with a warning rather than taking the tool down.

## Coexistence

This package owns the `bash` tool's execution. If you also run another extension that re-registers `bash` (a renderer like `@pify/pretty`, say), whichever loads last wins — install order decides. `@pify/pretty` only changes rendering and leaves execution alone, so the usual advice is to let this package load after it.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
