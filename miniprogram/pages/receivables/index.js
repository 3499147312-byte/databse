const { call } = require("../../utils/api");
const { money, badgeClass, monthNow } = require("../../utils/format");

Page({
  data: {
    loading: true,
    tab: "plans",
    month: monthNow(),
    user: null,
    summary: {},
    plans: [],
    payments: [],
    warehouseTerms: [],
    canSetTerm: false,
    managers: [],
    paymentPlan: null,
    paymentAmount: "",
    paymentDate: "",
    paymentReference: "",
    paymentNote: "",
    termWarehouse: null,
    termManagerIndex: 0,
    termCreditDays: ""
  },

  onLoad(options) {
    this.pendingReceivableId = options.receivableId || "";
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
      const data = await call("getReceivables", { month: this.data.month }, { loading: false });
      const plans = (data.plans || []).map((item) => ({
        ...item,
        dueAmountText: money(item.dueAmount),
        paidAmountText: money(item.paidAmount),
        outstandingText: money(item.outstanding),
        badge: badgeClass(item.status)
      }));
      const payments = (data.payments || []).map((item) => ({
        ...item,
        amountText: money(item.amount),
        badge: badgeClass(item.status)
      }));
      this.setData({
        loading: false,
        user: data.user,
        summary: {
          dueAmount: money(data.summary.dueAmount),
          receivedThisMonth: money(data.summary.receivedThisMonth),
          paidAgainstDue: money(data.summary.paidAgainstDue),
          outstanding: money(data.summary.outstanding),
          overdue: money(data.summary.overdue)
        },
        plans,
        payments,
        warehouseTerms: data.warehouseTerms || [],
        canSetTerm: Boolean(data.canSetTerm),
        managers: data.managers || []
      });
      if (this.pendingReceivableId) {
        const selected = plans.find((item) => item.id === this.pendingReceivableId);
        if (selected && selected.outstanding > 0) this.startPaymentByPlan(selected);
        this.pendingReceivableId = "";
      }
    } catch {
      this.setData({ loading: false });
    }
  },

  switchTab(event) {
    this.setData({ tab: event.currentTarget.dataset.tab, paymentPlan: null, termWarehouse: null });
  },

  changeMonth(event) {
    this.setData({ month: event.detail.value, paymentPlan: null }, () => this.load());
  },

  startPayment(event) {
    const plan = this.data.plans.find((item) => item.id === event.currentTarget.dataset.id);
    this.startPaymentByPlan(plan);
  },

  startPaymentByPlan(plan) {
    if (!plan) return;
    const date = new Date();
    const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    this.setData({
      tab: "plans",
      paymentPlan: plan,
      paymentAmount: Number(plan.outstanding || 0).toFixed(2),
      paymentDate: today,
      paymentReference: "",
      paymentNote: ""
    });
  },

  cancelPayment() {
    this.setData({ paymentPlan: null });
  },

  onInput(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },

  selectPaymentDate(event) {
    this.setData({ paymentDate: event.detail.value });
  },

  async submitPayment() {
    const plan = this.data.paymentPlan;
    if (!plan || !this.data.paymentAmount || !this.data.paymentDate || this.data.paymentNote.trim().length < 2) {
      wx.showToast({ title: "请完整填写到账信息", icon: "none" });
      return;
    }
    await call("recordWarehousePayment", {
      receivableId: plan.id,
      amount: Number(this.data.paymentAmount),
      paymentDate: this.data.paymentDate,
      reference: this.data.paymentReference.trim(),
      note: this.data.paymentNote.trim(),
      idempotencyKey: `payment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    });
    wx.showToast({ title: "回款已登记", icon: "success" });
    this.setData({ paymentPlan: null });
    await this.load();
  },

  async verifyPayment(event) {
    const payment = this.data.payments.find((item) => item.id === event.currentTarget.dataset.id);
    const result = await new Promise((resolve) => wx.showModal({
      title: "核实到账",
      content: `确认公司已经收到${payment.warehouseName}回款¥${payment.amountText}吗？`,
      success: resolve
    }));
    if (!result.confirm) return;
    await call("verifyWarehousePayment", { paymentId: payment.id });
    wx.showToast({ title: "已核实到账", icon: "success" });
    await this.load();
  },

  async voidPayment(event) {
    const result = await new Promise((resolve) => wx.showModal({
      title: "撤销回款登记",
      editable: true,
      placeholderText: "必须填写撤销原因",
      success: resolve
    }));
    if (!result.confirm || !result.content) return;
    await call("voidWarehousePayment", { paymentId: event.currentTarget.dataset.id, reason: result.content.trim() });
    wx.showToast({ title: "已撤销并留痕", icon: "success" });
    await this.load();
  },

  editTerm(event) {
    const item = this.data.warehouseTerms.find((entry) => entry.id === event.currentTarget.dataset.id);
    const managerIndex = Math.max(0, this.data.managers.findIndex((manager) => manager.id === item.managerId));
    this.setData({ termWarehouse: item, termManagerIndex: managerIndex, termCreditDays: String(item.creditDays) });
  },

  selectTermManager(event) {
    this.setData({ termManagerIndex: Number(event.detail.value) });
  },

  cancelTerm() {
    this.setData({ termWarehouse: null });
  },

  async saveTerm() {
    const warehouse = this.data.termWarehouse;
    const manager = this.data.managers[this.data.termManagerIndex];
    if (!warehouse || !manager || this.data.termCreditDays === "") {
      wx.showToast({ title: "请完整填写账期", icon: "none" });
      return;
    }
    await call("updateWarehouseTerm", {
      warehouseId: warehouse.id,
      managerId: manager.id,
      creditDays: Number(this.data.termCreditDays)
    });
    wx.showToast({ title: "账期已保存", icon: "success" });
    this.setData({ termWarehouse: null });
    await this.load();
  }
});
