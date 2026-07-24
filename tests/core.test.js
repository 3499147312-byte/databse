const assert = require("assert");
const {
  calc4,
  calcSale,
  monthEndPlusDays,
  receivableStatus,
  validPassword,
  newPasswordRecord,
  verifyPassword,
  warehouseManagerIdForUser
} = require("../cloudfunctions/api/lib/core");

assert.strictEqual(calc4(1.23456), 1.2346, "内部金额必须四舍五入保留4位");
assert.strictEqual(calc4(111.7 / 6), 18.6167, "40片规格等比换算必须保留4位");

const sale = {
  lines: [{
    qty: 3,
    ruleSnapshot: {
      salePrice: 111.7,
      repCommission: 3,
      supervisorCommission: 1.5,
      managerCommission: 0.75,
      promoBudget: 20
    }
  }]
};
assert.deepStrictEqual(calcSale(sale), {
  amount: 335.1,
  qty: 3,
  repCommission: 9,
  supervisorCommission: 4.5,
  managerCommission: 2.25,
  promoBudget: 60
});

assert.deepStrictEqual(calcSale({ ...sale, supervisorId: "" }), {
  amount: 335.1,
  qty: 3,
  repCommission: 9,
  supervisorCommission: 0,
  managerCommission: 6.75,
  promoBudget: 60
}, "经理直管代表不产生主管个人提成，原主管提成并入经理提成");

assert.strictEqual(monthEndPlusDays("2026-02", 30), "2026-03-30", "账期应从销售月月底起算");
assert.strictEqual(receivableStatus({ dueAmount: 100, dueDate: "2026-07-26" }, 0, "2026-07-23"), "三日内到期");
assert.strictEqual(receivableStatus({ dueAmount: 100, dueDate: "2026-07-22" }, 40, "2026-07-23"), "部分回款已逾期");
assert.strictEqual(receivableStatus({ dueAmount: 100, dueDate: "2026-07-22" }, 100, "2026-07-23"), "已结清");

const passwordUser = { username: "gk001", name: "张三" };
assert.strictEqual(validPassword("Strong@Pass94", passwordUser), true);
assert.strictEqual(validPassword("weakpassword", passwordUser), false);
const passwordRecord = newPasswordRecord("Strong@Pass94", 1000);
assert.strictEqual(verifyPassword(passwordRecord, "Strong@Pass94"), true);
assert.strictEqual(verifyPassword(passwordRecord, "Wrong@Pass94"), false);

assert.strictEqual(warehouseManagerIdForUser({ role: "manager", personId: "M001" }), "M001");
assert.strictEqual(warehouseManagerIdForUser({ role: "supervisor", managerId: "M001" }), "M001");
assert.strictEqual(warehouseManagerIdForUser({ role: "rep", managerId: "M001" }), "M001");
assert.strictEqual(warehouseManagerIdForUser({ role: "finance", managerId: "M001" }), "");

console.log("核心规则测试通过");
