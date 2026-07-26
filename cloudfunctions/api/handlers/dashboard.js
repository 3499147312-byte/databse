const {
  command,
  fetchAll,
  requireUser,
  assertPermission,
  assertAnyPermission,
  hasPermission,
  activeApprovalDelegation,
  userBusinessId,
  safeUser
} = require("../lib/context");
const {
  localDate,
  monthKey,
  daysBetween,
  calc4,
  calcSale
} = require("../lib/core");
const {
  scopedRows,
  decorateReceivables,
  mapById
} = require("../lib/domain");
const { ensureWeeklyTasks, isoWeek } = require("./reports");

async function visibleReps(user) {
  const reps = await fetchAll("users", { role: "rep", disabled: false });
  return reps.filter((item) => hasPermission(user, "sales.view", {
    ...item,
    repId: userBusinessId(item),
    ownerId: userBusinessId(item)
  }));
}

async function pendingApprovalRows(user, collectionName, businessType) {
  const rows = await fetchAll(collectionName, { status: command.in(["待主管审核", "待经理审核"]) }, { max: 3000 });
  const result = [];
  for (const item of rows) {
    const stage = item.status === "待主管审核" ? "supervisor" : "manager";
    const permission = `${businessType}.approve.${stage}`;
    if (hasPermission(user, permission, item) && item[`${stage}Id`] === userBusinessId(user)) {
      result.push(item);
      continue;
    }
    if (await activeApprovalDelegation(user, item, businessType, stage)) result.push(item);
  }
  return result;
}

