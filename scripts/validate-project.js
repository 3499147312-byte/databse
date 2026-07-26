const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const root = path.resolve(__dirname, "..");
const miniRoot = path.join(root, "miniprogram");
const cloudRoot = path.join(root, "cloudfunctions", "api");
const errors = [];

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

const appConfig = JSON.parse(fs.readFileSync(path.join(miniRoot, "app.json"), "utf8"));
for (const page of appConfig.pages || []) {
  for (const extension of [".js", ".json", ".wxml"]) {
    const target = path.join(miniRoot, `${page}${extension}`);
    if (!fs.existsSync(target)) errors.push(`缺少页面文件: ${target}`);
  }
}

for (const file of walk(miniRoot).filter((item) => item.endsWith(".json"))) {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`页面JSON格式错误: ${file}\n${error.message}`);
  }
}

for (const file of walk(miniRoot).filter((item) => item.endsWith(".wxml"))) {
  const source = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const stack = [];
  const voidTags = new Set(["input", "image", "icon", "progress", "checkbox", "radio", "slider", "switch"]);
  for (const match of source.matchAll(/<\s*(\/?)\s*([A-Za-z][\w-]*)([^>]*)>/g)) {
    const closing = Boolean(match[1]);
    const tag = match[2];
    const selfClosing = /\/\s*>$/.test(match[0]) || voidTags.has(tag);
    if (closing) {
      const expected = stack.pop();
      if (expected !== tag) {
        errors.push(`WXML标签未正确闭合: ${file}，期望</${expected || "无"}>，实际</${tag}>`);
        break;
      }
    } else if (!selfClosing) {
      stack.push(tag);
    }
  }
  if (stack.length) errors.push(`WXML存在未闭合标签: ${file}，${stack.join(", ")}`);
}

for (const file of walk(root).filter((item) => item.endsWith(".js"))) {
  const result = childProcess.spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) errors.push(`JavaScript语法错误: ${file}\n${result.stderr}`);
}

const clientSource = walk(miniRoot)
  .filter((item) => item.endsWith(".js"))
  .map((item) => fs.readFileSync(item, "utf8"))
  .join("\n");
if (/wx\.cloud\.database\s*\(/.test(clientSource)) errors.push("小程序端禁止直接访问数据库，必须统一经过云函数。");

const routerSource = fs.readFileSync(path.join(cloudRoot, "index.js"), "utf8");
const requiredActions = [
  "bootstrap", "login", "me", "changePassword", "getDashboard", "getApprovals",
  "getSalesPage", "submitSale", "submitZeroDaily", "approveSale", "rejectSale", "correctSale", "getInventoryPage",
  "receiveInventory", "getExpensesPage", "submitExpense", "approveExpense", "rejectExpense",
  "markExpensePaid", "markExpenseInvoiced", "getReceivables", "recordWarehousePayment",
  "verifyWarehousePayment", "voidWarehousePayment", "updateWarehouseTerm", "getReports", "getBossPerformance",
  "submitWeekly", "approvePolicy", "rejectPolicy", "getAdminPage", "saveUser", "toggleUser",
  "resetUserPassword", "unbindUserWechat", "deleteUser", "adminImportRows",
  "getPermissionCenter", "savePermissionRole", "savePermissionAdmin", "saveUserPermissions",
  "reviewPermissionRequest", "saveApprovalDelegation", "migratePermissions"
];
for (const action of requiredActions) {
  if (!new RegExp(`\\b${action}:`).test(routerSource)) errors.push(`云函数总入口缺少操作: ${action}`);
}

const privateSeedPath = path.join(cloudRoot, "seed", "accounts.private.json");
const legacySeedPath = path.join(cloudRoot, "seed", "accounts.json");
const accountSeedPath = fs.existsSync(privateSeedPath)
  ? privateSeedPath
  : fs.existsSync(legacySeedPath)
    ? legacySeedPath
    : "";
const accounts = accountSeedPath ? JSON.parse(fs.readFileSync(accountSeedPath, "utf8")) : [];
if (!accountSeedPath) console.warn("未找到私有账号种子文件；跳过70人账号种子校验。");

if (accountSeedPath) {
const allowedRoles = new Set(["boss", "hq_auditor", "finance", "manager", "supervisor", "rep"]);
const expectedRoleCounts = { boss: 1, hq_auditor: 2, finance: 2, manager: 13, supervisor: 14, rep: 38 };
const peopleById = new Map(accounts.map((item) => [item.personId, item]));
const usernames = new Set();
const personIds = new Set();
const roleCounts = {};

if (accounts.length !== 70) errors.push(`初始账号应为70人，当前为${accounts.length}人。`);
for (const account of accounts) {
  roleCounts[account.role] = (roleCounts[account.role] || 0) + 1;
  if (!allowedRoles.has(account.role)) errors.push(`初始账号${account.username}的角色不受支持。`);
  if (!account.personId || !account.username || !account.name) errors.push(`初始账号${account.username || "未知"}缺少人员编号、账号或姓名。`);
  const usernameKey = String(account.username || "").toLowerCase();
  if (usernames.has(usernameKey)) errors.push(`初始账号存在重复登录账号: ${account.username}`);
  if (personIds.has(account.personId)) errors.push(`初始账号存在重复人员编号: ${account.personId}`);
  usernames.add(usernameKey);
  personIds.add(account.personId);
  if ("password" in account || "temporaryPassword" in account || "tempPassword" in account) {
    errors.push(`初始账号${account.username}含有明文密码字段。`);
  }
  if (!account.passwordHash || !account.passwordSalt || Number(account.passwordIterations) < 200000) {
    errors.push(`初始账号${account.username}的密码保护参数不合格。`);
  }
  if (account.mustChangePassword !== true) errors.push(`初始账号${account.username}未设置首次登录强制改密。`);
}

for (const [role, count] of Object.entries(expectedRoleCounts)) {
  if ((roleCounts[role] || 0) !== count) errors.push(`角色${role}应为${count}人，当前为${roleCounts[role] || 0}人。`);
}

const bosses = accounts.filter((item) => item.role === "boss");
if (bosses.length !== 1 || bosses[0]?.name !== "吴政锐") errors.push("初始账号必须且只能有一名老板：吴政锐。");

for (const account of accounts) {
  if (account.role === "supervisor") {
    const manager = peopleById.get(account.managerId);
    if (!manager || manager.role !== "manager") errors.push(`主管${account.name}未绑定有效经理。`);
  }
  if (account.role === "rep") {
    const manager = peopleById.get(account.managerId);
    const supervisor = account.supervisorId ? peopleById.get(account.supervisorId) : null;
    if (!manager || manager.role !== "manager") errors.push(`代表${account.name}未绑定有效经理。`);
    if (account.supervisorId && (!supervisor || supervisor.role !== "supervisor")) errors.push(`代表${account.name}填写了无效主管。`);
    if (supervisor && supervisor.managerId !== account.managerId) errors.push(`代表${account.name}的主管与经理不属于同一条管理线。`);
  }
}
}

const projectConfig = JSON.parse(fs.readFileSync(path.join(root, "project.config.json"), "utf8"));
if (projectConfig.miniprogramRoot !== "miniprogram/" || projectConfig.cloudfunctionRoot !== "cloudfunctions/") {
  errors.push("项目目录配置不正确。");
}

if (errors.length) {
  console.error(errors.join("\n\n"));
  process.exit(1);
}
console.log(`项目结构与安全静态检查通过：${appConfig.pages.length}个页面，${accounts.length}个初始账号`);
