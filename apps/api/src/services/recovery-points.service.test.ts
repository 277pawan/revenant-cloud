import assert from "node:assert/strict";
import test from "node:test";
import {
  findMissingLegacyRecoveryPointIds,
  findMissingRecoveryPointIds,
  resolveRecoverySettings,
  selectSnapshotAtVerificationTime,
  shouldFailMissingRestoreInstance,
  validateRecoveryTarget,
  type RecoverFromPointInput,
} from "./recovery-points.service.js";

const validInput: RecoverFromPointInput = {
  targetIdentifier: "app-restore-2026",
  confirmTargetIdentifier: "app-restore-2026",
  dbSubnetGroupName: "private-db-subnets",
  vpcSecurityGroupIds: ["sg-0123456789abcdef0"],
  instanceClass: "db.t3.micro",
};

test("reconciles only tracked snapshots absent from the successful AWS listing", () => {
  assert.deepEqual(
    findMissingRecoveryPointIds(
      [
        { id: "stale", snapshotIdentifier: "snapshot-no-longer-in-aws" },
        { id: "present", snapshotIdentifier: "snapshot-still-in-aws" },
        { id: "synthetic", snapshotIdentifier: "latest-verified-2026-09-27" },
      ],
      new Set(["snapshot-still-in-aws"])
    ),
    ["stale"]
  );
});

test("removes legacy recovery points when no matching AWS snapshot existed at verification time", () => {
  const verifiedAt = new Date("2026-10-04T13:51:10Z");
  const snapshots = [
    {
      DBSnapshotIdentifier: "snapshot-before-verification",
      SnapshotCreateTime: new Date("2026-10-04T13:50:00Z"),
      Status: "available",
    },
    {
      DBSnapshotIdentifier: "snapshot-after-verification",
      SnapshotCreateTime: new Date("2026-10-04T13:52:00Z"),
      Status: "available",
    },
  ];

  assert.deepEqual(
    findMissingLegacyRecoveryPointIds(
      [
        {
          id: "matched-legacy",
          snapshotIdentifier: "latest-verified-2026-10-04",
          lastVerifiedAt: verifiedAt,
          verificationStartedAt: null,
        },
        {
          id: "unmatched-legacy",
          snapshotIdentifier: "latest-verified-2026-10-04",
          lastVerifiedAt: new Date("2026-10-04T13:49:00Z"),
          verificationStartedAt: null,
        },
        {
          id: "unknown-verification-time",
          snapshotIdentifier: "latest-verified-2026-10-04",
          lastVerifiedAt: null,
          verificationStartedAt: null,
        },
      ],
      snapshots,
    ),
    ["unmatched-legacy", "unknown-verification-time"],
  );
});

test("treats a missing restored DB instance as failed after the AWS propagation grace period", () => {
  const createdAt = new Date("2026-09-27T04:00:00Z");
  assert.equal(
    shouldFailMissingRestoreInstance(createdAt, createdAt.getTime() + 9 * 60_000),
    false
  );
  assert.equal(
    shouldFailMissingRestoreInstance(createdAt, createdAt.getTime() + 10 * 60_000),
    true
  );
});

test("inherits recovery networking and instance class from the source RDS settings", () => {
  assert.deepEqual(
    resolveRecoverySettings(
      {},
      {
        DBSubnetGroup: { DBSubnetGroupName: "private-db-subnets" },
        VpcSecurityGroups: [
          { VpcSecurityGroupId: "sg-0123456789abcdef0" },
          { VpcSecurityGroupId: "sg-abcdef0123456789" },
        ],
        DBInstanceClass: "db.m6g.large",
      }
    ),
    {
      dbSubnetGroupName: "private-db-subnets",
      vpcSecurityGroupIds: ["sg-0123456789abcdef0", "sg-abcdef0123456789"],
      instanceClass: "db.m6g.large",
    }
  );
});

