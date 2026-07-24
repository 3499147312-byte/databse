const { call } = require("../../utils/api");
const { parse, toObjects } = require("../../utils/csv");
const { roleLabel, badgeClass } = require("../../utils/format");

const importTypes = [
  { key: "personnel", label: "人员" },
  { key: "warehouses", label: "仓库" },
  { key: "customers", label: "客户" },
  { key: "stores", label: "门店" },
  { key: "products", label: "产品" },
  { key: "inventory", label: "库存入库" },
  { key: "policies", label: "客户政策" },
  { key: "historicalSales", label: "历史销售" }
];

Page({
  data: {
    loading: true,
    tab: "users",
    users: [],
    editing: null,
    editingExisting: false,
    roles: [
      { key: "hq_auditor", label: "总部审核人员" },
      { key: "finance", label: "总部财务人员" },
      { key: "manager", label: "省区/区域经理" },
      { key: "supervisor", label: "地区主管" },
      { key: "rep", label: "业务代表" }
    ],
    roleIndex: 4,
    importTypes,
    importTypeIndex: 0,
    importPreview: null
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      const data = await call("getAdminPage", {}, { loading: false });
      this.setData({
        loading: false,
        users: (data.users || []).map((item) => ({
          ...item,
          roleText: roleLabel(item.role),
          badge: badgeClass(item.status)
        }))
      });
    } catch {
      this.setData({ loading: false });
    }
  },

  switchTab(event) {
    this.setData({ tab: event.currentTarget.dataset.tab, editing: null, importPreview: null });
  },

  newUser() {
    this.setData({
      editing: { id: "", name: "", username: "", province: "", parentId: "", tempPassword: "" },
      editingExisting: false,
      roleIndex: 4
    });
  },

  editUser(event) {
    const user = this.data.users.find((item) => item.id === event.currentTarget.dataset.id);
    const roleIndex = Math.max(0, this.data.roles.findIndex((item) => item.key === user.role));
    this.setData({
      editing: {
        id: user.id,
        name: user.name,
        username: user.username,
        province: user.province || "",
        parentId: user.parentId || "",
        tempPassword: ""
      },
      editingExisting: true,
      roleIndex
    });
  },

  cancelEdit() {
    this.setData({ editing: null, editingExisting: false });
  },

  onEditInput(event) {
    this.setData({ [`editing.${event.currentTarget.dataset.field}`]: event.detail.value });
  },

  selectRole(event) {
    this.setData({ roleIndex: Number(event.detail.value) });
  },

  async saveUser() {
    const editing = this.data.editing;
    const role = this.data.roles[this.data.roleIndex].key;
    if (!editing.id.trim() || !editing.name.trim() || !editing.username.trim() || !editing.province.trim()) {
      wx.showToast({ title: "请完整填写人员资料", icon: "none" });
      return;
    }
    await call("saveUser", {
      id: editing.id.trim(),
      name: editing.name.trim(),
      username: editing.username.trim(),
      role,
      province: editing.province.trim(),
      parentId: editing.parentId.trim(),
      tempPassword: editing.tempPassword
    });
    wx.showToast({ title: "人员资料已保存", icon: "success" });
    this.setData({ editing: null, editingExisting: false });
    await this.load();
  },

  async toggleUser(event) {
    await call("toggleUser", { userId: event.currentTarget.dataset.id });
    wx.showToast({ title: "账号状态已更新", icon: "success" });
    await this.load();
  },

  async resetPassword(event) {
    const user = this.data.users.find((item) => item.id === event.currentTarget.dataset.id);
    const result = await new Promise((resolve) => wx.showModal({
      title: "重置密码",
      content: `确认重置${user.name}的密码吗？原密码会立即失效。`,
      success: resolve
    }));
    if (!result.confirm) return;
    const data = await call("resetUserPassword", { userId: user.id });
    wx.showModal({
      title: "临时密码只显示一次",
      content: `${user.name}的新临时密码：\n${data.temporaryPassword}\n\n请立即私下发送给本人。`,
      confirmText: "我已记下",
      showCancel: false
    });
  },

  async unbindWechat(event) {
    const user = this.data.users.find((item) => item.id === event.currentTarget.dataset.id);
    const result = await new Promise((resolve) => wx.showModal({
      title: "解除微信绑定",
      content: `确认解除${user.name}当前绑定的微信吗？解绑后需用账号密码在新微信重新登录。`,
      confirmText: "确认解绑",
      success: resolve
    }));
    if (!result.confirm) return;
    await call("unbindUserWechat", { userId: user.id });
    wx.showToast({ title: "微信绑定已解除", icon: "success" });
    await this.load();
  },

  async deleteUser(event) {
    const user = this.data.users.find((item) => item.id === event.currentTarget.dataset.id);
    const result = await new Promise((resolve) => wx.showModal({
      title: "删除无业务人员",
      content: `只有完全没有客户、销售、审批、费用和回款记录的人员才能删除。确认尝试删除${user.name}吗？`,
      success: resolve
    }));
    if (!result.confirm) return;
    await call("deleteUser", { userId: user.id });
    wx.showToast({ title: "人员已删除", icon: "success" });
    await this.load();
  },

  selectImportType(event) {
    this.setData({ importTypeIndex: Number(event.detail.value), importPreview: null });
    this.pendingRows = null;
  },

  chooseCsv() {
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      extension: ["csv"],
      success: ({ tempFiles }) => this.readCsv(tempFiles[0]),
      fail: (error) => {
        if (!String(error.errMsg || "").includes("cancel")) wx.showToast({ title: "文件选择失败", icon: "none" });
      }
    });
  },

  readCsv(file) {
    if (file.size > 500 * 1024) {
      wx.showModal({ title: "文件过大", content: "小程序单次导入文件不能超过500KB，请拆成多个CSV。", showCancel: false });
      return;
    }
    wx.getFileSystemManager().readFile({
      filePath: file.path,
      encoding: "utf8",
      success: async ({ data }) => {
        try {
          const rows = toObjects(parse(data));
          if (!rows.length || rows.length > 1000) throw new Error("单次必须包含1至1000行数据。");
          this.pendingRows = rows;
          const type = this.data.importTypes[this.data.importTypeIndex].key;
          const preview = await call("adminImportRows", { type, rows, dryRun: true });
          this.setData({ importPreview: { ...preview, fileName: file.name } });
        } catch (error) {
          wx.showModal({ title: "文件不能导入", content: error.message, showCancel: false });
        }
      },
      fail: () => wx.showToast({ title: "文件读取失败", icon: "none" })
    });
  },

  async confirmImport() {
    if (!this.pendingRows || this.data.importPreview.errors.length) return;
    const type = this.data.importTypes[this.data.importTypeIndex].key;
    const data = await call("adminImportRows", { type, rows: this.pendingRows, dryRun: false });
    wx.showModal({
      title: "导入完成",
      content: `新增${data.insertCount}行，更新${data.updateCount}行。`,
      showCancel: false
    });
    this.pendingRows = null;
    this.setData({ importPreview: null });
    await this.load();
  }
});
