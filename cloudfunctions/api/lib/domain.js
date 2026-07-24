const crypto = require("crypto");
const {
  db,
  command,
  fetchAll,
  getDoc,
  setDoc,
  updateDoc,
  scopeWhere,
  canSeeScoped,
  userBusinessId,
  fail
} = require("./context");
const {
  nowIso,
  localDate,
  monthKey,
  monthEndPlusDays,
  calc4,
  calcSale,
  receivableStatus,
  warehouseManagerIdForUser
} = require("./core");

const standardPolicy = {
  normal: { salePrice: 111.7, repCommission: 3, supervisorCommission: 1.5, managerCommission: 0.75, promoBudget: 20 }
};

function lotId(warehouseId, productId, batchNo) {
  return `lot_${crypto.createHash("sha256").update(`${warehouseId}|${productId}|${batchNo}`).digest("hex").slice(0, 40)}`;
}

function receivableId(warehouseId, settlementMonth) {
  return `recv_${crypto.createHash("sha256").update(`${warehouseId}|${settlementMonth}`).digest("hex").slice(0, 40)}`;
}

async function mapById(collectionName, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const result = new Map();
  for (let index = 0; index < unique.length; index += 20) {
    const group = unique.slice(index, index + 20);
    const rows = await fetchAll(collectionName, { _id: command.in(group) }, { max: group.length });
    rows.forEach((item) => result.set(item._id, item));
  }
  return result;
}

async function visibleStores(user) {
  const id = userBusinessId(user);
  if (user.role === "rep") {
    if (!user.managerId) return [];
    return fetchAll("stores", { repId: id, managerId: user.managerId, status: command.neq("停用") });
  }
  if (user.role === "boss") return fetchAll("stores", { status: command.neq("停用") });
  if (!["manager", "supervisor"].includes(user.role)) return [];
  const field = user.role === "manager" ? "managerId" : "supervisorId";
  return fetchAll("stores", { [field]: id, status: command.neq("停用") });
}

async function visibleWarehouses(user) {
  if (user.role === "boss") return fetchAll("warehouses", { status: command.neq("停用") });
  const managerId = warehouseManagerIdForUser(user);
  if (!managerId) return [];
  return fetchAll("warehouses", { managerId, status: command.neq("停用") });
}

async function visibleCustomers(user) {
  const id = userBusinessId(user);
  if (user.role === "boss") return fetchAll("customers", { status: command.neq("停用") });
  if (user.role === "manager") return fetchAll("customers", { managerId: id, status: command.neq("停用") });
  if (user.role === "supervisor") return fetchAll("customers", { supervisorId: id, status: command.neq("停用") });
  if (user.role !== "rep") return [];
  const stores = await visibleStores(user);
  const ids = [...new Set(stores.map((item) => item.customerId))];
  if (!ids.length) return [];
  return fetchAll("customers", { _id: command.in(ids), status: command.neq("停用") });
}

async function scopedRows(collectionName, user, extraWhere = {}, options = {}) {
  if (user.role === "boss") return fetchAll(collectionName, extraWhere, options);
  const scope = scopeWhere(user);
  if (!scope) return [];
  const where = { ...extraWhere, ...scope };
  return fetchAll(collectionName, where, options);
}

async function getLineRule(customer, productId, date) {
  const product = await getDoc("products", productId);
  if (!product || product.status === "停用") fail("PRODUCT_NOT_FOUND", "产品不存在或已停用。");
  const policies = await fetchAll("policies", {
    customerId: customer._id,
    productId,
    status: "老板已通过",
    start: command.lte(date),
    end: command.gte(date)
  }, { max: 5 });
  const policy = policies.sort((a, b) => String(b.approvedAt || "").localeCompare(String(a.approvedAt || "")))[0];
  const base = standardPolicy.normal;
  const ratio = Number(product.ratio || 1);
  return {
    salePrice: calc4(policy?.invoicePrice === undefined ? base.salePrice * ratio : Number(policy.invoicePrice)),
    promoBudget: calc4(policy?.promoSpend === undefined ? base.promoBudget * ratio : Number(policy.promoSpend)),
    repCommission: calc4(policy?.repCommission === undefined ? base.repCommission * ratio : Number(policy.repCommission)),
    supervisorCommission: calc4(policy?.supervisorCommission === undefined ? base.supervisorCommission * ratio : Number(policy.supervisorCommission)),
    managerCommission: calc4(policy?.managerCommission === undefined ? base.managerCommission * ratio : Number(policy.managerCommission))
  };
}

