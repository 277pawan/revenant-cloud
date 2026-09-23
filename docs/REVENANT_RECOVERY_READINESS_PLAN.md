# Revenant — Recovery Readiness & Recovery Intelligence

> **Continuously prove that your systems are recoverable.**

Revenant started as a restore-verification platform:

> **Did your last backup really restore?**

The next product layer is broader:

> **If this system failed right now, could we actually recover it within the required RTO/RPO and prove that it works?**

This document is the implementation plan for evolving Revenant from **backup/restore verification** into a **Recovery Readiness platform**.

---

## 1. Product Direction

### Current

```text
Backup
  ↓
Restore
  ↓
Validate database
  ↓
Evidence
```

### Target

```text
                     ┌──────────────────────┐
                     │ Recovery Contract    │
                     │ RTO / RPO / Required │
                     │ checks / dependencies│
                     └──────────┬───────────┘
                                ↓
┌──────────────┐       ┌──────────────────────┐
│ Backup       │──────▶│ Recovery Drill       │
│ AWS RDS      │       │ Restore + Validate   │
│ PostgreSQL   │       └──────────┬───────────┘
│ Future: more │                  ↓
└──────────────┘       ┌──────────────────────┐
                       │ Application Recovery │
                       │ DB → API → Auth →    │
                       │ Critical journeys    │
                       └──────────┬───────────┘
                                  ↓
                       ┌──────────────────────┐
                       │ Recovery Readiness   │
                       │ Score + RTO/RPO +     │
                       │ dependencies + drift │
                       └──────────┬───────────┘
                                  ↓
                       ┌──────────────────────┐
                       │ Evidence / Passport  │
                       │ Signed + Auditable    │
                       └──────────────────────┘
```

---

# 2. Core Features

## 2.1 Recovery Contract

A customer defines what "recoverable" means for a system.

Example:

```yaml
version: "1"

recovery:
  rto: 15m
  rpo: 5m

  required:
    database: true
    schema: true
    critical_queries: true
    api: true
    healthcheck: true

  dependencies:
    - postgres
    - redis
    - object-storage

  application:
    healthcheck: "https://api.example.com/health"

  critical_queries:
    - name: users
      sql: "SELECT COUNT(*) FROM users"

    - name: orders
      sql: "SELECT COUNT(*) FROM orders"

  checks:
    - schema
    - row_counts
    - indexes
    - freshness
    - critical_queries
    - api_health
```

### Contract responsibilities

- Define RTO.
- Define RPO.
- Define mandatory recovery checks.
- Define critical dependencies.
- Define application health requirements.
- Define critical queries.
- Define minimum acceptable recovery state.
- Fail the recovery run when mandatory requirements are not met.

### Suggested implementation

**MVP**

- YAML
- Go YAML parser
- JSON Schema validation
- Existing Revenant validation engine

Recommended libraries:

- Go: `gopkg.in/yaml.v3`
- JSON Schema: `github.com/santhosh-tekuri/jsonschema/v6`

Do not introduce a policy engine initially.

**Later**

Evaluate Open Policy Agent (OPA/Rego) if customers need organization-wide policies such as:

```text
Every production database must:
- have RTO <= 30m
- be tested every 7 days
- validate critical queries
- have an application health check
- have a valid recovery certificate
```

OPA is designed for policy-as-code and can evaluate structured JSON inputs. See:
https://www.openpolicyagent.org/docs

---

# 3. Recovery Readiness

Recovery Readiness answers:

> **How confident are we that this system can actually be recovered right now?**

It should not be a subjective AI score.

The score must be derived from deterministic evidence.

Example:

```text
Recovery Readiness
────────────────────────────────

Database Restore          PASS
Schema Integrity          PASS
Critical Queries          PASS
Application Health        PASS
RTO                       PASS
RPO                       PASS
Dependencies              WARN
Recovery Procedure        PASS
Last Verified             2 hours ago

Readiness: 92/100
```

### Proposed readiness dimensions

| Dimension | Example |
|---|---|
| Backup availability | Valid recovery point exists |
| Restore success | Restore completed |
| Data integrity | Required checks pass |
| Schema integrity | Expected schema exists |
| Critical queries | Queries return expected results |
| API health | Required endpoints respond |
| RTO | Actual recovery <= target |
| RPO | Data loss <= target |
| Dependencies | Required dependencies available |
| Recovery procedure | Required steps are executable |
| Freshness | Last verification is within policy |
| Drift | No unresolved recovery-impacting changes |

