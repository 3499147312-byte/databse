const { call } = require("../../utils/api");
const { money, badgeClass } = require("../../utils/format");

Page({
  data: {
    loading: true,
    tab: "commissions",
    user: null,
    commissions: [],
    policies: [],
    weekly: [],
    risks: [],
    finance: [],
    audit: []
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
      const data = await call("getReports", {}, { loading: false });
      this.setData({
        loading: false,
        user: data.user,
        commissions: (data.commissions || []).map((item) => ({
          ...item,
          salesAmountText: money(item.salesAmount),
          commissionText: money(item.commission),
          promoBudgetText: money(item.promoBudget)
        })),
        policies: (data.policies || []).map((item) => ({
          ...item,
          invoicePriceText: money(item.invoicePrice),
          promoSpendText: money(item.promoSpend),
          badge: badgeClass(item.status)
        })),
        weekly: (data.weekly || []).map((item) => ({ ...item, badge: badgeClass(item.status) })),
        risks: (data.risks || []).map((item) => ({ ...item, badge: item.level === "高" ? "danger" : item.level === "中" ? "warn" : "" })),
        finance: (data.finance || []).map((item) => ({ ...item, amountText: money(item.amount), badge: badgeClass(item.status) })),
        audit: data.audit || []
      });
    } catch {
      this.setData({ loading: false });
    }
  },

  switchTab(event) {
    this.setData({ tab: event.currentTarget.dataset.tab });
  },

  async action(event) {
    const { action, id } = event.currentTarget.dataset;
    const result = await new Promise((resolve) => wx.showModal({
      title: "确认操作",
      content: action === "submitWeekly" ? "确认本周统计已经完成并提交吗？" : "确认财务状态已经真实完成吗？",
      success: resolve
    }));
    if (!result.confirm) return;
    await call(action, { id });
    wx.showToast({ title: "操作完成", icon: "success" });
    await this.load();
  }
});
