const { call } = require("../../utils/api");

Page({
  data: {
    forced: false,
    oldPassword: "",
    newPassword: "",
    confirmPassword: ""
  },

  onLoad(options) {
    this.setData({ forced: options.forced === "1" });
  },

  onInput(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },

  async submit() {
    const { oldPassword, newPassword, confirmPassword } = this.data;
    if (!oldPassword || !newPassword || !confirmPassword) {
      wx.showToast({ title: "请完整填写三个密码", icon: "none" });
      return;
    }
    const data = await call("changePassword", { oldPassword, newPassword, confirmPassword });
    wx.setStorageSync("gk_user", data.user);
    getApp().globalData.user = data.user;
    wx.showToast({ title: "密码已修改", icon: "success" });
    setTimeout(() => wx.reLaunch({ url: "/pages/home/index" }), 500);
  }
});
