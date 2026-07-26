const { call } = require("../../utils/api");
const config = require("../../config");

Page({
  data: {
    configured: false,
    envId: config.envId,
    username: "",
    password: ""
  },

  onLoad() {
    const configured = getApp().globalData.configured;
    this.setData({ configured });
    if (configured && getApp().globalData.user) this.tryResume();
  },

  async tryResume() {
    try {
      const data = await call("me", {}, { loading: false, silent: true });
      this.finishLogin(data.user);
    } catch {
      wx.removeStorageSync("gk_user");
      getApp().globalData.user = null;
    }
  },

  onInput(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },

  async submit() {
    const username = this.data.username.trim();
    if (!username || !this.data.password) {
      wx.showToast({ title: "请填写账号和密码", icon: "none" });
      return;
    }
    const data = await call("login", { username, password: this.data.password });
    this.finishLogin(data.user);
  },

  finishLogin(user) {
    wx.setStorageSync("gk_user", user);
    getApp().globalData.user = user;
    const next = !Array.isArray(user.capabilities) || user.capabilities.includes("dashboard.view")
      ? "/pages/home/index"
      : "/pages/profile/index";
    wx.reLaunch({ url: user.mustChangePassword ? "/pages/password/index?forced=1" : next });
  },

  async initialize() {
    const result = await new Promise((resolve) => {
      wx.showModal({
        title: "首次部署初始化",
        editable: true,
        placeholderText: "输入云函数中的一次性初始化码",
        content: "",
        success: resolve
      });
    });
    if (!result.confirm || !result.content) return;
    const data = await call("bootstrap", { setupCode: result.content.trim() });
    wx.showModal({
      title: "初始化完成",
      content: `已创建${data.usersCreated}个账号。现在请使用老板账号登录。初始化功能已经自动关闭。`,
      showCancel: false
    });
  }
});