### Important rule

The readiness score must be **explainable**.

Never show:

```text
AI says recovery confidence = 87%
```

Instead show:

```text
92/100

- Database restore: PASS
- Schema: PASS
- Queries: PASS
- API: PASS
- RTO: PASS
- RPO: PASS
- Redis dependency: NOT TESTED
- Verification age: 2 hours
```

AI can explain the result, but deterministic checks produce the result.

---

# 4. Recovery Drift

Recovery Drift detects when a system changes in a way that may invalidate a previously successful recovery test.

Example:

```text
Monday
Recovery test: PASS
RTO: 8m

Tuesday
Database size: +42%
New migration deployed
New Redis dependency added

Wednesday
Recovery readiness: AT RISK

Reason:
Recovery contract has changed since the last verified drill.
```

### Drift sources

#### Database

- Database size changes significantly.
- Table count changes.
- Schema changes.
- New indexes.
- New extensions.
- New large tables.
- Data growth changes restore duration.

#### Application

- Application version changes.
- API contract changes.
- New required endpoints.
- Health check changes.
- New environment variables.

#### Infrastructure

- RDS configuration changes.
- VPC/subnet changes.
- Security group changes.
- IAM role changes.
- KMS changes.
- Backup configuration changes.

#### Dependencies

- Redis added.
- S3/object storage dependency added.
- External API dependency added.
- Queue dependency added.

### Drift model

Store a recovery fingerprint after every successful run.

Example:

```json
{
  "database": {
    "engine": "postgres",
    "version": "16",
    "size_bytes": 4821930123,
    "schema_hash": "sha256:...",
    "table_count": 82
  },
  "application": {
    "version": "2026.09.21",
    "contract_hash": "sha256:..."
  },
  "dependencies": [
    "postgres",
    "redis",
    "object-storage"
  ]
}
```

Compare the current fingerprint with the last verified fingerprint.

### Drift states

```text
STABLE
MINOR_DRIFT
RECOVERY_AT_RISK
RECOVERY_INVALIDATED
```

Avoid automatically treating every change as failure.

A migration should not automatically mean recovery is broken.

The system should identify **potential recovery impact** and then require verification according to policy.

---

# 5. Application-Aware Recovery

This is the most important layer above basic database restore testing.

Instead of:

```text
Backup
  ↓
Database restored
  ↓
PASS
```

Revenant should support:

```text
Backup
  ↓
Database restored
  ↓
Schema verified
  ↓
Data verified
  ↓
Critical queries verified
  ↓
Application started
  ↓
Health endpoint verified
  ↓
Critical API endpoints verified
  ↓
Authentication verified
  ↓
Critical user journey verified
  ↓
PASS
```

## Example

```yaml
application:
  healthcheck:
    url: "http://recovered-api:8080/health"

  endpoints:
    - name: get-user
      method: GET
      path: "/api/users/1"
      expect_status: 200

    - name: create-order
      method: POST
      path: "/api/orders"
      expect_status: 201

  dependencies:
    - postgres
    - redis
```

### MVP checks

1. HTTP health check.
2. HTTP status check.
3. Response body assertion.
4. Database query.
5. Dependency connectivity.
6. Authentication check using test credentials.
7. Critical API endpoint checks.

### Later

Support a recovery test definition:

```yaml
journey:
  - request:
      method: POST
      url: /login
      body: ...

  - capture:
      token: "$.access_token"

  - request:
      method: GET
      url: /api/account
      headers:
        Authorization: "Bearer {{token}}"

  - assert:
      status: 200
```

This turns Revenant into a recovery-level synthetic test engine.

---

# 6. Recovery Passport

Every successful recovery drill should produce a portable evidence artifact.

Example:

```text
RECOVERY PASSPORT

System:
payments-production

Verified:
2026-09-21T08:32:11Z

Recovery Point:
snapshot-abc123

RTO Target:
15m

Actual RTO:
8m 42s

RPO Target:
5m

Observed RPO:
2m

Database:
PostgreSQL 16

Schema:
PASS

Critical Queries:
PASS

Application:
PASS

Dependencies:
PASS

Recovery Contract:
v4

Result:
VERIFIED
```

### Passport requirements

