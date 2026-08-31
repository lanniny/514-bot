import test from "node:test";
import assert from "node:assert/strict";
import { dueAtFireMs, nextAtFireMs, parseAtSchedule } from "../src/automations.mjs";

// 2026-08-30 是周日（dow=7）；用本地时区构造日期
function localMs(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

test("parseAtSchedule validates time and optional weekday list", () => {
  assert.deepEqual(parseAtSchedule("at:09:30"), { hour: 9, minute: 30, dows: null });
  assert.deepEqual(parseAtSchedule("at:21:00@7"), { hour: 21, minute: 0, dows: [7] });
  assert.deepEqual(parseAtSchedule("at:00:00@1,2,3,4,5"), { hour: 0, minute: 0, dows: [1, 2, 3, 4, 5] });
  assert.equal(parseAtSchedule("at:24:00"), null);
  assert.equal(parseAtSchedule("at:12:60"), null);
  assert.equal(parseAtSchedule("at:12:00@0"), null);
  assert.equal(parseAtSchedule("at:12:00@8"), null);
  assert.equal(parseAtSchedule("every:1d"), null);
  assert.equal(parseAtSchedule("manual"), null);
});

test("dueAtFireMs fires the daily slot after the watermark and not before", () => {
  const schedule = "at:09:30";
  // 昨日 09:30 已跑（水位线），今日 09:45 → 今日槽位到期
  assert.equal(dueAtFireMs(schedule, localMs(2026, 8, 29, 9, 30), localMs(2026, 8, 30, 9, 45)), localMs(2026, 8, 30, 9, 30));
  // 今日 08:55 还没到点
  assert.equal(dueAtFireMs(schedule, localMs(2026, 8, 29, 9, 30), localMs(2026, 8, 30, 8, 55)), null);
  // 今日 09:30 已跑（水位线=今日 09:30），今日 09:45 无新槽位
  assert.equal(dueAtFireMs(schedule, localMs(2026, 8, 30, 9, 30), localMs(2026, 8, 30, 9, 45)), null);
  // 无水位线（lastRunAt 缺失）回补最近一个已过槽位
  assert.equal(dueAtFireMs(schedule, 0, localMs(2026, 8, 30, 10, 0)), localMs(2026, 8, 30, 9, 30));
});

test("dueAtFireMs respects weekday filters", () => {
  // 2026-08-30 周日；at:21:00@7 到期
  assert.equal(dueAtFireMs("at:21:00@7", localMs(2026, 8, 29, 12, 0), localMs(2026, 8, 30, 21, 5)), localMs(2026, 8, 30, 21, 0));
  // 同一时点，at:21:00@1（周一）不到期
  assert.equal(dueAtFireMs("at:21:00@1", localMs(2026, 8, 29, 12, 0), localMs(2026, 8, 30, 21, 5)), null);
  // 工作日计划：周六 2026-09-05 不触发当日槽位；但上一周的工作日槽位（水位线之后）按
  // "漏跑合并取最新" 语义 = 周五 2026-09-04 09:00 到期
  assert.equal(dueAtFireMs("at:09:00@1,2,3,4,5", localMs(2026, 8, 30, 12, 0), localMs(2026, 9, 5, 10, 0)), localMs(2026, 9, 4, 9, 0));
});

test("nextAtFireMs previews the upcoming slot", () => {
  // 周日 22:00 之后，每日 09:30 的下一次 = 周一 09:30
  assert.equal(nextAtFireMs("at:09:30", localMs(2026, 8, 30, 22, 0)), localMs(2026, 8, 31, 9, 30));
  // 周日 20:00 之后，每周日 21:00 的下一次 = 今日 21:00
  assert.equal(nextAtFireMs("at:21:00@7", localMs(2026, 8, 30, 20, 0)), localMs(2026, 8, 30, 21, 0));
  assert.equal(nextAtFireMs("at:21:00@7", localMs(2026, 8, 30, 21, 0)), localMs(2026, 9, 6, 21, 0));
  assert.equal(nextAtFireMs("manual", Date.now()), null);
});
