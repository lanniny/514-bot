import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createResearchCheckpoint,
  validateResearchCheckpoint,
  RESEARCH_CHECKPOINT_SCHEMA,
} from "./research-checkpoint.mjs";

export class CheckpointStore {
  constructor({ dataRoot = null, filename = "checkpoints.jsonl" } = {}) {
    this.dataRoot = dataRoot;
    this.filename = filename;
    this.filePath = dataRoot ? join(dataRoot, filename) : null;
    this.byRun = new Map(); // runId -> Checkpoint[]
    this.byConversation = new Map(); // conversationId -> Checkpoint[]
    this.all = [];
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.filePath) return;

    try {
      const content = await readFile(this.filePath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item?.schema === RESEARCH_CHECKPOINT_SCHEMA && item.id) {
            this._indexCheckpoint(item);
          }
        } catch {
          // 忽略单行破损日志
        }
      }
    } catch (err) {
      if (err?.code !== "ENOENT") {
        console.warn(`[CheckpointStore] 读取检查点持久化文件失败:`, err?.message || err);
      }
    }
  }

  _indexCheckpoint(checkpoint) {
    this.all.push(checkpoint);

    if (checkpoint.runId) {
      const list = this.byRun.get(checkpoint.runId) || [];
      list.push(checkpoint);
      this.byRun.set(checkpoint.runId, list);
    }

    if (checkpoint.conversationId) {
      const list = this.byConversation.get(checkpoint.conversationId) || [];
      list.push(checkpoint);
      this.byConversation.set(checkpoint.conversationId, list);
    }
  }

  async record(input) {
    const checkpoint = input?.schema === RESEARCH_CHECKPOINT_SCHEMA && input.id
      ? input
      : createResearchCheckpoint(input);

    const validation = validateResearchCheckpoint(checkpoint);
    if (!validation.ok) {
      throw Object.assign(new Error(`无效的检查点: ${validation.reason}`), {
        code: "CHECKPOINT_INVALID",
      });
    }

    this._indexCheckpoint(checkpoint);

    if (this.filePath) {
      try {
        if (this.dataRoot) {
          await mkdir(this.dataRoot, { recursive: true });
        }
        await appendFile(this.filePath, JSON.stringify(checkpoint) + "\n", "utf8");
      } catch (err) {
        console.warn(`[CheckpointStore] 追加写入检查点失败:`, err?.message || err);
      }
    }

    return checkpoint;
  }

  getByRun(runId) {
    if (!runId) return [];
    return [...(this.byRun.get(String(runId)) || [])];
  }

  getByConversation(conversationId) {
    if (!conversationId) return [];
    return [...(this.byConversation.get(String(conversationId)) || [])];
  }

  getLatest(id) {
    if (!id) return null;
    const strId = String(id);
    const byRun = this.byRun.get(strId);
    if (byRun?.length) return byRun[byRun.length - 1];

    const byConv = this.byConversation.get(strId);
    if (byConv?.length) return byConv[byConv.length - 1];

    return null;
  }

  getAll() {
    return [...this.all];
  }
}