- JSON machine-readable version.
- Human-readable PDF.
- SHA-256 digest.
- Run ID.
- Recovery point ID.
- RTO/RPO measurements.
- Check results.
- Contract version.
- Environment metadata.
- Timestamp.
- Revenant version.
- Cryptographic signature.

### Storage

Current Revenant architecture can use object storage for evidence.

For the current GCP deployment:

- Google Cloud Storage
- Signed URLs
- Optional retention policies

For AWS-oriented enterprise deployments:

- Amazon S3
- S3 Object Lock for immutable evidence

Do not couple the core evidence model to one cloud.

Create an abstraction:

```text
EvidenceStore
 ├── GCS
 ├── S3
 └── Local filesystem
```

---

# 7. Recovery Challenges

Recovery tests should not always use the easiest/latest recovery point.

Introduce controlled recovery scenarios.

Examples:

```text
Challenge 1
Restore latest backup

Challenge 2
Restore backup from 24 hours ago

Challenge 3
Restore with current application version

Challenge 4
Recover after schema migration

Challenge 5
Recover with dependency unavailable

Challenge 6
Recover after credential rotation

Challenge 7
Recover after configuration change
```

The challenge must run in an isolated environment.

Never intentionally damage production.

### Challenge definition

```yaml
challenge:
  name: "24-hour recovery"

  recovery_point:
    strategy: older
    age: 24h

  environment:
    isolation: required

  validation:
    - schema
    - critical_queries
    - api_health

  objectives:
    rto: 15m
    rpo: 5m
```

---

# 8. Recovery Timeline

Every recovery drill should produce a timeline.

```text
00:00  Backup selected
00:18  Restore started
01:42  Database available
02:03  Schema validation
03:12  Data validation
04:10  Application started
05:20  API health check
06:41  Critical queries
08:42  Recovery complete
```

This allows Revenant to calculate:

```text
RTO target: 15m
Actual RTO: 8m 42s
Status: PASS
```

It also makes regression visible:

```text
Previous RTO: 6m 10s
Current RTO: 8m 42s
Change: +41%
```

---

# 9. Recovery Regression Detection

Track recovery performance over time.

Example:

```text
RTO TREND

10m ┤
 9m ┤                         ●
 8m ┤                   ●
 7m ┤             ●
 6m ┤       ●  ●
 5m ┤ ●  ●
    └────────────────────────────
      Week 1       Week 2       Week 3
```

Detect:

- RTO regression.
- RPO regression.
- Restore duration growth.
- Validation duration growth.
- Database growth.
- Increasing failure rate.

This should be deterministic statistical comparison, not an AI-generated prediction.

---

# 10. Recovery Readiness Dashboard

Recommended dashboard sections:

## System Overview

```text
Production Payments

Recovery Readiness     92/100
Last Verified          2h ago
RTO                    8m 42s / 15m
RPO                    2m / 5m

Status                  HEALTHY
```

## Why

```text
✓ Database restore
✓ Schema
✓ Critical queries
✓ API
✓ Authentication
✓ RTO
✓ RPO
⚠ Redis dependency changed
```

## Recovery Timeline

Show the latest drill as a visual timeline.

## Recovery Drift

```text
3 changes since last verification

1. PostgreSQL schema changed
2. Database size +18%
3. Redis dependency added
```

## Historical Evidence

Show previous passports and run history.

---

# 11. Architecture Changes

Current architecture:

```text
React Dashboard
      ↓
Fastify API
      ↓
PostgreSQL
      ↓
Scheduler / Jobs
      ↓
Runner
      ↓
Revenant CLI
      ↓
AWS / PostgreSQL
```

Target architecture:

```text
                         ┌─────────────────────┐
                         │ React Dashboard     │
                         └──────────┬──────────┘
                                    │
                         ┌──────────▼──────────┐
                         │ Fastify Control API  │
                         └──────────┬──────────┘
                                    │
               ┌────────────────────┼────────────────────┐
               │                    │                    │
       ┌───────▼───────┐    ┌───────▼────────┐   ┌──────▼───────┐
       │ Recovery       │    │ Drift Engine   │   │ Evidence     │
       │ Contracts      │    │                │   │ Service      │
       └───────┬───────┘    └───────┬────────┘   └──────┬───────┘
               │                     │                   │
               └─────────────────────┼───────────────────┘
                                     │
                              ┌──────▼──────┐
                              │ Job Runner  │
                              └──────┬──────┘
                                     │
                              ┌──────▼──────┐
                              │ Revenant CLI│
                              └──────┬──────┘
                                     │
                ┌────────────────────┼────────────────────┐
                │                    │                    │
             AWS RDS             PostgreSQL          Application
                │                    │                    │
                └────────────────────┼────────────────────┘
                                     │
                              ┌──────▼──────┐
                              │ Evidence    │
                              │ + Metrics   │
                              └─────────────┘
```

