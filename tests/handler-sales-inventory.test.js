const assert = require("assert");
const crypto = require("crypto");
const fixture = require("./fixtures/business-fixture");
const { createHarness, expectCode } = require("./helpers/handler-harness");
const { localDate, monthKey } = require("../cloudfunctions/api/lib/core");

function lotId(warehouseId, productId, batchNo) {
  return `lot_${crypto.createHash("sha256").update(`${warehouseId}|${productId}|${batchNo}`).digest("hex").slice(0, 40)}`;
}

function seed() {
  const copy = JSON.parse(JSON.stringify(fixture));
  copy.policies[0].start = "2020-01-01";
  copy.policies[0].end = "2099-12-31";
  copy.sales.forEach((sale) => {
    sale.date = localDate();
    sale.createdAt = `${localDate()}T08:00:00.000Z`;
  });
  copy.inventory_lots = [
    { _id: lotId("W001", "P240", "BATCH-001"), warehouseId: "W001", managerId: "M001", productId: "P240", batchNo: "BATCH-001", expiryDate: "2099-12-31", qty: 20, unitPrice: 60 },
    { _id: lotId("W001", "P120", "BATCH-002"), warehouseId: "W001", managerId: "M001", productId: "P120", batchNo: "BATCH-002", expiryDate: "2099-12-31", qty: 10, unitPrice: 30 }
  ];
  copy.inventory_moves = [];
  copy.daily_reports = [];
  copy.receivables = [];
  copy.corrections = [];
  return copy;
}

