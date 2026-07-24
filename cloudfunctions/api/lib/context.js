const crypto = require("crypto");
const cloud = require("wx-server-sdk");
const { nowIso, safeUser, userBusinessId, fail } = require("./core");

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
  "settings"
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
  if (user.mustChangePassword && !options.allowPasswordChange) {
    fail("PASSWORD_CHANGE_REQUIRED", "首次登录或密码重置后必须先修改密码。");
  }
  return user;
}

function assertRole(user, roles) {
  if (!roles.includes(user.role)) fail("FORBIDDEN", "当前账号没有这项操作权限。");
}

function scopeWhere(user) {
  const id = userBusinessId(user);
  if (user.role === "manager") return { managerId: id };
  if (user.role === "supervisor") return { supervisorId: id };
  if (user.role === "rep") return { repId: id };
  return null;
}

function canSeeScoped(user, item) {
  const id = userBusinessId(user);
  if (user.role === "boss") return true;
  if (user.role === "manager") return item.managerId === id;
  if (user.role === "supervisor") return item.supervisorId === id;
  if (user.role === "rep") return item.repId === id;
  return false;
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
  scopeWhere,
  canSeeScoped,
  writeAudit,
  withIdempotency,
  safeUser,
  userBusinessId,
  fail
};