---

# 12. Recommended Libraries / Services

## Required

### 12.1 AWS SDK for Go

Use the official AWS SDK for:

- RDS
- AWS Backup
- IAM
- STS
- CloudWatch
- EventBridge
- S3

The CLI should use AWS APIs directly rather than shelling out to the AWS CLI wherever practical.

Recommended:

```text
github.com/aws/aws-sdk-go-v2
```

---

### 12.2 YAML

For Revenant recovery contracts:

```text
gopkg.in/yaml.v3
```

---

### 12.3 JSON Schema

For validating `revenant.yaml`:

```text
github.com/santhosh-tekuri/jsonschema/v6
```

Use this before introducing a full policy engine.

---

### 12.4 OpenTelemetry

Use OpenTelemetry for the control plane and runner telemetry.

Recommended Node packages:

```text
@opentelemetry/api
@opentelemetry/sdk-node
@opentelemetry/auto-instrumentations-node
```

OpenTelemetry supports traces and metrics for Node.js and has instrumentation libraries for common dependencies.

Reference:

https://opentelemetry.io/docs/languages/js/

Use it for:

- Job execution traces.
- Restore duration.
- Validation duration.
- API latency.
- Runner health.
- Recovery pipeline timing.
- Error correlation.

---

### 12.5 HTTP Client

For application-aware checks:

Go:

```text
net/http
```

Prefer the standard library initially.

Do not add another HTTP library unless the recovery journey engine requires advanced features.

---

### 12.6 Cryptographic Signing

For Recovery Passports:

MVP:

```text
Ed25519
```

Go standard library:

```text
crypto/ed25519
```

Later enterprise option:

- AWS KMS
- Google Cloud KMS
- Customer-managed signing keys

The signature should cover the canonical passport payload.

---

### 12.7 Object Storage

Use an abstraction:

```text
EvidenceStore
```

Initial providers:

```text
GCS
S3
Local
```

Recommended current implementation:

```text
Google Cloud Storage
```

because the current Revenant cloud deployment uses Google Cloud.

Later:

```text
Amazon S3 + Object Lock
```

for customers requiring immutable evidence.

---

# 13. Optional Technologies

## Temporal

Temporal can eventually manage long-running recovery workflows:

```text
Schedule
   ↓
Select recovery point
   ↓
Start restore
   ↓
Wait
   ↓
Poll
   ↓
Validate
   ↓
Run application checks
   ↓
Generate passport
   ↓
Cleanup
```

Temporal is specifically designed for durable workflow execution that can resume after failures.

Reference:

https://docs.temporal.io/

### Recommendation

**Do not migrate to Temporal immediately.**

Re-use the existing Revenant scheduler/job system first.

Introduce Temporal when:

- workflows become significantly longer;
- many asynchronous steps need durable orchestration;
- retries and state recovery become difficult;
- multi-cloud workflows become complex.

This avoids a large architecture rewrite too early.

---

# 14. Optional Policy Engine

## Open Policy Agent

OPA can later express organization-wide recovery requirements.

Example:

```rego
package revenant.recovery

deny[msg] {
  input.rto_minutes > 30
  msg := "Production recovery RTO must be <= 30 minutes"
}

deny[msg] {
  input.validation_frequency_days > 7
  msg := "Production systems must be verified at least every 7 days"
}
```

Use OPA when customers need:

- Organization policies.
- Compliance rules.
- Central governance.
- Multi-team enforcement.
- Policy-as-code in CI/CD.

Do not make OPA a dependency of the initial implementation.

Reference:

https://www.openpolicyagent.org/docs

---

# 15. AI Usage

AI should improve the product without becoming the source of truth.

## Good AI use cases

### Failure explanation

Input:

```text
RTO failed.
Target: 15m
Actual: 24m
Database size increased 63%.
```

AI explanation:

```text
The most likely contributing factor is database growth.
The restored database is 63% larger than the previous verified run.
```

