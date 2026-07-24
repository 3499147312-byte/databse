const { call } = require("../../utils/api");
const { money } = require("../../utils/format");

Page({
  data: {
    loading: true,
    selectedMonth: "",
    currentMonth: "",
    lastMonth: "",
    managers: []
  },

  onShow() {
    this.load();
  },

  async onPullDownRefresh() {
    await this.load(this.data.selectedMonth);
    wx.stopPullDownRefresh();
  },

  async load(month = "") {
    try {
      const data = await call("getBossPerformance", { month }, { loading: false });
      this.setData({
        loading: false,
        selectedMonth: data.selectedMonth,
        currentMonth: data.currentMonth,
        lastMonth: data.lastMonth,
        managers: (data.managers || []).map((manager, index) => ({
          ...manager,
          rank: index + 1,
          amountText: money(manager.amount),
          expanded: false,
          warehouses: (manager.warehouses || []).map((warehouse) => ({
            ...warehouse,
            amountText: money(warehouse.amount)
          }))
        }))
      });
    } catch {
      this.setData({ loading: false });
    }
  },

  selectMonth(event) {
    const month = event.currentTarget.dataset.month;
    if (month !== this.data.selectedMonth) {
      this.setData({ loading: true });
      this.load(month);
    }
  },

  toggleManager(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ [`managers[${index}].expanded`]: !this.data.managers[index].expanded });
  }
});
