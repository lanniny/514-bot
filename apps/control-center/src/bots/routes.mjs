/**
 * bots/routes.mjs — 514 Bot 协作体系路由面（Wave G 面模式）。
 * 主驾在 server.mjs 接线：registerBotsRoutes(surfaceRouter, surfaceCtx)。
 *
 * 端点（全部走 /api/ 统一 Bearer 门）：
 *   GET    /api/bots                       Bot 花名册（profiles + 成员元数据投影）
 *   GET    /api/bots/protocol              协作协议摘要（Grok Bot 对标映射表）
 *   GET/PUT/DELETE /api/bots/<memberId>    Bot profile（job/standingRules/approvalBoundary/skills）
 *   POST   /api/bots/relay/kickoff         群聊 kickoff 派发（@A 做 X；@B 做 Y；单 owner 守卫）
 *   POST   /api/bots/relay/handoff         单点交接（Bot A → Bot B，task 消息 + handoffId）
 *   POST   /api/bots/relay/ack             交接确认（仅接收方，refs.ackOf 回执）
 *   GET    /api/bots/relay/<runId>         交接板（openHandoffs / acknowledgedHandoffs）
 *   GET/POST   /api/bots/routines          例行任务列表 / 创建
 *   GET/PUT/DELETE /api/bots/routines/<id> 例行任务单条（删除联动 automation，fail-closed）
 *   POST   /api/bots/routines/<id>/test    Test run（dry-run 计划装配，plan-only 如实标注）
 *   POST   /api/bots/routines/<id>/enable  启用（桥接 AutomationStore：create 或 enabled=true）
 *   POST   /api/bots/routines/<id>/pause   暂停（automation.enabled=false；无桥不假装在跑）
 */

import { BotProfileStore } from "./profiles.mjs";
import { BotRelayService } from "./relay.mjs";
import { BotRoutineStore, toAutomationSpec } from "./routines.mjs";
import { BotPrivateSkillStore } from "./private-skills.mjs";

const NOT_FOUND_CODES = new Set(["PROFILE_NOT_FOUND", "ROUTINE_NOT_FOUND", "MEMBER_NOT_FOUND", "RELAY_HANDOFF_NOT_FOUND", "PRIVATE_SKILL_NOT_FOUND"]);

let servicesPromise = null;

function safeGetMember(ctx, memberId) {
  try {
    const member = ctx.state.teamMembers?.get?.(memberId);
    return member ?? null;
  } catch {
    return null;
  }
}

async function initServices(ctx) {
  const resolveMember = (memberId) => safeGetMember(ctx, memberId);
  const profiles = await new BotProfileStore({ dataRoot: ctx.state.dataRoot, resolveMember }).init();
  const relay = new BotRelayService({
    bus: ctx.state.orchestrator.bus,
    resolveHandle: (handleOrId) => profiles.resolveHandle(handleOrId),
    resolveMember,
  });
  const routines = await new BotRoutineStore({
    dataRoot: ctx.state.dataRoot,
    resolveMember,
    routineQuotaFor: (memberId) => profiles.get(memberId)?.routineQuota ?? 50,
    resolveProfile: (memberId) => profiles.get(memberId) ?? null,
  }).init();
  const privateSkills = await new BotPrivateSkillStore({ dataRoot: ctx.state.dataRoot }).init();
  // W3（Grok 对标）：routine 运行历史回填。automation.triggered 是调度真源的唯一触发信号，
  // 按 automationRef 反查 routine 并追加 runHistory（保留 20 条，对齐 Grok）。
  // 历史是派生数据：subscriber 完全自封（event-store 会摘除抛错的订阅者），失败绝不外抛。
  if (ctx.state.eventStore?.subscribe) {
    ctx.state.eventStore.subscribe((event) => {
      try {
        if (event?.type !== "automation.triggered") return;
        const automationId = String(event.data?.id || "");
        if (!automationId) return;
        for (const routine of routines.list()) {
          if (String(routine.automationRef || "") !== automationId) continue;
          void routines.appendRunHistory(routine.id, {
            runId: typeof event.data?.runId === "string" ? event.data.runId : null,
            source: typeof event.data?.source === "string" ? event.data.source : "schedule",
            status: "triggered",
          }).catch(() => {});
        }
      } catch {
        // 派生数据失败静默：不影响事件主链
      }
    });
  }
  return { profiles, relay, routines, privateSkills };
}

function ensureServices(ctx) {
  if (!servicesPromise) {
    servicesPromise = initServices(ctx).catch((error) => {
      servicesPromise = null; // 初始化失败允许下一请求重试，不把拒绝缓存成永久态
      throw error;
    });
  }
  return servicesPromise;
}

/** 测试注入/复位（对齐 hooks/routes 的 set*ForTest 模式）。 */
export function setBotsServicesForTest(instance) {
  servicesPromise = Promise.resolve(instance);
}
export function resetBotsServicesForTest() {
  servicesPromise = null;
}