The underlying numbers still come from deterministic measurements.

---

### Drift explanation

```text
3 recovery-impacting changes detected.

AI summary:
"Your last verified recovery environment no longer matches
the current production dependency graph."
```

---

### Recovery plan generation

Existing Proof Composer can generate:

```yaml
revenant.yaml
```

from:

- Schema.
- DB introspection.
- User requirements.
- Existing configuration.

AI output must always be validated against the contract schema.

---

### Incident / recovery report

Generate:

```text
What happened
Why it failed
What changed
Impact on RTO/RPO
What should be verified next
```

---

## Bad AI use cases

Do not let an LLM decide:

```text
"Recovery is safe."
```

or:

```text
"Backup is probably valid."
```

Recovery status must come from actual execution evidence.

---

# 16. Security Requirements

This feature set will require stronger enterprise security.

## Secrets

Never store:

- DB passwords in plaintext.
- AWS secret keys in the database.
- Application credentials inside recovery plans.

Prefer:

- Short-lived credentials.
- AWS STS AssumeRole.
- Workload Identity where available.
- Secret Manager / Secrets Manager.
- Environment injection only during execution.

---

## Runner isolation

Recovery workloads should run in isolated environments.

Recommended:

```text
Customer environment
        ↓
Self-hosted runner
        ↓
Isolated recovery environment
        ↓
Restore
        ↓
Validate
        ↓
Destroy
```

---

## Network isolation

Support:

- Private VPC.
- Private database access.
- Customer-controlled runner.
- No requirement to expose databases publicly.

---

## Evidence integrity

Every passport should contain:

```text
payload
hash
signature
signing key identifier
timestamp
run ID
```

This prevents silent modification of evidence.

---

# 17. Database Model Changes

Recommended tables.

## recovery_contracts

```text
id
system_id
version
definition_json
rto_seconds
rpo_seconds
status
created_at
updated_at
```

## recovery_runs

```text
id
system_id
contract_id
runner_id
recovery_point_id
started_at
completed_at
status
actual_rto_seconds
observed_rpo_seconds
```

## recovery_checks

```text
id
run_id
name
type
status
duration_ms
expected
actual
error
metadata
```

## recovery_fingerprints

```text
id
system_id
run_id
database_hash
schema_hash
application_hash
dependency_hash
fingerprint_json
created_at
```

## recovery_drift

```text
id
system_id
from_fingerprint_id
to_fingerprint_id
severity
change_type
description
status
created_at
```

## recovery_passports

```text
id
run_id
version
payload_hash
signature
storage_location
created_at
```

## recovery_challenges

```text
id
system_id
name
definition_json
schedule
enabled
created_at
updated_at
```

---

# 18. API Changes

Recommended endpoints:

```text
POST   /recovery-contracts
GET    /recovery-contracts
GET    /recovery-contracts/:id
PUT    /recovery-contracts/:id

POST   /recovery-runs
GET    /recovery-runs
GET    /recovery-runs/:id

GET    /systems/:id/readiness
GET    /systems/:id/drift
GET    /systems/:id/fingerprint

GET    /recovery-runs/:id/passport
GET    /recovery-runs/:id/evidence

POST   /recovery-challenges
GET    /recovery-challenges
PUT    /recovery-challenges/:id

GET    /systems/:id/rto-history
GET    /systems/:id/rpo-history
```

---

# 19. CLI Changes

The CLI should remain useful without Revenant Cloud.

Recommended commands:

```bash
revenant verify
revenant contract validate
revenant recovery plan
revenant recovery run
revenant recovery passport
revenant recovery fingerprint
revenant recovery diff
```

Examples:

```bash
revenant contract validate revenant.yaml
```

```bash
revenant recovery run --plan revenant.yaml
```

```bash
revenant recovery diff \
  --before fingerprint.json \
  --after current.json
```

```bash
revenant recovery passport \
  --run-id abc123 \
  --output passport.json
```

The CLI remains the execution engine.

The cloud becomes the control plane, scheduler, history, governance, and evidence layer.

---

# 20. CI/CD Integration

Recovery should become part of deployment workflows.

Example:

```yaml
name: Recovery Validation

on:
  push:
    branches: [main]

jobs:
  recovery:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Validate recovery contract
        run: revenant contract validate revenant.yaml

      - name: Run recovery checks
        uses: 277pawan/revenant-action@v1
        with:
          plan: revenant.yaml
```

