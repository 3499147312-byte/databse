const assert = require("assert");
const {
  PERMISSION_DEFINITIONS,
  HIGH_RISK_PERMISSIONS,
  builtinRole,
  builtinRoles,
  normalizeScope,
  mergeScopes,
  resolveEffectivePermissions,
  scopeAllows
} = require("../cloudfunctions/api/lib/permissions");

assert.strictEqual(builtinRoles().length, 6, "必须生成六个V1.1等效内置模板");
assert(PERMISSION_DEFINITIONS.length >= 40, "权限编码应覆盖全部业务和管理动作");
assert(HIGH_RISK_PERMISSIONS.has("sales.correct"));
assert(HIGH_RISK_PERMISSIONS.has("admin.import"));
assert(!HIGH_RISK_PERMISSIONS.has("sales.view"));

// PERMISSION-SCOPE-01：团队与指定范围合并后仍严格隔离跨团队数据。
const manager = { _id: "acct_m1", personId: "M001", role: "manager", province: "海南", managerId: "" };
const teamOne = { _id: "sale_1", managerId: "M001", supervisorId: "S001", repId: "R001", customerId: "C001", warehouseId: "W001", province: "海南" };
const teamTwo = { _id: "sale_2", managerId: "M002", supervisorId: "S002", repId: "R002", customerId: "C002", warehouseId: "W002", province: "广东" };

const inherited = resolveEffectivePermissions(manager, builtinRole("manager"), null, null);
assert(inherited.grants["sales.view"].allowed);
assert(scopeAllows(manager, inherited.grants["sales.view"].scope, teamOne));
assert(!scopeAllows(manager, inherited.grants["sales.view"].scope, teamTwo));

const extended = resolveEffectivePermissions(manager, builtinRole("manager"), {
  overrideList: [{
    permission: "sales.view",
    mode: "extend",
    scope: { level: "specified", teamIds: ["M002"] },
    status: "启用"
  }]
}, null);
assert(scopeAllows(manager, extended.grants["sales.view"].scope, teamOne));
assert(scopeAllows(manager, extended.grants["sales.view"].scope, teamTwo), "追加范围应保留模板并增加指定团队");

const replaced = resolveEffectivePermissions(manager, builtinRole("manager"), {
  overrideList: [{
    permission: "sales.view",
    mode: "replace",
    scope: { level: "specified", warehouseIds: ["W002"] },
    status: "启用"
  }]
}, null);
assert(!scopeAllows(manager, replaced.grants["sales.view"].scope, teamOne), "替换范围不应保留模板团队");
assert(scopeAllows(manager, replaced.grants["sales.view"].scope, teamTwo));

const denied = resolveEffectivePermissions(manager, builtinRole("manager"), {
  overrideList: [{ permission: "sales.view", mode: "deny", status: "启用" }]
}, null);
assert.strictEqual(denied.grants["sales.view"], undefined, "禁用优先级最高");

// PERMISSION-EXPIRY-01：临时授权到期后失效并保留稳定错误码标记。
const expired = resolveEffectivePermissions(manager, builtinRole("manager"), {
  overrideList: [{
    permission: "performance.view",
    mode: "replace",
    scope: { level: "global" },
    expiresAt: "2020-01-01T00:00:00.000Z",
    status: "启用"
  }]
}, null, Date.parse("2026-07-26T00:00:00.000Z"));
assert.strictEqual(expired.grants["performance.view"], undefined, "过期授权必须自动失效");
assert(expired.expiredCodes.includes("performance.view"), "过期权限应保留稳定错误码所需标记");

const adminAuthorization = resolveEffectivePermissions(manager, builtinRole("manager"), null, {
  status: "启用",
  teamIds: ["M001"],
  grantCeiling: ["sales.view"]
});
assert(adminAuthorization.grants["permissions.center.view"]);
assert(adminAuthorization.grants["permissions.assign"]);
assert(!adminAuthorization.grants["permissions.roles.manage"]);

assert.deepStrictEqual(normalizeScope({ level: "specified", regions: ["海南", "海南"], teamIds: ["M1"] }), {
  level: "specified",
  regions: ["海南"],
  teamIds: ["M1"],
  customerIds: [],
  warehouseIds: []
});
assert.deepStrictEqual(mergeScopes({ level: "self" }, { level: "global" }), normalizeScope({ level: "global" }));

console.log("V1.2权限模板、优先级、范围与到期规则测试通过");
