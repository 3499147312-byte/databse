const { call } = require("../../utils/api");
const { money, badgeClass } = require("../../utils/format");

Page({
  data: {
    loading: true,
    canSubmit: false,
    customers: [],
    customerIndex: 0,
    types: ["奶茶", "饮料", "小礼品", "推广费"],
    typeIndex: 0,
    amount: "",
    note: "",
    expenses: []
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
      const data = await call("getExpensesPage", {}, { loading: false });
      this.setData({
        loading: false,
        canSubmit: data.canSubmit,
        customers: (data.customers || []).map((item) => ({ ...item, budgetText: money(item.availableBudget) })),
        expenses: (data.expenses || []).map((item) => ({ ...item, amountText: money(item.amount), badge: badgeClass(item.status) }))
      });
    } catch {
      this.setData({ loading: false });
    }
  },

  selectCustomer(event) {
    this.setData({ customerIndex: Number(event.detail.value) });
  },

  selectType(event) {
    this.setData({ typeIndex: Number(event.detail.value) });
  },

  onInput(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },

  async submit() {
    const customer = this.data.customers[this.data.customerIndex];
    if (!customer || !this.data.amount || this.data.note.trim().length < 2) {
      wx.showToast({ title: "请完整填写费用信息", icon: "none" });
      return;
    }
    await call("submitExpense", {
      customerId: customer.id,
      type: this.data.types[this.data.typeIndex],
      amount: Number(this.data.amount),
      note: this.data.note.trim(),
      idempotencyKey: `expense_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    });
    wx.showToast({ title: "费用已提交审核", icon: "success" });
    this.setData({ amount: "", note: "" });
    await this.load();
  },

  async financeAction(event) {
    const { action, id } = event.currentTarget.dataset;
    const result = await new Promise((resolve) => wx.showModal({
      title: action === "markExpensePaid" ? "确认已付款" : "确认已收票",
      content: "确认财务事项已经真实完成吗？操作后会保留人员和时间记录。",
      success: resolve
    }));
    if (!result.confirm) return;
    await call(action, { id });
    wx.showToast({ title: "财务状态已更新", icon: "success" });
    await this.load();
  }
});