Later:

```text
Migration
   ↓
Deploy
   ↓
Recovery fingerprint
   ↓
Drift detected
   ↓
Recovery validation
   ↓
Deployment gate
```

This is potentially valuable because recovery becomes part of engineering change management rather than an annual DR exercise.

---

# 21. AWS Integration

Revenant should integrate with AWS rather than attempt to replace AWS Backup.

AWS Backup already supports scheduled restore testing and optional post-restore validation workflows. AWS also exposes `PutRestoreValidationResult` for independently run validation results.

References:

- AWS Backup Restore Testing:
  https://docs.aws.amazon.com/aws-backup/latest/devguide/restore-testing.html
- AWS Backup Restore Testing Validation:
  https://docs.aws.amazon.com/aws-backup/latest/devguide/restore-testing-validation.html
- AWS `PutRestoreValidationResult`:
  https://docs.aws.amazon.com/aws-backup/latest/APIReference/API_PutRestoreValidationResult.html

### Revenant's layer

```text
AWS Backup
    ↓
Restore
    ↓
Revenant
    ↓
Application-aware validation
    ↓
Recovery Contract
    ↓
RTO/RPO
    ↓
Dependency validation
    ↓
Drift detection
    ↓
Recovery Passport
```

The differentiation is not "AWS cannot restore."

The product goal is to provide a vendor-neutral, application-aware, continuously tracked recovery-readiness layer.

---

# 22. Implementation Phases

## Phase 0 — Architecture preparation

### Tasks

- Finalize recovery contract schema.
- Define database model.
- Define recovery run state machine.
- Define fingerprint format.
- Define passport JSON format.
- Define deterministic readiness calculation.
- Define evidence signing format.

### Estimated time with AI assistance

**1–2 days**

---

# Phase 1 — Recovery Contract

### Build

- YAML parser.
- Contract schema.
- Contract validation.
- API CRUD.
- Dashboard editor.
- CLI validation.
- Versioning.

### Estimated time

**2–4 days**

---

# Phase 2 — Recovery Fingerprint

### Build

- DB metadata collection.
- Schema hash.
- Application version hash.
- Dependency list.
- Contract hash.
- Fingerprint persistence.
- Fingerprint comparison.

### Estimated time

**3–5 days**

---

# Phase 3 — Recovery Drift

### Build

- Change detection.
- Drift severity.
- Drift UI.
- Recovery-impacting change classification.
- Historical comparison.
- Drift API.

### Estimated time

**3–5 days**

---

# Phase 4 — Recovery Readiness

### Build

- Deterministic readiness engine.
- RTO calculation.
- RPO calculation.
- Required-check evaluation.
- Readiness API.
- Dashboard.
- Historical readiness.

### Estimated time

**3–5 days**

---

# Phase 5 — Application-Aware Recovery

### Build

- HTTP health checks.
- HTTP endpoint assertions.
- DB-to-API validation.
- Dependency checks.
- Authentication test support.
- Recovery journey definition.
- Isolated application execution.

### Estimated time

**5–8 days**

This is one of the larger phases because customer environments will vary significantly.

---

# Phase 6 — Recovery Passport

### Build

- Canonical JSON.
- SHA-256 hash.
- Ed25519 signing.
- PDF generation.
- Object storage.
- Signed download.
- Evidence history.

### Estimated time

**2–4 days**

---

# Phase 7 — Recovery Challenges

### Build

- Recovery point selection strategies.
- Older backup tests.
- Challenge definitions.
- Isolated execution.
- Challenge scheduling.
- Challenge results.

### Estimated time

**4–7 days**

---

# Phase 8 — RTO/RPO Regression

### Build

- Historical measurements.
- Trend API.
- RTO regression detection.
- RPO regression detection.
- Database growth correlation.
- Dashboard charts.

### Estimated time

**2–4 days**

---

# Phase 9 — Enterprise Hardening

### Build

- Short-lived credentials.
- AWS STS integration.
- Runner isolation.
- Secret management.
- Audit events.
- Evidence retention.
- RBAC expansion.
- Security logging.

### Estimated time

**5–10 days**

---

# Phase 10 — Observability

### Build

- OpenTelemetry traces.
- Recovery execution metrics.
- Runner metrics.
- API traces.
- Job correlation IDs.
- Error tracing.

