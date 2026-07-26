const crypto = require("crypto");
const {
  db,
  fetchAll,
  getDoc,
  setDoc,
  requireUser,
  assertPermission,
  hasPermission,
  assertApprovalAuthority,
  writeAudit,
  withIdempotency,
  userBusinessId,
  fail
} = require("../lib/context");
const {
  localDate,
  monthKey,
  nowIso,
  positiveNumber,
  calc4
} = require("../lib/core");
const {
  visibleCustomers,
  scopedRows,
  expenseBudget,
  mapById
} = require("../lib/domain");

async function nameMap() {
  const users = await fetchAll("users", {});
  return new Map(users.map((item) => [userBusinessId(item), item.name]));
}

async function getExpensesPage() {
  const user = await requireUser();
  assertPermission(user, "expenses.view");
  const customers = hasPermission(user, "expenses.submit")
    ? await visibleCustomers(user, "expenses.submit")
    : [];
  const userId = userBusinessId(user);
  const customerRows = [];
  if (user.role === "rep") {
    for (const customer of customers) {
      customerRows.push({
        id: customer._id,
        name: customer.name,
        availableBudget: await expenseBudget(userId, customer._id)
      });
    }
  }
  const scopedExpenses = await scopedRows(
    "expenses",
    user,
    {},
    { max: 3000, orderBy: { field: "createdAt", direction: "desc" } },
    "expenses.view"
  );
  const expenses = user.role === "finance"
    ? scopedExpenses.filter((item) => item.status === "已通过")
    : scopedExpenses;
  const customerMap = await mapById("customers", expenses.map((item) => item.customerId));
  const names = await nameMap();
  return {
    canSubmit: hasPermission(user, "expenses.submit") && user.role === "rep" && customerRows.length > 0,
    customers: customerRows,
    expenses: expenses.map((item) => ({
      id: item._id,
      date: item.date,
      repName: names.get(item.repId) || "",
      customerName: customerMap.get(item.customerId)?.name || "未配置客户",
      type: item.type,
      amount: Number(item.amount || 0),
      status: item.status,
      paymentStatus: item.paymentStatus,
      invoiceStatus: item.invoiceStatus,
      note: item.note,
      canMarkPaid: hasPermission(user, "expenses.pay", item) && item.status === "已通过" && item.paymentStatus !== "已付款",
      canMarkInvoiced: hasPermission(user, "expenses.invoice", item) && item.status === "已通过" && item.invoiceStatus === "待收票"
    }))
  };
}

async function submitExpense(payload) {
  const user = await requireUser();
  assertPermission(user, "expenses.submit");
  if (user.role !== "rep") fail("INVALID_POSITION", "只有业务代表岗位可以提交费用。");
  return withIdempotency(user, payload.idempotencyKey, "submitExpense", async () => {
    const repId = userBusinessId(user);
    const customers = await visibleCustomers(user, "expenses.submit");
    const customer = customers.find((item) => item._id === payload.customerId);
    const amount = Number(payload.amount);
    const note = String(payload.note || "").trim();
    const allowedTypes = ["奶茶", "饮料", "小礼品", "推广费"];
    if (!customer) fail("CUSTOMER_FORBIDDEN", "客户不存在或不在当前业务代表范围。");
    if (!allowedTypes.includes(payload.type)) fail("INVALID_EXPENSE_TYPE", "费用类型不在允许范围。");
    if (!positiveNumber(amount, 10000000) || note.length < 2 || note.length > 200) {
      fail("INVALID_EXPENSE", "报销金额必须大于0，说明需填写2到200个字。");
    }
    const available = await expenseBudget(repId, customer._id);
    if (amount > available) fail("EXPENSE_BUDGET_EXCEEDED", `本月该客户可用客情额度只有${available.toFixed(2)}元。`);
    const id = `expense_${Date.now()}_${crypto.randomBytes(7).toString("hex")}`;
    const noInvoice = ["奶茶", "饮料"].includes(payload.type);
    await setDoc("expenses", id, {
      date: localDate(),
      expenseMonth: monthKey(),
      repId,
      supervisorId: customer.supervisorId,
      managerId: customer.managerId,
      customerId: customer._id,
      type: payload.type,
      amount: calc4(amount),
      note,
      status: customer.supervisorId ? "待主管审核" : "待经理审核",
      paymentStatus: "未付款",
      invoiceStatus: noInvoice ? "无需发票" : "待收票",
      createdBy: user._id,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });
    await writeAudit(user, "提交费用报销", id, `${customer.name} / ${payload.type} / ${amount.toFixed(2)}元`);
    return { id };
  });
}

