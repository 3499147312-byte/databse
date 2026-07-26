const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const apiModulePath = path.join(root, "miniprogram", "utils", "api.js");

function loadPage(pageName, call) {
  require.cache[require.resolve(apiModulePath)] = {
    id: apiModulePath,
    filename: apiModulePath,
    loaded: true,
    exports: { call }
  };
  let definition;
  global.Page = (value) => { definition = value; };
  const pagePath = path.join(root, "miniprogram", "pages", pageName, "index.js");
  delete require.cache[require.resolve(pagePath)];
  require(pagePath);
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(values) {
      for (const [key, value] of Object.entries(values)) {
        const arrayMatch = key.match(/^([A-Za-z0-9_]+)\[(\d+)\]\.([A-Za-z0-9_]+)$/);
        if (arrayMatch) {
          this.data[arrayMatch[1]][Number(arrayMatch[2])][arrayMatch[3]] = value;
        } else {
          this.data[key] = value;
        }
      }
    }
  };
  return page;
}

(async () => {
  // PROFILE-PAGE-01：我的账号显示当前用户，可进入改密并确认退出登录。
  {
    const app = { globalData: { user: { personId: "R001", name: "测试代表", role: "rep" } } };
    const actions = { navigation: [], relaunch: [], removed: [] };
    global.getApp = () => app;
    global.wx = {
      getStorageSync: () => null,
      navigateTo: (options) => actions.navigation.push(options),
      reLaunch: (options) => actions.relaunch.push(options),
      removeStorageSync: (key) => actions.removed.push(key),
      showModal: (options) => options.success({ confirm: true })
    };
    const page = loadPage("profile", async () => ({}));
    page.onShow();
    assert.strictEqual(page.data.user.personId, "R001");
    assert.strictEqual(page.data.roleText, "业务代表");
    page.changePassword();
    assert.deepStrictEqual(actions.navigation, [{ url: "/pages/password/index" }]);
    page.logout();
    assert.deepStrictEqual(actions.removed, ["gk_user"]);
    assert.strictEqual(app.globalData.user, null);
    assert.deepStrictEqual(actions.relaunch, [{ url: "/pages/login/index" }]);
  }

  // UI-PERSON-01：人员编辑使用固定操作区，不需要滚动到页面底部保存。
  {
    const wxml = fs.readFileSync(path.join(root, "miniprogram", "pages", "admin", "index.wxml"), "utf8");
    const wxss = fs.readFileSync(path.join(root, "miniprogram", "pages", "admin", "index.wxss"), "utf8");
    assert(wxml.includes("editor-mask") && wxml.includes("editor-actions"));
    assert(wxss.includes("position: fixed") && wxss.includes(".editor-actions"));
  }

  // PASSWORD-PAGE-01：改密页面校验三个输入框，成功后保存安全用户并回首页。
  {
    const app = { globalData: { user: null } };
    const calls = [];
    const toasts = [];
    const relaunch = [];
    const stored = [];
    global.getApp = () => app;
    global.wx = {
      showToast: (options) => toasts.push(options),
      setStorageSync: (key, value) => stored.push({ key, value }),
      reLaunch: (options) => relaunch.push(options)
    };
    const page = loadPage("password", async (action, payload) => {
      calls.push({ action, payload });
      return { user: { personId: "R001", mustChangePassword: false } };
    });
    page.onLoad({ forced: "1" });
    assert.strictEqual(page.data.forced, true);
    await page.submit();
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(toasts[0].title, "请完整填写三个密码");
    page.setData({
      oldPassword: "Aa!OldPass123",
      newPassword: "Bb!NewPass456",
      confirmPassword: "Bb!NewPass456"
    });
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (operation) => operation();
    await page.submit();
    global.setTimeout = originalSetTimeout;
    assert.deepStrictEqual(calls[0], {
      action: "changePassword",
      payload: {
        oldPassword: "Aa!OldPass123",
        newPassword: "Bb!NewPass456",
        confirmPassword: "Bb!NewPass456"
      }
    });
    assert.strictEqual(stored[0].key, "gk_user");
    assert.strictEqual(app.globalData.user.mustChangePassword, false);
    assert.deepStrictEqual(relaunch, [{ url: "/pages/home/index" }]);
  }

  // SALES-PAGE-FLOW-01：页面添加/合并产品明细，整单提交后清空草稿。
  {
    const calls = [];
    const toasts = [];
    global.wx = {
      showToast: (options) => toasts.push(options),
      showModal: (options) => options.success({ confirm: true })
    };
    const pageData = {
      isRep: true,
      dailySubmitted: false,
      canSubmit: true,
      stores: [{ id: "ST001", label: "客户甲 - 门店甲" }],
      products: [{ id: "P240", label: "测试产品240片" }],
      sales: []
    };
    const page = loadPage("sales", async (action, payload) => {
      calls.push({ action, payload });
      if (action === "getSalesPage") return pageData;
      return { status: "已提交" };
    });
    await page.load();
    page.setData({ qty: "2", batchNo: "BATCH-001" });
    page.addLine();
    page.setData({ qty: "3", batchNo: "BATCH-001" });
    page.addLine();
    assert.strictEqual(page.data.draftLines.length, 1);
    assert.strictEqual(page.data.draftLines[0].qty, 5);
    await page.submit();
    const submit = calls.find((item) => item.action === "submitSale");
    assert.strictEqual(submit.payload.storeId, "ST001");
    assert.deepStrictEqual(submit.payload.lines, [{ productId: "P240", qty: 5, batchNo: "BATCH-001" }]);
    assert.strictEqual(page.data.draftLines.length, 0);
    assert(toasts.some((item) => item.title === "已提交主管审核"));
  }

  // SALES-ZERO-PAGE-01：页面确认零销售后调用接口、提示成功并刷新日报状态。
  {
    const calls = [];
    const toasts = [];
    let submitted = false;
    global.wx = {
      showToast: (options) => toasts.push(options),
      showModal: (options) => options.success({ confirm: true })
    };
    const page = loadPage("sales", async (action) => {
      calls.push(action);
      if (action === "submitZeroDaily") {
        submitted = true;
        return { status: "已提交" };
      }
      if (action === "getSalesPage") {
        return { isRep: true, dailySubmitted: submitted, canSubmit: true, stores: [], products: [], sales: [] };
      }
      return {};
    });
    await page.load();
    assert.strictEqual(page.data.dailySubmitted, false);
    await page.submitZeroDaily();
    assert.strictEqual(page.data.dailySubmitted, true);
    assert.deepStrictEqual(calls, ["getSalesPage", "submitZeroDaily", "getSalesPage"]);
    assert(toasts.some((item) => item.title === "今日日报已提交"));
  }

  delete global.Page;
  delete global.wx;
  delete global.getApp;
  console.log("账号与销售页面操作流程测试通过");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
