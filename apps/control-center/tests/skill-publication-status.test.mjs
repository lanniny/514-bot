import test from "node:test";
import assert from "node:assert/strict";
import { skillPublicationStatus } from "../public/modules/skill-publication-status.js";

test("skill publication feedback keeps incomplete recovery distinct from normal success", () => {
  assert.equal(skillPublicationStatus({ item: { id: "legacy" } }), null);
  assert.equal(skillPublicationStatus({ item: { publication: { committed: true, cleanupPending: false } } }), null);
  const recovery = skillPublicationStatus({ item: { publication: { committed: true, recoveryRequired: true } } });
  const cleanup = skillPublicationStatus({ publication: { committed: true, cleanupPending: true } });
  const unknown = skillPublicationStatus({ item: { publication: { committed: false } } });
  for (const result of [recovery, cleanup, unknown]) assert.equal(result.tone, "warning");
  assert.notEqual(recovery.message, cleanup.message);
  assert.notEqual(unknown.message, recovery.message);
});
