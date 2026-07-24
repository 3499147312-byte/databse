const assert = require("assert");
const fixture = require("./fixtures/business-fixture");
const { createHarness, expectCode } = require("./helpers/handler-harness");
const { localDate, monthKey } = require("../cloudfunctions/api/lib/core");

function seed() {
  const copy = JSON.parse(JSON.stringify(fixture));
  copy.users.push({ _id: "acct_audit", personId: "A001", name: "测试审核", role: "hq_auditor", disabled: false });
  copy.users.forEach((user) => {
    user.province = user.province || (user.managerId === "M002" || user.personId === "M002" ? "乙区" : "甲区");
  });
  copy.policies[0].start = "2020-01-01";
  copy.policies[0].end = "2099-12-31";
  copy.policies.push({
    _id: "POL_PENDING",
    customerId: "C001",
    productId: "P120",
    supervisorId: "S001",
    managerId: "M001",
    status: "待老板审核",
    start: "2026-01-01",
    end: "2099-12-31",
    invoicePrice: 55.85,
    retailPrice: 80,
    headRebate: 1,
    noInvoiceRebate: 0,
    promoSpend: 10,
    monthlyTarget: 100,
    submittedBy: "S001"
  });
  copy.sales.forEach((sale) => {
    sale.date = localDate();
    sale.settlementMonth = monthKey();
  });
  copy.expenses = [{
    _id: "EXP_PENDING",
    date: localDate(),
    repId: "R001",
    supervisorId: "S001",
    managerId: "M001",
    customerId: "C001",
    type: "小礼品",
    amount: 20,
    note: "活动用品",
    status: "待主管审核",
    paymentStatus: "未付款",
    invoiceStatus: "待收票",
    createdAt: `${localDate()}T08:00:00.000Z`
  }, {
    _id: "EXP_FINANCE",
    date: localDate(),
    repId: "R001",
    supervisorId: "S001",
    managerId: "M001",
    customerId: "C001",
    type: "推广费",
    amount: 30,
    note: "推广活动",
    status: "已通过",
    paymentStatus: "待付款",
    invoiceStatus: "待收票",
    createdAt: `${localDate()}T09:00:00.000Z`
  }];
  copy.daily_reports = [{
    _id: "DAILY_R1",
    repId: "R001",
    supervisorId: "S001",
    managerId: "M001",
    date: localDate(),
    submitted: true
  }];
  copy.weekly_reports = [];
  copy.receivables = [{
    _id: "RECV001",
    warehouseId: "W001",
    warehouseName: "甲区仓库",
    managerId: "M001",
    settlementMonth: monthKey(),
    dueDate: localDate(),
    dueAmount: 411.7,
    paidAmount: 0
  }];
  copy.warehouse_payments = [{
    _id: "PAY_PENDING",
    receivableId: "RECV001",
    warehouseId: "W001",
    managerId: "M001",
    settlementMonth: monthKey(),
    paymentDate: localDate(),
    amount: 50,
    status: "待财务确认",
    registeredBy: "M001"
  }];
  copy.inventory_lots = [{
    _id: "LOT_LOW",
    warehouseId: "W001",
    managerId: "M001",
    productId: "P240",
    batchNo: "BATCH-RISK",
    expiryDate: "2099-12-31",
    qty: 50,
    unitPrice: 60
  }];
  copy.audit_logs = [{
    _id: "LOG001",
    actorId: "M001",
    actorName: "经理甲",
    action: "测试操作",
    target: "TEST",
    detail: "匿名审计数据",
    createdAt: `${localDate()}T10:00:00.000Z`
  }];
  return copy;
}

