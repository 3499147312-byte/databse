const assert = require("assert");
const {
  calc4,
  calcSale,
  daysBetween,
  monthKey,
  validDate,
  positiveNumber,
  nonNegativeNumber,
  validCode,
  validBatchNo,
  userBusinessId,
  safeUser,
  validPassword,
  temporaryPassword,
  receivableStatus
} = require("../cloudfunctions/api/lib/core");

assert.strictEqual(validDate("2028-02-29"), true, "闰年日期应有效");
assert.strictEqual(validDate("2027-02-29"), false, "非闰年2月29日应无效");
assert.strictEqual(validDate("2026-13-01"), false, "无效月份应被拒绝");
assert.strictEqual(monthKey("2026-07-24"), "2026-07");
assert.strictEqual(daysBetween("2026-07-24", "2026-07-27"), 3);

assert.strictEqual(positiveNumber(1), true);
assert.strictEqual(positiveNumber(1.5, 10, true), false, "整数数量不能使用小数");
assert.strictEqual(positiveNumber(0), false);
assert.strictEqual(nonNegativeNumber(0), true);
assert.strictEqual(nonNegativeNumber(-0.01), false);
assert.strictEqual(validCode("GKCY-001_2"), true);
assert.strictEqual(validCode("含中文"), false);
assert.strictEqual(validBatchNo("2026/07-A.1"), true);
assert.strictEqual(validBatchNo("批号一"), false);

const multiLineSale = {
  supervisorId: "S001",
  lines: [
    { qty: 3, ruleSnapshot: { salePrice: 100, repCommission: 2.5, supervisorCommission: 1.2, managerCommission: 0.8, promoBudget: 18 } },
    { qty: 2, ruleSnapshot: { salePrice: 55.85, repCommission: 1.5, supervisorCommission: 0.75, managerCommission: 0.375, promoBudget: 10 } }
  ]
};
assert.deepStrictEqual(calcSale(multiLineSale), {
  amount: 411.7,
  qty: 5,
  repCommission: 10.5,
  supervisorCommission: 5.1,
  managerCommission: 3.15,
  promoBudget: 74
});
assert.deepStrictEqual(calcSale({ ...multiLineSale, supervisorId: "" }), {
  amount: 411.7,
  qty: 5,
  repCommission: 10.5,
  supervisorCommission: 0,
  managerCommission: 8.25,
  promoBudget: 74
}, "经理直管代表时主管提成应并入经理提成");
assert.strictEqual(calc4(0.1 + 0.2), 0.3);

assert.strictEqual(userBusinessId({ _id: "acct_1", personId: "R001" }), "R001");
assert.strictEqual(userBusinessId({ _id: "acct_1" }), "acct_1");
assert.deepStrictEqual(safeUser({
  _id: "acct_1",
  personId: "R001",
  username: "tester",
  name: "测试用户",
  role: "rep",
  managerId: "M001",
  supervisorId: "S001",
  disabled: true,
  mustChangePassword: true,
  passwordHash: "不得输出"
}), {
  id: "R001",
  accountId: "acct_1",
  username: "tester",
  name: "测试用户",
  role: "rep",
  province: "",
  department: "",
  managerId: "M001",
  supervisorId: "S001",
  status: "停用",
  mustChangePassword: true
}, "安全用户对象不得包含密码字段");

assert.strictEqual(validPassword("Tester@2026A", { username: "tester", name: "某员工" }), false, "密码不能包含账号");
assert.strictEqual(validPassword("Strong@2026A", { username: "tester", name: "某员工" }), true);
for (let index = 0; index < 25; index += 1) {
  const value = temporaryPassword();
  assert.strictEqual(value.length, 14);
  assert(/[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9]/.test(value), "临时密码必须包含四类字符");
}

assert.strictEqual(receivableStatus({ dueAmount: 100, dueDate: "2026-07-28" }, 20, "2026-07-24"), "部分回款");
assert.strictEqual(receivableStatus({ dueAmount: 100, dueDate: "2026-07-24" }, 20, "2026-07-24"), "部分回款今日到期");
assert.strictEqual(receivableStatus({ dueAmount: 100, dueDate: "2026-07-23" }, 0, "2026-07-24"), "已逾期");
assert.strictEqual(receivableStatus({ dueAmount: 100, dueDate: "2026-07-23" }, 101, "2026-07-24"), "回款超额");

console.log("扩展核心规则测试通过");