async function approveExpense(payload) {
  const user = await requireUser();
  const expense = await getDoc("expenses", payload.id);
  if (!expense) fail("EXPENSE_FORBIDDEN", "费用单不存在或不在当前权限范围。");
  const id = userBusinessId(user);
  if (expense.status === "待主管审核") {
    const authority = await assertApprovalAuthority(user, expense, "expenses", "supervisor");
    await db.runTransaction(async (transaction) => {
      const current = (await transaction.collection("expenses").doc(expense._id).get()).data;
      if (current.status !== "待主管审核" || current.supervisorId !== expense.supervisorId) {
        fail("EXPENSE_CHANGED", "费用单状态已经变化，请刷新后重试。");
      }
      await transaction.collection("expenses").doc(expense._id).update({ data: {
        status: "待经理审核",
        approvalTrail: [...(current.approvalTrail || []), {
          role: "supervisor",
          userId: id,
          actorName: user.name,
          delegated: authority.delegated,
          delegationId: authority.delegation?._id || "",
          time: nowIso()
        }],
        updatedAt: nowIso()
      } });
    });
    await writeAudit(
      user,
      authority.delegated ? "代理主管审核费用" : "主管审核费用",
      expense._id,
      authority.delegated
        ? `主管级通过；代理岗位=主管；团队=${expense.managerId}；授权=${authority.delegation._id}`
        : "主管级通过，流转到经理审核"
    );
    return { status: "待经理审核" };
  }
  if (expense.status === "待经理审核") {
    const authority = await assertApprovalAuthority(user, expense, "expenses", "manager");
    const available = await expenseBudget(expense.repId, expense.customerId, expense.expenseMonth, expense._id);
    if (Number(expense.amount) > available) fail("EXPENSE_BUDGET_CHANGED", `当前可用客情额度只有${available.toFixed(2)}元，不能通过。`);
    await db.runTransaction(async (transaction) => {
      const current = (await transaction.collection("expenses").doc(expense._id).get()).data;
      if (current.status !== "待经理审核" || current.managerId !== expense.managerId) {
        fail("EXPENSE_CHANGED", "费用单状态已经变化，请刷新后重试。");
      }
      await transaction.collection("expenses").doc(expense._id).update({ data: {
        status: "已通过",
        paymentStatus: "待付款",
        approvalTrail: [...(current.approvalTrail || []), {
          role: "manager",
          userId: id,
          actorName: user.name,
          delegated: authority.delegated,
          delegationId: authority.delegation?._id || "",
          time: nowIso()
        }],
        approvedAt: nowIso(),
        updatedAt: nowIso()
      } });
    });
    await writeAudit(
      user,
      authority.delegated ? "代理经理审核费用" : "经理审核费用",
      expense._id,
      authority.delegated
        ? `经理级最终通过；代理岗位=经理；团队=${expense.managerId}；授权=${authority.delegation._id}`
        : "经理级最终通过，进入财务闭环"
    );
    return { status: "已通过" };
  }
  fail("WRONG_APPROVAL_LEVEL", "当前不是这笔费用的审批人或状态已经变化。");
}

