const assert = require("assert");
const fixture = require("./fixtures/business-fixture");
const { createHarness, expectCode } = require("./helpers/handler-harness");
const { localDate, monthKey } = require("../cloudfunctions/api/lib/core");

function seed() {
  const copy = JSON.parse(JSON.stringify(fixture));
  copy.policies[0].start = "2020-01-01";
  copy.policies[0].end = "2099-12-31";
  copy.sales[0].date = localDate();
  copy.sales[0].settlementMonth = monthKey();
  copy.sales[1].date = localDate();
  copy.sales[1].settlementMonth = monthKey();
  copy.expenses = [
    {
      _id: "EXP001",
      date: localDate(),
      repId: "R001",
      supervisorId: "S001",
      managerId: "M001",
      customerId: "C001",
      expenseMonth: monthKey(),
      type: "小礼品",
      amount: 20,
      note: "客户活动用品",
      status: "待主管审核",
      paymentStatus: "未付款",
      invoiceStatus: "待收票",
      createdAt: `${localDate()}T08:00:00.000Z`
    },
    {
      _id: "EXP_PAID",
      date: localDate(),
      repId: "R001",
      supervisorId: "S001",
      managerId: "M001",
      customerId: "C001",
      expenseMonth: monthKey(),
      type: "推广费",
      amount: 10,
      note: "终端推广活动",
      status: "已通过",
      paymentStatus: "待付款",
      invoiceStatus: "待收票",
      createdAt: `${localDate()}T09:00:00.000Z`
    }
  ];
  copy.receivables = [{
    _id: "RECV001",
    warehouseId: "W001",
    warehouseName: "甲区仓库",
    managerId: "M001",
    settlementMonth: monthKey(),
    dueDate: localDate(),
    dueAmount: 500,
    paidAmount: 100
  }];
  copy.warehouse_payments = [];
  copy.audit_logs = [];
  return copy;
}

