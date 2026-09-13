/**
 * The aboveEditor box listing background jobs — running ones, and any that
 * finished in the last 15s so a completion is visible before it disappears.
 * Pure string builder; the extension wraps it in a pi-tui Text.
 */
import type { Job } from "./types.ts";

const WIDTH = 54;
const MAX_ROWS = 8;

export interface WidgetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

function icon(job: Job): string {
  switch (job.status) {
    case "running":
      return "⟳";
    case "done":
      return "✓";
    case "failed":
      return "✗";
    default:
      return "◼";
  }
}

function color(job: Job): string {
  switch (job.status) {
    case "running":
      return "warning";
    case "done":
      return "success";
    case "failed":
      return "error";
    default:
      return "dim";
  }
}

function elapsed(job: Job, now: number): string {
  const end = job.endedAt ?? now;
  const s = Math.max(0, Math.round((end - job.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function buildWidgetLines(jobs: Job[], theme: WidgetTheme, now: number): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  const visible = jobs
    .filter((j) => j.status === "running" || (j.endedAt ?? 0) > now - 15_000)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (visible.length === 0) return [];

  const running = visible.filter((j) => j.status === "running").length;
  const title = ` ⚙ shell-bg · ${running} running `;
  const hint = " /shell-bg ";
  const pad = Math.max(1, WIDTH - title.length - hint.length);
  const lines = [dim(`╭${title}${"─".repeat(pad)}${hint}╮`)];

  const shown = visible.slice(-MAX_ROWS);
  const hidden = visible.length - shown.length;
  for (const j of shown) {
    const c = color(j);
    lines.push(
      `${theme.fg(c, icon(j))} ${theme.fg(c, j.id)} ${dim(`· ${elapsed(j, now)}`)} ${dim(clip(j.command, 28))}`,
    );
  }
  if (hidden > 0) lines.push(dim(`│ … +${hidden} more`));
  lines.push(dim(`╰${"─".repeat(WIDTH)}╯`));
  return lines;
}
