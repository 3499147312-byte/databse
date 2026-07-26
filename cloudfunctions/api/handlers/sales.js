const crypto = require("crypto");
const {
  db,
  command,
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
  validBatchNo,
  calcSale
} = require("../lib/core");
const {
  lotId,
  mapById,
  visibleStores,
  scopedRows,
  getLineRule,
  rebuildReceivable
} = require("../lib/domain");

function newId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(7).toString("hex")}`;
}

function dailyReportId(repId, date) {
  return `daily_${crypto.createHash("sha256").update(`${repId}|${date}`).digest("hex").slice(0, 40)}`;
}

async function userNameMap() {
  const users = await fetchAll("users", {});
  return new Map(users.map((item) => [userBusinessId(item), item.name]));
}

async function getSalesPage() {
  const user = await requireUser();
  assertPermission(user, "sales.view");
  const userId = userBusinessId(user);
  const stores = await visibleStores(user);
  const customerMap = await mapById("customers", stores.map((item) => item.customerId));
  const warehouseMap = await mapById("warehouses", stores.map((item) => item.warehouseId));
  const products = await fetchAll("products", { status: command.neq("停用") });
  const sales = await scopedRows("sales", user, {}, { max: 500, orderBy: { field: "createdAt", direction: "desc" } });
  const saleCustomerMap = await mapById("customers", sales.map((item) => item.customerId));
  const saleWarehouseMap = await mapById("warehouses", sales.map((item) => item.warehouseId));
  const productMap = await mapById("products", sales.flatMap((item) => (item.lines || []).map((line) => line.productId)));
  const names = await userNameMap();
  const dailyReport = user.role === "rep" ? await getDoc("daily_reports", dailyReportId(userId, localDate())) : null;

  return {
    isRep: user.role === "rep",
    dailySubmitted: Boolean(dailyReport?.submitted),
    canSubmit: hasPermission(user, "sales.submit") && user.role === "rep" && stores.length > 0,
    stores: stores.map((item) => ({
      id: item._id,
      label: `${customerMap.get(item.customerId)?.name || "未配置客户"} - ${item.name}`,
      warehouseId: item.warehouseId,
      warehouseName: warehouseMap.get(item.warehouseId)?.name || ""
    })),
    products: products.map((item) => ({ id: item._id, label: `${item.name}${item.spec}` })),
    sales: sales.map((sale) => {
      const total = calcSale(sale);
      return {
        id: sale._id,
        date: sale.date,
        repName: names.get(sale.repId) || "",
        customerName: saleCustomerMap.get(sale.customerId)?.name || "未配置客户",
        warehouseName: saleWarehouseMap.get(sale.warehouseId)?.name || "未配置仓库",
        lineText: (sale.lines || []).map((line) => `${productMap.get(line.productId)?.spec || line.productId} × ${line.qty}盒 · 批号${line.batchNo}`).join("；"),
        amount: total.amount,
        status: sale.correctionStatus && sale.correctionStatus !== "正常" ? sale.correctionStatus : sale.status,
        canCorrect: hasPermission(user, "sales.correct", sale) && sale.status === "已通过" && sale.correctionStatus === "正常"
      };
    })
  };
}

async function submitSale(payload) {
  const user = await requireUser();
  assertPermission(user, "sales.submit");
  if (user.role !== "rep") fail("INVALID_POSITION", "只有业务代表岗位可以填报销售。");
  return withIdempotency(user, payload.idempotencyKey, "submitSale", async () => {
    const repId = userBusinessId(user);
    const store = await getDoc("stores", payload.storeId);
    if (!store || store.status === "停用" || store.repId !== repId) fail("STORE_FORBIDDEN", "该门店不属于当前业务代表。");
    const customer = await getDoc("customers", store.customerId);
    const warehouse = await getDoc("warehouses", store.warehouseId);
    if (!customer || customer.status === "停用" || !warehouse || warehouse.status === "停用") {
      fail("MASTER_DATA_DISABLED", "客户或仓库不存在、已停用。");
    }
    if (!user.managerId || customer.managerId !== user.managerId || warehouse.managerId !== user.managerId) {
      fail("WAREHOUSE_TEAM_FORBIDDEN", "客户、门店或仓库不属于当前业务代表所在经理团队。");
    }
    const sourceLines = Array.isArray(payload.lines) ? payload.lines : [{
      productId: payload.productId,
      qty: payload.qty,
      batchNo: payload.batchNo
    }];
    if (!sourceLines.length || sourceLines.length > 20) fail("INVALID_LINES", "一张销售单必须包含1至20条产品明细。");
    const combined = new Map();
    for (const source of sourceLines) {
      const productId = String(source.productId || "");
      const batchNo = String(source.batchNo || "").trim();
      const qty = Number(source.qty);
      if (!positiveNumber(qty, 1000000, true)) fail("INVALID_QTY", "每条销售数量必须是1到100万之间的整数。");
      if (!validBatchNo(batchNo)) fail("INVALID_BATCH", "销售批号格式不正确。");
      const key = `${productId}|${batchNo}`;
      combined.set(key, {
        productId,
        batchNo,
        qty: Number(combined.get(key)?.qty || 0) + qty
      });
    }
    const lines = [];
    for (const line of combined.values()) {
      if (!positiveNumber(line.qty, 1000000, true)) fail("INVALID_QTY", "合并后的销售数量超过允许范围。");
      const lot = await getDoc("inventory_lots", lotId(store.warehouseId, line.productId, line.batchNo));
      if (!lot || Number(lot.qty || 0) <= 0 || lot.expiryDate < localDate()) {
        fail("BATCH_UNAVAILABLE", `仓库没有产品${line.productId}的有效批号${line.batchNo}，或批号已经过期。`);
      }
      lines.push({
        ...line,
        ruleSnapshot: await getLineRule(customer, line.productId, localDate())
      });
    }
    const id = newId("sale");
    const sale = {
      date: localDate(),
      settlementMonth: monthKey(),
      repId,
      supervisorId: customer.supervisorId,
      managerId: customer.managerId,
      customerId: customer._id,
      storeId: store._id,
      warehouseId: warehouse._id,
      status: customer.supervisorId ? "待主管审核" : "待经理审核",
      correctionStatus: "正常",
      lines,
      approvalTrail: [],
      createdBy: user._id,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    await setDoc("sales", id, sale);
    const reportId = dailyReportId(repId, sale.date);
    await setDoc("daily_reports", reportId, {
      repId,
      supervisorId: customer.supervisorId,
      managerId: customer.managerId,
      date: sale.date,
      submitted: true,
      submittedAt: nowIso()
    });
    const totalQty = lines.reduce((sum, line) => sum + line.qty, 0);
    await writeAudit(user, "提交销售日报", id, `${customer.name} / ${lines.length}条明细 / ${totalQty}盒`);
    return { id, status: sale.status };
  });
}

async function submitZeroDaily() {
  const user = await requireUser();
  assertPermission(user, "sales.zero");
  if (user.role !== "rep") fail("INVALID_POSITION", "只有业务代表岗位可以提交零销售日报。");
  const repId = userBusinessId(user);
  const date = localDate();
  const id = dailyReportId(repId, date);
  const existing = await getDoc("daily_reports", id);
  if (existing?.submitted) return { status: "已提交" };
  await setDoc("daily_reports", id, {
    repId,
    supervisorId: user.supervisorId || "",
    managerId: user.managerId || "",
    date,
    submitted: true,
    zeroSalesDeclared: true,
    submittedAt: nowIso()
  });
  await writeAudit(user, "提交零销售日报", id, `${date}无销量`);
  return { status: "已提交" };
}

async function approveSale(payload) {
  const user = await requireUser();
  const sale = await getDoc("sales", payload.id);
  if (!sale) fail("SALE_FORBIDDEN", "销售单不存在或不在当前权限范围。");
  const userId = userBusinessId(user);

  if (sale.status === "待主管审核") {
    const authority = await assertApprovalAuthority(user, sale, "sales", "supervisor");
    await db.runTransaction(async (transaction) => {
      const current = (await transaction.collection("sales").doc(sale._id).get()).data;
      if (current.status !== "待主管审核" || current.supervisorId !== sale.supervisorId) {
        fail("SALE_CHANGED", "销售单状态已经变化，请刷新后重试。");
      }
      await transaction.collection("sales").doc(sale._id).update({
        data: {
          status: "待经理审核",
          approvalTrail: command.push({
            role: "supervisor",
            userId,
            actorName: user.name,
            delegated: authority.delegated,
            delegationId: authority.delegation?._id || "",
            time: nowIso()
          }),
          updatedAt: nowIso()
        }
      });
    });
    await writeAudit(
      user,
      authority.delegated ? "代理主管审核销售" : "主管审核销售",
      sale._id,
      authority.delegated
        ? `主管级通过；代理岗位=主管；团队=${sale.managerId}；授权=${authority.delegation._id}`
        : "主管级通过，流转到经理审核"
    );
    return { status: "待经理审核" };
  }

  if (sale.status !== "待经理审核") fail("WRONG_APPROVAL_LEVEL", "销售单当前不在经理审核阶段。");
  const authority = await assertApprovalAuthority(user, sale, "sales", "manager");

  await db.runTransaction(async (transaction) => {
    const current = (await transaction.collection("sales").doc(sale._id).get()).data;
    if (current.status !== "待经理审核" || current.managerId !== sale.managerId) fail("SALE_CHANGED", "销售单状态已经变化，请刷新后重试。");
    for (const line of current.lines || []) {
      const id = lotId(current.warehouseId, line.productId, line.batchNo);
      const lot = (await transaction.collection("inventory_lots").doc(id).get()).data;
      if (!lot || lot.expiryDate < current.date || Number(lot.qty || 0) < Number(line.qty || 0)) {
        fail("INSUFFICIENT_INVENTORY", `批号${line.batchNo}库存不足或已经过期，不能最终通过。`);
      }
      await transaction.collection("inventory_lots").doc(id).update({
        data: { qty: command.inc(-Number(line.qty)), updatedAt: nowIso() }
      });
    }
    await transaction.collection("sales").doc(current._id).update({
      data: {
        status: "已通过",
        approvedAt: nowIso(),
        approvalTrail: command.push({
          role: "manager",
          userId,
          actorName: user.name,
          delegated: authority.delegated,
          delegationId: authority.delegation?._id || "",
          time: nowIso()
        }),
        updatedAt: nowIso()
      }
    });
  });

  await rebuildReceivable(sale.warehouseId, sale.settlementMonth);
  await writeAudit(
    user,
    authority.delegated ? "代理经理审核销售" : "经理审核销售",
    sale._id,
    authority.delegated
      ? `经理级最终通过；代理岗位=经理；团队=${sale.managerId}；授权=${authority.delegation._id}`
      : "经理级最终通过，库存、业绩、提成和应收生效"
  );
  return { status: "已通过" };
}

async function rejectSale(payload) {
  const user = await requireUser();
  const reason = String(payload.reason || "").trim();
  if (reason.length < 2 || reason.length > 200) fail("INVALID_REJECT_REASON", "驳回原因需填写2到200个字。");
  const sale = await getDoc("sales", payload.id);
  if (!sale) fail("SALE_FORBIDDEN", "销售单不存在或不在当前权限范围。");
  const id = userBusinessId(user);
  const stage = sale.status === "待主管审核" ? "supervisor" : sale.status === "待经理审核" ? "manager" : "";
  if (!stage) fail("WRONG_APPROVAL_LEVEL", "当前销售单不在可驳回的审批阶段。");
  const authority = await assertApprovalAuthority(user, sale, "sales", stage);
  const status = stage === "supervisor" ? "主管驳回" : "经理驳回";
  await db.runTransaction(async (transaction) => {
    const current = (await transaction.collection("sales").doc(sale._id).get()).data;
    const expectedStatus = stage === "supervisor" ? "待主管审核" : "待经理审核";
    if (current.status !== expectedStatus) fail("SALE_CHANGED", "销售单状态已经变化，请刷新后重试。");
    await transaction.collection("sales").doc(sale._id).update({
      data: {
        status,
        rejectedReason: reason,
        rejectedBy: id,
        rejectedAt: nowIso(),
        approvalTrail: command.push({
          role: stage,
          userId: id,
          actorName: user.name,
          delegated: authority.delegated,
          delegationId: authority.delegation?._id || "",
          result: "驳回",
          reason,
          time: nowIso()
        }),
        updatedAt: nowIso()
      }
    });
  });
  await writeAudit(
    user,
    authority.delegated ? "代理驳回销售日报" : "驳回销售日报",
    sale._id,
    authority.delegated
      ? `${reason}；代理岗位=${stage === "supervisor" ? "主管" : "经理"}；团队=${sale.managerId}；授权=${authority.delegation._id}`
      : reason
  );
  return { status };
}

async function correctSale(payload) {
  const user = await requireUser();
  if (!["作废", "退货"].includes(payload.type) || String(payload.reason || "").trim().length < 2 || String(payload.reason).trim().length > 200) {
    fail("INVALID_CORRECTION", "纠错类型或原因不正确。");
  }
  const sale = await getDoc("sales", payload.saleId);
  if (!sale) fail("SALE_FORBIDDEN", "销售单不存在或不在当前权限范围。");
  assertPermission(user, "sales.correct", sale);
  return withIdempotency(user, payload.idempotencyKey, "correctSale", async () => {
    await db.runTransaction(async (transaction) => {
      const current = (await transaction.collection("sales").doc(sale._id).get()).data;
      if (current.status !== "已通过" || current.correctionStatus !== "正常") fail("SALE_NOT_CORRECTABLE", "只有正常状态的已通过销售单可以纠错。");
      for (const line of current.lines || []) {
        const id = lotId(current.warehouseId, line.productId, line.batchNo);
        await transaction.collection("inventory_lots").doc(id).update({
          data: { qty: command.inc(Number(line.qty)), updatedAt: nowIso() }
        });
      }
      await transaction.collection("sales").doc(current._id).update({
        data: {
          correctionStatus: payload.type === "退货" ? "已退货" : "已作废",
          correctedAt: nowIso(),
          correctedBy: userBusinessId(user),
          correctionReason: String(payload.reason).trim(),
          updatedAt: nowIso()
        }
      });
    });
    const correctionId = newId("correction");
    await setDoc("corrections", correctionId, {
      saleId: sale._id,
      type: payload.type,
      reason: String(payload.reason).trim(),
      actorId: userBusinessId(user),
      actorName: user.name,
      managerId: sale.managerId,
      supervisorId: sale.supervisorId,
      repId: sale.repId,
      createdAt: nowIso()
    });
    await rebuildReceivable(sale.warehouseId, sale.settlementMonth);
    await writeAudit(user, `${payload.type}销售单`, sale._id, String(payload.reason).trim());
    return { status: payload.type === "退货" ? "已退货" : "已作废" };
  });
}

module.exports = { getSalesPage, submitSale, submitZeroDaily, approveSale, rejectSale, correctSale };
