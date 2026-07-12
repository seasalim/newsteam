import assert from "node:assert/strict";
import test from "node:test";

import { JobQueue } from "../src/scheduler.ts";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvedValue) => {
    resolve = resolvedValue;
  });

  return { promise, resolve };
}

async function flushAsyncWork() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

test("JobQueue serializes user jobs", async () => {
  const queue = new JobQueue();
  const firstJob = createDeferred<void>();
  const started: string[] = [];

  const firstRun = queue.enqueue(async () => {
    started.push("first");
    await firstJob.promise;
  }, "user");

  const secondRun = queue.enqueue(async () => {
    started.push("second");
  }, "user");

  await flushAsyncWork();
  assert.deepEqual(started, ["first"]);

  firstJob.resolve();
  await Promise.all([firstRun, secondRun]);

  assert.deepEqual(started, ["first", "second"]);
});

test("JobQueue reports running and pending work", async () => {
  const queue = new JobQueue();
  const blocker = createDeferred<void>();

  const runningJob = queue.enqueue(async () => {
    await blocker.promise;
  }, "user");
  const pendingJob = queue.enqueue(async () => {}, "user");

  await flushAsyncWork();
  assert.deepEqual(queue.getStatus(), {
    running: true,
    pendingUsers: 1,
    pendingFeeds: 0,
  });

  blocker.resolve();
  await Promise.all([runningJob, pendingJob]);
  assert.deepEqual(queue.getStatus(), {
    running: false,
    pendingUsers: 0,
    pendingFeeds: 0,
  });
});

test("JobQueue drops feed jobs when another job is already running", async () => {
  const queue = new JobQueue();
  const blocker = createDeferred<void>();
  const started: string[] = [];

  const runningJob = queue.enqueue(async () => {
    started.push("user");
    await blocker.promise;
  }, "user");

  await flushAsyncWork();
  const accepted = await queue.enqueue(async () => {
    started.push("feed");
  }, "feed");

  assert.equal(accepted, false);
  blocker.resolve();
  await runningJob;
  assert.deepEqual(started, ["user"]);
});

test("JobQueue gives user jobs priority over pending feed jobs", async () => {
  const queue = new JobQueue();
  const order: string[] = [];

  const feedRun = queue.enqueue(async () => {
    order.push("feed");
  }, "feed");

  const userRun = queue.enqueue(async () => {
    order.push("user");
  }, "user");

  await Promise.all([feedRun, userRun]);
  assert.deepEqual(order, ["user", "feed"]);
});