### Estimated time

**2–3 days**

---

# 23. Total Estimated Development Time

Assuming:

- Existing Revenant CLI is working.
- Existing Fastify API is working.
- Existing dashboard is working.
- Existing PostgreSQL/Drizzle setup is working.
- Existing runner architecture is usable.
- One developer.
- AI coding assistance is used heavily.
- Scope is initially PostgreSQL + AWS RDS.
- No major redesign of existing UI.

### MVP

Features:

- Recovery Contract
- Recovery Fingerprint
- Recovery Drift
- Recovery Readiness
- Basic application-aware checks
- Recovery Passport
- RTO/RPO history

Estimated:

**3–5 weeks**

---

### Strong Beta

Add:

- Recovery Challenges
- Better application journeys
- Enterprise credential model
- Better isolation
- Evidence retention
- OpenTelemetry
- Better dashboard
- CI/CD gates
- AWS integration improvements

Estimated:

**6–9 weeks**

---

### Enterprise-ready version

Add:

- Multi-account AWS
- Multi-cloud
- Strong RBAC
- SSO/SAML
- Advanced audit
- KMS integration
- Immutable evidence
- Organization policies
- OPA integration
- Advanced runner isolation
- Security hardening
- Compliance workflows

Estimated:

**10–16+ weeks**

These are engineering estimates, not guarantees. Integration complexity and customer environments can materially increase the timeline.

---

# 24. Recommended MVP Scope

Do **not** build everything in this document at once.

The first release should be:

```text
1. Recovery Contract
2. Recovery Fingerprint
3. Recovery Drift
4. Recovery Readiness
5. Application Health Check
6. RTO/RPO Measurement
7. Recovery Passport
8. Dashboard
```

The core experience should be:

```text
Customer defines recovery contract
             ↓
Revenant runs recovery drill
             ↓
Revenant validates DB
             ↓
Revenant validates application
             ↓
Revenant measures RTO/RPO
             ↓
Revenant compares recovery fingerprint
             ↓
Revenant calculates readiness
             ↓
Revenant generates passport
             ↓
Customer can prove:
"this system was recoverable when we tested it"
```

---

# 25. What NOT to Build Yet

Avoid adding these during the first MVP:

- Kubernetes operator.
- Full multi-cloud restore engine.
- Custom workflow engine.
- Temporal migration.
- OPA dependency.
- AI recovery decisions.
- Complex ML anomaly detection.
- Full CMDB.
- 20+ database engines.
- Full disaster-recovery orchestration.
- Automated production failover.
- Complex chaos engineering.

These can become future products, but they will significantly increase complexity before the core recovery-readiness workflow is proven.

---

# 26. Product Moat Direction

The potential long-term advantage should not be:

```text
"We can restore PostgreSQL."
```

That is easy to copy and overlaps with cloud-native backup products.

The stronger direction is:

```text
Recovery Contract
       +
Recovery History
       +
Recovery Fingerprint
       +
Recovery Drift
       +
Application-aware validation
       +
RTO/RPO evidence
       +
Recovery Passport
```

Over time Revenant can build a historical understanding of:

```text
How recoverable is this system?
How has that changed?
What changed before recovery degraded?
How long does recovery actually take?
Which dependencies repeatedly cause failures?
Which systems have not been verified recently?
```

That historical recovery dataset can become an important part of the product.

---

# 27. Definition of Done

A system should be considered **Recovery Verified** only when:

```text
[✓] Valid recovery point exists
[✓] Restore completed
[✓] Database is reachable
[✓] Schema checks passed
[✓] Required data checks passed
[✓] Critical queries passed
[✓] Required application checks passed
[✓] Required dependencies passed
[✓] RTO target passed
[✓] RPO target passed
[✓] Recovery contract passed
[✓] Evidence generated
[✓] Evidence signed
[✓] Recovery fingerprint stored
```

If any mandatory requirement fails:

```text
Recovery Verified = false
```

---

# 28. Final Product Position

### Today

> **Verify your backups actually restore.**

### Next

> **Know whether your system is recoverable.**

### Long term

> **Continuously prove your systems are recoverable.**

The product should move from a **restore test** to a **recovery intelligence layer** that sits above backup infrastructure.

AWS, PostgreSQL, cloud storage, Kubernetes, CI/CD, and other infrastructure remain execution environments.

