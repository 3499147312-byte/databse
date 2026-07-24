const { call } = require("../../utils/api");
const { money, badgeClass } = require("../../utils/format");

function requestId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

Page({
  data: {
    loading: true,
    isRep: false,
    dailySubmitted: false,
    canSubmit: false,
    stores: [],
    products: [],
    storeIndex: 0,
    productIndex: 0,
    qty: "",
    batchNo: "",
    draftLines: [],
    sales: []
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
      const data = await call("getSalesPage", {}, { loading: false });
      this.setData({
        loading: false,
        isRep: data.isRep,
        dailySubmitted: data.dailySubmitted,
        canSubmit: data.canSubmit,
        stores: data.stores || [],
        products: data.products || [],
        sales: (data.sales || []).map((item) => ({
          ...item,
          amountText: money(item.amount),
          badge: badgeClass(item.status)
        }))
      });
    } catch {
      this.setData({ loading: false });
    }
  },

  selectStore(event) {
    this.setData({ storeIndex: Number(event.detail.value) });
  },

  selectProduct(event) {
    this.setData({ productIndex: Number(event.detail.value) });
  },

  onInput(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },

  addLine() {
    const product = this.data.products[this.data.productIndex];
    const qty = Number(this.data.qty);
    const batchNo = this.data.batchNo.trim();
    if (!product || !Number.isInteger(qty) || qty <= 0 || !batchNo) {
      wx.showToast({ title: "请填写产品、正整数数量和批号", icon: "none" });
      return;
    }
    const key = `${product.id}|${batchNo}`;
    const existingIndex = this.data.draftLines.findIndex((item) => item.key === key);
    if (existingIndex >= 0) {
      this.setData({
        [`draftLines[${existingIndex}].qty`]: this.data.draftLines[existingIndex].qty + qty,
        qty: "",
        batchNo: ""
      });
      return;
    }
    if (this.data.draftLines.length >= 20) {
      wx.showToast({ title: "一张销售单最多20条明细", icon: "none" });
      return;
    }
    this.setData({
      draftLines: [...this.data.draftLines, { key, productId: product.id, productName: product.label, qty, batchNo }],
      qty: "",
      batchNo: ""
    });
  },

  removeLine(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ draftLines: this.data.draftLines.filter((_, itemIndex) => itemIndex !== index) });
  },

  async submit() {
    const store = this.data.stores[this.data.storeIndex];
    if (!store || !this.data.draftLines.length) {
      wx.showToast({ title: "请选择门店并加入至少一条产品", icon: "none" });
      return;
    }
    await call("submitSale", {
      storeId: store.id,
      lines: this.data.draftLines.map(({ productId, qty, batchNo }) => ({ productId, qty, batchNo })),
      idempotencyKey: requestId("sale")
    });
    wx.showToast({ title: "已提交主管审核", icon: "success" });
    this.setData({ qty: "", batchNo: "", draftLines: [] });
    await this.load();
  },

  async submitZeroDaily() {
    const result = await new Promise((resolve) => wx.showModal({
      title: "提交零销售日报",
      content: "确认今天暂时没有销量吗？提交后如当天产生销售，仍可继续填写销售单。",
      success: resolve
    }));
    if (!result.confirm) return;
    await call("submitZeroDaily");
    wx.showToast({ title: "今日日报已提交", icon: "success" });
    await this.load();
  },

  async correct(event) {
    const { id, type } = event.currentTarget.dataset;
    const result = await new Promise((resolve) => {
      wx.showModal({
        title: type === "退货" ? "登记退货" : "作废销售单",
        editable: true,
        placeholderText: "请输入原因，至少2个字",
        success: resolve
      });
    });
    if (!result.confirm || !result.content) return;
    await call("correctSale", { saleId: id, type, reason: result.content.trim(), idempotencyKey: requestId("correction") });
    wx.showToast({ title: "已处理并留痕", icon: "success" });
    await this.load();
  }
});
