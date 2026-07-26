const crypto = require("crypto");
const cloud = require("wx-server-sdk");
const { nowIso, safeUser, userBusinessId, fail } = require("./core");
const {
  HIGH_RISK_PERMISSIONS,
  permissionRoleIdForPosition,
  builtinRoles,
  resolveEffectivePermissions,
  scopeAllows
} = require("./permissions");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const command = db.command;
const collections = [
  "users",
  "warehouses",
  "customers",
  "stores",
  "products",
  "policies",
  "inventory_lots",
  "inventory_moves",
  "sales",
  "expenses",
  "daily_reports",
  "weekly_reports",
  "receivables",
  "warehouse_payments",
  "corrections",
  "audit_logs",
  "idempotency",
  "settings",
  "permission_roles",
  "user_permissions",
  "permission_admins",
  "permission_requests",
  "approval_delegations"
];

async function fetchAll(collectionName, where = {}, options = {}) {
  const max = Math.min(Number(options.max || 3000), 10000);
  const pageSize = 100;
  const rows = [];
  while (rows.length < max) {
    let query = db.collection(collectionName).where(where);
    if (options.orderBy) query = query.orderBy(options.orderBy.field, options.orderBy.direction || "desc");
    const result = await query.skip(rows.length).limit(Math.min(pageSize, max - rows.length)).get();
    rows.push(...result.data);
    if (result.data.length < pageSize) break;
  }
  return rows;
}

async function getDoc(collectionName, id) {
  try {
    return (await db.collection(collectionName).doc(id).get()).data;
  } catch (error) {
    if (String(error.errMsg || error.message).includes("does not exist") || error.errCode === -1) return null;
    throw error;
  }
}

async function setDoc(collectionName, id, data) {
  const copy = { ...data };
  delete copy._id;
  await db.collection(collectionName).doc(id).set({ data: copy });
  return { _id: id, ...copy };
}

async function updateDoc(collectionName, id, data) {
  await db.collection(collectionName).doc(id).update({ data });
}

async function findUserByBusinessId(id) {
  const direct = await getDoc("users", id);
  if (direct) return direct;
  const result = await db.collection("users").where({ personId: id }).limit(1).get();
  return result.data[0] || null;
}

async function findUserByOpenid(openid) {
  if (!openid) return null;
  const result = await db.collection("users").where({ openid }).limit(1).get();
  return result.data[0] || null;
}

async function requireUser(options = {}) {
  const { OPENID } = cloud.getWXContext();
  const user = await findUserByOpenid(OPENID);
  if (!user) fail("AUTH_REQUIRED", "当前微信尚未绑定员工账号，请重新登录。");
  if (user.disabled) fail("ACCOUNT_DISABLED", "账号已经停用，请联系老板。");
  if (user.reauthRequired && !options.allowReauth) {
    fail("REAUTH_REQUIRED", "权限发生重要变化，请重新输入账号和密码。");
  }
  if (user.mustChangePassword && !options.allowPasswordChange) {
    fail("PASSWORD_CHANGE_REQUIRED", "首次登录或密码重置后必须先修改密码。");
  }
  return attachAuthorization(user);
}

function assertRole(user, roles) {
  if (!roles.includes(user.role)) fail("FORBIDDEN", "当前账号没有这项操作权限。");
}

async function attachAuthorization(user) {
  if (!user) return user;
  if (user._authorization) return user;
  const id = userBusinessId(user);
  const roleId = user.role === "boss"
    ? permissionRoleIdForPosition("boss")
    : user.permissionRoleId || permissionRoleIdForPosition(user.role);
  const [roleDocument, userPermissionDocument, permissionAdminDocument] = await Promise.all([
    getDoc("permission_roles", roleId),
    getDoc("user_permissions", id),
    getDoc("permission_admins", id)
  ]);
  const authorization = resolveEffectivePermissions(
    user,
    roleDocument,
    userPermissionDocument,
    permissionAdminDocument
  );
  const regionNames = new Set(Object.values(authorization.grants || {})
    .flatMap((grant) => grant.scope?.regions || []));
  if (regionNames.size) {
    const managers = await fetchAll("users", { role: "manager", disabled: false }, { max: 3000 });
    for (const grant of Object.values(authorization.grants || {})) {
      const regions = grant.scope?.regions || [];
      if (!regions.length) continue;
      const matchingTeams = managers
        .filter((manager) => regions.some((region) => {
          const targetRegion = String(manager.province || manager.department || "");
          return targetRegion === region || targetRegion.startsWith(`${region}/`);
        }))
        .map(userBusinessId);
      grant.scope.teamIds = [...new Set([...(grant.scope.teamIds || []), ...matchingTeams])];
    }
  }
  return {
    ...user,
    permissionRoleId: roleId,
    _authorization: authorization,
    _permissionAdmin: permissionAdminDocument || null
  };
}

function hasPermission(user, permission, item = null) {
  const grant = user?._authorization?.grants?.[permission];
  return Boolean(grant?.allowed && scopeAllows(user, grant.scope, item));
}

function assertPermission(user, permission, item = null) {
  const grant = user?._authorization?.grants?.[permission];
  if (!grant?.allowed && user?._authorization?.expiredCodes?.includes(permission)) {
    fail("GRANT_EXPIRED", "这项临时权限已经到期，请联系权限管理员。");
  }
  if (!grant?.allowed) fail("PERMISSION_DENIED", "当前账号没有这项功能权限。");
  if (!scopeAllows(user, grant.scope, item)) fail("SCOPE_DENIED", "该数据不在当前账号的授权范围内。");
  return grant;
}

