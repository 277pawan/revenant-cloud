/** Lightweight in-process metrics and request correlation (Phase 10 MVP). */

export type ObservabilitySnapshot = {
  uptimeSeconds: number;
  requestsTotal: number;
  requestsByStatus: Record<string, number>;
  activeJobs: number;
  errorsTotal: number;
};

const startedAt = Date.now();
let requestsTotal = 0;
let errorsTotal = 0;
const requestsByStatus: Record<string, number> = {};
let activeJobs = 0;

export function recordRequest(statusCode: number): void {
  requestsTotal += 1;
  const bucket = String(statusCode);
  requestsByStatus[bucket] = (requestsByStatus[bucket] ?? 0) + 1;
  if (statusCode >= 500) errorsTotal += 1;
}

export function setActiveJobs(count: number): void {
  activeJobs = count;
}

export function getObservabilitySnapshot(): ObservabilitySnapshot {
  return {
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requestsTotal,
    requestsByStatus: { ...requestsByStatus },
    activeJobs,
    errorsTotal,
  };
}

export function generateCorrelationId(): string {
  return `rvn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
