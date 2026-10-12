# NOTICE — whale/（DS鲸鱼娘 通用 Live2D 模型）

本目录**不属于 BongoCat 上游素材**，与 `bongo-*` 三套猫模型无关，请勿混用授权说明。

## 来源与授权

- 原始压缩包：`DS鲸鱼娘.zip`（含 `DS面捕版.zip` / `DS鼠控版.zip`，内容基本一致；本目录取自**鼠控版**）
- 模型本体：`c_0120.moc3`（Live2D Cubism **moc3 v4**，247 参数）
- 作者：B站 **@冷面酱**（UID 11272072）
- 版权：**@白柒七** & **@ZipZipPin**
- 许可：**CC BY-NC-SA 4.0**（署名 — 非商业性使用 — 相同方式共享）
  https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh
- 原包内 `使用须知.txt` 原文要求：**禁止任何形式的倒卖以及出售**；本模型为无偿分享（NC），禁止以商业盈利为主要目的使用。

**本目录仅用于 514cc 本地自用**，不随产品分发、不用于任何商业用途。
按 SA 条款，若再分发本目录的修改版，须以同样许可（CC BY-NC-SA 4.0）释出。

## 514cc 对原素材做过的改动（SA 要求明示）

1. **文件名 ASCII 化**：
   - 44 个中文名 `.exp3.json` → `expressions/<语义名>.exp3.json`（原名对照见 `expression-names.json`）
   - `motions/` 下 6 个中文名 `.motion3.json` → `motions/<语义名>.motion3.json`；`aidale.motion3.json` → `motions/hammer.motion3.json`
   - 原因：静态资源层对非 ASCII 路径返回 404（已实测）
2. **补写 `c_0120.model3.json`**：原文件 `FileReferences` 只有 Moc/Textures/Physics/DisplayInfo，
   没有 Expressions / Motions 段，标准 Live2D 播放器无法发现素材。
   本目录补入了这两段（素材内容未改，只补索引）。
3. **未改动**：`c_0120.moc3`、两张贴图、`c_0120.physics3.json`、`c_0120.cdi3.json` 均逐字节保持原样。

## 运行时

- `live2dcubismcore.min.js` — Live2D Cubism Core（专有许可，"Redistributable Code"），
  随 514cc 已有 vendor 提供，**不在本目录内**：`../pet/live2dcubismcore.min.js`
- `pixi-live2d-cubism4.min.js` — pixi-live2d-display 0.4.0（MIT, © 2020 Guan），同上，位于 `../pet/`

## 重要技术提醒

本模型**没有** BongoCat 猫的专属参数（`CatParamLeftHandDown`、`ParamMouseX` 等，0 命中）。
更危险的是 **`Param3` / `Param4` / `Param5` 在此模型上是「高光大小 / 高光挤压 / 高光左右」，
且属于 physics3.json 的输出**——沿用猫的写参表会持续破坏她的眼睛高光，且不会报错。
写参必须走 `public/pet/pet-models/whale.js` 声明的通用分支。
