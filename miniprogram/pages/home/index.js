const { call } = require("../../utils/api");
const { money, roleLabel, badgeClass } = require("../../utils/format");

const allMenus = [
  { key: "sales", label: "销售日报", url: "/pages/sales/index", roles: ["rep", "supervisor", "manager", "boss"] },
  { key: "approvals", label: "审核中心", url: "/pages/approvals/index", roles: ["supervisor", "manager", "boss"] },
  { key: "hq-view", label: "政策与费用", url: "/pages/approvals/index", roles: ["hq_auditor"] },
  { key: "inventory", label: "库存管理", url: "/pages/inventory/index", roles: ["rep", "supervisor", "manager", "boss"] },
  { key: "receivables", label: "仓库回款", url: "/pages/receivables/index", roles: ["manager", "boss", "finance"] },
  { key: "expenses", label: "费用报销", url: "/pages/expenses/index", roles: ["rep", "supervisor", "manager", "boss"] },
  { key: "finance-expenses", label: "费用财务", url: "/pages/expenses/index", roles: ["finance"] },
  { key: "reports", label: "经营报表", url: "/pages/reports/index", roles: ["rep", "supervisor", "manager", "boss"] },
  { key: "performance", label: "省区月度业绩", url: "/pages/performance/index", roles: ["boss"] },
  { key: "admin", label: "人员与导入", url: "/pages/admin/index", roles: ["boss"] },
  { key: "profile", label: "我的账号", url: "/pages/profile/index", roles: ["rep", "supervisor", "manager", "boss", "hq_auditor", "finance"] }
];

Page({
  data: {
    loading: true,
    user: null,
    roleText: "",
    menus: [],
    metrics: {},
    reminders: [],
    tasks: []
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
      const data = await call("getDashboard", {}, { loading: false });
      const user = data.user;
      wx.setStorageSync("gk_user", user);
      getApp().globalData.user = user;
      if (user.mustChangePassword) {
        wx.reLaunch({ url: "/pages/password/index?forced=1" });
        return;
      }
      this.setData({
        loading: false,
        user,
        roleText: roleLabel(user.role),
        showSalesMetrics: ["rep", "supervisor", "manager", "boss"].includes(user.role),
        showCommissionMetrics: ["rep", "supervisor", "manager"].includes(user.role),
        showReceivableMetrics: ["manager", "boss", "finance"].includes(user.role),
        showDailyMetric: ["supervisor", "manager", "boss"].includes(user.role),
        menus: allMenus.filter((item) => item.roles.includes(user.role)),
        metrics: {
          todaySales: money(data.metrics.todaySales),
          monthSales: money(data.metrics.monthSales),
          todayCommission: money(data.metrics.todayCommission),
          monthCommission: money(data.metrics.monthCommission),
          monthDue: money(data.metrics.monthDue),
          monthReceived: money(data.metrics.monthReceived),
          missingDaily: data.metrics.missingDaily,
          pending: data.metrics.pending
        },
        reminders: (data.receivableReminders || []).map((item) => ({
          ...item,
          dueAmountText: money(item.dueAmount),
          paidAmountText: money(item.paidAmount),
          outstandingText: money(item.outstanding),
          badge: badgeClass(item.status)
        })),
        tasks: data.tasks || []
      });
    } catch {
      this.setData({ loading: false });
    }
  },

  openMenu(event) {
    wx.navigateTo({ url: event.currentTarget.dataset.url });
  },

  openReceivable(event) {
    wx.navigateTo({ url: `/pages/receivables/index?receivableId=${event.currentTarget.dataset.id}` });
  }
});
