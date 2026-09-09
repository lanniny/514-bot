import Ajv2020 from "ajv/dist/2020.js";

let bytes = 0;
const chunks = [];
try {
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 12 * 1024 * 1024) throw new Error("schema validation input exceeds its byte budget");
    chunks.push(chunk);
  }
  const { schema, definition, instance } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Object.hasOwn(schema.$defs || {}, definition)) throw new Error("unknown control schema definition");
  const target = { $schema: schema.$schema, $defs: schema.$defs, ...schema.$defs[definition] };
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  const validate = ajv.compile(target);
  const valid = validate(instance);
  const errors = (validate.errors || []).map((error) => ({
    path: error.instancePath || "$",
    message: `${error.message}${error.params.missingProperty ? `: ${error.params.missingProperty}` : ""}`,
  }));
  process.stdout.write(JSON.stringify(errors));
  process.exitCode = valid ? 0 : 1;
} catch (error) {
  process.stderr.write(String(error.message || "schema validation failed"));
  process.exitCode = 1;
}
