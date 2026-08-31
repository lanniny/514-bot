import test from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_ADAPTER_METHODS,
  REQUIRED_TEMPLATE_FIELDS,
  validateAdapterTemplate,
  validateAllTemplates,
} from "../src/adapters/adapter-sdk.mjs";
import { ADAPTER_TEMPLATES, ADAPTER_BINDINGS } from "../src/adapters/manifest.mjs";

test("W3.14 every registered adapter template passes the SDK contract", () => {
  const results = validateAllTemplates(ADAPTER_TEMPLATES);
  assert.equal(results.length, ADAPTER_TEMPLATES.length);
  for (const result of results) {
    assert.equal(result.valid, true, `${result.id}: ${result.errors.join("; ")}`);
  }
});

test("W3.14 template ids are unique and bindings reference known templates", () => {
  const ids = new Set(ADAPTER_TEMPLATES.map((template) => template.id));
  assert.equal(ids.size, ADAPTER_TEMPLATES.length, "template ids must be unique");
  for (const binding of ADAPTER_BINDINGS) {
    assert.ok(binding.adapterId, `binding ${binding.profileId} must declare adapterId`);
    assert.ok(
      ADAPTER_TEMPLATES.some((template) => template.factoryKey === binding.factoryKey),
      `binding ${binding.profileId} references unknown factoryKey ${binding.factoryKey}`,
    );
  }
});

test("W3.14 validator rejects incomplete templates", () => {
  const bad = validateAdapterTemplate({ id: "x", label: "X" });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((error) => error.includes("factoryKey")));
  const badDefault = validateAdapterTemplate({
    id: "y", label: "Y", factoryKey: "claude-cli",
    permissionModes: ["plan"], defaultPermissionMode: "build",
  });
  assert.equal(badDefault.valid, false);
  assert.ok(REQUIRED_TEMPLATE_FIELDS.includes("factoryKey"));
  assert.ok(REQUIRED_ADAPTER_METHODS.includes("send"));
});