async function getDashboard() {
  const user = await requireUser();
  assertPermission(user, "dashboard.view");
  if (hasPermission(user, "reports.weekly.submit") || user.role === "boss") await ensureWeeklyTasks(user);
  const today = localDate();
  const month = monthKey(today);
  const hasSalesScope = hasPermission(user, "sales.view");
  const sales = hasSalesScope
    ? await scopedRows("sales", user, {
        status: "已通过",
        correctionStatus: "正常"
      }, { max: 3000 })
    : [];
  const todaySales = sales.filter((item) => item.date === today);
  const monthSales = sales.filter((item) => item.settlementMonth === month);
  const commissionField = user.role === "rep"
    ? "repCommission"
    : user.role === "supervisor"
      ? "supervisorCommission"
      : user.role === "manager"
        ? "managerCommission"
        : "";
  const commissionTotal = (items) => commissionField
    ? calc4(items.reduce((sum, item) => sum + Number(calcSale(item)[commissionField] || 0), 0))
    : 0;
  const reps = hasSalesScope ? await visibleReps(user) : [];
  const repIds = reps.map((item) => userBusinessId(item));
  const reports = repIds.length
    ? await fetchAll("daily_reports", { date: today, repId: command.in(repIds), submitted: true })
    : [];
  const submitted = new Set(reports.map((item) => item.repId));
  const missing = reps.filter((item) => !submitted.has(userBusinessId(item)));

  const visiblePendingSales = hasPermission(user, "sales.view")
    ? await scopedRows("sales", user, { status: command.in(["待主管审核", "待经理审核"]) }, { max: 1000 }, "sales.view")
    : [];
  const actionableSales = hasPermission(user, "sales.approve.supervisor") || hasPermission(user, "sales.approve.manager")
    ? await pendingApprovalRows(user, "sales", "sales")
    : [];
  const pendingSales = [...new Map([...visiblePendingSales, ...actionableSales].map((item) => [item._id, item])).values()];
  const visiblePendingExpenses = hasPermission(user, "expenses.view")
    ? await scopedRows("expenses", user, { status: command.in(["待主管审核", "待经理审核"]) }, { max: 1000 }, "expenses.view")
    : [];
  const actionableExpenses = hasPermission(user, "expenses.approve.supervisor") || hasPermission(user, "expenses.approve.manager")
    ? await pendingApprovalRows(user, "expenses", "expenses")
    : [];
  const pendingExpenses = [...new Map([...visiblePendingExpenses, ...actionableExpenses].map((item) => [item._id, item])).values()];
  const pendingPolicies = hasPermission(user, "policies.approve") || hasPermission(user, "policies.reject")
    ? (await fetchAll("policies", { status: "待老板审核" })).filter((item) =>
      hasPermission(user, "policies.approve", item) || hasPermission(user, "policies.reject", item))
    : [];
  const pendingPayments = hasPermission(user, "receivables.verify")
    ? (await fetchAll("warehouse_payments", { status: command.in(["待老板核实", "待财务确认"]) }))
      .filter((item) => hasPermission(user, "receivables.verify", item))
    : [];
  const financeExpenses = hasPermission(user, "expenses.pay") || hasPermission(user, "expenses.invoice")
    ? (await fetchAll("expenses", { status: "已通过" }, { max: 1000 }))
      .filter((item) => hasPermission(user, "expenses.pay", item) || hasPermission(user, "expenses.invoice", item))
    : [];
  const visiblePolicies = hasPermission(user, "policies.view")
    ? (await fetchAll("policies", {}, { max: 3000 })).filter((item) => hasPermission(user, "policies.view", item))
    : [];
  const visibleExpenses = hasPermission(user, "expenses.view")
    ? (await fetchAll("expenses", {}, { max: 3000 })).filter((item) => hasPermission(user, "expenses.view", item))
    : [];

  let monthDue = 0;
  let monthReceived = 0;
  let reminders = [];
  if (hasPermission(user, "receivables.view")) {
    const receivables = (await fetchAll("receivables", {})).filter((item) => hasPermission(user, "receivables.view", item));
    const decorated = await decorateReceivables(user, receivables);
    monthDue = decorated.filter((item) => monthKey(item.dueDate) === month).reduce((sum, item) => sum + item.dueAmount, 0);
    const payments = (await fetchAll("warehouse_payments", { status: command.neq("已作废") }))
      .filter((item) => hasPermission(user, "receivables.view", item));
    monthReceived = payments.filter((item) => monthKey(item.paymentDate) === month).reduce((sum, item) => sum + Number(item.amount || 0), 0);
    reminders = decorated
      .filter((item) => item.outstanding > 0 && daysBetween(today, item.dueDate) <= 3)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  let weeklyPending = [];
  if (user.role === "boss") {
    weeklyPending = await fetchAll("weekly_reports", { week: isoWeek(), status: "未提交" });
  } else if (hasPermission(user, "reports.weekly.submit")) {
    weeklyPending = await fetchAll("weekly_reports", { week: isoWeek(), ownerId: userBusinessId(user), status: "未提交" });
  }
  const localWeekday = new Date(`${today}T00:00:00+08:00`).getDay();
  const weeklyLevel = weeklyPending.length ? (localWeekday === 0 || localWeekday >= 5 ? "danger" : "warn") : "";
  const tasks = [
    {
      key: "daily",
      title: "业务代表日报",
      value: missing.length ? `${missing.length}人未提交` : "全部完成",
      detail: missing.length ? missing.map((item) => item.name).join("、") : "今日全部业务代表已提交",
      level: missing.length ? "danger" : ""
    },
    {
      key: "approval",
      title: "待处理审批",
      value: `${pendingSales.length + pendingExpenses.length + pendingPolicies.length + pendingPayments.length}条`,
      detail: "销售、费用、客户政策和仓库回款核实",
      level: pendingSales.length + pendingExpenses.length + pendingPolicies.length + pendingPayments.length ? "warn" : ""
    },
    {
      key: "weekly",
      title: "本周销售统计",
      value: weeklyPending.length ? `${weeklyPending.length}项未提交` : "全部完成",
      detail: weeklyPending.length ? "主管按客户、经理按区域，每周五前必须完成" : "本周统计任务已经完成",
      level: weeklyLevel
    }
  ];
  const hasApprovalActions = [
    "sales.approve.supervisor",
    "sales.approve.manager",
    "expenses.approve.supervisor",
    "expenses.approve.manager",
    "policies.approve",
    "receivables.verify"
  ].some((code) => hasPermission(user, code));
  const readOnlyHeadquarters = !hasApprovalActions && !hasPermission(user, "sales.view") && (visiblePolicies.length || visibleExpenses.length);
  if (readOnlyHeadquarters) {
    tasks.splice(0, tasks.length,
      {
        key: "policy-view",
        title: "客户政策资料",
        value: `${visiblePolicies.length}条`,
        detail: "可查看全部客户政策，最终审批仍由老板完成",
        level: ""
      },
      {
        key: "expense-view",
        title: "费用申请资料",
        value: `${visibleExpenses.length}条`,
        detail: "可查看全部费用申请，不具有审批权限",
        level: ""
      });
  } else if (financeExpenses.length || pendingPayments.length) {
    const financePending = financeExpenses.filter((item) => item.paymentStatus !== "已付款" || item.invoiceStatus === "待收票").length;
    tasks.splice(0, tasks.length,
      {
        key: "finance-expense",
        title: "费用财务处理",
        value: `${financePending}条待闭环`,
        detail: "处理已审批费用的付款和收票",
        level: financePending ? "warn" : ""
      },
      {
        key: "finance-payment",
        title: "仓库回款确认",
        value: `${pendingPayments.length}条待确认`,
        detail: "核对仓库到账并完成财务确认",
        level: pendingPayments.length ? "warn" : ""
      });
  }

  return {
    user: safeUser(user),
    metrics: {
      todaySales: calc4(todaySales.reduce((sum, item) => sum + calcSale(item).amount, 0)),
      monthSales: calc4(monthSales.reduce((sum, item) => sum + calcSale(item).amount, 0)),
      todayCommission: commissionTotal(todaySales),
      monthCommission: commissionTotal(monthSales),
      monthDue: calc4(monthDue),
      monthReceived: calc4(monthReceived),
      missingDaily: missing.length,
      pending: readOnlyHeadquarters
        ? 0
        : user.role === "finance"
          ? financeExpenses.filter((item) => item.paymentStatus !== "已付款" || item.invoiceStatus === "待收票").length + pendingPayments.length
          : pendingSales.length + pendingExpenses.length + pendingPolicies.length + pendingPayments.length
    },
    receivableReminders: reminders,
    tasks
  };
}

async function getApprovals() {
  const user = await requireUser();
  assertAnyPermission(user, [
    "sales.approve.supervisor",
    "sales.approve.manager",
    "expenses.approve.supervisor",
    "expenses.approve.manager",
    "expenses.view",
    "policies.view",
    "policies.approve",
    "policies.reject"
  ]);
  const canApproveSales = hasPermission(user, "sales.approve.supervisor") || hasPermission(user, "sales.approve.manager");
  const canApproveExpenses = hasPermission(user, "expenses.approve.supervisor") || hasPermission(user, "expenses.approve.manager");
  const sales = canApproveSales ? await pendingApprovalRows(user, "sales", "sales") : [];
  const expenses = canApproveExpenses
    ? await pendingApprovalRows(user, "expenses", "expenses")
    : hasPermission(user, "expenses.view")
      ? (await fetchAll("expenses", {}, { max: 3000, orderBy: { field: "createdAt", direction: "desc" } }))
        .filter((item) => hasPermission(user, "expenses.view", item))
      : [];
  const canReviewPolicies = hasPermission(user, "policies.approve") || hasPermission(user, "policies.reject");
  const policies = hasPermission(user, "policies.view") && (canReviewPolicies || user.role === "hq_auditor")
    ? (await fetchAll("policies", {}, { max: 3000, orderBy: { field: "createdAt", direction: "desc" } }))
      .filter((item) => hasPermission(user, "policies.view", item))
    : [];
  const customerMap = await mapById("customers", [
    ...sales.map((item) => item.customerId),
    ...expenses.map((item) => item.customerId),
    ...policies.map((item) => item.customerId)
  ]);
  const productMap = await mapById("products", [
    ...sales.flatMap((item) => (item.lines || []).map((line) => line.productId)),
    ...policies.map((item) => item.productId)
  ]);
  const users = await fetchAll("users", {});
  const names = new Map(users.map((item) => [userBusinessId(item), item.name]));
  return {
    sales: sales.map((sale) => ({
      id: sale._id,
      date: sale.date,
      repName: names.get(sale.repId) || "",
      customerName: customerMap.get(sale.customerId)?.name || "未配置客户",
      lineText: (sale.lines || []).map((line) => `${productMap.get(line.productId)?.spec || line.productId} × ${line.qty}盒 · 批号${line.batchNo}`).join("；"),
      amount: calcSale(sale).amount,
      status: sale.status,
      canAct: canApproveSales
    })),
    expenses: expenses.map((item) => ({
      id: item._id,
      date: item.date,
      repName: names.get(item.repId) || "",
      customerName: customerMap.get(item.customerId)?.name || "未配置客户",
      type: item.type,
      amount: item.amount,
      note: item.note,
      status: item.status,
      paymentStatus: item.paymentStatus,
      invoiceStatus: item.invoiceStatus,
      canAct: canApproveExpenses
    })),
    policies: policies.map((item) => ({
      id: item._id,
      customerName: customerMap.get(item.customerId)?.name || "未配置客户",
      productName: `${productMap.get(item.productId)?.name || ""}${productMap.get(item.productId)?.spec || item.productId}`,
      invoicePrice: item.invoicePrice,
      retailPrice: item.retailPrice,
      headRebate: item.headRebate,
      noInvoiceRebate: item.noInvoiceRebate,
      promoSpend: item.promoSpend,
      monthlyTarget: item.monthlyTarget,
      repCommission: item.repCommission,
      supervisorCommission: item.supervisorCommission,
      managerCommission: item.managerCommission,
      hasSpecialCommission: [item.repCommission, item.supervisorCommission, item.managerCommission]
        .some((value) => value !== undefined && value !== null),
      note: item.note,
      sourceNo: item.sourceNo,
      submittedByName: names.get(item.submittedBy) || "",
      start: item.start,
      end: item.end,
      status: item.status,
      canApprove: hasPermission(user, "policies.approve", item),
      canReject: hasPermission(user, "policies.reject", item),
      canAct: hasPermission(user, "policies.approve", item) || hasPermission(user, "policies.reject", item)
    })),
    viewMode: canApproveSales || canApproveExpenses || policies.some((item) =>
      hasPermission(user, "policies.approve", item) || hasPermission(user, "policies.reject", item))
      ? "approval"
      : "readOnly"
  };
}

module.exports = { getDashboard, getApprovals };
