const crypto = require("crypto");
const {
  db,
  command,
  fetchAll,
  getDoc,
  updateDoc,
  requireUser,
  assertRole,
  canSeeScoped,
  writeAudit,
  withIdempotency,
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
  calc4,
  roleLabel
} = require("../lib/core");
const {
  visibleWarehouses,
  decorateReceivables,
  rebuildReceivable
} = require("../lib/domain");

async function getReceivables(payload) {
  const user = await requireUser();
  assertRole(user, ["manager", "boss", "finance"]);
  const selectedMonth = /^\d{4}-\d{2}$/.test(String(payload.month || "")) ? payload.month : monthKey();
  const hasGlobalFinanceAccess = ["boss", "finance"].includes(user.role);
  const allReceivables = hasGlobalFinanceAccess
    ? await fetchAll("receivables", {})
    : await fetchAll("receivables", { managerId: userBusinessId(user) });
  const visible = allReceivables.filter((item) => Number(item.dueAmount || 0) > 0 || Number(item.paidAmount || 0) > 0);
  const decoratedAll = await decorateReceivables(user, visible);
  const plans = decoratedAll.filter((item) => monthKey(item.dueDate) === selectedMonth);
  const payments = hasGlobalFinanceAccess
    ? await fetchAll("warehouse_payments", {}, { max: 1000, orderBy: { field: "registeredAt", direction: "desc" } })
    : await fetchAll("warehouse_payments", { managerId: userBusinessId(user) }, { max: 1000, orderBy: { field: "registeredAt", direction: "desc" } });
  const activePayments = payments.filter((item) => item.status !== "已作废");
  const receivedThisMonth = activePayments
    .filter((item) => monthKey(item.paymentDate) === selectedMonth)
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const dueAmount = plans.reduce((sum, item) => sum + item.dueAmount, 0);
  const paidAgainstDue = plans.reduce((sum, item) => sum + Math.min(item.dueAmount, item.paidAmount), 0);
  const outstanding = plans.reduce((sum, item) => sum + item.outstanding, 0);
  const overdue = decoratedAll.filter((item) => item.dueDate < localDate()).reduce((sum, item) => sum + item.outstanding, 0);
  const users = await fetchAll("users", {});
  const userMap = new Map(users.map((item) => [userBusinessId(item), item]));
  const warehouseRows = hasGlobalFinanceAccess
    ? await fetchAll("warehouses", { status: command.neq("停用") })
    : await visibleWarehouses(user);
  const warehouseMap = new Map(warehouseRows.map((item) => [item._id, item]));
  const warehouseTerms = [...warehouseMap.values()].map((item) => ({
    id: item._id,
    name: item.name,
    province: item.province,
    managerId: item.managerId || "",
    managerName: userMap.get(item.managerId)?.name || "",
    creditDays: Number(item.creditDays || 0)
  }));

  return {
    user: safeUser(user),
    summary: {
      dueAmount: calc4(dueAmount),
      receivedThisMonth: calc4(receivedThisMonth),
      paidAgainstDue: calc4(paidAgainstDue),
      outstanding: calc4(outstanding),
      overdue: calc4(overdue)
    },
    plans,
    payments: payments.map((item) => ({
      id: item._id,
      warehouseName: warehouseMap.get(item.warehouseId)?.name || item.warehouseName || "未配置仓库",
      settlementMonth: item.settlementMonth,
      paymentDate: item.paymentDate,
      amount: Number(item.amount || 0),
      reference: item.reference || "",
      note: item.note || "",
      status: item.status,
      registeredByName: userMap.get(item.registeredBy)?.name || item.registeredByName || "",
      canVerify: ["boss", "finance"].includes(user.role) && ["待老板核实", "待财务确认"].includes(item.status),
      canVoid: item.status !== "已作废" && (["boss", "finance"].includes(user.role) || (["待老板核实", "待财务确认"].includes(item.status) && item.registeredBy === userBusinessId(user)))
    })),
    warehouseTerms,
    managers: user.role === "boss"
      ? users.filter((item) => item.role === "manager" && !item.disabled).map((item) => ({ id: userBusinessId(item), label: `${item.name} · ${item.province || item.department}` }))
      : []
  };
}

