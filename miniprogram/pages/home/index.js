const { call } = require("../../utils/api");
const { money, roleLabel, badgeClass } = require("../../utils/format");

const allMenus = [
  { key: "sales", label: "销售日报", url: "/pages/sales/index", any: ["sales.view"] },
  { key: "approvals", label: "审核中心", url: "/pages/approvals/index", any: ["sales.approve.supervisor", "sales.approve.manager", "expenses.approve.supervisor", "expenses.approve.manager", "policies.approve", "policies.reject"] },
  { key: "hq-view", label: "政策与费用", url: "/pages/approvals/index", roles: ["hq_auditor"] },
  { key: "inventory", label: "库存管理", url: "/pages/inventory/index", any: ["inventory.view"] },
  { key: "receivables", label: "仓库回款", url: "/pages/receivables/index", any: ["receivables.view"] },
  { key: "expenses", label: "费用管理", url: "/pages/expenses/index", any: ["expenses.view"] },
  { key: "reports", label: "经营报表", url: "/pages/reports/index", any: ["reports.view"] },
  { key: "performance", label: "省区月度业绩", url: "/pages/performance/index", any: ["performance.view"] },
  { key: "admin", label: "人员与导入", url: "/pages/admin/index", any: ["admin.users.view", "admin.import"] },
  { key: "permissions", label: "权限中心", url: "/pages/permissions/index", any: ["permissions.center.view"] },
  { key: "profile", label: "我的账号", url: "/pages/profile/index", always: true }
];

function canOpen(menu, user) {
  const capabilities = new Set(user.capabilities || []);
  return menu.always
    || (menu.roles || []).includes(user.role)
    || (menu.any || []).some((code) => capabilities.has(code));
}

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
      const capabilities = new Set(user.capabilities || []);
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
        showSalesMetrics: capabilities.has("sales.view"),
        showCommissionMetrics: capabilities.has("sales.view") && ["rep", "supervisor", "manager"].includes(user.role),
        showReceivableMetrics: capabilities.has("receivables.view"),
        showDailyMetric: capabilities.has("sales.view") && user.role !== "rep",
        menus: allMenus.filter((item) => canOpen(item, user)),
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
