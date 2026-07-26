const PERMISSION_DEFINITIONS = Object.freeze([
  ["dashboard.view", "查看首页", "首页", false],
  ["sales.view", "查看销售", "销售", false],
  ["sales.submit", "填报销售", "销售", false],
  ["sales.zero", "提交零销售日报", "销售", false],
  ["sales.approve.supervisor", "主管级审核销售", "销售", false],
  ["sales.approve.manager", "经理级终审销售", "销售", false],
  ["sales.correct", "销售退货或作废", "销售", true],
  ["inventory.view", "查看库存", "库存", false],
  ["inventory.receive", "登记入库", "库存", false],
  ["expenses.view", "查看费用", "费用", false],
  ["expenses.submit", "提交费用", "费用", false],
  ["expenses.approve.supervisor", "主管级审核费用", "费用", false],
  ["expenses.approve.manager", "经理级终审费用", "费用", false],
  ["expenses.pay", "确认费用付款", "费用", true],
  ["expenses.invoice", "确认费用收票", "费用", true],
  ["receivables.view", "查看应收回款", "回款", false],
  ["receivables.record", "登记回款", "回款", false],
  ["receivables.verify", "核实回款", "回款", true],
  ["receivables.void", "撤销回款", "回款", true],
  ["receivables.term", "设置仓库账期", "回款", true],
  ["policies.view", "查看客户政策", "政策", false],
  ["policies.approve", "通过客户政策", "政策", true],
  ["policies.reject", "驳回客户政策", "政策", true],
  ["reports.view", "查看经营报表", "报表", false],
  ["reports.weekly.submit", "提交周统计", "报表", false],
  ["reports.risk.view", "查看风控", "报表", false],
  ["reports.audit.view", "查看审计日志", "报表", false],
  ["performance.view", "查看省区月度业绩", "报表", false],
  ["admin.users.view", "查看人员账号", "管理", false],
  ["admin.users.manage", "新增或修改人员", "管理", true],
  ["admin.users.toggle", "停用或启用人员", "管理", true],
  ["admin.users.reset", "重置人员密码", "管理", true],
  ["admin.users.unbind", "解绑人员微信", "管理", true],
  ["admin.users.delete", "删除无业务人员", "管理", true],
  ["admin.import", "批量导入数据", "管理", true],
  ["permissions.center.view", "查看权限中心", "权限", false],
  ["permissions.assign", "分配普通权限", "权限", false],
  ["permissions.roles.manage", "管理权限角色模板", "权限", true],
  ["permissions.admins.manage", "管理权限管理员", "权限", true],
  ["permissions.requests.review", "审批高危授权", "权限", true],
  ["permissions.delegations.manage", "管理审批代理", "权限", true]
].map(([code, label, group, highRisk]) => Object.freeze({ code, label, group, highRisk })));

const DEFINITION_MAP = new Map(PERMISSION_DEFINITIONS.map((item) => [item.code, item]));
const HIGH_RISK_PERMISSIONS = new Set(PERMISSION_DEFINITIONS.filter((item) => item.highRisk).map((item) => item.code));
const SYSTEM_CONTROL_PERMISSIONS = new Set([
  "permissions.roles.manage",
  "permissions.admins.manage",
  "permissions.requests.review",
  "permissions.delegations.manage"
]);

function permissionRoleIdForPosition(role) {
  return `builtin_${role}`;
}

function grant(level = "self", extra = {}) {
  return { level, regions: [], teamIds: [], customerIds: [], warehouseIds: [], ...extra };
}

