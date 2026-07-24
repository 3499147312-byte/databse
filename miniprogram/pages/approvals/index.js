const { call } = require("../../utils/api");
const { money, badgeClass } = require("../../utils/format");

Page({
  data: {
    loading: true,
    tab: "sales",
    viewMode: "approval",
    showSales: true,
    sales: [],
    expenses: [],
    policies: []
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
      const data = await call("getApprovals", {}, { loading: false });
      this.setData({
        loading: false,
        tab: data.viewMode === "readOnly" ? "policies" : this.data.tab,
        viewMode: data.viewMode || "approval",
        showSales: data.viewMode !== "readOnly",
        sales: (data.sales || []).map((item) => ({ ...item, amountText: money(item.amount), badge: badgeClass(item.status) })),
        expenses: (data.expenses || []).map((item) => ({ ...item, amountText: money(item.amount), badge: badgeClass(item.status) })),
        policies: (data.policies || []).map((item) => ({
          ...item,
          invoicePriceText: money(item.invoicePrice),
          retailPriceText: money(item.retailPrice),
          headRebateText: money(item.headRebate),
          noInvoiceRebateText: money(item.noInvoiceRebate),
          promoSpendText: money(item.promoSpend),
          repCommissionText: money(item.repCommission),
          supervisorCommissionText: money(item.supervisorCommission),
          managerCommissionText: money(item.managerCommission),
          badge: badgeClass(item.status)
        }))
      });
    } catch {
      this.setData({ loading: false });
    }
  },

  switchTab(event) {
    this.setData({ tab: event.currentTarget.dataset.tab });
  },

  async approve(event) {
    const { action, id } = event.currentTarget.dataset;
    const content = action === "approvePolicy"
      ? "请确认价格、返利、推广开销、月销任务和特殊提成无误。通过后将用于新的销售单。"
      : action === "approveExpense"
        ? "确认费用资料无误后通过，经理最终通过后将进入财务付款和收票流程。"
        : "通过后会进入下一审批层级，经理最终通过销售时会扣减库存。";
    const result = await new Promise((resolve) => {
      wx.showModal({
        title: "确认审核通过",
        content,
        success: resolve
      });
    });
    if (!result.confirm) return;
    await call(action, { id });
    wx.showToast({ title: "审核已通过", icon: "success" });
    await this.load();
  },

  async reject(event) {
    const { action, id } = event.currentTarget.dataset;
    const result = await new Promise((resolve) => {
      wx.showModal({
        title: "驳回并退回",
        editable: true,
        placeholderText: "请填写2至200字驳回原因",
        confirmText: "确认驳回",
        success: resolve
      });
    });
    if (!result.confirm) return;
    const reason = String(result.content || "").trim();
    if (reason.length < 2) {
      wx.showToast({ title: "请填写驳回原因", icon: "none" });
      return;
    }
    await call(action, { id, reason });
    wx.showToast({ title: "已驳回", icon: "success" });
    await this.load();
  }
});