function httpStatusFor(error) {
  if (error.httpStatus) return error.httpStatus;
  if (NOT_FOUND_CODES.has(error.code)) return 404;
  if (error.code === "ROUTINE_BRIDGE_UNAVAILABLE") return 503;
  if (error.code === "RUN_NOT_FOUND") return 404;
  return 400;
}

function projectBot(profile, member) {
  return {
    memberId: profile.memberId,
    handle: profile.handle,
    job: profile.job,
    standingRules: profile.standingRules,
    approvalBoundary: profile.approvalBoundary,
    skills: profile.skills,
    routineQuota: profile.routineQuota,
    pinned: profile.pinned,
    hidden: profile.hidden,
    notes: profile.notes,
    updatedAt: profile.updatedAt,
    member: member
      ? {
          label: member.label ?? null,
          shortLabel: member.shortLabel ?? null,
          role: member.role ?? null,
          runtimeProfileId: member.runtimeProfileId ?? null,
          builtin: member.builtin === true,
        }
      : null,
  };
}

/** 协议摘要：Grok Bot ↔ 514cc 对标映射（docs/bot-collaboration-protocol.md 的机器可读版）。 */
const PROTOCOL_SUMMARY = Object.freeze({
  schema: "514cc.bot-collab-protocol/v1",
  source: "docs/bot-collaboration-protocol.md",
  reference: "https://docs.x.ai/grok-bot (x.ai/bot 产品文档)",
  layers: [
    { id: "profiles", grok: "Create and manage Bots（durable teammate：job/description/审批边界/50 routine 配额）", local: "src/bots/profiles.mjs（team-members 叠加层，不造第二 roster）" },
    { id: "relay", grok: "Message and collaborate（@ 指派、kickoff、hand off work、单 owner）", local: "src/bots/relay.mjs（基于 BusStore，task + handoffId + ack 回执）" },
    { id: "routines", grok: "Skills and routines（六要素确认、Test run、50/Bot、20 条历史）", local: "src/bots/routines.mjs（桥接 AutomationStore，不造第二调度器）" },
    { id: "approvals", grok: "Approvals, security, and privacy（显式边界、Auto Review、secure handoff）", local: "approval-broker（既有）+ profiles.approvalBoundary（按 Bot 持久边界）" },
  ],
  principles: [
    "最小花名册：一个 Bot 端到端拥有一个结果（Grok: Give one Bot ownership of an end-to-end outcome）",
    "每阶段单 owner：kickoff 内同 handle 双指派 fail-fast（Grok: Too many parallel handoffs create duplicate work）",
    "外部动作审批后：requireApproval 清单为持久边界（Grok: Keep external actions behind a clear approval boundary）",
    "缺数据报告失败：noDataPolicy 不允许 stale-data 默认（Grok: report the failure instead of using old data）",
  ],
});

