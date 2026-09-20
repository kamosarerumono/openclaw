import { describe, expect, it } from "vitest";
import {
  applyTaskRecordPatch,
  buildTaskRecordForCreate,
  captureTaskPersistenceReceipt,
  matchesTaskPersistenceReceipt,
  normalizeTaskRecord,
  resolveTaskCreateIdentity,
  type CreateTaskRecordParams,
} from "./task-registry-records.js";
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";

function task(status: TaskStatus, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task-${status}`,
    runtime: "cli",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: status,
    status,
    deliveryStatus: "not_applicable",
    notifyPolicy: "done_only",
    createdAt: 100,
    ...overrides,
  };
}

describe("normalizeTaskRecord", () => {
  it.each(["succeeded", "failed", "timed_out", "cancelled", "lost"] as const)(
    "materializes %s completion from the latest terminal event",
    (status) => {
      expect(normalizeTaskRecord(task(status, { lastEventAt: 250 })).endedAt).toBe(250);
    },
  );

  it("falls back to original creation when a legacy terminal has no event time", () => {
    expect(normalizeTaskRecord(task("failed", { createdAt: 200, startedAt: 100 })).endedAt).toBe(
      200,
    );
  });

  it("does not add an end time to active records", () => {
    const active = task("running", { lastEventAt: 250 });
    expect(normalizeTaskRecord(active)).toBe(active);
    expect(active.endedAt).toBeUndefined();
    expect(active).not.toHaveProperty("runId");
    expect(active).not.toHaveProperty("childSessionKey");
  });

  it("keeps creation, patches, and persistence receipts on canonical task identifiers", () => {
    const params: CreateTaskRecordParams = {
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      runId: " run-one ",
      childSessionKey: " agent:main:subagent:one ",
      task: "canonical identifier receipt",
    };
    const { record } = buildTaskRecordForCreate(params, resolveTaskCreateIdentity(params), {
      now: 100,
      taskId: "task-one",
    });
    expect(record).toMatchObject({
      runId: "run-one",
      childSessionKey: "agent:main:subagent:one",
    });
    const receipt = captureTaskPersistenceReceipt(record);
    const same = applyTaskRecordPatch(record, {
      runId: " run-one ",
      childSessionKey: " agent:main:subagent:one ",
    });
    expect(matchesTaskPersistenceReceipt(same, receipt)).toBe(true);

    const replacement = applyTaskRecordPatch(record, { runId: " run-two " });
    expect(replacement.runId).toBe("run-two");
    expect(matchesTaskPersistenceReceipt(replacement, receipt)).toBe(false);

    const cleared = applyTaskRecordPatch(record, { runId: " \t ", childSessionKey: " \n " });
    expect(cleared).not.toHaveProperty("runId");
    expect(cleared).not.toHaveProperty("childSessionKey");
    expect(() => captureTaskPersistenceReceipt(cleared)).toThrow(
      "Task persistence selection requires a run identity",
    );
  });
});