async function rejectExpense(payload) {
  const user = await requireUser();
  const reason = String(payload.reason || "").trim();
  if (reason.length < 2 || reason.length > 200) fail("INVALID_REJECT_REASON", "驳回原因需填写2到200个字。");
  const expense = await getDoc("expenses", payload.id);
  if (!expense) fail("EXPENSE_FORBIDDEN", "费用单不存在或不在当前权限范围。");
  const id = userBusinessId(user);
  const stage = expense.status === "待主管审核"
    ? "supervisor"
    : expense.status === "待经理审核"
      ? "manager"
      : "";
  if (!stage) fail("WRONG_APPROVAL_LEVEL", "当前费用不在可驳回的审批阶段。");
  const authority = await assertApprovalAuthority(user, expense, "expenses", stage);
  const status = stage === "supervisor" ? "主管驳回" : "经理驳回";
  await db.runTransaction(async (transaction) => {
    const current = (await transaction.collection("expenses").doc(expense._id).get()).data;
    const expectedStatus = stage === "supervisor" ? "待主管审核" : "待经理审核";
    if (current.status !== expectedStatus) fail("EXPENSE_CHANGED", "费用单状态已经变化，请刷新后重试。");
    await transaction.collection("expenses").doc(expense._id).update({ data: {
      status,
      rejectedReason: reason,
      rejectedBy: id,
      rejectedAt: nowIso(),
      approvalTrail: [...(current.approvalTrail || []), {
        role: stage,
        userId: id,
        actorName: user.name,
        delegated: authority.delegated,
        delegationId: authority.delegation?._id || "",
        result: "驳回",
        reason,
        time: nowIso()
      }],
      updatedAt: nowIso()
    } });
  });
  await writeAudit(
    user,
    authority.delegated ? "代理驳回费用申请" : "驳回费用申请",
    expense._id,
    authority.delegated
      ? `${reason}；代理岗位=${stage === "supervisor" ? "主管" : "经理"}；团队=${expense.managerId}；授权=${authority.delegation._id}`
      : reason
  );
  return { status };
}

async function markExpensePaid(payload) {
  const user = await requireUser();
  const expense = await getDoc("expenses", payload.id);
  if (expense) assertPermission(user, "expenses.pay", expense);
  if (!expense || expense.status !== "已通过" || expense.paymentStatus === "已付款") fail("EXPENSE_NOT_PAYABLE", "费用不存在、未通过或已经付款。");
  await db.runTransaction(async (transaction) => {
    const current = (await transaction.collection("expenses").doc(expense._id).get()).data;
    if (current.status !== "已通过" || current.paymentStatus === "已付款") {
      fail("EXPENSE_NOT_PAYABLE", "费用不存在、未通过或已经付款。");
    }
    await transaction.collection("expenses").doc(expense._id).update({
      data: { paymentStatus: "已付款", paidAt: nowIso(), paidBy: userBusinessId(user) }
    });
  });
  await writeAudit(user, "确认费用付款", expense._id, `${expense.type} / ${Number(expense.amount).toFixed(2)}元`);
  return { paymentStatus: "已付款" };
}

async function markExpenseInvoiced(payload) {
  const user = await requireUser();
  const expense = await getDoc("expenses", payload.id);
  if (expense) assertPermission(user, "expenses.invoice", expense);
  if (!expense || expense.status !== "已通过" || expense.invoiceStatus !== "待收票") fail("EXPENSE_NOT_INVOICEABLE", "费用不存在、未通过或当前不需要收票。");
  await db.runTransaction(async (transaction) => {
    const current = (await transaction.collection("expenses").doc(expense._id).get()).data;
    if (current.status !== "已通过" || current.invoiceStatus !== "待收票") {
      fail("EXPENSE_NOT_INVOICEABLE", "费用不存在、未通过或当前不需要收票。");
    }
    await transaction.collection("expenses").doc(expense._id).update({
      data: { invoiceStatus: "已收票", invoicedAt: nowIso(), invoicedBy: userBusinessId(user) }
    });
  });
  await writeAudit(user, "确认费用收票", expense._id, `${expense.type}发票已收`);
  return { invoiceStatus: "已收票" };
}

module.exports = {
  getExpensesPage,
  submitExpense,
  approveExpense,
  rejectExpense,
  markExpensePaid,
  markExpenseInvoiced
};
