import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function formatDateForFile(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class EventLogger {
  private readonly logDir: string;
  private dirEnsured = false;

  constructor(logDir: string = path.resolve("logs")) {
    this.logDir = logDir;
  }

  emit(event: string, data?: Record<string, unknown>): void {
    if (!this.dirEnsured) {
      mkdirSync(this.logDir, { recursive: true });
      this.dirEnsured = true;
    }

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      data: data ?? {},
    });

    appendFileSync(this.getLogPath(), line + "\n", "utf8");
  }

  getLogPath(date?: Date): string {
    const dateStr = formatDateForFile(date ?? new Date());
    return path.join(this.logDir, `events-${dateStr}.jsonl`);
  }
}
