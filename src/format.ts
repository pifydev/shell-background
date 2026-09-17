/**
 * Turning a job (and its log tail) into the text a tool returns. Pure: given a
 * job and a tail, produce the string — the extension supplies both.
 */
import type { Job } from "./types.ts";
import { readTail, countLines } from "./tail.ts";

function secs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function duration(job: Job): string {
  const end = job.endedAt ?? Date.now();
  return secs(Math.max(0, end - job.startedAt));
}

/** `[bg-1 · done · exit 0 · 4.2s]` — the one-line header every result carries. */
export function header(job: Job): string {
  const verdict =
    job.status === "running"
      ? "running"
      : job.status === "orphaned"
        ? "orphaned (another session)"
        : job.signal
          ? `signal ${job.signal}`
          : job.status === "killed"
            ? "killed"
            : `exit ${job.exitCode ?? "?"}`;
  return `[${job.id} · ${job.status} · ${verdict} · ${duration(job)}]`;
}

/**
 * The full result of a finished (or polled) job: the header, then the tail of
 * its output, with an honest note when output was truncated and where the whole
 * log lives.
 */
export function formatResult(job: Job, tailBytes: number): string {
  const tail = readTail(job.logPath, tailBytes);
  const lines = [header(job)];
  if (tail.text.trim() === "") {
    lines.push(job.status === "running" ? "(no output yet)" : "(no output)");
  } else {
    if (tail.truncated) {
      lines.push(`… showing the last ${countLines(tail.text)} lines — full log: ${job.logPath}`);
    }
    lines.push(tail.text.replace(/\n+$/, ""));
  }
  return lines.join("\n");
}

/** A roster of jobs for `shell_status` with no id. */
export function formatList(jobs: Job[]): string {
  if (jobs.length === 0) return "No background commands this session.";
  const rows = jobs
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((j) => {
      const cmd = j.command.replace(/\s+/g, " ").trim();
      const short = cmd.length <= 48 ? cmd : `${cmd.slice(0, 47)}…`;
      return `${header(j)}  ${short}`;
    });
  return [`${jobs.filter((j) => j.status === "running").length} running, ${jobs.length} total:`, ...rows].join("\n");
}