(async () => {
  const rep = fixture.users.find((item) => item.personId === "R001");
  const supervisor = fixture.users.find((item) => item.personId === "S001");
  const manager = fixture.users.find((item) => item.personId === "M001");
  const boss = fixture.users.find((item) => item.role === "boss");
  const finance = fixture.users.find((item) => item.role === "finance");

  // EXPENSE-PAGE-01：代表看到本团队客户额度，财务只看已通过费用。
  {
    const harness = createHarness(seed(), rep);
    const expenses = harness.loadHandler("expenses");
    const page = await expenses.getExpensesPage();
    assert.strictEqual(page.canSubmit, true);
    assert.deepStrictEqual(page.customers.map((item) => item.id), ["C001"]);
    assert(page.customers.find((item) => item.id === "C001").availableBudget > 0);
    harness.setUser(finance);
    const financePage = await expenses.getExpensesPage();
    assert.strictEqual(financePage.canSubmit, false);
    assert.deepStrictEqual(financePage.expenses.map((item) => item.id), ["EXP_PAID"]);
    assert.strictEqual(financePage.expenses[0].canMarkPaid, true);
  }

  // EXPENSE-SUBMIT-01：代表按允许类型和额度提交，饮料类无需发票。
  {
    const harness = createHarness(seed(), rep);
    const expenses = harness.loadHandler("expenses");
    const result = await expenses.submitExpense({
      idempotencyKey: "expense-submit-001",
      customerId: "C001",
      type: "饮料",
      amount: 5,
      note: "客户会议饮料"
    });
    const row = harness.get("expenses", result.id);
    assert.strictEqual(row.status, "待主管审核");
    assert.strictEqual(row.invoiceStatus, "无需发票");
    assert.strictEqual(row.amount, 5);
  }

  // EXPENSE-SUBMIT-02：非法类型、跨团队客户和超额度均拦截。
  {
    const harness = createHarness(seed(), rep);
    const expenses = harness.loadHandler("expenses");
    await expectCode(expenses.submitExpense({
      idempotencyKey: "expense-submit-002",
      customerId: "C001",
      type: "宴请",
      amount: 5,
      note: "不允许类型"
    }), "INVALID_EXPENSE_TYPE");
    await expectCode(expenses.submitExpense({
      idempotencyKey: "expense-submit-003",
      customerId: "C002",
      type: "小礼品",
      amount: 5,
      note: "跨团队客户"
    }), "CUSTOMER_FORBIDDEN");
    await expectCode(expenses.submitExpense({
      idempotencyKey: "expense-submit-004",
      customerId: "C001",
      type: "推广费",
      amount: 999999,
      note: "超过本月额度"
    }), "EXPENSE_BUDGET_EXCEEDED");
  }

  // EXPENSE-APPROVE-01：主管通过流转经理，经理通过进入财务闭环。
  {
    const harness = createHarness(seed(), supervisor);
    const expenses = harness.loadHandler("expenses");
    assert.strictEqual((await expenses.approveExpense({ id: "EXP001" })).status, "待经理审核");
    harness.setUser(manager);
    assert.strictEqual((await expenses.approveExpense({ id: "EXP001" })).status, "已通过");
    assert.strictEqual(harness.get("expenses", "EXP001").paymentStatus, "待付款");
  }

  // EXPENSE-REJECT-01：审批人驳回必须填写有效原因。
  {
    const harness = createHarness(seed(), supervisor);
    const expenses = harness.loadHandler("expenses");
    await expectCode(expenses.rejectExpense({ id: "EXP001", reason: "错" }), "INVALID_REJECT_REASON");
    assert.strictEqual((await expenses.rejectExpense({ id: "EXP001", reason: "凭证不全" })).status, "主管驳回");
  }

  // EXPENSE-FINANCE-01：财务确认付款和收票，重复操作被拦截。
  {
    const harness = createHarness(seed(), finance);
    const expenses = harness.loadHandler("expenses");
    assert.strictEqual((await expenses.markExpensePaid({ id: "EXP_PAID" })).paymentStatus, "已付款");
    assert.strictEqual((await expenses.markExpenseInvoiced({ id: "EXP_PAID" })).invoiceStatus, "已收票");
    await expectCode(expenses.markExpensePaid({ id: "EXP_PAID" }), "EXPENSE_NOT_PAYABLE");
    await expectCode(expenses.markExpenseInvoiced({ id: "EXP_PAID" }), "EXPENSE_NOT_INVOICEABLE");
  }

  // RECEIVABLE-PAGE-01：经理只查看本团队应收、回款和仓库账期。
  {
    const harness = createHarness(seed(), manager);
    const receivables = harness.loadHandler("receivables");
    const page = await receivables.getReceivables({ month: monthKey() });
    assert.strictEqual(page.summary.dueAmount, 500);
    assert.strictEqual(page.summary.outstanding, 400);
    assert.deepStrictEqual(page.warehouseTerms.map((item) => item.id), ["W001"]);
    assert.strictEqual(page.managers.length, 0);
  }

  // RECEIVABLE-PAY-01：经理登记回款后进入财务确认，并冲减未回金额。
  {
    const harness = createHarness(seed(), manager);
    const receivables = harness.loadHandler("receivables");
    const result = await receivables.recordWarehousePayment({
      idempotencyKey: "payment-record-001",
      receivableId: "RECV001",
      paymentDate: localDate(),
      amount: 50.25,
      reference: "TEST-REF-001",
      note: "客户银行到账"
    });
    assert.strictEqual(result.status, "待财务确认");
    assert.strictEqual(harness.get("receivables", "RECV001").paidAmount, 150.25);
    assert.strictEqual(harness.get("warehouse_payments", result.id).amount, 50.25);
  }

  // RECEIVABLE-PAY-02：超额、未来日期和超过两位小数均拦截。
  {
    const harness = createHarness(seed(), manager);
    const receivables = harness.loadHandler("receivables");
    await expectCode(receivables.recordWarehousePayment({
      idempotencyKey: "payment-record-002",
      receivableId: "RECV001",
      paymentDate: localDate(),
      amount: 401,
      note: "超过剩余应收"
    }), "PAYMENT_EXCEEDS_OUTSTANDING");
    await expectCode(receivables.recordWarehousePayment({
      idempotencyKey: "payment-record-003",
      receivableId: "RECV001",
      paymentDate: localDate(),
      amount: 1.001,
      note: "金额精度不合法"
    }), "INVALID_PAYMENT_AMOUNT");
  }

  // RECEIVABLE-VERIFY-01：财务核实经理登记的回款。
  {
    const data = seed();
    data.warehouse_payments.push({
      _id: "PAY001",
      receivableId: "RECV001",
      warehouseId: "W001",
      managerId: "M001",
      settlementMonth: monthKey(),
      paymentDate: localDate(),
      amount: 30,
      status: "待财务确认",
      registeredBy: "M001"
    });
    const harness = createHarness(data, finance);
    const receivables = harness.loadHandler("receivables");
    assert.strictEqual((await receivables.verifyWarehousePayment({ paymentId: "PAY001" })).status, "财务已确认");
    assert.strictEqual(harness.get("warehouse_payments", "PAY001").verifiedBy, "F001");
  }

  // RECEIVABLE-VOID-01：经理可撤销自己未核实的回款，并还原应收。
  {
    const data = seed();
    data.warehouse_payments.push({
      _id: "PAY001",
      receivableId: "RECV001",
      warehouseId: "W001",
      managerId: "M001",
      amount: 30,
      status: "待财务确认",
      registeredBy: "M001"
    });
    data.receivables[0].paidAmount = 130;
    const harness = createHarness(data, manager);
    const receivables = harness.loadHandler("receivables");
    assert.strictEqual((await receivables.voidWarehousePayment({ paymentId: "PAY001", reason: "流水重复" })).status, "已作废");
    assert.strictEqual(harness.get("receivables", "RECV001").paidAmount, 100);
  }

  // RECEIVABLE-TERM-01：老板设置责任经理和账期，并同步已有应收。
  {
    const harness = createHarness(seed(), boss);
    const receivables = harness.loadHandler("receivables");
    const result = await receivables.updateWarehouseTerm({ warehouseId: "W001", managerId: "M002", creditDays: 45 });
    assert.strictEqual(result.warehouseId, "W001");
    assert.strictEqual(harness.get("warehouses", "W001").managerId, "M002");
    assert.strictEqual(harness.get("warehouses", "W001").creditDays, 45);
    assert.strictEqual(harness.get("receivables", "RECV001").managerId, "M002");
    await expectCode(receivables.updateWarehouseTerm({ warehouseId: "W001", managerId: "M002", creditDays: 366 }), "WAREHOUSE_TERM_INVALID");
  }

  console.log("费用与应收云函数测试通过");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
