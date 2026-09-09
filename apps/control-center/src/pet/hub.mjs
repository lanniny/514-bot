/**
 * pet/hub.mjs — 桌宠瞬态事件枢纽（内存 pub/sub）。
 *
 * 只承载打字脉冲等高频低价值信号：与 event-store 的持久哈希链事件流严格分离，
 * 不落盘、不回放、无游标。消费者掉线或异常都不影响发布方。
 */

const MAX_LISTENERS = 8;

export function createPetHub() {
  const listeners = new Set();

  return {
    /**
     * 广播一条瞬态脉冲。kind 必须是简短的事件名（同时作为 SSE event 字段）。
     * @param {{ kind: string }} event
     */
    publish(event) {
      const kind = String(event?.kind || "").trim();
      if (!kind) return false;
      for (const listener of listeners) {
        try {
          listener({ kind, at: Date.now() });
        } catch {
          // 单个消费者异常不拖垮其他消费者；流式写失败由各自的 close 清理
        }
      }
      return true;
    },

    /**
     * 订阅脉冲流，返回退订函数。订阅数有上限，防止孤儿连接无限累积。
     * @param {(event: { kind: string, at: number }) => void} listener
     */
    subscribe(listener) {
      if (typeof listener !== "function") {
        throw Object.assign(new Error("pet hub listener must be a function"), { code: "PET_LISTENER_INVALID", httpStatus: 400 });
      }
      if (listeners.size >= MAX_LISTENERS) {
        throw Object.assign(new Error("pet hub subscribers full"), { code: "PET_HUB_CAPACITY", httpStatus: 503 });
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    subscriberCount() {
      return listeners.size;
    },
  };
}
