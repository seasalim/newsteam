export type JobPriority = "user" | "feed";

type Job = () => Promise<void>;

type QueueEntry = {
  job: Job;
  resolve: (accepted: boolean) => void;
  reject: (error: unknown) => void;
};

export class JobQueue {
  private running = false;
  private drainScheduled = false;
  private pendingUsers: QueueEntry[] = [];
  private pendingFeeds: QueueEntry[] = [];

  getStatus(): { running: boolean; pendingUsers: number; pendingFeeds: number } {
    return {
      running: this.running,
      pendingUsers: this.pendingUsers.length,
      pendingFeeds: this.pendingFeeds.length,
    };
  }

  enqueue(job: Job, priority: JobPriority): Promise<boolean> {
    if (priority === "feed" && (this.running || this.pendingFeeds.length > 0)) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve, reject) => {
      const entry: QueueEntry = { job, resolve, reject };

      if (priority === "user") {
        this.pendingUsers.push(entry);
      } else {
        this.pendingFeeds.push(entry);
      }

      this.scheduleDrain();
    });
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) {
      return;
    }

    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.running) {
      return;
    }

    const next = this.pendingUsers.shift() ?? this.pendingFeeds.shift();

    if (!next) {
      return;
    }

    this.running = true;

    try {
      await next.job();
      next.resolve(true);
    } catch (error) {
      next.reject(error);
    } finally {
      this.running = false;

      if (this.pendingUsers.length > 0 || this.pendingFeeds.length > 0) {
        this.scheduleDrain();
      }
    }
  }
}
