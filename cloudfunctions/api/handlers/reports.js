const crypto = require("crypto");
const {
  db,
  command,
  fetchAll,
  getDoc,
  setDoc,
  updateDoc,
  requireUser,
  assertPermission,
  hasPermission,
  writeAudit,
  userBusinessId,
  safeUser,
  fail
} = require("../lib/context");
const {
  localDate,
  monthKey,
  nowIso,
  validDate,
  positiveNumber,
  nonNegativeNumber,
  calcSale,
  calc4,
  roleLabel
} = require("../lib/core");
const {
  scopedRows,
  visibleWarehouses,
  visibleCustomers,
  decorateReceivables,
  mapById
} = require("../lib/domain");

function isoWeek(dateText = localDate()) {
  const date = new Date(`${dateText}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function previousMonth(value) {
  const [year, month] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return date.toISOString().slice(0, 7);
}

async function ensureWeeklyTasks(user) {
  const week = isoWeek();
  const id = userBusinessId(user);
  const tasks = [];
  if (user.role === "supervisor") {
    const customers = await fetchAll("customers", { supervisorId: id, status: command.neq("停用") });
    for (const customer of customers) {
      tasks.push({
        key: `customer|${id}|${customer._id}|${week}`,
        data: {
          type: "customer",
          ownerId: id,
          supervisorId: id,
          managerId: customer.managerId,
          customerId: customer._id,
          title: customer.name,
          week
        }
      });
    }
  } else if (user.role === "manager") {
    tasks.push({
      key: `province|${id}|${week}`,
      data: {
        type: "province",
        ownerId: id,
        managerId: id,
        province: user.province,
        title: `${user.province || "负责区域"}周统计`,
        week
      }
    });
  } else if (user.role === "boss") {
    const users = await fetchAll("users", { disabled: false });
    for (const item of users.filter((entry) => entry.role === "manager")) {
      const ownerId = userBusinessId(item);
      tasks.push({
        key: `province|${ownerId}|${week}`,
        data: {
          type: "province",
          ownerId,
          managerId: ownerId,
          province: item.province,
          title: `${item.name} · ${item.province || "负责区域"}周统计`,
          week
        }
      });
    }
    const customers = await fetchAll("customers", { status: command.neq("停用") });
    for (const customer of customers) {
      if (!customer.supervisorId) continue;
      tasks.push({
        key: `customer|${customer.supervisorId}|${customer._id}|${week}`,
        data: {
          type: "customer",
          ownerId: customer.supervisorId,
          supervisorId: customer.supervisorId,
          managerId: customer.managerId,
          customerId: customer._id,
          title: customer.name,
          week
        }
      });
    }
  }
  const existingIds = new Set((await fetchAll("weekly_reports", { week }, { max: 3000 })).map((item) => item._id));
  const missing = tasks.map((task) => ({
    ...task,
    id: `weekly_${crypto.createHash("sha256").update(task.key).digest("hex").slice(0, 40)}`
  })).filter((task) => !existingIds.has(task.id));
  for (let index = 0; index < missing.length; index += 10) {
    await Promise.all(missing.slice(index, index + 10).map((task) => setDoc("weekly_reports", task.id, {
      ...task.data,
      status: "未提交",
      note: "",
      createdAt: nowIso()
    })));
  }
}

async function getReports() {
  const user = await requireUser();
  assertPermission(user, "reports.view");
  if (hasPermission(user, "reports.weekly.submit") || user.role === "boss") await ensureWeeklyTasks(user);
  const month = monthKey();
  const sales = hasPermission(user, "sales.view")
    ? await scopedRows("sales", user, { settlementMonth: month, status: "已通过", correctionStatus: "正常" }, { max: 3000 }, "sales.view")
    : [];
  const users = await fetchAll("users", {});
  const userMap = new Map(users.map((item) => [userBusinessId(item), item]));
  const grouped = new Map();
  const add = (ownerId, role, sale, commission) => {
    const row = grouped.get(`${ownerId}|${role}`) || { key: `${ownerId}|${role}`, ownerId, role, salesAmount: 0, qty: 0, commission: 0, promoBudget: 0 };
    const total = calcSale(sale);
    row.salesAmount = calc4(row.salesAmount + total.amount);
    row.qty += total.qty;
    row.commission = calc4(row.commission + commission);
    row.promoBudget = calc4(row.promoBudget + total.promoBudget);
    grouped.set(row.key, row);
  };
  sales.forEach((sale) => {
    const total = calcSale(sale);
    if (user.role === "rep") add(sale.repId, "rep", sale, total.repCommission);
    else if (user.role === "supervisor") add(sale.supervisorId, "supervisor", sale, total.supervisorCommission);
    else if (user.role === "manager") add(sale.managerId, "manager", sale, total.managerCommission);
    else add(sale.managerId, "manager", sale, total.managerCommission);
  });

  let policies;
  if (hasPermission(user, "policies.view") && user.role === "rep") {
    const customers = await visibleCustomers(user, "policies.view");
    const customerIds = customers.map((item) => item._id);
    policies = customerIds.length
      ? await fetchAll("policies", { customerId: command.in(customerIds) }, { max: 1000 })
      : [];
  } else if (hasPermission(user, "policies.view")) {
    policies = await scopedRows("policies", user, {}, { max: 1000 }, "policies.view");
  } else {
    policies = [];
  }
  const policyCustomerMap = await mapById("customers", policies.map((item) => item.customerId));
  const productMap = await mapById("products", policies.map((item) => item.productId));
  let weekly = [];
  if (user.role === "boss") weekly = await fetchAll("weekly_reports", { week: isoWeek() });
  else if (hasPermission(user, "reports.weekly.submit")) weekly = await fetchAll("weekly_reports", { week: isoWeek(), ownerId: userBusinessId(user) });
  const weeklyCustomerMap = await mapById("customers", weekly.map((item) => item.customerId));

  const risks = [];
  const warehouses = hasPermission(user, "reports.risk.view") && hasPermission(user, "inventory.view")
    ? await visibleWarehouses(user, "inventory.view")
    : [];
  const warehouseIds = warehouses.map((item) => item._id);
  const lots = warehouseIds.length ? await fetchAll("inventory_lots", { warehouseId: command.in(warehouseIds) }) : [];
  const lotProductMap = await mapById("products", lots.map((item) => item.productId));
  const warehouseMap = new Map(warehouses.map((item) => [item._id, item]));
  lots.forEach((lot) => {
    const target = `${warehouseMap.get(lot.warehouseId)?.name || "仓库"} / ${lotProductMap.get(lot.productId)?.spec || lot.productId} / 批号${lot.batchNo}`;
    if (Number(lot.qty || 0) < 100) risks.push({ key: `low_${lot._id}`, level: "高", type: "低库存", target, detail: `当前库存${lot.qty}盒，低于100盒预警线` });
    const days = Math.round((new Date(`${lot.expiryDate}T00:00:00Z`) - new Date(`${localDate()}T00:00:00Z`)) / 86400000);
    if (days <= 180) risks.push({ key: `expiry_${lot._id}`, level: days <= 90 ? "高" : "中", type: "近效期", target, detail: `有效期${lot.expiryDate}，剩余${days}天` });
  });
  policies.filter((item) => item.status === "待老板审核").forEach((item) => {
    risks.push({ key: `policy_${item._id}`, level: "中", type: "政策未审", target: policyCustomerMap.get(item.customerId)?.name || item.customerId, detail: "未经过老板审核，不能作为销售和费用规则" });
  });
  if (hasPermission(user, "reports.risk.view") && hasPermission(user, "receivables.view")) {
    const receivableRows = (await fetchAll("receivables", {}))
      .filter((item) => hasPermission(user, "receivables.view", item));
    const decorated = await decorateReceivables(user, receivableRows);
    decorated.filter((item) => item.dueDate < localDate() && item.outstanding > 0).forEach((item) => {
      risks.push({ key: `recv_${item.id}`, level: "高", type: "回款逾期", target: item.warehouseName, detail: `${item.settlementMonth}销售尚欠${item.outstanding.toFixed(2)}元，到期日${item.dueDate}` });
    });
  }
  if (hasPermission(user, "reports.risk.view") && hasPermission(user, "receivables.verify")) {
    const pendingPayments = (await fetchAll("warehouse_payments", { status: command.in(["待老板核实", "待财务确认"]) }))
      .filter((item) => hasPermission(user, "receivables.verify", item));
    pendingPayments.forEach((item) => risks.push({ key: `payment_${item._id}`, level: "中", type: "回款待核实", target: item.warehouseName || item.warehouseId, detail: `${item.paymentDate}登记到账${Number(item.amount).toFixed(2)}元` }));
  }

  const finance = hasPermission(user, "expenses.view")
    ? await scopedRows("expenses", user, { status: "已通过" }, { max: 1000 }, "expenses.view")
    : [];
  const financeCustomerMap = await mapById("customers", finance.map((item) => item.customerId));
  let audit = [];
  if (hasPermission(user, "reports.audit.view")) {
    audit = (await fetchAll("audit_logs", {}, { max: 500, orderBy: { field: "createdAt", direction: "desc" } }))
      .filter((item) => hasPermission(user, "reports.audit.view", { ...item, repId: item.actorId, ownerId: item.actorId }));
  }

  return {
    user: safeUser(user),
    commissions: [...grouped.values()].map((item) => ({
      ...item,
      ownerName: userMap.get(item.ownerId)?.name || "",
      roleName: roleLabel(item.role)
    })),
    policies: policies.map((item) => ({
      id: item._id,
      customerName: policyCustomerMap.get(item.customerId)?.name || "未配置客户",
      productName: `${productMap.get(item.productId)?.name || ""}${productMap.get(item.productId)?.spec || item.productId}`,
      invoicePrice: item.invoicePrice,
      promoSpend: item.promoSpend,
      monthlyTarget: item.monthlyTarget,
      start: item.start,
      end: item.end,
      status: item.status
    })),
    weekly: weekly.map((item) => ({
      id: item._id,
      title: item.type === "customer" ? weeklyCustomerMap.get(item.customerId)?.name || item.title : item.title,
      week: item.week,
      status: item.status,
      note: item.note,
      canSubmit: hasPermission(user, "reports.weekly.submit", { ...item, ownerId: item.ownerId }) && item.ownerId === userBusinessId(user) && item.status === "未提交"
    })),
    risks,
    finance: finance.map((item) => ({
      id: item._id,
      repName: userMap.get(item.repId)?.name || "",
      customerName: financeCustomerMap.get(item.customerId)?.name || "未配置客户",
      type: item.type,
      amount: item.amount,
      status: item.status,
      paymentStatus: item.paymentStatus,
      invoiceStatus: item.invoiceStatus,
      canMarkPaid: hasPermission(user, "expenses.pay", item) && item.paymentStatus !== "已付款",
      canMarkInvoiced: hasPermission(user, "expenses.invoice", item) && item.invoiceStatus === "待收票"
    })),
    audit: audit.map((item) => ({
      id: item._id,
      action: item.action,
      actorName: item.actorName,
      target: item.target,
      detail: item.detail,
      createdAtText: String(item.createdAt || "").replace("T", " ").slice(0, 19)
    }))
  };
}

async function getBossPerformance(payload) {
  const user = await requireUser();
  assertPermission(user, "performance.view");
  const currentMonth = monthKey();
  const lastMonth = previousMonth(currentMonth);
  const selectedMonth = [currentMonth, lastMonth].includes(String(payload.month || "")) ? payload.month : currentMonth;
  const [allSales, users, warehouses, products] = await Promise.all([
    fetchAll("sales", { settlementMonth: selectedMonth, status: "已通过", correctionStatus: "正常" }, { max: 10000 }),
    fetchAll("users", { role: "manager", disabled: false }, { max: 3000 }),
    fetchAll("warehouses", {}, { max: 3000 }),
    fetchAll("products", {}, { max: 3000 })
  ]);
  const sales = allSales.filter((item) => hasPermission(user, "performance.view", item));
  const managerMap = new Map(users.map((item) => [userBusinessId(item), item]));
  const warehouseMap = new Map(warehouses.map((item) => [item._id, item]));
  const productMap = new Map(products.map((item) => [item._id, item]));
  const rows = new Map();
  const ensureManager = (managerId) => {
    if (!rows.has(managerId)) {
      const manager = managerMap.get(managerId);
      rows.set(managerId, {
        id: managerId,
        name: manager?.name || "历史经理/未配置",
        province: manager?.province || manager?.department || "",
        amount: 0,
        qty: 0,
        products: new Map(),
        warehouses: new Map()
      });
    }
    return rows.get(managerId);
  };
  users.forEach((item) => ensureManager(userBusinessId(item)));
  for (const sale of sales) {
    const manager = ensureManager(sale.managerId || "unassigned");
    const total = calcSale(sale);
    manager.amount = calc4(manager.amount + total.amount);
    manager.qty += total.qty;
    if (!manager.warehouses.has(sale.warehouseId)) {
      manager.warehouses.set(sale.warehouseId, {
        id: sale.warehouseId,
        name: warehouseMap.get(sale.warehouseId)?.name || "未配置仓库",
        amount: 0,
        qty: 0,
        products: new Map()
      });
    }
    const warehouse = manager.warehouses.get(sale.warehouseId);
    warehouse.amount = calc4(warehouse.amount + total.amount);
    warehouse.qty += total.qty;
    for (const line of sale.lines || []) {
      const product = productMap.get(line.productId);
      const label = product ? `${product.name}${product.spec}` : line.productId;
      const managerProduct = manager.products.get(line.productId) || { id: line.productId, label, qty: 0 };
      managerProduct.qty += Number(line.qty || 0);
      manager.products.set(line.productId, managerProduct);
      const warehouseProduct = warehouse.products.get(line.productId) || { id: line.productId, label, qty: 0 };
      warehouseProduct.qty += Number(line.qty || 0);
      warehouse.products.set(line.productId, warehouseProduct);
    }
  }
  return {
    selectedMonth,
    currentMonth,
    lastMonth,
    managers: [...rows.values()]
      .map((item) => ({
        ...item,
        products: [...item.products.values()].sort((a, b) => b.qty - a.qty),
        warehouses: [...item.warehouses.values()]
          .map((warehouse) => ({ ...warehouse, products: [...warehouse.products.values()].sort((a, b) => b.qty - a.qty) }))
          .sort((a, b) => b.amount - a.amount)
      }))
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "zh-CN"))
  };
}

async function submitWeekly(payload) {
  const user = await requireUser();
  assertPermission(user, "reports.weekly.submit");
  const report = await getDoc("weekly_reports", payload.id);
  if (!report || report.ownerId !== userBusinessId(user) || report.status !== "未提交") fail("WEEKLY_FORBIDDEN", "周任务不存在、已经提交或不属于当前账号。");
  await updateDoc("weekly_reports", report._id, {
    status: "已提交",
    note: "已统计本周销售、费用、库存和下周计划。",
    submittedAt: nowIso(),
    submittedBy: userBusinessId(user)
  });
  await writeAudit(user, "提交周统计", report._id, report.title);
  return { status: "已提交" };
}

async function approvePolicy(payload) {
  const user = await requireUser();
  const policy = await getDoc("policies", payload.id);
  if (policy) assertPermission(user, "policies.approve", policy);
  if (!policy || policy.status !== "待老板审核") fail("POLICY_NOT_APPROVABLE", "政策不存在或已经处理。");
  const amounts = [policy.invoicePrice, policy.retailPrice, policy.headRebate, policy.noInvoiceRebate, policy.promoSpend];
  if (!validDate(policy.start) || !validDate(policy.end) || policy.start > policy.end
    || !positiveNumber(policy.invoicePrice) || !amounts.every((value) => nonNegativeNumber(value))
    || !positiveNumber(policy.monthlyTarget, 1000000, true)) {
    fail("POLICY_INVALID", "政策中的日期、销售价、返利、推广费用或预计月销不合法。");
  }
  await db.runTransaction(async (transaction) => {
    const current = (await transaction.collection("policies").doc(policy._id).get()).data;
    if (current.status !== "待老板审核") fail("POLICY_NOT_APPROVABLE", "政策不存在或已经处理。");
    await transaction.collection("policies").doc(policy._id).update({ data: {
      status: "老板已通过",
      approvedBy: userBusinessId(user),
      approvedAt: nowIso()
    } });
  });
  await writeAudit(user, "老板审核客户政策", policy._id, "政策审核通过");
  return { status: "老板已通过" };
}

async function rejectPolicy(payload) {
  const user = await requireUser();
  const reason = String(payload.reason || "").trim();
  if (reason.length < 2 || reason.length > 200) fail("INVALID_REJECT_REASON", "驳回原因需填写2到200个字。");
  const policy = await getDoc("policies", payload.id);
  if (policy) assertPermission(user, "policies.reject", policy);
  if (!policy || policy.status !== "待老板审核") fail("POLICY_NOT_APPROVABLE", "政策不存在或已经处理。");
  await db.runTransaction(async (transaction) => {
    const current = (await transaction.collection("policies").doc(policy._id).get()).data;
    if (current.status !== "待老板审核") fail("POLICY_NOT_APPROVABLE", "政策不存在或已经处理。");
    await transaction.collection("policies").doc(policy._id).update({ data: {
      status: "老板驳回",
      rejectedReason: reason,
      rejectedBy: userBusinessId(user),
      rejectedAt: nowIso()
    } });
  });
  await writeAudit(user, "老板驳回客户政策", policy._id, reason);
  return { status: "老板驳回" };
}

module.exports = { getReports, getBossPerformance, submitWeekly, approvePolicy, rejectPolicy, isoWeek, ensureWeeklyTasks };
