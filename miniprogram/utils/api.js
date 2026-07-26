const config = require("../config");

function showError(message) {
  wx.showModal({
    title: "操作没有完成",
    content: message || "请稍后重试。",
    showCancel: false
  });
}

async function call(action, payload = {}, options = {}) {
  const app = getApp();
  if (!app.globalData.configured) {
    throw new Error("请先在 miniprogram/config.js 填写云开发环境ID。");
  }
  if (options.loading !== false) wx.showLoading({ title: "处理中", mask: true });
  try {
    const response = await wx.cloud.callFunction({
      name: config.cloudFunctionName,
      data: { action, payload }
    });
    const result = response.result || {};
    if (!result.ok) {
      const error = new Error(result.message || "云端处理失败");
      error.code = result.code;
      if (["AUTH_REQUIRED", "REAUTH_REQUIRED"].includes(result.code)) {
        wx.removeStorageSync("gk_user");
        app.globalData.user = null;
        wx.reLaunch({ url: "/pages/login/index" });
      }
      throw error;
    }
    return result.data;
  } catch (error) {
    if (!options.silent) showError(error.message);
    throw error;
  } finally {
    if (options.loading !== false) wx.hideLoading();
  }
}

module.exports = { call, showError };
