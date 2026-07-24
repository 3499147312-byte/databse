const assert = require("assert");
const path = require("path");
const { money, roleLabel, badgeClass, monthNow } = require("../miniprogram/utils/format");

(async () => {
  // CLIENT-FORMAT-01：金额、角色、状态徽章和当前月份格式稳定。
  assert.strictEqual(money(12.3), "12.30");
  assert.strictEqual(money(null), "0.00");
  assert.strictEqual(roleLabel("finance"), "总部财务人员");
  assert.strictEqual(roleLabel("rep"), "业务代表");
  assert.strictEqual(badgeClass("经理驳回"), "danger");
  assert.strictEqual(badgeClass("近效期预警"), "warn");
  assert.strictEqual(badgeClass("已通过"), "");
  assert(/^\d{4}-\d{2}$/.test(monthNow()));

  // CLIENT-API-01：调用云函数时显示加载状态并返回业务数据。
  const app = { globalData: { configured: true, user: { id: "R001" } } };
  const calls = { show: 0, hide: 0, modals: [], removed: [], relaunch: [] };
  global.getApp = () => app;
  global.wx = {
    showLoading: () => { calls.show += 1; },
    hideLoading: () => { calls.hide += 1; },
    showModal: (options) => { calls.modals.push(options); },
    removeStorageSync: (key) => { calls.removed.push(key); },
    reLaunch: (options) => { calls.relaunch.push(options); },
    cloud: {
      callFunction: async ({ name, data }) => ({
        result: { ok: true, data: { name, action: data.action, payload: data.payload } }
      })
    }
  };
  const apiPath = path.resolve(__dirname, "..", "miniprogram", "utils", "api.js");
  delete require.cache[apiPath];
  const api = require(apiPath);
  const success = await api.call("getDashboard", { test: 1 });
  assert.strictEqual(success.action, "getDashboard");
  assert.deepStrictEqual(success.payload, { test: 1 });
  assert.strictEqual(calls.show, 1);
  assert.strictEqual(calls.hide, 1);

  // CLIENT-API-02：云端业务错误弹窗；登录失效时清缓存并回登录页。
  wx.cloud.callFunction = async () => ({ result: { ok: false, code: "AUTH_REQUIRED", message: "请重新登录" } });
  await assert.rejects(api.call("me"), /请重新登录/);
  assert.deepStrictEqual(calls.removed, ["gk_user"]);
  assert.deepStrictEqual(calls.relaunch, [{ url: "/pages/login/index" }]);
  assert.strictEqual(app.globalData.user, null);
  assert(calls.modals.some((item) => item.content === "请重新登录"));

  // CLIENT-API-03：未配置云环境时不发起请求。
  app.globalData.configured = false;
  await assert.rejects(api.call("getDashboard"), /云开发环境ID/);

  // CLIENT-APP-01：小程序启动时初始化云环境并恢复本地登录用户。
  let appDefinition;
  let cloudInit;
  global.App = (definition) => { appDefinition = definition; };
  global.wx = {
    cloud: {
      init: (options) => { cloudInit = options; }
    },
    getStorageSync: (key) => key === "gk_user" ? { personId: "R001" } : null,
    showModal: () => {}
  };
  const appPath = path.resolve(__dirname, "..", "miniprogram", "app.js");
  delete require.cache[appPath];
  require(appPath);
  appDefinition.onLaunch();
  if (appDefinition.globalData.configured) {
    assert.strictEqual(cloudInit.traceUser, true);
    assert.deepStrictEqual(appDefinition.globalData.user, { personId: "R001" });
  }

  delete global.getApp;
  delete global.wx;
  delete global.App;
  console.log("小程序客户端工具与启动流程测试通过");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
