const config = require("./config");

App({
  globalData: {
    user: null,
    configured: false
  },

  onLaunch() {
    const configured = config.envId && !config.envId.includes("请替换");
    this.globalData.configured = configured;
    if (!wx.cloud) {
      wx.showModal({
        title: "基础库版本过低",
        content: "请在微信开发者工具中选择较新的调试基础库。",
        showCancel: false
      });
      return;
    }
    if (!configured) return;
    wx.cloud.init({
      env: config.envId,
      traceUser: true
    });
    this.globalData.user = wx.getStorageSync("gk_user") || null;
  }
});