function assertAnyPermission(user, permissions, item = null) {
  const matched = permissions.find((permission) => hasPermission(user, permission, item));
  if (!matched) fail("PERMISSION_DENIED", "当前账号没有这项功能权限。");
  return matched;
}

function scopeWhere(user) {
  const id = userBusinessId(user);
  if (user.role === "manager") return { managerId: id };
  if (user.role === "supervisor") return { supervisorId: id };
  if (user.role === "rep") return { repId: id };
  return null;
}

function canSeeScoped(user, item, permission = "") {
  if (permission && user?._authorization) return hasPermission(user, permission, item);
  const id = userBusinessId(user);
  if (user.role === "boss") return true;
  if (user.role === "manager") return item.managerId === id;
  if (user.role === "supervisor") return item.supervisorId === id;
  if (user.role === "rep") return item.repId === id;
  return false;
}

async function fetchPermitted(collectionName, user, permission, extraWhere = {}, options = {}) {
  assertPermission(user, permission);
  const rows = await fetchAll(collectionName, extraWhere, options);
  return rows.filter((item) => hasPermission(user, permission, item));
}

async function ensureBuiltinPermissionRoles() {
  for (const role of builtinRoles()) {
    const existing = await getDoc("permission_roles", role._id);
    if (!existing) {
      const grantList = Object.entries(role.grants || {}).map(([permission, scope]) => ({ permission, scope }));
      const record = { ...role };
      delete record.grants;
      await setDoc("permission_roles", role._id, {
        ...record,
        grantList,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        version: 1
      });
    }
  }
}

async function bumpPermissionVersion(userId, options = {}) {
  const user = await findUserByBusinessId(userId);
  if (!user) fail("USER_NOT_FOUND", "人员不存在。");
  const nextVersion = Number(user.permissionVersion || 0) + 1;
  await updateDoc("users", user._id, {
    permissionVersion: nextVersion,
    ...(options.forceReauth ? { reauthRequired: true } : {}),
    permissionsUpdatedAt: nowIso()
  });
  return nextVersion;
}

async function activeApprovalDelegation(user, item, businessType, stage) {
  const id = userBusinessId(user);
  const today = nowIso().slice(0, 10);
  const rows = await fetchAll("approval_delegations", {
    delegateUserId: id,
    managerId: item.managerId,
    businessType,
    stage,
    status: "启用"
  }, { max: 20 });
  return rows.find((entry) => {
    const startOk = !entry.startDate || entry.startDate <= today;
    const endOk = !entry.expiresAt || entry.expiresAt.slice(0, 10) >= today;
    return startOk && endOk;
  }) || null;
}

async function assertApprovalAuthority(user, item, businessType, stage) {
  const id = userBusinessId(user);
  const permission = `${businessType}.approve.${stage}`;
  const ownerId = stage === "supervisor" ? item.supervisorId : item.managerId;
  if (ownerId === id) {
    assertPermission(user, permission, item);
    return { delegated: false, stage, permission };
  }
  const delegation = await activeApprovalDelegation(user, item, businessType, stage);
  if (!delegation) fail("WRONG_APPROVAL_LEVEL", "当前不是该审批阶段的负责人或有效代理人。");
  return { delegated: true, stage, permission, delegation };
}

async function writeAudit(user, action, target, detail) {
  const id = `log_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
  await setDoc("audit_logs", id, {
    actorId: user ? userBusinessId(user) : "system",
    actorName: user ? user.name : "系统",
    actorRole: user ? user.role : "system",
    action,
    target: String(target || ""),
    detail: String(detail || "").slice(0, 1000),
    createdAt: nowIso()
  });
}

async function withIdempotency(user, key, action, operation) {
  if (!/^[A-Za-z0-9._-]{8,100}$/.test(String(key || ""))) {
    fail("INVALID_IDEMPOTENCY_KEY", "请求编号不正确，请退出页面后重试。");
  }
  const digest = crypto.createHash("sha256").update(`${userBusinessId(user)}|${action}|${key}`).digest("hex");
  const existing = await getDoc("idempotency", digest);
  if (existing?.status === "done") return existing.result;
  if (existing?.status === "processing" && Date.now() - Number(existing.startedAtMs || 0) < 60000) {
    fail("REQUEST_PROCESSING", "相同操作正在处理中，请勿重复点击。");
  }
  await setDoc("idempotency", digest, {
    userId: userBusinessId(user),
    action,
    status: "processing",
    startedAtMs: Date.now(),
    createdAt: nowIso()
  });
  try {
    const result = await operation();
    await updateDoc("idempotency", digest, { status: "done", result, finishedAt: nowIso() });
    return result;
  } catch (error) {
    await updateDoc("idempotency", digest, { status: "failed", errorCode: error.code || "ERROR", finishedAt: nowIso() });
    throw error;
  }
}

module.exports = {
  cloud,
  db,
  command,
  collections,
  fetchAll,
  getDoc,
  setDoc,
  updateDoc,
  findUserByBusinessId,
  findUserByOpenid,
  requireUser,
  assertRole,
  attachAuthorization,
  hasPermission,
  assertPermission,
  assertAnyPermission,
  scopeWhere,
  canSeeScoped,
  fetchPermitted,
  ensureBuiltinPermissionRoles,
  bumpPermissionVersion,
  activeApprovalDelegation,
  assertApprovalAuthority,
  HIGH_RISK_PERMISSIONS,
  writeAudit,
  withIdempotency,
  safeUser,
  userBusinessId,
  fail
};
