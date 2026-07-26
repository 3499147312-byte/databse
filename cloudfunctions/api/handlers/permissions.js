const crypto = require("crypto");
const {
  db,
  fetchAll,
  getDoc,
  setDoc,
  updateDoc,
  findUserByBusinessId,
  requireUser,
  attachAuthorization,
  assertPermission,
  ensureBuiltinPermissionRoles,
  bumpPermissionVersion,
  writeAudit,
  safeUser,
  userBusinessId,
  fail
} = require("../lib/context");
const { nowIso } = require("../lib/core");
const {
  PERMISSION_DEFINITIONS,
  DEFINITION_MAP,
  HIGH_RISK_PERMISSIONS,
  SYSTEM_CONTROL_PERMISSIONS,
  permissionRoleIdForPosition,
  normalizeScope
} = require("../lib/permissions");

function clean(value) {
  return String(value ?? "").trim();
}

function cleanList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))];
}

function normalizeExpiry(value) {
  const text = clean(value);
  if (!text) return "";
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T23:59:59.999+08:00`
    : text;
  if (Number.isNaN(Date.parse(normalized))) fail("INVALID_EXPIRY", "权限截止时间格式不正确。");
  return normalized;
}

function ownerOnly(user) {
  if (user.role !== "boss") fail("PERMISSION_DENIED", "只有老板可以执行这项权限管理操作。");
}

function roleGrantList(role) {
  if (Array.isArray(role?.grantList)) return role.grantList;
  return Object.entries(role?.grants || {}).map(([permission, scope]) => ({ permission, scope }));
}

function highRiskCodesFromRole(role) {
  return new Set(roleGrantList(role)
    .map((item) => item.permission)
    .filter((permission) => HIGH_RISK_PERMISSIONS.has(permission)));
}

function effectiveHighRiskCodes(role, overrides) {
  const result = highRiskCodesFromRole(role);
  for (const override of overrides || []) {
    if (!HIGH_RISK_PERMISSIONS.has(override.permission) || override.status === "停用") continue;
    if (override.mode === "deny") result.delete(override.permission);
    else if (["extend", "replace"].includes(override.mode)) result.add(override.permission);
  }
  return result;
}

function requireHighRiskConfirmation(payload, reason) {
  if (!reason || reason.length < 2 || reason.length > 200) {
    fail("INVALID_REASON", "高危授权必须填写2至200字原因。");
  }
  if (payload.confirmed !== true) fail("CONFIRM_REQUIRED", "高危授权必须二次确认。");
}

function publicRole(role) {
  return {
    id: role._id,
    name: role.name,
    positionRole: role.positionRole || "",
    builtin: Boolean(role.builtin),
    status: role.status || "启用",
    grants: roleGrantList(role).map((item) => ({
      permission: item.permission,
      scope: normalizeScope(item.scope)
    })),
    updatedAt: role.updatedAt || ""
  };
}

function publicOverrideDocument(document) {
  return {
    userId: document?._id || "",
    roleId: document?.roleId || "",
    overrides: (document?.overrideList || []).map((item) => ({
      permission: item.permission,
      mode: item.mode || "inherit",
      scope: normalizeScope(item.scope),
      expiresAt: item.expiresAt || "",
      reason: item.reason || "",
      status: item.status || "启用"
    })),
    version: Number(document?.version || 0)
  };
}

function targetTeamId(user) {
  if (user.role === "manager") return userBusinessId(user);
  return user.managerId || "";
}

function adminCanManage(adminUser, adminDocument, target) {
  if (!adminDocument || adminDocument.status !== "启用") return false;
  const adminId = userBusinessId(adminUser);
  const targetId = userBusinessId(target);
  if (!target || target.role === "boss" || targetId === adminId) return false;
  const people = cleanList(adminDocument.personIds);
  const teams = cleanList(adminDocument.teamIds);
  const regions = cleanList(adminDocument.regions);
  if (people.includes(targetId)) return true;
  if (teams.includes(targetTeamId(target))) return true;
  const targetRegion = String(target.province || target.department || "");
  return regions.some((region) => targetRegion === region || targetRegion.startsWith(`${region}/`));
}

async function assertManageTarget(actor, target) {
  if (!target || target.role === "boss") fail("USER_PROTECTED", "老板账号不能由权限中心调整。");
  if (actor.role === "boss") return { owner: true, admin: null };
  const admin = actor._permissionAdmin;
  if (!adminCanManage(actor, admin, target)) fail("SCOPE_DENIED", "该人员不在当前权限管理员的管理范围内。");
  const targetAdmin = await getDoc("permission_admins", userBusinessId(target));
  if (targetAdmin?.status === "启用") fail("PERMISSION_DENIED", "权限管理员之间不能互相调整权限。");
  return { owner: false, admin };
}

function validatePermission(permission) {
  if (!DEFINITION_MAP.has(permission)) fail("INVALID_PERMISSION", `权限编码不存在：${permission}`);
}

function validateOverride(source) {
  const permission = clean(source.permission);
  validatePermission(permission);
  const mode = clean(source.mode || "inherit");
  if (!["inherit", "extend", "replace", "deny"].includes(mode)) fail("INVALID_PERMISSION_MODE", "个人权限模式不正确。");
  const expiresAt = normalizeExpiry(source.expiresAt);
  if (expiresAt && Date.parse(expiresAt) <= Date.now() && ["extend", "replace"].includes(mode)) {
    fail("GRANT_EXPIRED", "授权截止时间已经过去。");
  }
  const reason = clean(source.reason);
  if (reason.length > 200) fail("INVALID_REASON", "授权原因不能超过200字。");
  return {
    permission,
    mode,
    scope: normalizeScope(source.scope),
    expiresAt,
    reason,
    status: source.status === "停用" ? "停用" : "启用"
  };
}

function adminGrantAllowed(admin, override) {
  const ceiling = new Set(cleanList(admin?.grantCeiling));
  if (!ceiling.has(override.permission)) {
    fail("GRANT_LIMIT_EXCEEDED", `权限“${override.permission}”超过管理员授权上限。`);
  }
  if (SYSTEM_CONTROL_PERMISSIONS.has(override.permission)) {
    fail("GRANT_LIMIT_EXCEEDED", "系统权限管理能力不能下发。");
  }
}

async function getPermissionCenter() {
  let actor = await requireUser();
  await ensureBuiltinPermissionRoles();
  actor = await attachAuthorization(actor);
  assertPermission(actor, "permissions.center.view");
  const [roles, users, overrides, admins, requests, delegations, audit] = await Promise.all([
    fetchAll("permission_roles", {}, { max: 200 }),
    fetchAll("users", {}, { max: 3000 }),
    fetchAll("user_permissions", {}, { max: 3000 }),
    fetchAll("permission_admins", {}, { max: 3000 }),
    fetchAll("permission_requests", {}, { max: 1000, orderBy: { field: "createdAt", direction: "desc" } }),
    fetchAll("approval_delegations", {}, { max: 1000, orderBy: { field: "createdAt", direction: "desc" } }),
    fetchAll("audit_logs", {}, { max: 300, orderBy: { field: "createdAt", direction: "desc" } })
  ]);
  const visibleUsers = users
    .filter((item) => item.role !== "boss")
    .filter((item) => actor.role === "boss" || adminCanManage(actor, actor._permissionAdmin, item));
  const visibleIds = new Set(visibleUsers.map(userBusinessId));
  return {
    user: safeUser(actor),
    isBoss: actor.role === "boss",
    definitions: PERMISSION_DEFINITIONS,
    roles: roles.map(publicRole).sort((a, b) => `${a.builtin ? 0 : 1}|${a.name}`.localeCompare(`${b.builtin ? 0 : 1}|${b.name}`, "zh-CN")),
    users: visibleUsers.map((item) => ({
      ...safeUser(item),
      permissionRoleId: item.permissionRoleId || permissionRoleIdForPosition(item.role)
    })),
    userPermissions: overrides.filter((item) => visibleIds.has(item._id)).map(publicOverrideDocument),
    admins: actor.role === "boss" ? admins : admins.filter((item) => item._id === userBusinessId(actor)),
    requests: actor.role === "boss"
      ? requests
      : requests.filter((item) => item.requestedBy === userBusinessId(actor) || visibleIds.has(item.targetUserId)),
    delegations: actor.role === "boss"
      ? delegations
      : delegations.filter((item) => item.delegateUserId === userBusinessId(actor)),
    audit: actor.role === "boss"
      ? audit.filter((item) => String(item.action || "").includes("权限") || String(item.action || "").includes("代理"))
      : audit.filter((item) => item.actorId === userBusinessId(actor)),
    managerOptions: users
      .filter((item) => item.role === "manager" && !item.disabled)
      .map((item) => ({ id: userBusinessId(item), label: `${item.name} · ${item.province || item.department}` }))
  };
}

async function savePermissionRole(payload) {
  const actor = await requireUser();
  ownerOnly(actor);
  await ensureBuiltinPermissionRoles();
  const id = clean(payload.id);
  const existing = id ? await getDoc("permission_roles", id) : null;
  if (existing?._id === permissionRoleIdForPosition("boss")) fail("BOSS_PROTECTED", "老板权限模板不能修改。");
  const targetId = existing?._id || `custom_${crypto.randomBytes(10).toString("hex")}`;
  const name = clean(payload.name);
  if (!name || name.length > 30) fail("INVALID_ROLE_NAME", "权限角色名称必须为1至30字。");
  const grantList = (payload.grants || []).map((item) => {
    const permission = clean(item.permission);
    validatePermission(permission);
    if (SYSTEM_CONTROL_PERMISSIONS.has(permission)) {
      fail("GRANT_LIMIT_EXCEEDED", "自定义角色和普通内置模板不能包含系统最高权限。");
    }
    return { permission, scope: normalizeScope(item.scope) };
  });
  const duplicateCodes = new Set();
  for (const item of grantList) {
    if (duplicateCodes.has(item.permission)) fail("DUPLICATE_PERMISSION", "角色模板中存在重复权限。");
    duplicateCodes.add(item.permission);
  }
  const highRiskRoleCodes = grantList.filter((item) => HIGH_RISK_PERMISSIONS.has(item.permission));
  if (highRiskRoleCodes.length) requireHighRiskConfirmation(payload, clean(payload.reason));
  const oldHighRiskRoleCodes = highRiskCodesFromRole(existing);
  const record = {
    name,
    positionRole: existing?.positionRole || clean(payload.positionRole),
    builtin: Boolean(existing?.builtin),
    status: payload.status === "停用" ? "停用" : "启用",
    grantList,
    version: Number(existing?.version || 0) + 1,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
    updatedBy: userBusinessId(actor)
  };
  await setDoc("permission_roles", targetId, record);
  const assignedUsers = await fetchAll("users", { permissionRoleId: targetId }, { max: 3000 });
  const removedHighRisk = [...oldHighRiskRoleCodes].some((code) => !highRiskRoleCodes.some((item) => item.permission === code))
    || (existing?.status !== "停用" && record.status === "停用" && oldHighRiskRoleCodes.size > 0);
  for (const user of assignedUsers) await bumpPermissionVersion(userBusinessId(user), { forceReauth: removedHighRisk });
  await writeAudit(actor, existing ? "修改权限角色" : "创建自定义权限角色", targetId, `${name} / ${grantList.length}项权限`);
  return { role: publicRole({ _id: targetId, ...record }) };
}

async function savePermissionAdmin(payload) {
  const actor = await requireUser();
  ownerOnly(actor);
  const target = await findUserByBusinessId(clean(payload.userId));
  if (!target || target.role === "boss" || target.disabled) fail("USER_PROTECTED", "只能把启用的非老板人员设为权限管理员。");
  const id = userBusinessId(target);
  const grantCeiling = cleanList(payload.grantCeiling);
  grantCeiling.forEach(validatePermission);
  if (grantCeiling.some((item) => SYSTEM_CONTROL_PERMISSIONS.has(item))) {
    fail("GRANT_LIMIT_EXCEEDED", "权限管理员不能获得系统最高权限的下发能力。");
  }
  const record = {
    status: payload.status === "停用" ? "停用" : "启用",
    personIds: cleanList(payload.personIds).filter((item) => item !== id),
    teamIds: cleanList(payload.teamIds),
    regions: cleanList(payload.regions),
    grantCeiling,
    canRequestHighRisk: payload.canRequestHighRisk !== false,
    expiresAt: normalizeExpiry(payload.expiresAt),
    updatedAt: nowIso(),
    updatedBy: userBusinessId(actor),
    createdAt: (await getDoc("permission_admins", id))?.createdAt || nowIso()
  };
  await setDoc("permission_admins", id, record);
  await bumpPermissionVersion(id, { forceReauth: record.status === "停用" });
  await writeAudit(actor, record.status === "启用" ? "设置权限管理员" : "停用权限管理员", id, `${target.name} / 上限${grantCeiling.length}项`);
  return { admin: { _id: id, ...record } };
}

async function saveUserPermissions(payload) {
  const actor = await requireUser();
  assertPermission(actor, "permissions.assign");
  const target = await findUserByBusinessId(clean(payload.userId));
  const access = await assertManageTarget(actor, target);
  const targetId = userBusinessId(target);
  const existing = await getDoc("user_permissions", targetId);
  const existingMap = new Map((existing?.overrideList || []).map((item) => [item.permission, item]));
  const incoming = (payload.overrides || []).map(validateOverride);
  const pendingRequests = [];
  const applied = [];
  for (const override of incoming) {
    if (HIGH_RISK_PERMISSIONS.has(override.permission) && ["extend", "replace"].includes(override.mode)) {
      requireHighRiskConfirmation(payload, override.reason);
    }
    if (!access.owner) adminGrantAllowed(access.admin, override);
    if (!access.owner && HIGH_RISK_PERMISSIONS.has(override.permission) && override.mode !== "deny" && override.mode !== "inherit") {
      if (!access.admin.canRequestHighRisk) fail("GRANT_LIMIT_EXCEEDED", "当前权限管理员不能提交高危授权申请。");
      if (!override.reason || override.reason.length < 2) fail("INVALID_REASON", "高危授权申请必须填写2至200字原因。");
      const requestId = `preq_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
      const request = {
        targetUserId: targetId,
        targetName: target.name,
        permission: override.permission,
        override,
        status: "待老板确认",
        requestedBy: userBusinessId(actor),
        requestedByName: actor.name,
        createdAt: nowIso()
      };
      await setDoc("permission_requests", requestId, request);
      pendingRequests.push({ _id: requestId, ...request });
      continue;
    }
    if (override.mode === "inherit") existingMap.delete(override.permission);
    else existingMap.set(override.permission, {
      ...override,
      grantedBy: userBusinessId(actor),
      grantedAt: nowIso()
    });
    applied.push(override.permission);
  }
  let roleId = target.permissionRoleId || permissionRoleIdForPosition(target.role);
  const oldRole = await getDoc("permission_roles", roleId);
  let newRole = oldRole;
  if (payload.permissionRoleId && payload.permissionRoleId !== roleId) {
    if (!access.owner) fail("PERMISSION_DENIED", "只有老板可以更换人员的权限角色模板。");
    const role = await getDoc("permission_roles", clean(payload.permissionRoleId));
    if (!role || role.status === "停用") fail("INVALID_ROLE", "权限角色不存在或已停用。");
    const addedRoleHighRisk = [...highRiskCodesFromRole(role)].some((code) => !highRiskCodesFromRole(oldRole).has(code));
    if (addedRoleHighRisk) requireHighRiskConfirmation(payload, clean(payload.reason));
    roleId = role._id;
    newRole = role;
    await updateDoc("users", target._id, { permissionRoleId: roleId });
  }
  const oldHighRisk = effectiveHighRiskCodes(oldRole, existing?.overrideList || []);
  const newHighRisk = effectiveHighRiskCodes(newRole, [...existingMap.values()]);
  const forceReauth = [...oldHighRisk].some((item) => !newHighRisk.has(item));
  const record = {
    roleId,
    overrideList: [...existingMap.values()],
    version: Number(existing?.version || 0) + 1,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
    updatedBy: userBusinessId(actor)
  };
  await setDoc("user_permissions", targetId, record);
  await bumpPermissionVersion(targetId, { forceReauth });
  await writeAudit(actor, "调整人员权限", targetId, `${target.name} / 已应用${applied.length}项 / 待确认${pendingRequests.length}项`);
  return { applied, pendingRequests, permission: publicOverrideDocument({ _id: targetId, ...record }) };
}