(async () => {
  const rep = fixture.users.find((item) => item.personId === "R001");
  const supervisor = fixture.users.find((item) => item.personId === "S001");
  const manager = fixture.users.find((item) => item.personId === "M001");
  const boss = fixture.users.find((item) => item.role === "boss");
  const finance = fixture.users.find((item) => item.role === "finance");
  const auditor = seed().users.find((item) => item.role === "hq_auditor");

  // DASHBOARD-01：经理看本团队销售、日报缺失、审批和应收提醒。
  {
    const harness = createHarness(seed(), manager);
    const dashboard = harness.loadHandler("dashboard");
    const result = await dashboard.getDashboard();
    assert(result.metrics.todaySales > 0);
    assert.strictEqual(result.metrics.missingDaily, 0);
    assert(result.metrics.pending >= 1);
    assert(result.tasks.some((item) => item.key === "weekly"));
    assert(harness.rows("weekly_reports").some((item) => item.ownerId === "M001"));
  }

  // DASHBOARD-02：财务仪表盘仅显示财务闭环任务。
  {
    const harness = createHarness(seed(), finance);
    const dashboard = harness.loadHandler("dashboard");
    const result = await dashboard.getDashboard();
    assert.deepStrictEqual(result.tasks.map((item) => item.key), ["finance-expense", "finance-payment"]);
    assert.strictEqual(result.metrics.pending, 2);
    assert.strictEqual(result.metrics.todaySales, 0);
  }

  // DASHBOARD-03：总部审核只读查看政策和费用，不计入待审批。
  {
    const harness = createHarness(seed(), auditor);
    const dashboard = harness.loadHandler("dashboard");
    const result = await dashboard.getDashboard();
    assert.deepStrictEqual(result.tasks.map((item) => item.key), ["policy-view", "expense-view"]);
    assert.strictEqual(result.metrics.pending, 0);
  }

  // APPROVALS-01：主管获得自己的待审销售与费用并可操作。
  {
    const data = seed();
    data.sales[0].status = "待主管审核";
    const harness = createHarness(data, supervisor);
    const dashboard = harness.loadHandler("dashboard");
    const result = await dashboard.getApprovals();
    assert.strictEqual(result.sales.length, 1);
    assert.strictEqual(result.expenses.length, 1);
    assert(result.sales.every((item) => item.canAct));
    assert.strictEqual(result.policies.length, 0);
  }

  // APPROVALS-02：总部审核可看全部政策费用，但没有审核按钮。
  {
    const harness = createHarness(seed(), auditor);
    const dashboard = harness.loadHandler("dashboard");
    const result = await dashboard.getApprovals();
    assert.strictEqual(result.viewMode, "readOnly");
    assert.strictEqual(result.expenses.length, 2);
    assert.strictEqual(result.policies.length, 2);
    assert(result.expenses.every((item) => !item.canAct));
    assert(result.policies.every((item) => !item.canAct));
  }

  // REPORTS-01：经理报表汇总业绩、提成、风险、周任务和本人审计。
  {
    const harness = createHarness(seed(), manager);
    const reports = harness.loadHandler("reports");
    const result = await reports.getReports();
    assert(result.commissions.some((item) => item.ownerId === "M001" && item.salesAmount > 0));
    assert(result.risks.some((item) => item.type === "低库存"));
    assert(result.weekly.some((item) => item.canSubmit));
    assert.deepStrictEqual(result.audit.map((item) => item.id), ["LOG001"]);
  }

  // PERFORMANCE-01：老板可切换本月/上月并查看经理、产品和仓库排名。
  {
    const harness = createHarness(seed(), boss);
    const reports = harness.loadHandler("reports");
    const result = await reports.getBossPerformance({ month: monthKey() });
    assert.strictEqual(result.selectedMonth, monthKey());
    assert.strictEqual(result.managers[0].id, "M001");
    assert(result.managers[0].products.length > 0);
    assert(result.managers[0].warehouses.length > 0);
    assert.strictEqual(result.managers.find((item) => item.id === "M002").amount, 0);
  }

  // WEEKLY-01：任务所属经理提交一次后不可重复提交。
  {
    const harness = createHarness(seed(), manager);
    const reports = harness.loadHandler("reports");
    await reports.ensureWeeklyTasks(manager);
    const task = harness.rows("weekly_reports").find((item) => item.ownerId === "M001");
    assert(task);
    assert.strictEqual((await reports.submitWeekly({ id: task._id })).status, "已提交");
    await expectCode(reports.submitWeekly({ id: task._id }), "WEEKLY_FORBIDDEN");
  }

  // POLICY-APPROVE-01：老板通过合法政策；非法政策不得通过。
  {
    const harness = createHarness(seed(), boss);
    const reports = harness.loadHandler("reports");
    assert.strictEqual((await reports.approvePolicy({ id: "POL_PENDING" })).status, "老板已通过");
    assert.strictEqual(harness.get("policies", "POL_PENDING").approvedBy, "BOSS");
    const invalid = { ...seed().policies[1], _id: "POL_INVALID", invoicePrice: -1 };
    harness.data.policies.POL_INVALID = invalid;
    await expectCode(reports.approvePolicy({ id: "POL_INVALID" }), "POLICY_INVALID");
  }

  // POLICY-REJECT-01：老板填写原因驳回政策，短原因被拒绝。
  {
    const harness = createHarness(seed(), boss);
    const reports = harness.loadHandler("reports");
    await expectCode(reports.rejectPolicy({ id: "POL_PENDING", reason: "错" }), "INVALID_REJECT_REASON");
    assert.strictEqual((await reports.rejectPolicy({ id: "POL_PENDING", reason: "价格依据不足" })).status, "老板驳回");
    assert.strictEqual(harness.get("policies", "POL_PENDING").rejectedReason, "价格依据不足");
  }

  console.log("仪表盘、审批与报表云函数测试通过");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