(async () => {
  const rep = fixture.users.find((item) => item.personId === "R001");
  const supervisor = fixture.users.find((item) => item.personId === "S001");
  const manager = fixture.users.find((item) => item.personId === "M001");
  const boss = fixture.users.find((item) => item.role === "boss");

  // SALES-PAGE-01：代表只能看到自己的门店、销售和可售产品。
  {
    const harness = createHarness(seed(), rep);
    const sales = harness.loadHandler("sales");
    const page = await sales.getSalesPage();
    assert.strictEqual(page.isRep, true);
    assert.strictEqual(page.canSubmit, true);
    assert.deepStrictEqual(page.stores.map((item) => item.id), ["ST001"]);
    assert.strictEqual(page.products.length, 2);
    assert(page.sales.every((item) => item.repName === "代表甲"));
  }

  // SALES-SUBMIT-01：多产品销售写入日报，重复产品批号合并。
  {
    const harness = createHarness(seed(), rep);
    const sales = harness.loadHandler("sales");
    const result = await sales.submitSale({
      idempotencyKey: "sale-submit-001",
      storeId: "ST001",
      lines: [
        { productId: "P240", batchNo: "BATCH-001", qty: 2 },
        { productId: "P240", batchNo: "BATCH-001", qty: 1 }
      ]
    });
    const row = harness.get("sales", result.id);
    assert.strictEqual(result.status, "待主管审核");
    assert.strictEqual(row.lines.length, 1);
    assert.strictEqual(row.lines[0].qty, 3);
    assert.strictEqual(row.lines[0].ruleSnapshot.salePrice, 100);
    assert.strictEqual(harness.rows("daily_reports").length, 1);
  }

  // SALES-SUBMIT-02：跨团队门店和无效数量必须拦截。
  {
    const harness = createHarness(seed(), rep);
    const sales = harness.loadHandler("sales");
    await expectCode(sales.submitSale({
      idempotencyKey: "sale-submit-002",
      storeId: "ST002",
      lines: [{ productId: "P240", batchNo: "BATCH-001", qty: 1 }]
    }), "STORE_FORBIDDEN");
    await expectCode(sales.submitSale({
      idempotencyKey: "sale-submit-003",
      storeId: "ST001",
      lines: [{ productId: "P240", batchNo: "BATCH-001", qty: 0 }]
    }), "INVALID_QTY");
  }

  // SALES-ZERO-01：零销售日报可重复点击但只保留一条。
  {
    const harness = createHarness(seed(), rep);
    const sales = harness.loadHandler("sales");
    assert.strictEqual((await sales.submitZeroDaily()).status, "已提交");
    assert.strictEqual((await sales.submitZeroDaily()).status, "已提交");
    assert.strictEqual(harness.rows("daily_reports").length, 1);
    assert.strictEqual(harness.rows("daily_reports")[0].zeroSalesDeclared, true);
  }

  // SALES-APPROVE-01：主管通过后流转经理，不扣库存。
  {
    const data = seed();
    data.sales[0].status = "待主管审核";
    const harness = createHarness(data, supervisor);
    const sales = harness.loadHandler("sales");
    const before = harness.rows("inventory_lots")[0].qty;
    assert.strictEqual((await sales.approveSale({ id: "SALE001" })).status, "待经理审核");
    assert.strictEqual(harness.get("sales", "SALE001").status, "待经理审核");
    assert.strictEqual(harness.rows("inventory_lots")[0].qty, before);
  }

  // SALES-APPROVE-02：经理最终通过扣减批号库存并重建应收。
  {
    const data = seed();
    data.sales[0].status = "待经理审核";
    const harness = createHarness(data, manager);
    const sales = harness.loadHandler("sales");
    assert.strictEqual((await sales.approveSale({ id: "SALE001" })).status, "已通过");
    assert.strictEqual(harness.get("inventory_lots", lotId("W001", "P240", "BATCH-001")).qty, 17);
    assert(harness.rows("receivables").some((item) => item.warehouseId === "W001"));
  }

  // SALES-REJECT-01：审批人可填写原因驳回，短原因被拒绝。
  {
    const data = seed();
    data.sales[0].status = "待主管审核";
    const harness = createHarness(data, supervisor);
    const sales = harness.loadHandler("sales");
    await expectCode(sales.rejectSale({ id: "SALE001", reason: "错" }), "INVALID_REJECT_REASON");
    assert.strictEqual((await sales.rejectSale({ id: "SALE001", reason: "数量有误" })).status, "主管驳回");
    assert.strictEqual(harness.get("sales", "SALE001").rejectedReason, "数量有误");
  }

  // SALES-CORRECT-01：老板作废已通过销售，库存返还并留下纠错记录。
  {
    const harness = createHarness(seed(), boss);
    const sales = harness.loadHandler("sales");
    const result = await sales.correctSale({
      idempotencyKey: "sale-correct-001",
      saleId: "SALE001",
      type: "作废",
      reason: "录入重复"
    });
    assert.strictEqual(result.status, "已作废");
    assert.strictEqual(harness.get("inventory_lots", lotId("W001", "P240", "BATCH-001")).qty, 23);
    assert.strictEqual(harness.get("sales", "SALE001").correctionStatus, "已作废");
    assert.strictEqual(harness.rows("corrections").length, 1);
  }

  // INVENTORY-PAGE-01：经理查看本团队仓库、批号和低库存预警。
  {
    const harness = createHarness(seed(), manager);
    const inventory = harness.loadHandler("inventory");
    const page = await inventory.getInventoryPage();
    assert.strictEqual(page.canReceive, true);
    assert.deepStrictEqual(page.warehouses.map((item) => item.id), ["W001"]);
    assert(page.balances.some((item) => item.status === "低库存预警"));
    assert.strictEqual(page.lots.length, 2);
  }

  // INVENTORY-RECEIVE-01：责任经理入库创建批号库存和库存流水。
  {
    const harness = createHarness(seed(), manager);
    const inventory = harness.loadHandler("inventory");
    const result = await inventory.receiveInventory({
      idempotencyKey: "inventory-in-001",
      warehouseId: "W001",
      productId: "P240",
      qty: 25,
      unitPrice: 62.3456,
      batchNo: "BATCH-NEW",
      expiryDate: "2099-12-31"
    });
    assert(result.id.startsWith("move_"));
    assert.strictEqual(harness.rows("inventory_moves").length, 1);
    assert(harness.rows("inventory_lots").some((item) => item.batchNo === "BATCH-NEW" && item.qty === 25));
  }

  // INVENTORY-RECEIVE-02：其他团队仓库及无效数量不可入库。
  {
    const harness = createHarness(seed(), manager);
    const inventory = harness.loadHandler("inventory");
    await expectCode(inventory.receiveInventory({
      idempotencyKey: "inventory-in-002",
      warehouseId: "W002",
      productId: "P240",
      qty: 1,
      unitPrice: 10,
      batchNo: "BATCH-X",
      expiryDate: "2099-12-31"
    }), "INVENTORY_FORBIDDEN");
    await expectCode(inventory.receiveInventory({
      idempotencyKey: "inventory-in-003",
      warehouseId: "W001",
      productId: "P240",
      qty: -1,
      unitPrice: 10,
      batchNo: "BATCH-X",
      expiryDate: "2099-12-31"
    }), "INVALID_INVENTORY_NUMBER");
  }

  assert.strictEqual(monthKey(localDate()).length, 7);
  console.log("销售与库存云函数测试通过");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
