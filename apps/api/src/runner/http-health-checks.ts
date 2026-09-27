export type HttpHealthSpec = {
  url: string;
  name: string;
  expectStatus: number;
  method: string;
};

export type HttpHealthCheckResult = {
  checkName: string;
  checkType: "http_health";
  status: "pass" | "fail";
  message: string;
  durationMs: number;
};

export type ContractApplicationConfig = {
  healthcheck?: string;
  endpoints?: Array<{
    name: string;
    method: string;
    path: string;
    expect_status?: number;
  }>;
};

/** Remove http_health entries — executed in Node, not the Go CLI (older CLIs lack the type). */
export function stripHttpHealthFromChecksBlock(checksBlock: string): string {
  const stripped = checksBlock.replace(
    /\n\s*-\s*type:\s*http_health\b[^\n]*(?:\n\s+[^\n-][^\n]*)*/gi,
    ""
  );
  return stripped.trimEnd() || "checks:\n  - type: connect";
}

function parseHttpHealthSpecsFromPlan(planYaml: string | null): HttpHealthSpec[] {
  if (!planYaml) return [];
  const checksMatch = planYaml.match(/checks:\s*\n([\s\S]*)/i);
  if (!checksMatch) return [];

  const specs: HttpHealthSpec[] = [];
  const itemRe = /-\s*type:\s*http_health\b([\s\S]*?)(?=\n\s*-\s*type:|\s*$)/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(checksMatch[0])) !== null) {
    const block = match[1];
    const urlMatch =
      block.match(/url:\s*["']([^"']+)["']/i) ?? block.match(/url:\s*(\S+)/i);
    if (!urlMatch?.[1]) continue;
    const nameMatch = block.match(/name:\s*["']?([^"'\n]+)["']?/i);
    const statusMatch = block.match(/expect_status:\s*(\d+)/i);
    const methodMatch = block.match(/method:\s*["']?(\w+)["']?/i);
    specs.push({
      url: urlMatch[1].trim(),
      name: nameMatch?.[1]?.trim() || "application_health",
      expectStatus: statusMatch ? Number(statusMatch[1]) : 200,
      method: (methodMatch?.[1] ?? "GET").toUpperCase(),
    });
  }
  return specs;
}

function resolveEndpointUrl(base: string | undefined, path: string): string {
  const trimmed = path.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!base) return trimmed;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return trimmed;
  }
}

function specsFromContractApplication(
  application?: ContractApplicationConfig | null
): HttpHealthSpec[] {
  if (!application) return [];
  const specs: HttpHealthSpec[] = [];
  const base = application.healthcheck?.trim();

  if (base) {
    specs.push({
      url: base,
      name: "application_health",
      expectStatus: 200,
      method: "GET",
    });
  }

  for (const ep of application.endpoints ?? []) {
    const url = resolveEndpointUrl(base, ep.path);
    if (!url) continue;
    specs.push({
      url,
      name: ep.name?.trim() || "api_endpoint",
      expectStatus: ep.expect_status ?? 200,
      method: (ep.method ?? "GET").toUpperCase(),
    });
  }

  return specs;
}

function dedupeSpecs(specs: HttpHealthSpec[]): HttpHealthSpec[] {
  const seen = new Set<string>();
  const out: HttpHealthSpec[] = [];
  for (const s of specs) {
    const key = `${s.method}:${s.url}:${s.expectStatus}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function collectHttpHealthSpecs(
  planYaml: string | null,
  contractApplication?: ContractApplicationConfig | null
): HttpHealthSpec[] {
  return dedupeSpecs([
    ...parseHttpHealthSpecsFromPlan(planYaml),
    ...specsFromContractApplication(contractApplication),
  ]);
}

export async function runHttpHealthCheck(
  spec: HttpHealthSpec
): Promise<HttpHealthCheckResult> {
  const started = Date.now();
  const method = spec.method === "POST" ? "POST" : "GET";
  try {
    const res = await fetch(spec.url, {
      method,
      signal: AbortSignal.timeout(15_000),
    });
    const ok = res.status === spec.expectStatus;
    return {
      checkName: spec.name,
      checkType: "http_health",
      status: ok ? "pass" : "fail",
      message: ok
        ? `HTTP ${method} ${spec.url} returned ${res.status}`
        : `expected HTTP ${spec.expectStatus}, got ${res.status} from ${spec.url}`,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      checkName: spec.name,
      checkType: "http_health",
      status: "fail",
      message: `HTTP health check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      durationMs: Date.now() - started,
    };
  }
}

export async function runHttpHealthChecks(
  specs: HttpHealthSpec[]
): Promise<HttpHealthCheckResult[]> {
  const results: HttpHealthCheckResult[] = [];
  for (const spec of specs) {
    results.push(await runHttpHealthCheck(spec));
  }
  return results;
}
