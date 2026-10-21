// Esquemas de los mensajes estructurados que intercambian los agentes a través
// del orquestador. Todo JSON emitido por un agente se valida aquí antes de usarse.
import { z } from 'zod';

export const ReviewOutputSchema = z.object({
  project_path: z.string().min(1),
  project_exists: z.boolean(),
  summary: z.string(),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  plan: z.array(z.string()),
  risks: z.array(z.string()).default([]),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export const DevelopOutputSchema = z.object({
  summary: z.string(),
  files_touched: z.array(z.string()).default([]),
  tests_added: z.array(z.string()).default([]),
  notes: z.string().default(''),
});
export type DevelopOutput = z.infer<typeof DevelopOutputSchema>;

export const DocumentOutputSchema = z.object({
  summary: z.string(),
  files_touched: z.array(z.string()).default([]),
  skipped_reason: z.string().default(''),
});
export type DocumentOutput = z.infer<typeof DocumentOutputSchema>;

export const QaVerdictSchema = z.object({
  verdict: z.enum(['approved', 'rejected']),
  summary: z.string(),
  criteria: z
    .array(z.object({ criterion: z.string(), met: z.boolean(), evidence: z.string().default('') }))
    .default([]),
  issues: z
    .array(
      z.object({
        severity: z.enum(['critical', 'major', 'minor']),
        file: z.string().optional(),
        description: z.string(),
        suggestion: z.string().optional(),
      }),
    )
    .default([]),
  suggested_tests: z.array(z.string()).default([]),
  documentation: z
    .object({ needs_update: z.boolean(), targets: z.array(z.string()).default([]), notes: z.string().optional() })
    .default({ needs_update: false, targets: [] }),
});

export const DocReviewSchema = z.object({
  verdict: z.enum(['approved', 'rejected']),
  summary: z.string(),
  issues: z.array(z.string()).default([]),
});
export type DocReview = z.infer<typeof DocReviewSchema>;

/** JSON Schema (para `claude --json-schema`) equivalente a los esquemas zod de Claude. */
export function toJsonSchema(schema: z.ZodType): string {
  // Claude Code 2.1.x rechaza la referencia "$schema" a draft 2020-12 que añade zod: se omite.
  const { $schema: _omit, ...json } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return JSON.stringify(json);
}

/**
 * Extrae el último objeto JSON de un texto libre (OpenCode no tiene salida
 * estructurada forzada): primero bloques ```json, luego el último {...} balanceado.
 */
export function extractLastJson(text: string): unknown | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  for (let i = fenced.length - 1; i >= 0; i--) {
    const parsed = tryParse(fenced[i]);
    if (parsed !== null) return parsed;
  }
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = end; i >= 0; i--) {
      const ch = text[i];
      if (ch === '"' && text[i - 1] !== '\\') inStr = !inStr;
      if (inStr) continue;
      if (ch === '}') depth++;
      else if (ch === '{') {
        depth--;
        if (depth === 0) {
          const parsed = tryParse(text.slice(i, end + 1));
          if (parsed !== null) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

function tryParse(s: string): unknown | null {
  try {
    const v = JSON.parse(s.trim());
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
