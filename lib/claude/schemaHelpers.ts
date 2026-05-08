import { z } from "zod";

/**
 * Converts a Zod schema to a JSON Schema object compatible with Anthropic's tool input_schema.
 * Strips the top-level $schema property that Zod v4 adds but Anthropic rejects.
 */
export function toAnthropicSchema(
  schema: z.ZodType
): { type: "object"; properties: Record<string, unknown>; [key: string]: unknown } {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema, ...clean } = raw;
  return clean as { type: "object"; properties: Record<string, unknown> };
}
