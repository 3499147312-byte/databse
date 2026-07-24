const crypto = require("crypto");

const MAX_QTY = 1000000;
const MAX_MONEY = 1000000000;

function nowIso() {
  return new Date().toISOString();
}

function localDate(offsetMinutes = 480) {
  const date = new Date(Date.now() + offsetMinutes * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function monthKey(value = localDate()) {
  return String(value).slice(0, 7);
}

function validDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function monthEndPlusDays(settlementMonth, creditDays) {
  const [year, month] = String(settlementMonth).split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) throw new Error("销售月份格式不正确");
  const date = new Date(Date.UTC(year, month, 0));
  date.setUTCDate(date.getUTCDate() + Number(creditDays || 0));
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00Z`);
  const to = new Date(`${toDate}T00:00:00Z`);
  return Math.round((to - from) / 86400000);
}

function calc4(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 10000) / 10000;
}

function positiveNumber(value, max = MAX_MONEY, integer = false) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= max && (!integer || Number.isInteger(number));
}

function nonNegativeNumber(value, max = MAX_MONEY) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max;
}

function validCode(value) {
  return /^[A-Za-z0-9._-]{2,64}$/.test(String(value || ""));
}

function validBatchNo(value) {
  return /^[A-Za-z0-9._/-]{1,50}$/.test(String(value || ""));
}

function roleLabel(role) {
  return {
    boss: "老板",
    hq_auditor: "总部审核人员",
    finance: "总部财务人员",
    manager: "省区/区域经理",
    supervisor: "地区主管",
    rep: "业务代表"
  }[role] || role || "";
}

function roleFromLabel(value) {
  return {
    "总部审核人员": "hq_auditor",
    "总部财务人员": "finance",
    "省区/区域经理": "manager",
    "地区主管": "supervisor",
    "业务代表": "rep",
    hq_auditor: "hq_auditor",
    finance: "finance",
    manager: "manager",
    supervisor: "supervisor",
    rep: "rep"
  }[value];
}

function userBusinessId(user) {
  return user.personId || user._id;
}

function warehouseManagerIdForUser(user) {
  if (user.role === "manager") return userBusinessId(user);
  if (["supervisor", "rep"].includes(user.role)) return user.managerId || "";
  return "";
}

function safeUser(user) {
  return {
    id: userBusinessId(user),
    accountId: user._id,
    username: user.username,
    name: user.name,
    role: user.role,
    province: user.province || "",
    department: user.department || "",
    managerId: user.managerId || "",
    supervisorId: user.supervisorId || "",
    status: user.disabled ? "停用" : "启用",
    mustChangePassword: Boolean(user.mustChangePassword)
  };
}

function derivePassword(password, salt, iterations) {
  return crypto.pbkdf2Sync(String(password), Buffer.from(salt, "hex"), Number(iterations), 32, "sha256").toString("hex");
}

function verifyPassword(user, password) {
  if (!user.passwordHash || !user.passwordSalt) return false;
  const actual = derivePassword(password, user.passwordSalt, user.passwordIterations);
  const expectedBuffer = Buffer.from(user.passwordHash, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function validPassword(password, user) {
  const value = String(password || "");
  return value.length >= 10
    && value.length <= 128
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /\d/.test(value)
    && /[^A-Za-z0-9]/.test(value)
    && !value.toLowerCase().includes(String(user.username || "").toLowerCase())
    && !value.includes(String(user.name || ""));
}

function newPasswordRecord(password, iterations) {
  const passwordSalt = crypto.randomBytes(16).toString("hex");
  return {
    passwordSalt,
    passwordIterations: iterations,
    passwordHash: derivePassword(password, passwordSalt, iterations)
  };
}

function temporaryPassword(length = 14) {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%&*"];
  const pick = (chars) => chars[crypto.randomInt(0, chars.length)];
  const chars = groups.map(pick);
  const all = groups.join("");
  while (chars.length < length) chars.push(pick(all));
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = crypto.randomInt(0, index + 1);
    [chars[index], chars[swap]] = [chars[swap], chars[index]];
  }
  return chars.join("");
}

function provinceFromDepartment(department = "") {
  const match = String(department).match(/([^\s/]+省|北京市|上海市|天津市|重庆市)/);
  return match ? match[1] : "";
}

function calcSale(sale) {
  const total = (sale.lines || []).reduce((result, line) => {
    const rule = line.ruleSnapshot || {};
    result.amount = calc4(result.amount + Number(rule.salePrice || 0) * Number(line.qty || 0));
    result.qty += Number(line.qty || 0);
    result.repCommission = calc4(result.repCommission + Number(rule.repCommission || 0) * Number(line.qty || 0));
    result.supervisorCommission = calc4(result.supervisorCommission + Number(rule.supervisorCommission || 0) * Number(line.qty || 0));
    result.managerCommission = calc4(result.managerCommission + Number(rule.managerCommission || 0) * Number(line.qty || 0));
    result.promoBudget = calc4(result.promoBudget + Number(rule.promoBudget || 0) * Number(line.qty || 0));
    return result;
  }, { amount: 0, qty: 0, repCommission: 0, supervisorCommission: 0, managerCommission: 0, promoBudget: 0 });
  if (sale.supervisorId === "") {
    total.managerCommission = calc4(total.managerCommission + total.supervisorCommission);
    total.supervisorCommission = 0;
  }
  return total;
}

function receivableStatus(receivable, paidAmount, today = localDate()) {
  const due = calc4(receivable.dueAmount);
  const paid = calc4(paidAmount);
  if (paid > due) return "回款超额";
  if (due > 0 && paid >= due) return "已结清";
  const days = daysBetween(today, receivable.dueDate);
  if (days < 0) return paid > 0 ? "部分回款已逾期" : "已逾期";
  if (days === 0) return paid > 0 ? "部分回款今日到期" : "今日到期";
  if (days <= 3) return paid > 0 ? "部分回款即将到期" : "三日内到期";
  return paid > 0 ? "部分回款" : "未到期";
}

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

module.exports = {
  MAX_QTY,
  MAX_MONEY,
  nowIso,
  localDate,
  monthKey,
  validDate,
  monthEndPlusDays,
  daysBetween,
  calc4,
  positiveNumber,
  nonNegativeNumber,
  validCode,
  validBatchNo,
  roleLabel,
  roleFromLabel,
  userBusinessId,
  warehouseManagerIdForUser,
  safeUser,
  verifyPassword,
  validPassword,
  newPasswordRecord,
  temporaryPassword,
  provinceFromDepartment,
  calcSale,
  receivableStatus,
  fail
};
