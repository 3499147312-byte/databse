const { call } = require("../../utils/api");
const { money, badgeClass } = require("../../utils/format");

Page({
  data: {
    loading: true,
    canReceive: false,
    warehouses: [],
    products: [],
    warehouseIndex: 0,
    productIndex: 0,
    qty: "",
    unitPrice: "",
    batchNo: "",
    expiryDate: "",
    balances: [],
    lots: []
  },

  onShow() {
    this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    try {
      const data = await call("getInventoryPage", {}, { loading: false });
      this.setData({
        loading: false,
        canReceive: data.canReceive,
        warehouses: data.warehouses || [],
        products: data.products || [],
        balances: (data.balances || []).map((item) => ({ ...item, badge: badgeClass(item.status) })),
        lots: (data.lots || []).map((item) => ({ ...item, badge: badgeClass(item.status), unitPriceText: money(item.unitPrice) }))
      });
    } catch {
      this.setData({ loading: false });
    }
  },

  selectWarehouse(event) {
    this.setData({ warehouseIndex: Number(event.detail.value) });
  },

  selectProduct(event) {
    this.setData({ productIndex: Number(event.detail.value) });
  },

  selectDate(event) {
    this.setData({ expiryDate: event.detail.value });
  },

  onInput(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },

  async submit() {
    const warehouse = this.data.warehouses[this.data.warehouseIndex];
    const product = this.data.products[this.data.productIndex];
    const { qty, unitPrice, batchNo, expiryDate } = this.data;
    if (!warehouse || !product || !qty || !unitPrice || !batchNo.trim() || !expiryDate) {
      wx.showToast({ title: "请完整填写入库信息", icon: "none" });
      return;
    }
    await call("receiveInventory", {
      warehouseId: warehouse.id,
      productId: product.id,
      qty: Number(qty),
      unitPrice: Number(unitPrice),
      batchNo: batchNo.trim(),
      expiryDate,
      idempotencyKey: `inventory_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    });
    wx.showToast({ title: "入库成功", icon: "success" });
    this.setData({ qty: "", unitPrice: "", batchNo: "", expiryDate: "" });
    await this.load();
  }
});
