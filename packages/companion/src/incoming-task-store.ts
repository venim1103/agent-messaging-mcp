import { randomUUID } from "node:crypto";
import type { CreateTaskOptions, TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type { Request, RequestId, Result, Task } from "@modelcontextprotocol/sdk/types.js";

const MAX_PENDING_TASKS = 16;
const RESULT_RETENTION_MS = 5 * 60_000;

export class IncomingTaskStore implements TaskStore {
  private readonly records = new Map<string, {
    task: Task;
    augmented: boolean;
    sessionId?: string;
    result?: Result;
    controller: AbortController;
    timer?: NodeJS.Timeout;
  }>();

  async createTask(_options: CreateTaskOptions, _requestId: RequestId, request: Request, sessionId?: string): Promise<Task> {
    const augmented = request.method === "tools/call" && !!request.params?.task;
    if (augmented && [...this.records.values()].filter(record => record.augmented).length >= MAX_PENDING_TASKS) {
      throw new Error("TASK_LIMIT: Wait for retained tasks to expire before creating another task.");
    }
    const timestamp = new Date().toISOString();
    const task: Task = { taskId: randomUUID(), status: "working", createdAt: timestamp, lastUpdatedAt: timestamp,
      ttl: null, pollInterval: 1000 };
    this.records.set(task.taskId, { task, augmented, sessionId, controller: new AbortController() });
    return { ...task };
  }

  private record(taskId: string, sessionId?: string) {
    const record = this.records.get(taskId);
    return record && (sessionId === undefined || record.sessionId === undefined || record.sessionId === sessionId)
      ? record : undefined;
  }

  isAugmented(taskId: string) { return this.records.get(taskId)?.augmented === true; }
  signal(taskId: string) {
    const record = this.records.get(taskId);
    if (!record) throw new Error("TASK_NOT_FOUND");
    return record.controller.signal;
  }

  async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    const record = this.record(taskId, sessionId);
    return record ? { ...record.task } : null;
  }

  async storeTaskResult(taskId: string, status: "completed" | "failed", result: Result, sessionId?: string) {
    const record = this.record(taskId, sessionId);
    if (!record || record.task.status !== "working") throw new Error("TASK_NOT_WORKING");
    record.result = result;
    await this.updateTaskStatus(taskId, status, undefined, sessionId);
  }

  async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    const record = this.record(taskId, sessionId);
    if (!record?.result) throw new Error("TASK_RESULT_UNAVAILABLE");
    if (!record.augmented) {
      clearTimeout(record.timer);
      this.records.delete(taskId);
    }
    return record.result;
  }

  async updateTaskStatus(taskId: string, status: Task["status"], statusMessage?: string, sessionId?: string) {
    const record = this.record(taskId, sessionId);
    if (!record || record.task.status !== "working") throw new Error("TASK_NOT_WORKING");
    record.task = { ...record.task, status, lastUpdatedAt: new Date().toISOString(),
      ...(statusMessage ? { statusMessage } : {}) };
    if (status === "cancelled" || status === "completed" || status === "failed") {
      record.controller.abort();
      record.timer = setTimeout(() => this.records.delete(taskId), RESULT_RETENTION_MS);
      record.timer.unref();
    }
  }

  async listTasks(cursor?: string, sessionId?: string) {
    const tasks = [...this.records.values()].filter(record => record.augmented && this.record(record.task.taskId, sessionId))
      .map(record => ({ ...record.task }));
    if (cursor) throw new Error("INVALID_TASK_CURSOR");
    return { tasks };
  }

  cleanup() {
    for (const record of this.records.values()) {
      record.controller.abort();
      clearTimeout(record.timer);
    }
    this.records.clear();
  }
}