const ROLE_GRANTS = Object.freeze({
  boss: {
    "dashboard.view": grant("global"),
    "sales.view": grant("global"),
    "sales.correct": grant("global"),
    "inventory.view": grant("global"),
    "inventory.receive": grant("global"),
    "expenses.view": grant("global"),
    "expenses.pay": grant("global"),
    "expenses.invoice": grant("global"),
    "receivables.view": grant("global"),
    "receivables.record": grant("global"),
    "receivables.verify": grant("global"),
    "receivables.void": grant("global"),
    "receivables.term": grant("global"),
    "policies.view": grant("global"),
    "policies.approve": grant("global"),
    "policies.reject": grant("global"),
    "reports.view": grant("global"),
    "reports.risk.view": grant("global"),
    "reports.audit.view": grant("global"),
    "performance.view": grant("global"),
    "admin.users.view": grant("global"),
    "admin.users.manage": grant("global"),
    "admin.users.toggle": grant("global"),
    "admin.users.reset": grant("global"),
    "admin.users.unbind": grant("global"),
    "admin.users.delete": grant("global"),
    "admin.import": grant("global"),
    "permissions.center.view": grant("global"),
    "permissions.assign": grant("global"),
    "permissions.roles.manage": grant("global"),
    "permissions.admins.manage": grant("global"),
    "permissions.requests.review": grant("global"),
    "permissions.delegations.manage": grant("global")
  },
  hq_auditor: {
    "dashboard.view": grant("global"),
    "expenses.view": grant("global"),
    "policies.view": grant("global")
  },
  finance: {
    "dashboard.view": grant("global"),
    "expenses.view": grant("global"),
    "expenses.pay": grant("global"),
    "expenses.invoice": grant("global"),
    "receivables.view": grant("global"),
    "receivables.record": grant("global"),
    "receivables.verify": grant("global"),
    "receivables.void": grant("global")
  },
  manager: {
    "dashboard.view": grant("team"),
    "sales.view": grant("team"),
    "sales.approve.manager": grant("team"),
    "sales.correct": grant("team"),
    "inventory.view": grant("team"),
    "inventory.receive": grant("team"),
    "expenses.view": grant("team"),
    "expenses.approve.manager": grant("team"),
    "receivables.view": grant("team"),
    "receivables.record": grant("team"),
    "receivables.void": grant("team"),
    "policies.view": grant("team"),
    "reports.view": grant("team"),
    "reports.weekly.submit": grant("self"),
    "reports.risk.view": grant("team"),
    "reports.audit.view": grant("self")
  },
  supervisor: {
    "dashboard.view": grant("subordinates"),
    "sales.view": grant("subordinates"),
    "sales.approve.supervisor": grant("subordinates"),
    "inventory.view": grant("team"),
    "expenses.view": grant("subordinates"),
    "expenses.approve.supervisor": grant("subordinates"),
    "policies.view": grant("subordinates"),
    "reports.view": grant("subordinates"),
    "reports.weekly.submit": grant("self"),
    "reports.risk.view": grant("subordinates"),
    "reports.audit.view": grant("self")
  },
  rep: {
    "dashboard.view": grant("self"),
    "sales.view": grant("self"),
    "sales.submit": grant("self"),
    "sales.zero": grant("self"),
    "inventory.view": grant("team"),
    "expenses.view": grant("self"),
    "expenses.submit": grant("self"),
    "policies.view": grant("self"),
    "reports.view": grant("self"),
    "reports.audit.view": grant("self")
  }
});