async function recordWarehousePayment(payload) {
  const user = await requireUser();
  assertRole(user, ["manager", "boss", "finance"]);
  return withIdempotency(user, payload.idempotencyKey, "recordWarehousePayment", async () => {
    const amount = Number(payload.amount);
    const note = String(payload.note || "").trim();
    const reference = String(payload.reference || "").trim();
    if (!positiveNumber(amount, 1000000000) || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
      fail("INVALID_PAYMENT_AMOUNT", "到账金额必须大于0，并保留最多2位小数。");
    }
    if (!validDate(payload.paymentDate) || payload.paymentDate > localDate()) fail("INVALID_PAYMENT_DATE", "到账日期必须是今天或以前的合法日期。");
    if (note.length < 2 || note.length > 200 || reference.length > 100) fail("INVALID_PAYMENT_NOTE", "回款说明需填写2到200个字，流水号最长100个字。");
    const id = `payment_${Date.now()}_${crypto.randomBytes(7).toString("hex")}`;
    let payment;
    await db.runTransaction(async (transaction) => {
      const receivable = (await transaction.collection("receivables").doc(payload.receivableId).get()).data;
      if (!receivable || (!["boss", "finance"].includes(user.role) && !canSeeScoped(user, receivable))) fail("RECEIVABLE_FORBIDDEN", "应收计划不存在或不在当前权限范围。");
      const outstanding = calc4(Number(receivable.dueAmount || 0) - Number(receivable.paidAmount || 0));
      if (amount > outstanding) fail("PAYMENT_EXCEEDS_OUTSTANDING", `本次登记不能超过未回金额${outstanding.toFixed(2)}元。`);
      payment = {
        receivableId: receivable._id,
        warehouseId: receivable.warehouseId,
        managerId: receivable.managerId,
        settlementMonth: receivable.settlementMonth,
        paymentDate: payload.paymentDate,
        amount: calc4(amount),
        reference,
        note,
        status: user.role === "boss" ? "老板已核实" : user.role === "finance" ? "财务已确认" : "待财务确认",
        registeredBy: userBusinessId(user),
        registeredByName: user.name,
        registeredAt: nowIso(),
        verifiedBy: ["boss", "finance"].includes(user.role) ? userBusinessId(user) : "",
        verifiedAt: ["boss", "finance"].includes(user.role) ? nowIso() : ""
      };
      await transaction.collection("warehouse_payments").doc(id).set({ data: payment });
      await transaction.collection("receivables").doc(receivable._id).update({
        data: { paidAmount: command.inc(calc4(amount)), updatedAt: nowIso() }
      });
    });
    await writeAudit(user, "登记仓库回款", id, `${payment.settlementMonth}销售 / ${payment.amount.toFixed(2)}元 / ${payment.status}`);
    return { id, status: payment.status };
  });
}

async function verifyWarehousePayment(payload) {
  const user = await requireUser();
  assertRole(user, ["boss", "finance"]);
  const payment = await getDoc("warehouse_payments", payload.paymentId);
  if (!payment || !["待老板核实", "待财务确认"].includes(payment.status)) fail("PAYMENT_NOT_VERIFIABLE", "回款不存在或当前不需要核实。");
  const status = user.role === "finance" ? "财务已确认" : "老板已核实";
  await updateDoc("warehouse_payments", payment._id, {
    status,
    verifiedBy: userBusinessId(user),
    verifiedAt: nowIso()
  });
  await writeAudit(user, "核实仓库回款", payment._id, `${payment.settlementMonth}销售 / ${Number(payment.amount).toFixed(2)}元`);
  return { status };
}

async function voidWarehousePayment(payload) {
  const user = await requireUser();
  assertRole(user, ["manager", "boss", "finance"]);
  const reason = String(payload.reason || "").trim();
  if (reason.length < 2 || reason.length > 200) fail("INVALID_VOID_REASON", "撤销原因需填写2到200个字。");
  const original = await getDoc("warehouse_payments", payload.paymentId);
  if (!original) fail("PAYMENT_NOT_FOUND", "回款记录不存在。");
  const ownPending = user.role === "manager"
    && ["待老板核实", "待财务确认"].includes(original.status)
    && original.registeredBy === userBusinessId(user)
    && original.managerId === userBusinessId(user);
  if (!["boss", "finance"].includes(user.role) && !ownPending) fail("PAYMENT_VOID_FORBIDDEN", "经理只能撤销自己登记且尚未核实的回款。");

  await db.runTransaction(async (transaction) => {
    const payment = (await transaction.collection("warehouse_payments").doc(original._id).get()).data;
    if (payment.status === "已作废") fail("PAYMENT_ALREADY_VOID", "该回款已经撤销。");
    const receivable = (await transaction.collection("receivables").doc(payment.receivableId).get()).data;
    await transaction.collection("warehouse_payments").doc(payment._id).update({
      data: {
        status: "已作废",
        voidReason: reason,
        voidedBy: userBusinessId(user),
        voidedAt: nowIso()
      }
    });
    await transaction.collection("receivables").doc(receivable._id).update({
      data: { paidAmount: command.inc(-Number(payment.amount)), updatedAt: nowIso() }
    });
  });
  await writeAudit(user, "撤销仓库回款", original._id, `${Number(original.amount).toFixed(2)}元；原因：${reason}`);
  return { status: "已作废" };
}

async function updateWarehouseTerm(payload) {
  const user = await requireUser();
  assertRole(user, ["boss"]);
  const warehouse = await getDoc("warehouses", payload.warehouseId);
  const managers = await fetchAll("users", { role: "manager", disabled: false });
  const manager = managers.find((item) => userBusinessId(item) === payload.managerId);
  const creditDays = Number(payload.creditDays);
  if (!warehouse || !manager) fail("WAREHOUSE_TERM_INVALID", "仓库或负责人经理不存在。");
  if (!Number.isInteger(creditDays) || creditDays < 0 || creditDays > 365) fail("WAREHOUSE_TERM_INVALID", "账期必须是0到365之间的整数天。");
  await updateDoc("warehouses", warehouse._id, {
    managerId: userBusinessId(manager),
    creditDays,
    termUpdatedBy: userBusinessId(user),
    termUpdatedAt: nowIso()
  });
  const receivables = await fetchAll("receivables", { warehouseId: warehouse._id });
  for (const item of receivables) {
    await updateDoc("receivables", item._id, { managerId: userBusinessId(manager), updatedAt: nowIso() });
  }
  await rebuildReceivable(warehouse._id, monthKey());
  await writeAudit(user, "设置仓库账期", warehouse._id, `${warehouse.name} / ${manager.name} / 月底+${creditDays}天`);
  return { warehouseId: warehouse._id };
}

module.exports = {
  getReceivables,
  recordWarehousePayment,
  verifyWarehousePayment,
  voidWarehousePayment,
  updateWarehouseTerm
};
