const crypto = require("crypto");
const {
  db,
  command,
  fetchAll,
  getDoc,
  requireUser,
  assertPermission,
  hasPermission,
  writeAudit,
  withIdempotency,
  userBusinessId,
  fail
} = require("../lib/context");
const {
  localDate,
  nowIso,
  positiveNumber,
  validBatchNo,
  validDate,
  calc4
} = require("../lib/core");
const { lotId, visibleWarehouses, mapById } = require("../lib/domain");

async function getInventoryPage() {
  const user = await requireUser();
  assertPermission(user, "inventory.view");
  const warehouses = await visibleWarehouses(user);
  const warehouseIds = warehouses.map((item) => item._id);
  const products = await fetchAll("products", { status: command.neq("停用") });
  const lots = warehouseIds.length
    ? await fetchAll("inventory_lots", { warehouseId: command.in(warehouseIds) })
    : [];
  const warehouseMap = new Map(warehouses.map((item) => [item._id, item]));
  const managers = await fetchAll("users", { role: "manager", disabled: false });
  const managerMap = new Map(managers.map((item) => [userBusinessId(item), item]));
  const productMap = await mapById("products", lots.map((item) => item.productId));
  const balanceMap = new Map();
  lots.forEach((item) => {
    const key = `${item.warehouseId}|${item.productId}`;
    balanceMap.set(key, Number(balanceMap.get(key) || 0) + Number(item.qty || 0));
  });
  const balances = warehouses.flatMap((warehouse) => products.map((product) => {
    const qty = Number(balanceMap.get(`${warehouse._id}|${product._id}`) || 0);
    return {
      key: `${warehouse._id}_${product._id}`,
      warehouseName: warehouse.name,
      managerName: managerMap.get(warehouse.managerId)?.name || "未配置",
      productName: `${product.name}${product.spec}`,
      qty,
      status: qty < 100 ? "低库存预警" : "正常"
    };
  }));
  return {
    canReceive: hasPermission(user, "inventory.receive"),
    warehouses: warehouses.map((item) => ({
      id: item._id,
      name: item.name,
      managerName: managerMap.get(item.managerId)?.name || "未配置",
      displayName: `${item.name} · 负责人${managerMap.get(item.managerId)?.name || "未配置"}`
    })),
    products: products.map((item) => ({ id: item._id, label: `${item.name}${item.spec}` })),
    balances,
    lots: lots.sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate))).map((item) => {
      const days = Math.round((new Date(`${item.expiryDate}T00:00:00Z`) - new Date(`${localDate()}T00:00:00Z`)) / 86400000);
      return {
        id: item._id,
        warehouseName: warehouseMap.get(item.warehouseId)?.name || "未配置仓库",
        managerName: managerMap.get(warehouseMap.get(item.warehouseId)?.managerId)?.name || "未配置",
        productName: `${productMap.get(item.productId)?.name || ""}${productMap.get(item.productId)?.spec || item.productId}`,
        batchNo: item.batchNo,
        expiryDate: item.expiryDate,
        qty: Number(item.qty || 0),
        unitPrice: Number(item.unitPrice || 0),
        status: days <= 90 ? "近效期高风险" : days <= 180 ? "近效期预警" : "正常"
      };
    })
  };
}

async function receiveInventory(payload) {
  const user = await requireUser();
  assertPermission(user, "inventory.receive");
  return withIdempotency(user, payload.idempotencyKey, "receiveInventory", async () => {
    const visible = await visibleWarehouses(user, "inventory.receive");
    const warehouse = visible.find((item) => item._id === payload.warehouseId);
    const product = await getDoc("products", payload.productId);
    if (!warehouse || !warehouse.managerId || !product || product.status === "停用") {
      fail("INVENTORY_FORBIDDEN", "仓库必须配置责任经理，且仓库和产品须在当前权限范围内。");
    }
    const qty = Number(payload.qty);
    const unitPrice = Number(payload.unitPrice);
    if (!positiveNumber(qty, 1000000, true) || !positiveNumber(unitPrice, 10000000)) {
      fail("INVALID_INVENTORY_NUMBER", "入库数量必须是正整数，供货单价必须是有效正数。");
    }
    if (!validBatchNo(payload.batchNo) || !validDate(payload.expiryDate) || payload.expiryDate < localDate()) {
      fail("INVALID_BATCH", "批号格式不正确，或有效期已经过期。");
    }
    const id = lotId(warehouse._id, product._id, payload.batchNo);
    const moveId = `move_${Date.now()}_${crypto.randomBytes(7).toString("hex")}`;
    await db.runTransaction(async (transaction) => {
      let existing = null;
      try {
        existing = (await transaction.collection("inventory_lots").doc(id).get()).data;
      } catch {
        existing = null;
      }
      if (existing && existing.expiryDate !== payload.expiryDate) {
        fail("BATCH_EXPIRY_CONFLICT", "同一仓库、产品和批号已经存在不同有效期，请核对商业发货单。");
      }
      if (existing) {
        await transaction.collection("inventory_lots").doc(id).update({
          data: {
            qty: command.inc(qty),
            unitPrice: calc4(unitPrice),
            updatedAt: nowIso()
          }
        });
      } else {
        await transaction.collection("inventory_lots").doc(id).set({
          data: {
            warehouseId: warehouse._id,
            managerId: warehouse.managerId || "",
            productId: product._id,
            batchNo: payload.batchNo,
            expiryDate: payload.expiryDate,
            qty,
            unitPrice: calc4(unitPrice),
            createdAt: nowIso(),
            updatedAt: nowIso()
          }
        });
      }
      await transaction.collection("inventory_moves").doc(moveId).set({
        data: {
          type: "in",
          status: "已通过",
          date: localDate(),
          warehouseId: warehouse._id,
          managerId: warehouse.managerId || userBusinessId(user),
          productId: product._id,
          qty,
          unitPrice: calc4(unitPrice),
          batchNo: payload.batchNo,
          expiryDate: payload.expiryDate,
          source: "商业发货申请",
          createdBy: userBusinessId(user),
          createdAt: nowIso()
        }
      });
    });
    await writeAudit(user, "商业发货入库", moveId, `${warehouse.name} / ${product.name}${product.spec} / ${qty}盒 / 批号${payload.batchNo}`);
    return { id: moveId };
  });
}

module.exports = { getInventoryPage, receiveInventory };