test("configured recovery class takes precedence over the source class", () => {
  assert.equal(
    resolveRecoverySettings(
      {},
      {
        DBSubnetGroup: { DBSubnetGroupName: "private-db-subnets" },
        VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-0123456789abcdef0" }],
        DBInstanceClass: "db.m6g.large",
      },
      "db.t3.micro"
    ).instanceClass,
    "db.t3.micro"
  );
});

test("a missing source can recover into AWS default networking", () => {
  assert.deepEqual(
    resolveRecoverySettings({}, {}, "db.t3.micro", true),
    {
      dbSubnetGroupName: undefined,
      vpcSecurityGroupIds: [],
      instanceClass: "db.t3.micro",
    }
  );
});

test("recovery network overrides must include both subnet group and security groups", () => {
  assert.throws(
    () =>
      resolveRecoverySettings(
        { dbSubnetGroupName: "private-db-subnets" },
        {},
        "db.t3.micro",
        true
      ),
    /Provide both a DB subnet group and at least one VPC security group/
  );
});

test("selects the newest available source snapshot that existed at verification time", () => {
  const cutoff = new Date("2026-09-27T04:01:00Z");
  const selected = selectSnapshotAtVerificationTime(
    [
      {
        DBSnapshotIdentifier: "later-snapshot",
        SnapshotCreateTime: new Date("2026-09-27T04:02:00Z"),
        Status: "available",
      },
      {
        DBSnapshotIdentifier: "newest-before-cutoff",
        DBSnapshotArn: "arn:aws:rds:us-east-1:123456789012:snapshot:newest-before-cutoff",
        SnapshotCreateTime: new Date("2026-09-27T03:59:00Z"),
        Status: "available",
      },
      {
        DBSnapshotIdentifier: "still-restoring",
        SnapshotCreateTime: new Date("2026-09-27T03:58:00Z"),
        Status: "creating",
      },
      {
        DBSnapshotIdentifier: "older-snapshot",
        SnapshotCreateTime: new Date("2026-09-26T03:00:00Z"),
        Status: "available",
      },
    ],
    cutoff
  );

  assert.equal(selected?.DBSnapshotIdentifier, "newest-before-cutoff");
  assert.equal(
    selected?.DBSnapshotArn,
    "arn:aws:rds:us-east-1:123456789012:snapshot:newest-before-cutoff"
  );
});

test("does not guess a snapshot if none was available by verification time", () => {
  assert.equal(
    selectSnapshotAtVerificationTime(
      [{
        DBSnapshotIdentifier: "created-later",
        SnapshotCreateTime: new Date("2026-09-27T04:02:00Z"),
        Status: "available",
      }],
      new Date("2026-09-27T04:01:00Z")
    ),
    null
  );
});

test("validates distinct AWS recovery target names and returns lowercase identifiers", () => {
  assert.equal(
    validateRecoveryTarget({ ...validInput, targetIdentifier: "App-Restore-2026", confirmTargetIdentifier: "App-Restore-2026" }, "production-db"),
    "app-restore-2026"
  );
});

test("refuses to target the configured production database", () => {
  assert.throws(
    () => validateRecoveryTarget({ ...validInput, targetIdentifier: "Production-DB", confirmTargetIdentifier: "Production-DB" }, "production-db"),
    /cannot match the source production database/
  );
});

test("requires exact typed confirmation while allowing AWS-derived network placement", () => {
  assert.throws(
    () => validateRecoveryTarget({ ...validInput, confirmTargetIdentifier: "different-target" }, "production-db"),
    /exactly to confirm/
  );
  assert.equal(
    validateRecoveryTarget({
      targetIdentifier: "app-restore-2026",
      confirmTargetIdentifier: "app-restore-2026",
    }, "production-db"),
    "app-restore-2026"
  );
});

test("rejects malformed or ambiguous AWS instance identifiers", () => {
  for (const targetIdentifier of ["7starts-with-number", "double--hyphen", "ends-with-"]) {
    assert.throws(
      () => validateRecoveryTarget({ ...validInput, targetIdentifier, confirmTargetIdentifier: targetIdentifier }, "production-db"),
      /valid AWS RDS name/
    );
  }
});