export function registerBotsRoutes(router, ctx) {
  const guarded = (handler) => async (request, response, url) => {
    try {
      return await handler(request, response, url);
    } catch (error) {
      ctx.json(response, httpStatusFor(error), {
        ok: false,
        code: error.code || "BOTS_ERROR",
        message: error.message,
      });
      return true;
    }
  };

  // ---- 花名册列表（精确匹配 /api/bots，其余放行给子路径 dispatcher）----
  router.get("/api/bots", guarded(async (_request, response, url) => {
    if (url.pathname !== "/api/bots") return false;
    const { profiles } = await ensureServices(ctx);
    const bots = profiles.list().map((profile) => projectBot(profile, safeGetMember(ctx, profile.memberId)));
    ctx.json(response, 200, {
      ok: true,
      schema: "514cc.bots-list/v1",
      count: bots.length,
      bots,
    });
    return true;
  }));

  // ---- 协议摘要（静态投影，供 UI/agent 拉取协作规则）----
  router.get("/api/bots/protocol", guarded(async (_request, response, url) => {
    if (url.pathname !== "/api/bots/protocol") return false;
    const { profiles, routines } = await ensureServices(ctx);
    ctx.json(response, 200, {
      ok: true,
      ...PROTOCOL_SUMMARY,
      live: {
        profileCount: profiles.status().count,
        routineCount: routines.status().count,
        profilesStore: profiles.status().state,
        routinesStore: routines.status().state,
      },
    });
    return true;
  }));

  // ---- relay：kickoff / handoff / ack（POST）----
  router.post("/api/bots/relay/", guarded(async (request, response, url) => {
    const sub = decodeURIComponent(url.pathname.slice("/api/bots/relay/".length));
    const { relay } = await ensureServices(ctx);
    if (sub === "kickoff") {
      const payload = await ctx.body(request);
      const result = await relay.kickoff({
        runId: payload?.runId,
        from: payload?.from ?? "lo",
        text: payload?.text,
        strictStages: payload?.strictStages === true,
      });
      ctx.json(response, 201, { ok: true, ...result });
      return true;
    }
    if (sub === "handoff") {
      const payload = await ctx.body(request);
      const result = await relay.handoff({
        runId: payload?.runId,
        from: payload?.from,
        to: payload?.to,
        stage: payload?.stage ?? null,
        text: payload?.text,
      });
      ctx.json(response, 201, { ok: true, ...result });
      return true;
    }
    if (sub === "ack") {
      const payload = await ctx.body(request);
      const result = await relay.acknowledge({
        runId: payload?.runId,
        from: payload?.from,
        handoffId: payload?.handoffId,
      });
      ctx.json(response, 200, { ok: true, ...result });
      return true;
    }
    return false;
  }));

  // ---- relay：交接板（GET /api/bots/relay/<runId>）----
  router.get("/api/bots/relay/", guarded(async (_request, response, url) => {
    const runId = decodeURIComponent(url.pathname.slice("/api/bots/relay/".length));
    if (!runId) return false;
    const { relay } = await ensureServices(ctx);
    const board = await relay.readBoard(runId);
    ctx.json(response, 200, { ok: true, ...board });
    return true;
  }));

  // ---- routines：列表 / 创建 ----
  router.get("/api/bots/routines", guarded(async (_request, response, url) => {
    if (url.pathname !== "/api/bots/routines") return false;
    const { routines } = await ensureServices(ctx);
    const owningMemberId = url.searchParams.get("owning") || null;
    const items = routines.list({ owningMemberId });
    ctx.json(response, 200, { ok: true, schema: "514cc.bot-routines-list/v1", count: items.length, routines: items });
    return true;
  }));

  router.post("/api/bots/routines", guarded(async (request, response, url) => {
    if (url.pathname !== "/api/bots/routines") return false;
    const { routines } = await ensureServices(ctx);
    const payload = await ctx.body(request);
    const created = await routines.create(payload ?? {});
    ctx.json(response, 201, { ok: true, routine: created });
    return true;
  }));

  // ---- routines 单条与动作（GET/PUT/DELETE/POST .../test|enable|pause）----
  const routineSingleHandler = (method) => guarded(async (request, response, url) => {
    const rest = decodeURIComponent(url.pathname.slice("/api/bots/routines/".length));
    const [id, action] = rest.split("/");
    if (!id) return false;
    const { routines, profiles } = await ensureServices(ctx);
    const automations = ctx.state.automations;

    if (method === "GET" && !action) {
      const routine = routines.get(id);
      if (!routine) {
        ctx.json(response, 404, { ok: false, code: "ROUTINE_NOT_FOUND", message: `routine ${id} does not exist` });
        return true;
      }
      ctx.json(response, 200, { ok: true, routine });
      return true;
    }

    if (method === "PUT" && !action) {
      const payload = await ctx.body(request);
      const updated = await routines.update(id, payload ?? {});
      // 已启用且有桥接引用：自动化同步到最新指令/调度（一致性，不留两张皮）
      if (updated.enabled && updated.automationRef && automations) {
        const profile = profiles.get(updated.owningMemberId) ?? null;
        const spec = toAutomationSpec(updated, profile);
        await automations.update(updated.automationRef, {
          name: spec.name,
          prompt: spec.prompt,
          schedule: spec.schedule,
          requestedAgentIds: spec.requestedAgentIds,
        });
      }
      ctx.json(response, 200, { ok: true, routine: updated });
      return true;
    }

    if (method === "DELETE" && !action) {
      // 先删 automation 再删 routine：automation 删失败则 routine 保留（fail-closed，不留孤儿调度）
      const existing = routines.get(id);
      if (!existing) {
        ctx.json(response, 404, { ok: false, code: "ROUTINE_NOT_FOUND", message: `routine ${id} does not exist` });
        return true;
      }
      if (existing.automationRef && automations) {
        await automations.remove(existing.automationRef);
      }
      const removed = await routines.remove(id);
      ctx.json(response, 200, { ok: true, ...removed });
      return true;
    }

    if (method === "POST" && action === "test") {
      const result = await routines.testRun(id);
      ctx.json(response, 200, { ok: true, ...result });
      return true;
    }

    if (method === "POST" && action === "enable") {
      const routine = routines.get(id);
      if (!routine) {
        ctx.json(response, 404, { ok: false, code: "ROUTINE_NOT_FOUND", message: `routine ${id} does not exist` });
        return true;
      }
      const bridgeWritable = Boolean(automations?.status?.().writable);
      if (!bridgeWritable) {
        // fail-closed：调度桥不可用就不开启——不留下「看起来在跑其实没接电」的假状态
        ctx.json(response, 503, {
          ok: false,
          code: "ROUTINE_BRIDGE_UNAVAILABLE",
          message: "automation bridge is not writable; routine stays disabled instead of pretending to run",
        });
        return true;
      }
      const profile = profiles.get(routine.owningMemberId) ?? null;
      const spec = toAutomationSpec({ ...routine, enabled: true }, profile);
      let automationRef = routine.automationRef;
      if (automationRef) {
        await automations.update(automationRef, { enabled: true });
      } else {
        const created = await automations.create(spec);
        automationRef = created.id;
        await routines.setAutomationRef(id, automationRef);
      }
      const updated = await routines.update(id, { enabled: true });
      ctx.json(response, 200, { ok: true, routine: updated, automationRef });
      return true;
    }

    if (method === "POST" && action === "pause") {
      const routine = routines.get(id);
      if (!routine) {
        ctx.json(response, 404, { ok: false, code: "ROUTINE_NOT_FOUND", message: `routine ${id} does not exist` });
        return true;
      }
      if (routine.automationRef && automations) {
        await automations.update(routine.automationRef, { enabled: false });
      }
      const updated = await routines.update(id, { enabled: false });
      ctx.json(response, 200, { ok: true, routine: updated });
      return true;
    }

    return false;
  });

  router.get("/api/bots/routines/", routineSingleHandler("GET"));
  router.put("/api/bots/routines/", routineSingleHandler("PUT"));
  router.delete("/api/bots/routines/", routineSingleHandler("DELETE"));
  router.post("/api/bots/routines/", routineSingleHandler("POST"));

  // ---- LO 私有技能（Grok: Private skills；必须注册在 profileSingleHandler 之前——
  //      /api/bots/private-skills 形似 /api/bots/<memberId>，前缀匹配按注册序派发）----
  router.get("/api/bots/private-skills", guarded(async (_request, response, url) => {
    if (url.pathname !== "/api/bots/private-skills") return false;
    const { privateSkills } = await ensureServices(ctx);
    ctx.json(response, 200, { ok: true, count: privateSkills.status().count, skills: privateSkills.list() });
    return true;
  }));

  router.post("/api/bots/private-skills", guarded(async (request, response, url) => {
    if (url.pathname !== "/api/bots/private-skills") return false;
    const payload = await ctx.body(request);
    const { privateSkills } = await ensureServices(ctx);
    const skill = await privateSkills.create(payload ?? {});
    ctx.json(response, 201, { ok: true, skill });
    return true;
  }));

  const privateSkillSingleHandler = (method) => guarded(async (request, response, url) => {
    const id = decodeURIComponent(url.pathname.slice("/api/bots/private-skills/".length));
    if (!id || id.includes("/")) return false;
    const { privateSkills } = await ensureServices(ctx);
    if (method === "PUT") {
      const payload = await ctx.body(request);
      const skill = await privateSkills.update(id, payload ?? {});
      ctx.json(response, 200, { ok: true, skill });
      return true;
    }
    if (method === "DELETE") {
      const removed = await privateSkills.remove(id);
      ctx.json(response, 200, { ok: true, ...removed });
      return true;
    }
    return false;
  });

  router.put("/api/bots/private-skills/", privateSkillSingleHandler("PUT"));
  router.delete("/api/bots/private-skills/", privateSkillSingleHandler("DELETE"));

  // ---- Bot profile 单条（GET/PUT/DELETE /api/bots/<memberId>；放最后避免吞掉子路径）----
  const profileSingleHandler = (method) => guarded(async (request, response, url) => {
    const memberId = decodeURIComponent(url.pathname.slice("/api/bots/".length));
    if (!memberId || memberId.includes("/")) return false; // 子路径（relay/routines/protocol）已在上面注册
    const { profiles } = await ensureServices(ctx);

    if (method === "GET") {
      const profile = profiles.get(memberId);
      if (!profile) {
        ctx.json(response, 404, { ok: false, code: "PROFILE_NOT_FOUND", message: `profile for member ${memberId} does not exist` });
        return true;
      }
      ctx.json(response, 200, { ok: true, bot: projectBot(profile, safeGetMember(ctx, memberId)) });
      return true;
    }

    if (method === "PUT") {
      const payload = await ctx.body(request);
      const saved = await profiles.upsert(memberId, payload ?? {});
      ctx.json(response, 200, { ok: true, bot: projectBot(saved, safeGetMember(ctx, memberId)) });
      return true;
    }

    if (method === "DELETE") {
      const removed = await profiles.remove(memberId);
      ctx.json(response, 200, { ok: true, ...removed });
      return true;
    }

    return false;
  });

  router.get("/api/bots/", profileSingleHandler("GET"));
  router.put("/api/bots/", profileSingleHandler("PUT"));
  router.delete("/api/bots/", profileSingleHandler("DELETE"));
}
