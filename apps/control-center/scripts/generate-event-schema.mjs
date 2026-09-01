#!/usr/bin/env node
/**
 * Generate eventEnvelope JSON Schema from event-shape.js (HX-03, 2026-09-01).
 * Replaces $defs.eventEnvelope in contracts.schema.json with the generated definition.
 * Run: npm run schema:generate
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEventEnvelopeSchema } from "../public/modules/event-shape.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const schemaPath = resolve(__dirname, "../../../schemas/control-center/contracts.schema.json");

const schema = JSON.parse(await readFile(schemaPath, "utf8"));
schema.$defs.eventEnvelope = buildEventEnvelopeSchema();
await writeFile(schemaPath, JSON.stringify(schema, null, 2) + "\n");
console.log("✓ eventEnvelope schema regenerated from event-shape.js");
