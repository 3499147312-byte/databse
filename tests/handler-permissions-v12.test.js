const assert = require("assert");
const fixture = require("./fixtures/business-fixture");
const { createHarness, expectCode } = require("./helpers/handler-harness");

function seed() {
  const copy = JSON.parse(JSON.stringify(fixture));
  copy.permission_roles = [];
  copy.user_permissions = [];
  copy.permission_admins = [];
  copy.permission_requests = [];
  copy.approval_delegations = [];
  copy.audit_logs = [];
  copy.settings = [{ _id: "bootstrap", completed: true, version: "1.1.0" }];
  return copy;
}

(async () => {
  const data = seed();
  const boss = data.users.find((item) => item.role === "boss");
  const manager = data.users.find((item) => item.personId === "M001");
  const otherManager = data.users.find((item) => item.personId === "M002");
  const rep = data.users.find((item) => item.personId === "R001");
  const delegate = data.users.find((item) => item.personId === "S002");
  const harness = createHarness(data, boss);
  let permissions = harness.loadHandler("permissions");

  // PERMISSION-MIGRATE-01：迁移生成六模板，重复运行不覆盖自定义绑定。
  const migration = await permissions.migratePermissions();
  assert.strictEqual(migration.totalUsers, data.users.length);
  assert.strictEqual(harness.rows("permission_roles").length, 6);
  assert(harness.rows("users").every((item) => item.permissionRoleId === `builtin_${item.role}`));
  assert.strictEqual(harness.get("settings", "bootstrap").version, "1.2.0");

  // PERMISSION-ROLE-01：自定义角色创建、绑定、停用及老板模板保护。
  const custom = await permissions.savePermissionRole({
    name: "区域观察员",
    grants: [
      { permission: "dashboard.view", scope: { level: "self" } },
      { permission: "sales.view", scope: { level: "specified", regions: ["海南"] } }
    ]
  });
  assert(custom.role.id.startsWith("custom_"));
  assert.strictEqual(custom.role.grants.length, 2);
  await expectCode(permissions.savePermissionRole({
    name: "高危模板",
    reason: "包含销售作废能力",
    grants: [{ permission: "sales.correct", scope: { level: "team" } }]
  }), "CONFIRM_REQUIRED");
  await expectCode(permissions.savePermissionRole({
    id: "builtin_boss",
    name: "不可修改",
    grants: []
  }), "BOSS_PROTECTED");

  await permissions.saveUserPermissions({
    userId: "R001",
    permissionRoleId: custom.role.id,
    overrides: []
  });
  assert.strictEqual(harness.get("users", "acct_r1").permissionRoleId, custom.role.id);
  await permissions.migratePermissions();
  assert.strictEqual(harness.get("users", "acct_r1").permissionRoleId, custom.role.id, "重复迁移不得覆盖自定义角色绑定");
  await permissions.savePermissionRole({
    id: custom.role.id,
    name: "区域观察员（停用）",
    status: "停用",
    grants: []
  });
  assert.strictEqual(harness.get("permission_roles", custom.role.id).status, "停用");

  // PERMISSION-ADMIN-01：权限管理员只能在目标范围和授权上限内工作。
  await permissions.savePermissionAdmin({
    userId: "M001",
    teamIds: ["M001"],
    grantCeiling: ["sales.view", "sales.correct"],
    canRequestHighRisk: true
  });
  assert.strictEqual(harness.get("permission_admins", "M001").status, "启用");

  harness.setUser(harness.get("users", "acct_m1"));
  permissions = harness.loadHandler("permissions");
  const center = await permissions.getPermissionCenter();
  assert.strictEqual(center.isBoss, false);
  assert(center.users.some((item) => (item.id || item.personId) === "R001"));
  assert(!center.users.some((item) => (item.id || item.personId) === "M002"));

  // PERMISSION-USER-01：普通个人权限调整立即应用。
  const ordinary = await permissions.saveUserPermissions({
    userId: "R001",
    overrides: [{
      permission: "sales.view",
      mode: "extend",
      scope: { level: "specified", customerIds: ["C002"] },
      reason: "临时协同"
    }]
  });
  assert.deepStrictEqual(ordinary.applied, ["sales.view"]);

  // PERMISSION-REQUEST-01：高危权限由管理员申请、老板确认后生效。
  const highRisk = await permissions.saveUserPermissions({
    userId: "R001",
    overrides: [{
      permission: "sales.correct",
      mode: "replace",
      scope: { level: "team" },
      reason: "临时处理退货"
    }],
    confirmed: true
  });
  assert.strictEqual(highRisk.applied.length, 0);
  assert.strictEqual(highRisk.pendingRequests.length, 1);
  const requestId = highRisk.pendingRequests[0]._id;
  assert.strictEqual(harness.get("permission_requests", requestId).status, "待老板确认");

  await expectCode(permissions.saveUserPermissions({
    userId: "R001",
    overrides: [{ permission: "inventory.receive", mode: "replace", scope: { level: "team" } }]
  }), "GRANT_LIMIT_EXCEEDED");
  await expectCode(permissions.saveUserPermissions({
    userId: "M002",
    overrides: [{ permission: "sales.view", mode: "replace", scope: { level: "team" } }]
  }), "SCOPE_DENIED");

  harness.setUser(harness.get("users", "acct_boss"));
  permissions = harness.loadHandler("permissions");
  await permissions.reviewPermissionRequest({ id: requestId, decision: "通过" });
  assert(harness.get("user_permissions", "R001").overrideList.some((item) => item.permission === "sales.correct"));

  // PERMISSION-REVOKE-01：高危权限收回后强制重新认证。
  await permissions.saveUserPermissions({
    userId: "R001",
    overrides: [{ permission: "sales.correct", mode: "deny", scope: { level: "self" }, reason: "收回退货权限" }]
  });
  assert.strictEqual(harness.get("users", "acct_r1").reauthRequired, true, "高危权限收回必须强制重新认证");

  // DELEGATION-01：代理仅对指定团队、业务和审批阶段生效并记录来源。
  const delegationResult = await permissions.saveApprovalDelegation({
    businessType: "sales",
    stage: "manager",
    managerId: manager.personId,
    delegateUserId: delegate.personId,
    startDate: new Date().toISOString().slice(0, 10),
    expiresAt: "2099-12-31",
    reason: "经理休假"
  });
  const delegationId = delegationResult.delegation._id;
  assert.strictEqual(harness.get("approval_delegations", delegationId).status, "启用");

  harness.get("sales", "SALE001").status = "待经理审核";
  harness.get("sales", "SALE001").approvalTrail = [];
  harness.setUser(harness.get("users", "acct_s2"));
  const sales = harness.loadHandler("sales");
  const rejected = await sales.rejectSale({ id: "SALE001", reason: "代理审核资料不完整" });
  assert.strictEqual(rejected.status, "经理驳回");
  const trail = harness.get("sales", "SALE001").approvalTrail.at(-1);
  assert.strictEqual(trail.delegated, true);
  assert.strictEqual(trail.delegationId, delegationId);
  assert(harness.state.audits.some((item) =>
    item.action === "代理驳回销售日报"
    && item.detail.includes("代理岗位=经理")
    && item.detail.includes(`授权=${delegationId}`)));
  // DELEGATION-RACE-01：原审批人与代理竞争处理时，第二次操作被状态检查拒绝。
  await expectCode(sales.rejectSale({ id: "SALE001", reason: "重复处理" }), "WRONG_APPROVAL_LEVEL");

  harness.setUser(harness.get("users", "acct_boss"));
  permissions = harness.loadHandler("permissions");
  await permissions.saveApprovalDelegation({ ...delegationResult.delegation, id: delegationId, status: "停用" });
  assert.strictEqual(harness.get("users", "acct_s2").reauthRequired, true);
  assert(harness.state.audits.some((item) => item.action.includes("权限")));

  // 保证测试变量确实代表了不同组织团队，避免范围用例退化。
  assert.notStrictEqual(manager.personId, otherManager.personId);
  assert.strictEqual(rep.managerId, manager.personId);

  console.log("V1.2权限管理员、高危审批、收回重登、迁移与代理审批测试通过");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
