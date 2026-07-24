const assert = require("assert");
const crypto = require("crypto");
const fixture = require("./fixtures/business-fixture");
const { createHarness } = require("./helpers/handler-harness");
const { localDate, monthKey } = require("../cloudfunctions/api/lib/core");

function lotId(warehouseId, productId, batchNo) {
  return `lot_${crypto.createHash("sha256").update(`${warehouseId}|${productId}|${batchNo}`).digest("hex").slice(0, 40)}`;
}

function seed() {
  const copy = JSON.parse(JSON.stringify(fixture));
  copy.users.push({ _id: "acct_audit", personId: "A001", name: "测试审核", role: "hq_auditor", disabled: false });
  copy.policies[0].start = "2020-01-01";
  copy.policies[0].end = "2099-12-31";
  copy.sales = [];
  copy.expenses = [];
  copy.daily_reports = [];
  copy.weekly_reports = [];
  copy.receivables = [];
  copy.warehouse_payments = [];
  copy.inventory_moves = [];
  copy.corrections = [];
  copy.audit_logs = [];
  copy.inventory_lots = [{
    _id: lotId("W001", "P240", "BATCH-FLOW"),
    warehouseId: "W001",
    managerId: "M001",
    productId: "P240",
    batchNo: "BATCH-FLOW",
    expiryDate: "2099-12-31",
    qty: 50,
    unitPrice: 60
  }];
  return copy;
}

(async () => {
  const rep = fixture.users.find((item) => item.personId === "R001");
  const supervisor = fixture.users.find((item) => item.personId === "S001");
  const manager = fixture.users.find((item) => item.personId === "M001");
  const finance = fixture.users.find((item) => item.role === "finance");

  // FLOW-SALES-01：代表填报→主管审核→经理终审→扣库存→计业绩→生成应收。
  const harness = createHarness(seed(), rep);
  const sales = harness.loadHandler("sales");
  const dashboard = harness.loadHandler("dashboard");
  const expenses = harness.loadHandler("expenses");
  const receivables = harness.loadHandler("receivables");
  const reports = harness.loadHandler("reports");

  const submitted = await sales.submitSale({
    idempotencyKey: "flow-sale-001",
    storeId: "ST001",
    lines: [{ productId: "P240", qty: 2, batchNo: "BATCH-FLOW" }]
  });
  assert.strictEqual(submitted.status, "待主管审核");
  assert.strictEqual(harness.rows("daily_reports")[0].submitted, true);

  harness.setUser(supervisor);
  const supervisorQueue = await dashboard.getApprovals();
  assert.deepStrictEqual(supervisorQueue.sales.map((item) => item.id), [submitted.id]);
  assert.strictEqual((await sales.approveSale({ id: submitted.id })).status, "待经理审核");
  assert.strictEqual(harness.get("inventory_lots", lotId("W001", "P240", "BATCH-FLOW")).qty, 50);

  harness.setUser(manager);
  const managerQueue = await dashboard.getApprovals();
  assert.deepStrictEqual(managerQueue.sales.map((item) => item.id), [submitted.id]);
  assert.strictEqual((await sales.approveSale({ id: submitted.id })).status, "已通过");
  assert.strictEqual(harness.get("inventory_lots", lotId("W001", "P240", "BATCH-FLOW")).qty, 48);
  assert.strictEqual(harness.rows("receivables").length, 1);
  assert.strictEqual(harness.rows("receivables")[0].dueAmount, 200);

  const managerHome = await dashboard.getDashboard();
  assert.strictEqual(managerHome.metrics.todaySales, 200);
  assert.strictEqual(managerHome.metrics.missingDaily, 0);
  const managerReport = await reports.getReports();
  assert(managerReport.commissions.some((item) => item.ownerId === "M001" && item.salesAmount === 200));

  // FLOW-EXPENSE-01：代表按销售额度申请→主管→经理→财务付款及收票。
  harness.setUser(rep);
  const expense = await expenses.submitExpense({
    idempotencyKey: "flow-expense-001",
    customerId: "C001",
    type: "小礼品",
    amount: 20,
    note: "客户活动测试"
  });
  assert.strictEqual(harness.get("expenses", expense.id).status, "待主管审核");
  assert.strictEqual(harness.get("expenses", expense.id).invoiceStatus, "待收票");

  harness.setUser(supervisor);
  assert.strictEqual((await expenses.approveExpense({ id: expense.id })).status, "待经理审核");
  harness.setUser(manager);
  assert.strictEqual((await expenses.approveExpense({ id: expense.id })).status, "已通过");
  assert.strictEqual(harness.get("expenses", expense.id).paymentStatus, "待付款");

  harness.setUser(finance);
  const financePage = await expenses.getExpensesPage();
  const financeItem = financePage.expenses.find((item) => item.id === expense.id);
  assert.strictEqual(financeItem.canMarkPaid, true);
  assert.strictEqual(financeItem.canMarkInvoiced, true);
  await expenses.markExpensePaid({ id: expense.id });
  await expenses.markExpenseInvoiced({ id: expense.id });
  assert.strictEqual(harness.get("expenses", expense.id).paymentStatus, "已付款");
  assert.strictEqual(harness.get("expenses", expense.id).invoiceStatus, "已收票");

  // FLOW-PAYMENT-01：经理登记回款→财务确认→首页和应收计划同步。
  const plan = harness.rows("receivables")[0];
  harness.setUser(manager);
  const payment = await receivables.recordWarehousePayment({
    idempotencyKey: "flow-payment-001",
    receivableId: plan._id,
    paymentDate: localDate(),
    amount: 100,
    reference: "FLOW-REF-001",
    note: "流程测试到账"
  });
  assert.strictEqual(payment.status, "待财务确认");
  assert.strictEqual(harness.get("receivables", plan._id).paidAmount, 100);

  harness.setUser(finance);
  assert.strictEqual((await receivables.verifyWarehousePayment({ paymentId: payment.id })).status, "财务已确认");
  const paymentMonthPage = await receivables.getReceivables({ month: monthKey() });
  assert.strictEqual(paymentMonthPage.summary.receivedThisMonth, 100);
  const dueMonthPage = await receivables.getReceivables({ month: plan.dueDate.slice(0, 7) });
  assert.strictEqual(dueMonthPage.summary.outstanding, 100);

  // FLOW-ZERO-01：无销售代表提交零销售→日报完成→不产生销售、库存或应收。
  {
    const zeroHarness = createHarness(seed(), rep);
    const zeroSales = zeroHarness.loadHandler("sales");
    const zeroDashboard = zeroHarness.loadHandler("dashboard");
    const beforeQty = zeroHarness.rows("inventory_lots")[0].qty;
    assert.strictEqual((await zeroSales.submitZeroDaily()).status, "已提交");
    zeroHarness.setUser(supervisor);
    const home = await zeroDashboard.getDashboard();
    assert.strictEqual(home.metrics.missingDaily, 0);
    assert.strictEqual(zeroHarness.rows("sales").length, 0);
    assert.strictEqual(zeroHarness.rows("receivables").length, 0);
    assert.strictEqual(zeroHarness.rows("inventory_lots")[0].qty, beforeQty);
  }

  console.log("销售、费用、回款和零销售端到端流程测试通过");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
