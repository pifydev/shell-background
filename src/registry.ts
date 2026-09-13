/**
 * The set of background jobs, in memory and mirrored to disk.
 *
 * The live Map is the source of truth while the session runs. Each job is also
 * written to a small JSON sidecar (atomically, temp + rename) so the status
 * tool still answers after a `/reload` re-instantiates the extension, and so a
 * job that outran the session can be reconciled: on load, a job still marked
 * running whose pid is no longer alive is settled as finished rather than shown
 * as forever-running.
 *
 * Scoped to one session via the base directory the caller supplies, so two pi
 * sessions never reconcile each other's jobs. Zero dependencies — node:fs/path.
 */
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "./types.ts";
import { isRecord } from "./types.ts";

function isAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we may not signal it — still alive.
    return (err as { code?: string }).code === "EPERM";
  }
}

function isJob(v: unknown): v is Job {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.command === "string" &&
    typeof v.logPath === "string" &&
    typeof v.status === "string"
  );
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private counter = 0;
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(join(baseDir, "logs"), { recursive: true });
  }

  logPathFor(id: string): string {
    return join(this.baseDir, "logs", `${id}.log`);
  }

  create(command: string, cwd: string): Job {
    const id = `bg-${++this.counter}`;
    const job: Job = {
      id,
      command,
      cwd,
      pid: null,
      status: "running",
      exitCode: null,
      signal: null,
      logPath: this.logPathFor(id),
      startedAt: Date.now(),
      endedAt: null,
      auto: false,
      delivered: false,
    };
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  all(): Job[] {
    return [...this.jobs.values()];
  }

  running(): Job[] {
    return this.all().filter((j) => j.status === "running");
  }

  persist(job: Job): void {
    try {
      const file = join(this.baseDir, `${job.id}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(job));
      renameSync(tmp, file);
    } catch {
      // A registry we cannot persist still works for the live session.
    }
  }

  /** Load persisted jobs and settle any whose process has since died. */
  load(): void {
    let files: string[];
    try {
      files = readdirSync(this.baseDir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(join(this.baseDir, f), "utf8"));
        if (!isJob(raw)) continue;
        const job = raw;
        if (job.status === "running" && !isAlive(job.pid)) {
          job.status = "done";
          job.endedAt = job.endedAt ?? Date.now();
        }
        this.jobs.set(job.id, job);
        const n = Number(job.id.replace(/^bg-/, ""));
        if (Number.isFinite(n)) this.counter = Math.max(this.counter, n);
      } catch {
        // Skip a corrupt sidecar rather than fail the whole load.
      }
    }
  }
}
