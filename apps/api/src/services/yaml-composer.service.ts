import type { Env } from "../config/env.js";
import { composeYamlFromSchema } from "../lib/composer-check-builder.js";
import { createAppError } from "../lib/errors.js";
import { analyzeSchema } from "../lib/schema-analyzer.js";
import { YAML_COMPOSER_SYSTEM_PROMPT } from "../lib/yaml-composer-prompt.js";
import {
  extractYamlDocument,
  redactSchemaSecrets,
  validateRevenantYaml,
} from "../lib/revenant-yaml.js";

export interface YamlComposerInput {
  schemaText: string;
  intent?: string;
  planName?: string;
  layers?: string[];
}

const OPENROUTER_DEFAULT_MODEL = "mistralai/mistral-small-3.2-24b-instruct";
const MISTRAL_DEFAULT_MODEL = "mistral-small-latest";

const DEPRECATED_OPENROUTER_MODELS: Record<string, string> = {
  "mistralai/mistral-small-latest": OPENROUTER_DEFAULT_MODEL,
};

function resolveProvider(env: Env): {
  url: string;
  model: string;
  isOpenRouter: boolean;
} {
  const key = env.MISTRAL_API_KEY ?? "";
  const urlHint = env.MISTRAL_API_URL ?? "";
  const isOpenRouter =
    key.startsWith("sk-or-v1-") || urlHint.includes("openrouter.ai");

  let url =
    urlHint || "https://api.mistral.ai/v1/chat/completions";
  if (isOpenRouter && !url.includes("openrouter.ai")) {
    url = "https://openrouter.ai/api/v1/chat/completions";
  }

  let model =
    env.MISTRAL_MODEL ??
    (isOpenRouter ? OPENROUTER_DEFAULT_MODEL : MISTRAL_DEFAULT_MODEL);

  if (isOpenRouter) {
    model = DEPRECATED_OPENROUTER_MODELS[model] ?? model;
    if (!model.includes("/")) {
      model =
        model === MISTRAL_DEFAULT_MODEL
          ? OPENROUTER_DEFAULT_MODEL
          : `mistralai/${model}`;
    }
  }

  return { url, model, isOpenRouter };
}

export function createYamlComposerService(env: Env) {
  return {
    status() {
      const configured = Boolean(env.MISTRAL_API_KEY);
      return {
        enabled: configured,
        provider: null,
        model: null,
      };
    },

    async generate(input: YamlComposerInput) {
      if (!env.MISTRAL_API_KEY) {
        throw createAppError(
          503,
          "Proof Composer is temporarily unavailable. Please try again later or write your plan manually.",
          "AI_NOT_CONFIGURED"
        );
      }

      const schema = redactSchemaSecrets(input.schemaText).trim();
      if (schema.length < 20) {
        throw createAppError(
          400,
          "Paste or upload a schema (SQL, Prisma, Drizzle, or similar)",
          "VALIDATION_ERROR"
        );
      }

      const planName = input.planName?.trim() || "restore-proof";
      const analysis = analyzeSchema(schema);

      if (analysis && analysis.tables.length > 0) {
        const composed = composeYamlFromSchema(analysis, {
          planName,
          layers: input.layers,
          intent: input.intent,
        });
        const validated = validateRevenantYaml(composed.yamlText);
        const byType: Record<string, number> = {};
        for (const c of validated.checks) {
          byType[c.type] = (byType[c.type] ?? 0) + 1;
        }
        return {
          yamlText: validated.yamlText,
          checks: validated.checks,
          summary: {
            total: validated.checks.length,
            byType,
          },
        };
      }

      const { url, model, isOpenRouter } = resolveProvider(env);
      const layers =
        input.layers && input.layers.length > 0
          ? input.layers.join(", ")
          : "default restore-proof layers";

      const userContent = [
        `Plan name: ${planName}`,
        `Proof layers to include: ${layers}`,
        input.intent?.trim()
          ? `MANDATORY user rules (must appear in checks):\n${input.intent.trim()}`
          : "User conditions: none — infer a solid default proof plan from the schema.",
        "Schema / models:",
        schema,
      ].join("\n\n");

      const headers: Record<string, string> = {
        Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
        "Content-Type": "application/json",
      };
      if (isOpenRouter) {
        headers["HTTP-Referer"] = env.PUBLIC_APP_URL;
        headers["X-Title"] = "Revenant Proof Composer";
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 3500,
          messages: [
            { role: "system", content: YAML_COMPOSER_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.error(
          "[yaml-composer] upstream error",
          res.status,
          detail.slice(0, 500)
        );
        throw createAppError(
          502,
          "Revenant AI is temporarily unavailable. Please try again in a few minutes.",
          "AI_UPSTREAM"
        );
      }

      const payload = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content?.trim()) {
        console.error("[yaml-composer] upstream returned empty content");
        throw createAppError(
          502,
          "Revenant AI is temporarily unavailable. Please try again in a few minutes.",
          "AI_UPSTREAM"
        );
      }

      try {
        const yamlText = extractYamlDocument(content);
        const validated = validateRevenantYaml(yamlText);
        const byType: Record<string, number> = {};
        for (const c of validated.checks) {
          byType[c.type] = (byType[c.type] ?? 0) + 1;
        }
        return {
          yamlText: validated.yamlText,
          checks: validated.checks,
          summary: {
            total: validated.checks.length,
            byType,
          },
        };
      } catch (err) {
        console.error(
          "[yaml-composer] generated YAML failed validation",
          err instanceof Error ? err.message : err
        );
        throw createAppError(
          422,
          "We couldn't build a valid plan from your schema. Try a smaller schema or simpler rules.",
          "AI_INVALID_YAML"
        );
      }
    },
  };
}

export type YamlComposerService = ReturnType<typeof createYamlComposerService>;