async function reviewPermissionRequest(payload) {
  const actor = await requireUser();
  ownerOnly(actor);
  const request = await getDoc("permission_requests", clean(payload.id));
  if (!request || request.status !== "待老板确认") fail("REQUEST_NOT_PENDING", "授权申请不存在或已经处理。");
  const decision = clean(payload.decision);
  if (!["通过", "驳回"].includes(decision)) fail("INVALID_DECISION", "请选择通过或驳回。");
  const note = clean(payload.note);
  if (decision === "驳回" && (note.length < 2 || note.length > 200)) fail("INVALID_REASON", "驳回原因必须为2至200字。");
  let target = null;
  if (decision === "通过") {
    target = await findUserByBusinessId(request.targetUserId);
    if (!target || target.role === "boss") fail("USER_PROTECTED", "目标人员不存在或不能授权。");
  }
  await db.runTransaction(async (transaction) => {
    const currentRequest = (await transaction.collection("permission_requests").doc(request._id).get()).data;
    if (currentRequest.status !== "待老板确认") fail("REQUEST_NOT_PENDING", "授权申请不存在或已经处理。");
    if (decision === "通过") {
      let document = null;
      try {
        document = (await transaction.collection("user_permissions").doc(request.targetUserId).get()).data;
      } catch {
        document = null;
      }
      const overrideMap = new Map((document?.overrideList || []).map((item) => [item.permission, item]));
      overrideMap.set(request.permission, {
        ...validateOverride(request.override),
        grantedBy: userBusinessId(actor),
        grantedAt: nowIso(),
        approvedRequestId: request._id
      });
      await transaction.collection("user_permissions").doc(request.targetUserId).set({ data: {
        roleId: target.permissionRoleId || permissionRoleIdForPosition(target.role),
        overrideList: [...overrideMap.values()],
        version: Number(document?.version || 0) + 1,
        createdAt: document?.createdAt || nowIso(),
        updatedAt: nowIso(),
        updatedBy: userBusinessId(actor)
      } });
      const currentUser = (await transaction.collection("users").doc(target._id).get()).data;
      await transaction.collection("users").doc(target._id).update({ data: {
        permissionVersion: Number(currentUser.permissionVersion || 0) + 1,
        permissionsUpdatedAt: nowIso()
      } });
    }
    await transaction.collection("permission_requests").doc(request._id).update({ data: {
      status: decision === "通过" ? "老板已通过" : "老板已驳回",
      reviewedBy: userBusinessId(actor),
      reviewedAt: nowIso(),
      reviewNote: note
    } });
  });
  await writeAudit(actor, decision === "通过" ? "通过高危权限申请" : "驳回高危权限申请", request.targetUserId, `${request.permission} / ${note || request.override.reason}`);
  return { status: decision === "通过" ? "老板已通过" : "老板已驳回" };
}

