import type { Env } from "../config/env.js";
import { createAppError } from "../lib/errors.js";
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

function resolveProvider(env: Env): {
  url: string;
  model: string;
  isOpenRouter: boolean;
} {
  const key = env.MISTRAL_API_KEY ?? "";
  const isOpenRouter = key.startsWith("sk-or-v1-");
  let url =
    env.MISTRAL_API_URL ?? "https://api.mistral.ai/v1/chat/completions";
  if (isOpenRouter && url.includes("api.mistral.ai")) {
    url = "https://openrouter.ai/api/v1/chat/completions";
  }
  const model =
    env.MISTRAL_MODEL ??
    (isOpenRouter ? "mistralai/mistral-small-latest" : "mistral-small-latest");
  return { url, model, isOpenRouter };
}

export function createYamlComposerService(env: Env) {
  return {
    status() {
      const configured = Boolean(env.MISTRAL_API_KEY);
      const { isOpenRouter, model } = configured
        ? resolveProvider(env)
        : { isOpenRouter: false, model: "" };
      return {
        enabled: configured,
        provider: configured ? (isOpenRouter ? "openrouter" : "mistral") : null,
        model: configured ? model : null,
      };
    },

    async generate(input: YamlComposerInput) {
      if (!env.MISTRAL_API_KEY) {
        throw createAppError(
          503,
          "Proof Composer is not configured (MISTRAL_API_KEY)",
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

      const { url, model, isOpenRouter } = resolveProvider(env);
      const layers =
        input.layers && input.layers.length > 0
          ? input.layers.join(", ")
          : "default restore-proof layers";

      const userContent = [
        `Plan name: ${input.planName?.trim() || "restore-proof"}`,
        `Proof layers to include: ${layers}`,
        input.intent?.trim()
          ? `User conditions after restore:\n${input.intent.trim()}`
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
        throw createAppError(
          502,
          `Model request failed (${res.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`,
          "AI_UPSTREAM"
        );
      }

      const payload = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content?.trim()) {
        throw createAppError(502, "Model returned an empty plan", "AI_UPSTREAM");
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
        throw createAppError(
          422,
          err instanceof Error
            ? `Generated YAML failed Revenant rules: ${err.message}`
            : "Generated YAML failed Revenant rules",
          "AI_INVALID_YAML"
        );
      }
    },
  };
}

export type YamlComposerService = ReturnType<typeof createYamlComposerService>;
