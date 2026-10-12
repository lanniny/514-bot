const NAME = "514cc-pet";
/**
 * 消息通道名。桌宠页另开一条 `514cc-pet-cmd` 用于「反向指令」：
 * 桌宠发起的模型/表情/动作切换，经主窗口落到插件台账（真源）。
 *
 * 为什么不复用同一条：`514cc-pet` 上主窗口已经在应答 `pet-hello`，
 * 桌宠页 `pet-engine.js` 的 onmessage 又只处理 pet-token / pet-config —— 混在一起
 * 会让「指令回执」和「配置下发」抢同一个分支。分通道，语义各自清楚。
 */
const COMMAND_NAME = "514cc-pet-cmd";

// Web fallback accepts only the expected parent/iframe at the exact current origin.
export function createPetChannel(getPeer, host = window, nativeWindow = false, name = NAME) {
  if (nativeWindow && typeof host.BroadcastChannel === "function") return new host.BroadcastChannel(name);
  const channel = {
    onmessage: null,
    postMessage(data) {
      getPeer()?.postMessage({ channel: name, data }, host.location.origin);
    },
    close() { host.removeEventListener("message", receive); channel.onmessage = null; },
  };
  function receive(event) {
    const peer = getPeer();
    if (!peer || event.source !== peer || event.origin !== host.location.origin || event.data?.channel !== name) return;
    channel.onmessage?.({ data: event.data.data });
  }
  host.addEventListener("message", receive);
  return channel;
}

/** 桌宠页的指令通道（BroadcastChannel 或同源 iframe 桥）。 */
export function createPetCommandChannel(getPeer, host = window, nativeWindow = false) {
  return createPetChannel(getPeer, host, nativeWindow, COMMAND_NAME);
}

export { COMMAND_NAME as PET_COMMAND_CHANNEL_NAME };