async function saveApprovalDelegation(payload) {
  const actor = await requireUser();
  ownerOnly(actor);
  const businessType = clean(payload.businessType);
  const stage = clean(payload.stage);
  if (!["sales", "expenses"].includes(businessType)) fail("INVALID_DELEGATION", "代理业务只能是销售或费用。");
  if (!["supervisor", "manager"].includes(stage)) fail("INVALID_DELEGATION", "代理阶段只能是主管审核或经理审核。");
  const manager = await findUserByBusinessId(clean(payload.managerId));
  const delegate = await findUserByBusinessId(clean(payload.delegateUserId));
  if (!manager || manager.role !== "manager" || manager.disabled) fail("INVALID_DELEGATION", "请选择有效的经理团队。");
  if (!delegate || delegate.role === "boss" || delegate.disabled) fail("INVALID_DELEGATION", "请选择启用的非老板代理人。");
  const startDate = clean(payload.startDate) || nowIso().slice(0, 10);
  const expiresAt = normalizeExpiry(payload.expiresAt);
  if (Number.isNaN(Date.parse(startDate)) || !expiresAt || expiresAt.slice(0, 10) < startDate) {
    fail("INVALID_EXPIRY", "审批代理必须填写有效的开始和截止日期，且截止日期不能早于开始日期。");
  }
  const id = clean(payload.id) || `deleg_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
  const existing = await getDoc("approval_delegations", id);
  if (stage === "manager" && userBusinessId(delegate) === userBusinessId(manager)) {
    fail("INVALID_DELEGATION", "经理阶段不能把审批代理给原经理本人。");
  }
  if (payload.status !== "停用") {
    const enabled = await fetchAll("approval_delegations", {
      businessType,
      stage,
      managerId: userBusinessId(manager),
      status: "启用"
    }, { max: 100 });
    const conflict = enabled.find((item) => item._id !== id
      && String(item.startDate || "") <= expiresAt.slice(0, 10)
      && String(item.expiresAt || "").slice(0, 10) >= startDate);
    if (conflict) fail("DELEGATION_CONFLICT", "该团队和审批阶段在所选日期内已有代理人。");
  }
  const record = {
    businessType,
    stage,
    managerId: userBusinessId(manager),
    managerName: manager.name,
    delegateUserId: userBusinessId(delegate),
    delegateName: delegate.name,
    startDate,
    expiresAt,
    status: payload.status === "停用" ? "停用" : "启用",
    reason: clean(payload.reason).slice(0, 200),
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
    updatedBy: userBusinessId(actor)
  };
  await setDoc("approval_delegations", id, record);
  await bumpPermissionVersion(userBusinessId(delegate), { forceReauth: Boolean(existing && record.status === "停用") });
  await writeAudit(actor, record.status === "启用" ? "设置审批代理" : "停用审批代理", id, `${record.managerName} / ${businessType}.${stage} / ${record.delegateName}`);
  return { delegation: { _id: id, ...record } };
}

async function migratePermissions() {
  const actor = await requireUser();
  ownerOnly(actor);
  await ensureBuiltinPermissionRoles();
  const users = await fetchAll("users", {}, { max: 3000 });
  let updated = 0;
  for (const user of users) {
    const roleId = user.role === "boss"
      ? permissionRoleIdForPosition("boss")
      : user.permissionRoleId || permissionRoleIdForPosition(user.role);
    if (!user.permissionRoleId || (user.role === "boss" && user.permissionRoleId !== roleId) || !user.permissionVersion) {
      await updateDoc("users", user._id, {
        permissionRoleId: roleId,
        permissionVersion: Math.max(1, Number(user.permissionVersion || 0)),
        reauthRequired: false,
        permissionsUpdatedAt: nowIso()
      });
      updated += 1;
    }
  }
  const settings = await getDoc("settings", "bootstrap");
  await setDoc("settings", "bootstrap", {
    ...(settings || {}),
    version: "1.2.0",
    permissionSchemaVersion: 1,
    permissionMigratedAt: nowIso(),
    permissionMigratedBy: userBusinessId(actor)
  });
  await writeAudit(actor, "权限体系迁移", "permission-v1", `检查${users.length}个账号，更新${updated}个`);
  return { totalUsers: users.length, updated, version: "1.2.0" };
}

module.exports = {
  getPermissionCenter,
  savePermissionRole,
  savePermissionAdmin,
  saveUserPermissions,
  reviewPermissionRequest,
  saveApprovalDelegation,
  migratePermissions
};