const ROLE_LABELS = Object.freeze({
  boss: "老板",
  hq_auditor: "总部审核人员",
  finance: "总部财务人员",
  manager: "省区/区域经理",
  supervisor: "地区主管",
  rep: "业务代表"
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function builtinRole(role) {
  return {
    _id: permissionRoleIdForPosition(role),
    name: ROLE_LABELS[role] || role,
    positionRole: role,
    builtin: true,
    status: "启用",
    grants: clone(ROLE_GRANTS[role] || {})
  };
}

function builtinRoles() {
  return Object.keys(ROLE_GRANTS).map(builtinRole);
}

function cleanList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeScope(value = {}) {
  const levels = new Set(["self", "subordinates", "team", "specified", "global"]);
  return {
    level: levels.has(value.level) ? value.level : "self",
    regions: cleanList(value.regions),
    teamIds: cleanList(value.teamIds),
    customerIds: cleanList(value.customerIds),
    warehouseIds: cleanList(value.warehouseIds)
  };
}

function mergeScopes(baseValue = {}, extraValue = {}) {
  const base = normalizeScope(baseValue);
  const extra = normalizeScope(extraValue);
  if (base.level === "global" || extra.level === "global") return grant("global");
  const levelRank = { self: 0, subordinates: 1, team: 2 };
  const mergedLevel = base.level === "specified"
    ? extra.level
    : extra.level === "specified"
      ? base.level
      : levelRank[extra.level] > levelRank[base.level]
        ? extra.level
        : base.level;
  return {
    level: mergedLevel,
    regions: cleanList([...base.regions, ...extra.regions]),
    teamIds: cleanList([...base.teamIds, ...extra.teamIds]),
    customerIds: cleanList([...base.customerIds, ...extra.customerIds]),
    warehouseIds: cleanList([...base.warehouseIds, ...extra.warehouseIds])
  };
}

function activeOverride(rule, now = Date.now()) {
  if (!rule || rule.status === "停用") return false;
  if (!rule.expiresAt) return true;
  const expiry = Date.parse(rule.expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}

function resolveEffectivePermissions(user, roleDocument, userPermissionDocument, permissionAdminDocument, now = Date.now()) {
  const fallback = builtinRole(user.role);
  const role = roleDocument && roleDocument.status !== "停用" ? roleDocument : fallback;
  const effective = {};
  const expiredCodes = [];
  const roleGrants = Array.isArray(role.grantList)
    ? Object.fromEntries(role.grantList.map((item) => [item.permission, item.scope]))
    : role.grants || {};
  for (const [code, scope] of Object.entries(roleGrants)) {
    if (DEFINITION_MAP.has(code)) effective[code] = { allowed: true, scope: normalizeScope(scope), source: "role" };
  }
  const overrides = Array.isArray(userPermissionDocument?.overrideList)
    ? Object.fromEntries(userPermissionDocument.overrideList.map((item) => [item.permission, item]))
    : userPermissionDocument?.overrides || {};
  for (const [code, rule] of Object.entries(overrides)) {
    if (!DEFINITION_MAP.has(code)) continue;
    if (!activeOverride(rule, now)) {
      if (rule?.status !== "停用" && rule?.expiresAt && Date.parse(rule.expiresAt) <= now) expiredCodes.push(code);
      continue;
    }
    const mode = ["inherit", "extend", "replace", "deny"].includes(rule.mode) ? rule.mode : "inherit";
    if (mode === "inherit") continue;
    if (mode === "deny") {
      delete effective[code];
      continue;
    }
    const current = effective[code]?.scope || grant("self");
    effective[code] = {
      allowed: true,
      scope: mode === "extend" ? mergeScopes(current, rule.scope) : normalizeScope(rule.scope),
      source: "override",
      expiresAt: rule.expiresAt || ""
    };
  }
  if (permissionAdminDocument?.status === "启用" && activeOverride(permissionAdminDocument, now)) {
    effective["permissions.center.view"] = { allowed: true, scope: grant("specified"), source: "permission_admin" };
    effective["permissions.assign"] = { allowed: true, scope: grant("specified"), source: "permission_admin" };
  }
  return {
    roleId: role._id || permissionRoleIdForPosition(user.role),
    roleName: role.name || ROLE_LABELS[user.role] || user.role,
    grants: effective,
    codes: Object.keys(effective).sort(),
    expiredCodes
  };
}

function itemIdentity(item = {}) {
  return {
    ownerIds: cleanList([
      item.repId,
      item.ownerId,
      item.actorId,
      item.registeredBy,
      item.userId,
      item.personId,
      item._id && item.role ? item._id : ""
    ]),
    managerId: String(item.managerId || ""),
    supervisorId: String(item.supervisorId || ""),
    customerId: String(item.customerId || (item.channel ? item._id || "" : "")),
    warehouseId: String(item.warehouseId || (item.creditDays !== undefined ? item._id || "" : "")),
    region: String(item.province || item.region || item.department || "")
  };
}

function scopeAllows(user, scopeValue, item = null) {
  const scope = normalizeScope(scopeValue);
  if (scope.level === "global") return true;
  if (!item) return true;
  const id = String(user.personId || user._id || "");
  const managerId = user.role === "manager" ? id : String(user.managerId || "");
  const identity = itemIdentity(item);
  if (scope.customerIds.includes(identity.customerId) || scope.warehouseIds.includes(identity.warehouseId)) return true;
  if (scope.teamIds.includes(identity.managerId)) return true;
  if (scope.regions.some((region) => identity.region === region || identity.region.startsWith(`${region}/`))) return true;
  if (scope.level === "self") return identity.ownerIds.includes(id);
  if (scope.level === "subordinates") {
    if (user.role === "manager") return identity.managerId === id;
    if (user.role === "supervisor") return identity.supervisorId === id;
    return identity.ownerIds.includes(id);
  }
  if (scope.level === "team") return Boolean(managerId) && identity.managerId === managerId;
  return false;
}

function permissionLabels(codes) {
  return (codes || []).map((code) => DEFINITION_MAP.get(code)).filter(Boolean);
}

module.exports = {
  PERMISSION_DEFINITIONS,
  DEFINITION_MAP,
  HIGH_RISK_PERMISSIONS,
  SYSTEM_CONTROL_PERMISSIONS,
  ROLE_GRANTS,
  ROLE_LABELS,
  permissionRoleIdForPosition,
  builtinRole,
  builtinRoles,
  normalizeScope,
  mergeScopes,
  resolveEffectivePermissions,
  scopeAllows,
  permissionLabels
};
