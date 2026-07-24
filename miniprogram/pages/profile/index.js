const { roleLabel } = require("../../utils/format");

Page({
  data: {
    user: null,
    roleText: ""
  },

  onShow() {
    const user = getApp().globalData.user || wx.getStorageSync("gk_user");
    if (!user) {
      wx.reLaunch({ url: "/pages/login/index" });
      return;
    }
    this.setData({ user, roleText: roleLabel(user.role) });
  },

  changePassword() {
    wx.navigateTo({ url: "/pages/password/index" });
  },

  logout() {
    wx.showModal({
      title: "退出登录",
      content: "退出只会清除这台手机的登录状态，不会删除账号。",
      success: ({ confirm }) => {
        if (!confirm) return;
        wx.removeStorageSync("gk_user");
        getApp().globalData.user = null;
        wx.reLaunch({ url: "/pages/login/index" });
      }
    });
  }
});
