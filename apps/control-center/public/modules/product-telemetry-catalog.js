/**
 * C5 产品埋点注册表——视图与关键动作的单一真源。
 *
 * 服务端 summary 用这份名单做差集，才能诚实回答「哪些面从来没打开过」。
 * 禁止在 product-telemetry.mjs / 健康看板里再手写一份会过期的清单。
 */

import { NAV_ITEMS } from "./nav-config.js";

/** 主导航注册视图。与 nav-config 同步，增删视图只改那里。 */
export const REGISTERED_VIEWS = Object.freeze(Object.keys(NAV_ITEMS));

/**
 * 关键动作 id → 展示名。id 必须过 FIELD_WHITELIST 的 slug 字符集。
 * 只登记廉价、离散、不含用户内容的动作——禁止按键级事件。
 */
export const PRODUCT_ACTIONS = Object.freeze({
  "palette.invoke": { id: "palette.invoke", label: "命令面板" },
  "tour.dismiss": { id: "tour.dismiss", label: "关闭导览" },
  "tour.complete": { id: "tour.complete", label: "完成导览" },
  "skill.save": { id: "skill.save", label: "存为技能" },
  "kickoff.send": { id: "kickoff.send", label: "发送 kickoff" },
  "routine.create": { id: "routine.create", label: "新建例行" },
  "routine.enable": { id: "routine.enable", label: "启用例行" },
  "channel.open": { id: "channel.open", label: "打开渠道" },
  "value-proof.link": { id: "value-proof.link", label: "收获证明链接" },
});

export const PRODUCT_ACTION_IDS = Object.freeze({
  paletteInvoke: "palette.invoke",
  tourDismiss: "tour.dismiss",
  tourComplete: "tour.complete",
  skillSave: "skill.save",
  kickoffSend: "kickoff.send",
  routineCreate: "routine.create",
  routineEnable: "routine.enable",
  channelOpen: "channel.open",
  valueProofLink: "value-proof.link",
});

export const REGISTERED_CAPABILITIES = Object.freeze(Object.keys(PRODUCT_ACTIONS));

/**
 * 注册全集 − 已观察到的 = 从未用过。
 * observed 里的未知 id 不进分母，避免鬼视图把覆盖率撑歪。
 */
export function unusedRegistered(observed = [], registered = []) {
  const seen = new Set((Array.isArray(observed) ? observed : []).map(String));
  const known = [...new Set((Array.isArray(registered) ? registered : []).map(String).filter(Boolean))];
  return {
    known,
    used: known.filter((id) => seen.has(id)),
    unused: known.filter((id) => !seen.has(id)),
  };
}