async function activePaymentTotals(receivableIds) {
  const totals = new Map();
  if (!receivableIds.length) return totals;
  for (let index = 0; index < receivableIds.length; index += 20) {
    const ids = receivableIds.slice(index, index + 20);
    const rows = await fetchAll("warehouse_payments", {
      receivableId: command.in(ids),
      status: command.neq("已作废")
    });
    rows.forEach((item) => totals.set(item.receivableId, calc4(Number(totals.get(item.receivableId) || 0) + Number(item.amount || 0))));
  }
  return totals;
}

async function rebuildReceivable(warehouseId, settlementMonth) {
  const warehouse = await getDoc("warehouses", warehouseId);
  if (!warehouse) return null;
  const sales = await fetchAll("sales", {
    warehouseId,
    settlementMonth,
    status: "已通过",
    correctionStatus: "正常"
  });
  const dueAmount = calc4(sales.reduce((sum, sale) => sum + calcSale(sale).amount, 0));
  const qty = sales.reduce((sum, sale) => sum + calcSale(sale).qty, 0);
  const id = receivableId(warehouseId, settlementMonth);
  const existing = await getDoc("receivables", id);
  const isOpenSalesMonth = settlementMonth >= monthKey();
  const creditDays = existing && !isOpenSalesMonth ? Number(existing.creditDays || 0) : Number(warehouse.creditDays || 0);
  const dueDate = existing && !isOpenSalesMonth ? existing.dueDate : monthEndPlusDays(settlementMonth, creditDays);
  const record = {
    warehouseId,
    managerId: warehouse.managerId || "",
    settlementMonth,
    creditDays,
    dueDate,
    dueAmount,
    paidAmount: calc4(existing?.paidAmount || 0),
    qty,
    sourceSaleIds: sales.map((item) => item._id).sort(),
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso()
  };
  await setDoc("receivables", id, record);
  return { _id: id, ...record };
}

async function decorateReceivables(user, rows) {
  const warehouseMap = await mapById("warehouses", rows.map((item) => item.warehouseId));
  const managerMap = await mapById("users", []);
  const managers = await fetchAll("users", { role: "manager" });
  managers.forEach((item) => {
    managerMap.set(userBusinessId(item), item);
  });
  const missingPaidRows = rows.filter((item) => item.paidAmount === undefined);
  const totals = missingPaidRows.length ? await activePaymentTotals(missingPaidRows.map((item) => item._id)) : new Map();
  return rows.filter((item) => user.role === "finance" || canSeeScoped(user, item)).map((item) => {
    const paidAmount = calc4(item.paidAmount === undefined ? totals.get(item._id) || 0 : item.paidAmount);
    const outstanding = calc4(Math.max(0, Number(item.dueAmount || 0) - paidAmount));
    return {
      id: item._id,
      warehouseId: item.warehouseId,
      warehouseName: warehouseMap.get(item.warehouseId)?.name || "未配置仓库",
      managerId: item.managerId,
      managerName: managerMap.get(item.managerId)?.name || "",
      settlementMonth: item.settlementMonth,
      dueDate: item.dueDate,
      qty: Number(item.qty || 0),
      dueAmount: calc4(item.dueAmount),
      paidAmount,
      outstanding,
      status: receivableStatus(item, paidAmount),
      canRecord: ["boss", "manager", "finance"].includes(user.role)
    };
  });
}

async function expenseBudget(repId, customerId, targetMonth = monthKey(), excludeExpenseId = "") {
  const sales = await fetchAll("sales", {
    repId,
    customerId,
    settlementMonth: targetMonth,
    status: "已通过",
    correctionStatus: "正常"
  });
  const budget = sales.reduce((sum, sale) => sum + calcSale(sale).promoBudget, 0);
  const expenses = await fetchAll("expenses", {
    repId,
    customerId,
    expenseMonth: targetMonth,
    status: command.nin(["主管驳回", "经理驳回", "已作废"])
  });
  const occupied = expenses
    .filter((item) => item._id !== excludeExpenseId)
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return calc4(budget - occupied);
}

module.exports = {
  lotId,
  receivableId,
  mapById,
  visibleStores,
  visibleWarehouses,
  visibleCustomers,
  scopedRows,
  getLineRule,
  activePaymentTotals,
  rebuildReceivable,
  decorateReceivables,
  expenseBudget
};