Revenant becomes the layer that continuously answers:

> **"If this system failed right now, could we recover it within our actual recovery objectives — and can we prove it?"**

---

# 29. Multi-service expansion (one platform, many providers)

Revenant must not become "a Postgres tool that also does other things." It should become a **recovery intelligence layer** that works across engines and dependency types using the same contract, readiness score, drift model, and passport.

## Mental model

| Layer | What it is | Today | Future |
|-------|------------|-------|--------|
| **Recovery System** | One business system with a contract | `databases` row (1 workflow) | `systems` table grouping DB + app + deps |
| **Provider** | How to restore or validate a resource | `postgres`, `aws-rds` | `mysql`, `redis`, `http`, `s3`, … |
| **Recovery Contract** | RTO/RPO + required checks | `recovery_contracts` (Phase 1) | Versioned YAML + org policies |
| **Drill job** | One proof run | `jobs` + CLI | Same — providers plug in |
| **Fingerprint** | Recoverable-state snapshot | `recovery_fingerprints` | After every pass |
| **Passport** | Signed evidence artifact | `evidence_artifacts` → passport v2 | PDF + JSON |

**Rule:** Add providers **one at a time**. Never fork the product per engine.

## Provider plugin shape (CLI + API)

Each provider implements the same interface:

```text
Provider
 ├── id                  postgres | aws-rds | mysql | http | redis
 ├── role                restore | dependency | application
 ├── fingerprint()       → metadata for drift
 ├── restore?()          → optional (AWS/RDS owns restore for RDS)
 ├── validate()          → checks[] with pass/fail + duration
 └── supportedChecks[]   schema, sql, http_health, dependency_ping, …
```

**Go CLI:** `internal/providers/postgres`, `internal/providers/awsrds`, later `internal/providers/http`.

**API:** stores contract + aggregates results; does not run checks itself (runner/CLI does).

## Rollout order (recommended)

| Phase | Provider | Customer value |
|-------|----------|----------------|
| **Now** | PostgreSQL + AWS RDS | Core restore proof (shipped) |
| **Phase 5** | HTTP / healthcheck | Application-aware recovery |
| **Phase 5b** | Redis, S3 (dependency ping) | Dependency gaps in readiness |
| **Phase 6** | MySQL / MariaDB | Second database engine |
| **Later** | MongoDB, DynamoDB, K8s workload | Enterprise expansion |

Do **not** add a new engine until the previous one has: contract support, fingerprint, drift rules, passport fields, and dashboard dimension.

## One contract, many resources

```yaml
recovery:
  rto: 15m
  rpo: 5m
  resources:
    - id: payments-db
      provider: postgres
      role: primary
    - id: payments-api
      provider: http
      role: application
      healthcheck: https://api.example.com/health
  dependencies:
    - id: cache
      provider: redis
```

MVP maps `resources[0]` → existing `databaseId`. Later, `systems` owns multiple resources.

## Drift per provider

| Provider | Drift signals |
|----------|----------------|
| Postgres | schema hash, size, table count, plan version |
| AWS RDS | instance class, storage, parameter group, backup window |
| HTTP | contract hash, endpoint list, expected status codes |
| Redis | not in last drill, version change |

Drift **warns** first; only failed re-verification marks `NOT RECOVERY READY`.

## Pricing / plans

Keep **one plan** covering all providers the customer enables. Gate by:

- number of **recovery systems** (workflows),
- concurrent sandboxes,
- application-aware checks (Pro+),
- self-hosted agent (Pro+).

Do not sell "MySQL add-on" separately until there is demand.

## Implementation status (this repo)

| Item | Status |
|------|--------|
| Plan document | ✅ This file |
| `recovery_contracts` table | ✅ Migration `0016` |
| `recovery_fingerprints` / `recovery_drift_events` | ✅ Schema ready |
| Shared readiness engine | ✅ `@revenant/shared` |
| `GET /api/v1/databases/:id/readiness` | ✅ Phase 0 |
| Contract CRUD + YAML editor | 🔜 Phase 1 |
| Fingerprint on job pass | 🔜 Phase 2 |
| HTTP provider in CLI | 🔜 Phase 5 |
| Recovery Passport v2 | 🔜 Phase 6 |

**Next engineering step:** Phase 1 — contract CRUD, default contract on database create, dashboard Recovery Readiness panel wired to readiness API.
