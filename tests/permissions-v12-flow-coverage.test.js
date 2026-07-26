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

async function migrate(harness) {
  const permissions = harness.loadHandler("permissions");
  await permissions.migratePermissions();
  return permissions;
}

async function testRequestRejectionAndImmediateOrdinaryRevoke() {
  const data = seed();
  const boss = data.users.find((item) => item.role === "boss");
  const harness = createHarness(data, boss);
  let permissions = await migrate(harness);

  await permissions.savePermissionAdmin({
    userId: "M001",
    teamIds: ["M001"],
    grantCeiling: ["sales.view", "sales.correct"],
    canRequestHighRisk: true
  });

  harness.setUser(harness.get("users", "acct_m1"));
  permissions = harness.loadHandler("permissions");
  const pending = await permissions.saveUserPermissions({
    userId: "R001",
    overrides: [{
      permission: "sales.correct",
      mode: "replace",
      scope: { level: "team" },
      reason: "临时处理销售作废"
    }],
    confirmed: true
  });
  const requestId = pending.pendingRequests[0]._id;

  harness.setUser(harness.get("users", "acct_boss"));
  permissions = harness.loadHandler("permissions");
  await expectCode(
    permissions.reviewPermissionRequest({ id: requestId, decision: "驳回", note: "否" }),
    "INVALID_REASON"
  );
  const rejected = await permissions.reviewPermissionRequest({
    id: requestId,
    decision: "驳回",
    note: "授权范围和业务原因不充分"
  });
  assert.strictEqual(rejected.status, "老板已驳回");
  assert.strictEqual(harness.get("permission_requests", requestId).status, "老板已驳回");
  assert(!harness.get("user_permissions", "R001").overrideList.some((item) => item.permission === "sales.correct"));
  await expectCode(
    permissions.reviewPermissionRequest({ id: requestId, decision: "通过" }),
    "REQUEST_NOT_PENDING"
  );

  harness.setUser(harness.get("users", "acct_r1"));
  let sales = harness.loadHandler("sales");
  assert((await sales.getSalesPage()).stores.some((item) => item.id === "ST001"));

  harness.setUser(harness.get("users", "acct_boss"));
  permissions = harness.loadHandler("permissions");
  await permissions.saveUserPermissions({
    userId: "R001",
    overrides: [{
      permission: "sales.view",
      mode: "deny",
      scope: { level: "self" },
      reason: "暂停查看销售数据"
    }]
  });
  assert.strictEqual(harness.get("users", "acct_r1").reauthRequired, false);

  harness.setUser(harness.get("users", "acct_r1"));
  sales = harness.loadHandler("sales");
  await expectCode(sales.getSalesPage(), "PERMISSION_DENIED");
}

async function testRegionExpansionAndForgedCrossTeamRequest() {
  const data = seed();
  data.users.find((item) => item.personId === "M001").province = "海南";
  data.users.find((item) => item.personId === "M002").province = "广东";
  data.sales.push({
    ...JSON.parse(JSON.stringify(data.sales[0])),
    _id: "SALE003",
    warehouseId: "W002",
    customerId: "C002",
    storeId: "ST002",
    repId: "R002",
    supervisorId: "S002",
    managerId: "M002"
  });
  const boss = data.users.find((item) => item.role === "boss");
  const harness = createHarness(data, boss);
  const permissions = await migrate(harness);

  await permissions.saveUserPermissions({
    userId: "R001",
    overrides: [{
      permission: "sales.view",
      mode: "replace",
      scope: { level: "specified", regions: ["广东"] },
      reason: "跨区域只读协同"
    }]
  });

  harness.setUser(harness.get("users", "acct_r1"));
  const sales = harness.loadHandler("sales");
  const authorizedUser = await harness.context.requireUser();
  await expectCode(
    Promise.resolve().then(() => harness.context.assertPermission(
      authorizedUser,
      "sales.view",
      harness.get("sales", "SALE001")
    )),
    "SCOPE_DENIED"
  );
  const page = await sales.getSalesPage();
  assert.deepStrictEqual(page.stores.map((item) => item.id), ["ST002"]);
  assert(page.sales.some((item) => item.id === "SALE003"));
  assert(!page.sales.some((item) => item.id === "SALE001"));

  await expectCode(sales.submitSale({
    idempotencyKey: "forge-cross-team-001",
    storeId: "ST002",
    lines: [{ productId: "P240", qty: 1, batchNo: "BATCH-001" }]
  }), "STORE_FORBIDDEN");
}

