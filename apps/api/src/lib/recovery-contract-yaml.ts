import { dump as yamlDump, load as yamlLoad } from "js-yaml";
import type { RecoveryContractDefinition } from "@revenant/shared";
import { recoveryContractDefinitionSchema } from "../validations/recovery-contract.schema.js";

function normalizeDefinition(
  raw: RecoveryContractDefinition,
): RecoveryContractDefinition {
  const maxAge =
    raw.recovery.maxVerificationAgeHours ??
    (raw.recovery as { max_verification_age_hours?: number })
      .max_verification_age_hours;

  return {
    version: raw.version,
    recovery: {
      ...raw.recovery,
      maxVerificationAgeHours:
        maxAge ?? raw.recovery.maxVerificationAgeHours ?? 168,
      dependencies: raw.recovery.dependencies ?? [],
      required: {
        database: raw.recovery.required?.database ?? true,
        schema: raw.recovery.required?.schema ?? true,
        critical_queries: raw.recovery.required?.critical_queries ?? true,
        api: raw.recovery.required?.api ?? false,
        healthcheck: raw.recovery.required?.healthcheck ?? false,
      },
    },
  };
}

export function parseRecoveryContractYaml(
  yamlText: string,
): RecoveryContractDefinition {
  const parsed = yamlLoad(yamlText);
  const result = recoveryContractDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    const msg = result.error.errors.map((e) => e.message).join("; ");
    throw new Error(`Invalid recovery contract: ${msg}`);
  }
  return normalizeDefinition(result.data as RecoveryContractDefinition);
}

export function recoveryContractToYaml(
  definition: RecoveryContractDefinition,
): string {
  const recovery: Record<string, unknown> = {
    rto: definition.recovery.rto,
    rpo: definition.recovery.rpo,
    required: definition.recovery.required,
    dependencies: definition.recovery.dependencies ?? [],
    max_verification_age_hours:
      definition.recovery.maxVerificationAgeHours ?? 168,
  };
  if (definition.recovery.application) {
    recovery.application = definition.recovery.application;
  }
  if (definition.recovery.critical_queries?.length) {
    recovery.critical_queries = definition.recovery.critical_queries;
  }
  if (definition.recovery.checks?.length) {
    recovery.checks = definition.recovery.checks;
  }
  const doc = {
    version: definition.version,
    recovery,
  };
  return yamlDump(doc, { lineWidth: 100, noRefs: true });
}
