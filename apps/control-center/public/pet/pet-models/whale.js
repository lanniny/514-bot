/**
 * pet-models/whale.js — DS鲸鱼娘 模型描述（c_0120）。
 *
 * 与 BongoCat 三模式（猫）不同，这是一个通用 VTuber 模型：
 *   - 没有 CatParam* / ParamMouseX 等猫专属参数，绝不能复用猫的写参表；
 *   - model3.json 原本没有 Expressions / Motions 段，素材靠文件名寻址，
 *     已在本目录内 ASCII 化并补进清单（见 c_0120.model3.json）。
 *
 * 本文件只描述「模型是什么、能演什么」，不含任何渲染逻辑。
 * 素材授权：CC BY-NC-SA 4.0（非商业），作者 B站@冷面酱，版权 @白柒七 & @ZipZipPin。
 * 详见同目录 NOTICE.md。
 */

/** 表情语义名 → 文件（均在 expressions/ 下）。与 c_0120.model3.json 的 Expressions 一一对应。 */
export const WHALE_EXPRESSIONS = Object.freeze([
  "question", "exclamation", "dizzy", "sweat", "angry",
  "cry", "sad", "excited", "starry", "heart-eyes",
  "blush", "playful", "tongue", "blank", "drool",
  "soul-out", "gloomy", "heartbeat",
  "sunglasses", "glasses-round", "glasses-square", "glasses-oval",
  "sticker-cat", "sticker-rabbit", "sticker-bow",
  "flower", "double-peace", "paw-anim",
  "side-ponytail", "headband", "table-dark", "phone-color",
  "claw", "claw-color", "whale", "whale-on-table",
  "menu-press", "omurice", "pen", "eraser", "undo", "squeeze", "parfait", "love",
]);

/**
 * AI 状态 → 表情（**语义签名**）。
 *
 * 只列「状态本身需要被一眼认出」的瞬时状态：审批要你看、任务搞砸、回合完成、
 * 长时间静默、连接恢复中。这些状态切换必须给出**稳定可辨识**的脸，
 * 所以不参与轮换。
 *
 * 长驻状态（ready / typing）不在这里给固定脸 —— 走 WHALE_EXPRESSION_POOLS。
 */
export const WHALE_STATE_EXPRESSION = Object.freeze({
  attention: "exclamation",   // 审批待处理 —— 要你看
  failure: "angry",           // 任务需要关注 —— 搞砸了
  celebrate: "excited",       // 回合完成 —— 搞定了
  sleep: "drool",             // 静默 —— 闭眼口水
  reconnecting: "sweat",      // 连接恢复中
});

/**
 * 长驻状态的表情轮换池。
 *
 * **硬约束**（由 tests/pet-surface.test.mjs 从 exp3.json 机械核验，不靠人眼）：
 * 池内每个表情写的参数，必须与「引擎每帧写的参数（WHALE_DRIVABLE）」以及
 * 「物理输出参数（c_0120.physics3.json 的 Outputs）」**完全不相交**。
 *
 * 原因：exp3 的 Blend 全是 Add（叠加），一旦撞上引擎的每帧写值就会互相抵消，
 * 表现成「表情时有时无」这种极难复现的闪烁；撞上物理输出则会让解算器每帧被覆盖。
 *
 * 因此刻意排除两类：写 ParamEye*Open 的 excited / sunglasses / dizzy（与模型自带
 * 的 EyeBlink 打架）、写 ParamBrow* / ParamMouthForm 的 sad / heart-eyes / cry /
 * tongue / angry / playful（与引擎的写值叠加成半吊子表情）。
 */
export const WHALE_EXPRESSION_POOLS = Object.freeze({
  ready: Object.freeze([
    "question", "sweat", "starry", "flower", "heartbeat",
    "soul-out", "glasses-round", "glasses-square", "table-dark", "phone-color",
  ]),
  typing: Object.freeze([
    "claw", "claw-color", "pen", "eraser", "undo",
    "squeeze", "whale", "whale-on-table", "double-peace",
  ]),
});

/** 一次性动作（Emote 组），按语义名寻址。与 c_0120.model3.json 的 Emote 列表索引 0..5 严格对齐。 */
export const WHALE_MOTIONS = Object.freeze([
  "bubblegum", "ketchup", "open-phone", "selfie", "selfie-quick", "spray",
]);

/** 这个模型上确实存在、且适合程序驱动的参数（用于状态近似）。 */
export const WHALE_DRIVABLE = Object.freeze({
  headX: "ParamAngleX", headY: "ParamAngleY", headZ: "ParamAngleZ",
  eyeBallX: "ParamEyeBallX", eyeBallY: "ParamEyeBallY",
  eyeLOpen: "ParamEyeLOpen", eyeROpen: "ParamEyeROpen",
  mouthOpenY: "ParamMouthOpenY", mouthForm: "ParamMouthForm",
  breath: "ParamBreath",
});

/** 引擎消费的模型描述。 */
export const WHALE_PET_MODEL = Object.freeze({
  label: "鲸鱼娘",
  url: "/vendor/pet-models/whale/c_0120.model3.json",
  /** 与猫不同：本模型没有猫专属参数，写参必须走 whale 分支。 */
  kind: "generic",
  expressions: WHALE_EXPRESSIONS,
  stateExpression: WHALE_STATE_EXPRESSION,
  expressionPools: WHALE_EXPRESSION_POOLS,
  motions: WHALE_MOTIONS,
  /**
   * Emote 组名。欢庆时用 `motion(emoteGroup)` 走 startRandomMotion，
   * 由运行时按 model3.json 的实际条目数随机挑 —— 写死索引会让 6 个动作里
   * 5 个永远播不到（曾经就是 `motion("Emote", 0)`）。
   */
  emoteGroup: "Emote",
  drivable: WHALE_DRIVABLE,
});