async function testExpiredAuthorizationReturnsStableCode() {
  const data = seed();
  const boss = data.users.find((item) => item.role === "boss");
  const harness = createHarness(data, boss);
  await migrate(harness);
  harness.data.user_permissions.R001 = {
    _id: "R001",
    roleId: "builtin_rep",
    version: 1,
    overrideList: [{
      permission: "performance.view",
      mode: "replace",
      scope: { level: "global" },
      expiresAt: "2020-01-01T00:00:00.000Z",
      status: "启用"
    }]
  };

  harness.setUser(harness.get("users", "acct_r1"));
  const user = await harness.context.requireUser();
  assert(user._authorization.expiredCodes.includes("performance.view"));
  await expectCode(
    Promise.resolve().then(() => harness.context.assertPermission(user, "performance.view")),
    "GRANT_EXPIRED"
  );
}

async function testExpenseSupervisorDelegation() {
  const data = seed();
  const boss = data.users.find((item) => item.role === "boss");
  const harness = createHarness(data, boss);
  let permissions = await migrate(harness);
  const result = await permissions.saveApprovalDelegation({
    businessType: "expenses",
    stage: "supervisor",
    managerId: "M001",
    delegateUserId: "S002",
    startDate: new Date().toISOString().slice(0, 10),
    expiresAt: "2099-12-31",
    reason: "主管休假期间代审费用"
  });
  const delegationId = result.delegation._id;
  Object.assign(harness.get("expenses", "EXP001"), {
    status: "待主管审核",
    managerId: "M001",
    supervisorId: "S001",
    repId: "R001",
    approvalTrail: []
  });

  harness.setUser(harness.get("users", "acct_s2"));
  const expenses = harness.loadHandler("expenses");
  const approved = await expenses.approveExpense({ id: "EXP001" });
  assert.strictEqual(approved.status, "待经理审核");
  const trail = harness.get("expenses", "EXP001").approvalTrail.at(-1);
  assert.strictEqual(trail.delegated, true);
  assert.strictEqual(trail.role, "supervisor");
  assert.strictEqual(trail.delegationId, delegationId);
  assert(harness.state.audits.some((item) =>
    item.action === "代理主管审核费用"
    && item.detail.includes("代理岗位=主管")
    && item.detail.includes(`授权=${delegationId}`)));
  await expectCode(expenses.approveExpense({ id: "EXP001" }), "WRONG_APPROVAL_LEVEL");

  harness.setUser(harness.get("users", "acct_boss"));
  permissions = harness.loadHandler("permissions");
  await permissions.saveApprovalDelegation({ ...result.delegation, id: delegationId, status: "停用" });
  assert.strictEqual(harness.get("users", "acct_s2").reauthRequired, true);
}

async function testHighRiskRoleRemovalForcesReauthentication() {
  const data = seed();
  const boss = data.users.find((item) => item.role === "boss");
  const harness = createHarness(data, boss);
  const permissions = await migrate(harness);
  const created = await permissions.savePermissionRole({
    name: "临时退货专员",
    grants: [{ permission: "sales.correct", scope: { level: "team" } }],
    reason: "临时处理历史退货",
    confirmed: true
  });
  await permissions.saveUserPermissions({
    userId: "R001",
    permissionRoleId: created.role.id,
    overrides: [],
    reason: "临时处理历史退货",
    confirmed: true
  });
  assert.strictEqual(harness.get("users", "acct_r1").reauthRequired, false);

  await permissions.savePermissionRole({
    id: created.role.id,
    name: "临时退货专员（已收回）",
    grants: []
  });
  assert.strictEqual(harness.get("users", "acct_r1").reauthRequired, true);
}

(async () => {
  await testRequestRejectionAndImmediateOrdinaryRevoke();
  await testRegionExpansionAndForgedCrossTeamRequest();
  await testExpiredAuthorizationReturnsStableCode();
  await testExpenseSupervisorDelegation();
  await testHighRiskRoleRemovalForcesReauthentication();
  console.log("V1.2新增权限流程补充测试通过：驳回、普通收回、区域范围、越权、到期、费用代理和角色降权");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
