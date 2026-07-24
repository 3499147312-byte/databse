const fs = require("fs");
const path = require("path");

const privateSeedPath = path.join(__dirname, "..", "seed", "accounts.private.json");
const legacySeedPath = path.join(__dirname, "..", "seed", "accounts.json");
const accountSeedPath = fs.existsSync(privateSeedPath)
  ? privateSeedPath
  : fs.existsSync(legacySeedPath)
    ? legacySeedPath
    : "";
const accounts = accountSeedPath ? JSON.parse(fs.readFileSync(accountSeedPath, "utf8")) : [];
const config = require("../config");
const {
  cloud,
  db,
  collections,
  getDoc,
  setDoc,
  updateDoc,
  findUserByOpenid,
  requireUser,
  writeAudit,
  safeUser,
  fail
} = require("../lib/context");
const {
  nowIso,
  provinceFromDepartment,
  verifyPassword,
  validPassword,
  newPasswordRecord
} = require("../lib/core");

async function ensureCollections() {
  for (const name of collections) {
    try {
      await db.createCollection(name);
    } catch (error) {
      const message = String(error.errMsg || error.message || "");
      if (!message.includes("exist") && !message.includes("已存在") && error.errCode !== -502005) throw error;
    }
  }
}

async function bootstrap(payload, seedAccounts = accounts) {
  if (!config.setupCode || config.setupCode.includes("请改成") || config.setupCode.includes("CHANGE_ME")) {
    fail("SETUP_CODE_NOT_CHANGED", "请先修改云函数 api/config.js 中的一次性初始化码，再重新部署云函数。");
  }
  if (payload.setupCode !== config.setupCode) fail("INVALID_SETUP_CODE", "一次性初始化码不正确。");
  if (!seedAccounts.length) {
    fail("ACCOUNT_SEED_MISSING", "缺少私有初始账号文件，不能执行全新环境初始化。");
  }
  await ensureCollections();
  const initialized = await getDoc("settings", "bootstrap");
  const count = await db.collection("users").count();
  if (initialized?.completed || count.total > 0) fail("ALREADY_INITIALIZED", "系统已经初始化，不能重复执行。");

  let usersCreated = 0;
  for (const account of seedAccounts) {
    const personId = account.personId || "";
    await setDoc("users", account.id, {
      personId,
      username: account.username,
      usernameLower: String(account.username).toLowerCase(),
      name: account.name,
      role: account.role,
      department: account.department || "",
      province: account.province || provinceFromDepartment(account.department),
      workNo: account.workNo || "",
      userId: account.userId || "",
      managerId: account.managerId || "",
      supervisorId: account.supervisorId || "",
      passwordHash: account.passwordHash,
      passwordSalt: account.passwordSalt,
      passwordIterations: account.passwordIterations || config.passwordIterations,
      mustChangePassword: true,
      failedAttempts: 0,
      lockedUntil: 0,
      disabled: false,
      openid: "",
      createdAt: nowIso(),
      source: "初始账号清单"
    });
    usersCreated += 1;
  }

  const products = [
    { id: "hq240", name: "黄芪片", spec: "240片", ratio: 1 },
    { id: "hq120", name: "黄芪片", spec: "120片", ratio: 0.5 },
    { id: "hq40", name: "黄芪片", spec: "40片", ratio: 1 / 6 }
  ];
  for (const product of products) {
    await setDoc("products", product.id, { ...product, status: "启用", createdAt: nowIso(), source: "系统初始化" });
  }

  await setDoc("settings", "bootstrap", {
    completed: true,
    completedAt: nowIso(),
    accountCount: usersCreated,
    version: "1.1.0"
  });
  await writeAudit(null, "系统初始化", "bootstrap", `创建${usersCreated}个账号和${products.length}个产品规格`);
  return { usersCreated, productsCreated: products.length };
}

async function login(payload) {
  const username = String(payload.username || "").trim();
  const password = String(payload.password || "");
  if (!username || !password || username.length > 64 || password.length > 128) {
    fail("INVALID_CREDENTIALS", "账号或密码不正确。");
  }
  const result = await db.collection("users").where({ usernameLower: username.toLowerCase() }).limit(1).get();
  const user = result.data[0];
  if (!user || user.disabled) fail("INVALID_CREDENTIALS", "账号或密码不正确。");
  if (Number(user.lockedUntil || 0) > Date.now()) fail("ACCOUNT_LOCKED", "账号已临时锁定，请15分钟后再试。");

  if (!verifyPassword(user, password)) {
    const attempts = Number(user.failedAttempts || 0) + 1;
    const locked = attempts >= 5;
    await updateDoc("users", user._id, {
      failedAttempts: locked ? 0 : attempts,
      lockedUntil: locked ? Date.now() + 15 * 60 * 1000 : 0
    });
    fail("INVALID_CREDENTIALS", "账号或密码不正确。");
  }

  const { OPENID } = cloud.getWXContext();
  const bound = await findUserByOpenid(OPENID);
  if (bound && bound._id !== user._id) fail("WECHAT_ALREADY_BOUND", "这个微信已经绑定其他员工账号，请联系老板处理。");
  if (user.openid && user.openid !== OPENID) fail("ACCOUNT_ALREADY_BOUND", "该员工账号已绑定其他微信，请联系老板处理。");
  await updateDoc("users", user._id, {
    openid: OPENID,
    failedAttempts: 0,
    lockedUntil: 0,
    lastLoginAt: nowIso()
  });
  const updated = { ...user, openid: OPENID, failedAttempts: 0, lockedUntil: 0 };
  await writeAudit(updated, "账号登录", user._id, "微信小程序登录成功");
  return { user: safeUser(updated) };
}

async function me() {
  const user = await requireUser({ allowPasswordChange: true });
  return { user: safeUser(user) };
}

async function changePassword(payload) {
  const user = await requireUser({ allowPasswordChange: true });
  if (!verifyPassword(user, payload.oldPassword)) fail("WRONG_PASSWORD", "当前密码不正确。");
  if (payload.newPassword !== payload.confirmPassword) fail("PASSWORD_MISMATCH", "两次输入的新密码不一致。");
  if (!validPassword(payload.newPassword, user)) {
    fail("WEAK_PASSWORD", "新密码至少10位，并包含大小写字母、数字和特殊符号，且不能包含账号或姓名。");
  }
  if (verifyPassword(user, payload.newPassword)) fail("SAME_PASSWORD", "新密码不能和当前密码相同。");
  await updateDoc("users", user._id, {
    ...newPasswordRecord(payload.newPassword, config.passwordIterations),
    mustChangePassword: false,
    passwordChangedAt: nowIso(),
    failedAttempts: 0,
    lockedUntil: 0
  });
  const updated = { ...user, mustChangePassword: false };
  await writeAudit(user, "修改密码", user._id, "账号密码已更新");
  return { user: safeUser(updated) };
}

module.exports = { bootstrap, login, me, changePassword };
