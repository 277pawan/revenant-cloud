import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveRecoverySettings,
  selectSnapshotAtVerificationTime,
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