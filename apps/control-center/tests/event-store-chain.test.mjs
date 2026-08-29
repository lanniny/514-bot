import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore, CHAIN_GENESIS } from "../src/event-store.mjs";

async function withStore(options, fn) {
  const root = await mkdtemp(join(tmpdir(), "cc-chain-"));
  const path = join(root, "events.jsonl");
  // null 不会触发解构的默认值，必须归一成对象
  const store = await new EventStore(path, options ?? {}).init();
  try {
    return await fn({ store, path, root });
  } finally {
    await store.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

const linesOf = async (path) => (await readFile(path, "utf8")).split("\n").filter(Boolean);

test("每个事件都携带 prev 与 hash，首条以 genesis 起链", async () => {
  await withStore(null, async ({ store }) => {
    const first = await store.emit("alpha", { n: 1 });
    const second = await store.emit("beta", { n: 2 });
    const third = await store.emit("gamma", { n: 3 });

    assert.equal(first.prev, CHAIN_GENESIS, "首条事件的 prev 是 genesis");
    assert.equal(typeof first.hash, "string");
    assert.equal(first.hash.length, 43, "sha256 base64url 恒为 43 字符");
    assert.equal(second.prev, first.hash, "第二条引用第一条的哈希");
    assert.equal(third.prev, second.hash, "第三条引用第二条的哈希");
    assert.notEqual(third.hash, second.hash);
  });
});

test("落盘行的哈希与内存事件一致，且字段顺序把 prev/hash 放在末尾", async () => {
  await withStore(null, async ({ store, path }) => {
    const emitted = await store.emit("alpha", { n: 1 });
    const [line] = await linesOf(path);
    const parsed = JSON.parse(line);
    assert.equal(parsed.hash, emitted.hash, "落盘哈希与返回给调用方的哈希一致");
    assert.equal(parsed.prev, emitted.prev);
    const keys = Object.keys(parsed);
    assert.deepEqual(keys.slice(-2), ["prev", "hash"], "prev/hash 恒为最后两个键，便于 lastIndexOf 定位");
  });
});

test("verifyChain 对干净日志返回 ok", async () => {
  await withStore(null, async ({ store }) => {
    for (let i = 0; i < 10; i += 1) await store.emit("tick", { i });
    const status = await store.verifyChain();
    assert.equal(status.ok, true, "未被改动的日志校验通过");
    assert.equal(status.checked, 10);
    assert.deepEqual(status.breaks, []);
    assert.equal(status.fault, null);
    assert.equal(status.legacy, 0);
  });
});

test("篡改任意一条的内容会报 hash-mismatch 并定位到行号", async () => {
  await withStore(null, async ({ store, path }) => {
    await store.emit("alpha", { n: 1 });
    await store.emit("beta", { n: 2 });
    await store.emit("gamma", { n: 3 });
    const lines = await linesOf(path);
    // 只改中间一条的载荷，其余保持原样
    lines[1] = lines[1].replace('"beta"', '"BETA"');
    await writeFile(path, `${lines.join("\n")}\n`);

    const status = await store.verifyChain();
    assert.equal(status.ok, false, "内容被改必须被发现");
    assert.equal(status.breaks.length, 1, "只报一处断裂");
    assert.equal(status.breaks[0].line, 2, "断裂定位到第 2 行");
    assert.equal(status.breaks[0].reason, "hash-mismatch", "前驱未变，根因是内容本身");
  });
});

test("删除中间一条会报 prev-mismatch（前驱缺失）", async () => {
  await withStore(null, async ({ store, path }) => {
    await store.emit("alpha", {});
    await store.emit("beta", {});
    await store.emit("gamma", {});
    const lines = await linesOf(path);
    await writeFile(path, `${[lines[0], lines[2]].join("\n")}\n`);

    const status = await store.verifyChain();
    assert.equal(status.ok, false);
    // 删除会让后续事件的 prev 落空：两种情况都错，但根因是前驱缺失
    assert.equal(status.breaks[0].reason, "prev-mismatch", "根因应报前驱不匹配，而非内容被改");
    assert.equal(status.breaks[0].line, 2);
  });
});

test("删除首条会在第 1 行暴露，而不是被静默接受", async () => {
  await withStore(null, async ({ store, path }) => {
    await store.emit("alpha", {});
    await store.emit("beta", {});
    const lines = await linesOf(path);
    await writeFile(path, `${lines[1]}\n`);

    const status = await store.verifyChain();
    assert.equal(status.ok, false, "头部缺失不能悄悄通过");
    assert.equal(status.breaks[0].line, 1);
    assert.equal(status.breaks[0].expectedPrev, CHAIN_GENESIS, "第 1 行本应以 genesis 起链");
    assert.notEqual(status.breaks[0].actualPrev, CHAIN_GENESIS);
  });
});

test("剥掉 hash 字段会被当作遗留行而非『通过』", async () => {
  await withStore(null, async ({ store, path }) => {
    await store.emit("alpha", {});
    await store.emit("beta", {});
    const lines = await linesOf(path);
    const stripped = lines.map((line) => {
      const parsed = JSON.parse(line);
      delete parsed.hash;
      delete parsed.prev;
      return JSON.stringify(parsed);
    });
    await writeFile(path, `${stripped.join("\n")}\n`);

    const status = await store.verifyChain();
    assert.equal(status.legacy, 2, "无哈希的行计入遗留段");
    assert.equal(status.checked, 0, "遗留行不参与校验");
    assert.equal(status.ok, true, "遗留数据本身不算断裂");
  });
});

test("F-048 之前的历史文件可平滑升级：遗留段之后从 genesis 起新链", async () => {
  await withStore(null, async ({ store, path }) => {
    // 模拟升级前写入的两条事件（无 prev/hash）
    await appendFile(path, `${JSON.stringify({ schemaVersion: 1, eventId: "old-1", sequence: 1, type: "legacy", data: {} })}\n`);
    await appendFile(path, `${JSON.stringify({ schemaVersion: 1, eventId: "old-2", sequence: 2, type: "legacy", data: {} })}\n`);

    const reopened = await new EventStore(path).init();
    try {
      const first = await reopened.emit("after-upgrade", {});
      const second = await reopened.emit("after-upgrade-2", {});
      assert.equal(first.prev, CHAIN_GENESIS, "升级后首条从 genesis 起链");
      assert.equal(second.prev, first.hash);

      const status = await reopened.verifyChain();
      assert.equal(status.ok, true, "遗留段 + 新段整体可信");
      assert.equal(status.legacy, 2);
      assert.equal(status.checked, 2);
    } finally {
      await reopened.close();
    }
  });
});

test("并发 emit 不会让链断裂", async () => {
  await withStore(null, async ({ store }) => {
    // 链推进必须在第一个 await 之前完成，否则并发调用会拿到同一个 prev
    await Promise.all(Array.from({ length: 40 }, (_, i) => store.emit("concurrent", { i })));
    const status = await store.verifyChain();
    assert.equal(status.ok, true, "40 条并发写入后链仍完整");
    assert.equal(status.checked, 40);
    assert.deepEqual(status.breaks, []);
  });
});

test("载荷内含 hash/prev 字段文本不会干扰定位", async () => {
  await withStore(null, async ({ store, path }) => {
    // 恶意或巧合的载荷里塞进与链字段同形的文本，验证 lastIndexOf 的定位不被误导
    const sneaky = {
      note: '{"hash":"","prev":"genesis"}',
      another: 'x "prev":"AAA" y "hash":"BBB"',
    };
    const first = await store.emit("sneaky", sneaky);
    const second = await store.emit("sneaky2", sneaky);

    assert.equal(second.prev, first.hash, "载荷内的同形文本未干扰 prev 提取");

    const status = await store.verifyChain();
    assert.equal(status.ok, true, "含同形文本的载荷仍能通过校验");

    const lines = await linesOf(path);
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(parsed.data, sneaky, "载荷内容原样保留，未被链字段处理污染");
  });
});

test("超大事件被拒时回退 sequence 与链尖，不留下空洞", async () => {
  await withStore({ maxEventBytes: 1024 }, async ({ store }) => {
    const ok = await store.emit("fits", { v: "x".repeat(16) });
    const tipAfterOk = ok.hash;
    await assert.rejects(
      () => store.emit("too-big", { v: "x".repeat(4096) }),
      (error) => error.code === "EVENT_TOO_LARGE",
    );
    const next = await store.emit("fits-again", { v: "y" });
    assert.equal(next.prev, tipAfterOk, "被拒事件未推进链尖");
    const status = await store.verifyChain();
    assert.equal(status.ok, true, "拒绝写入后链依然连续");
    assert.equal(status.checked, 2, "只有两条落盘，被拒的那条不计入");
  });
});

test("空文件与不存在的路径都是干净的起点", async () => {
  await withStore(null, async ({ store, root }) => {
    const status = await store.verifyChain();
    assert.equal(status.ok, true);
    assert.equal(status.checked, 0);
    assert.equal(status.tip, CHAIN_GENESIS);

    const missing = await new EventStore(join(root, "nested", "missing.jsonl")).init();
    try {
      assert.equal((await missing.verifyChain()).ok, true, "缺失文件不算断裂");
    } finally {
      await missing.close();
    }
  });
});

test("verifyChain 是只读的：不改变链尖，也不因断裂抛错", async () => {
  await withStore(null, async ({ store, path }) => {
    await store.emit("alpha", {});
    await store.emit("beta", {});
    const tipBefore = store.chainTip;

    const lines = await linesOf(path);
    lines[1] = lines[1].replace('"beta"', '"BETA"');
    await writeFile(path, `${lines.join("\n")}\n`);

    // 断裂应体现在返回值里，而不是抛异常打断调用方
    const status = await store.verifyChain();
    assert.equal(status.ok, false);
    assert.equal(store.chainTip, tipBefore, "校验不改变链尖");

    // 校验失败后仍可继续写入，且新事件接在未受影响的链尖上
    const after = await store.emit("gamma", {});
    assert.equal(after.prev, tipBefore);
  });
});

test("init 会把链状态留在 chainStatus 上，供观测面直接读取", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-chain-"));
  const path = join(root, "events.jsonl");
  try {
    const writer = await new EventStore(path).init();
    await writer.emit("alpha", {});
    await writer.emit("beta", {});
    const expectedTip = writer.chainTip;
    await writer.close();

    const reader = await new EventStore(path).init();
    try {
      assert.equal(reader.chainStatus.ok, true, "init 已完成一次校验");
      assert.equal(reader.chainStatus.checked, 2);
      assert.equal(reader.chainTip, expectedTip, "重开后链尖与关闭前一致，后续写入接着链走");
      const next = await reader.emit("gamma", {});
      assert.equal(next.prev, expectedTip);
      assert.equal((await reader.verifyChain()).ok, true);
    } finally {
      await reader.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("关闭链校验时仍可正常读写，链从新的 genesis 段开始", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-chain-"));
  const path = join(root, "events.jsonl");
  try {
    const first = await new EventStore(path).init();
    await first.emit("alpha", {});
    await first.close();

    // 显式关闭全量校验（数据量极大时的逃生舱）：不扫描历史，也就无从得知链尖
    const second = await new EventStore(path, { verifyChain: false }).init();
    try {
      assert.equal(second.chainStatus, null, "未校验时不产链状态");
      assert.equal(second.chainTip, CHAIN_GENESIS, "未校验则链尖回落到 genesis");
      const event = await second.emit("beta", {});
      assert.equal(event.prev, CHAIN_GENESIS, "新写入从 genesis 起新段");
      // 关闭校验不是免费的：跳过了历史扫描就不知道真实链尖，
      // 于是新事件从 genesis 重新起链，与历史段接不上——这必须被显式发现，
      // 而不是悄悄伪装成连续。
      const status = await second.verifyChain();
      assert.equal(status.ok, false, "与历史段脱节必须暴露");
      assert.equal(status.breaks.length, 1);
      assert.equal(status.breaks[0].reason, "prev-mismatch");
      assert.equal(status.breaks[0].line, 2, "断裂点正是关闭校验后写入的首条");
    } finally {
      await second.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
