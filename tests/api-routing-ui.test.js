const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const apiRoot = path.join(root, "cloudfunctions", "api");
const actionGroups = {
  auth: ["bootstrap", "login", "me", "changePassword"],
  dashboard: ["getDashboard", "getApprovals"],
  sales: ["getSalesPage", "submitSale", "submitZeroDaily", "approveSale", "rejectSale", "correctSale"],
  inventory: ["getInventoryPage", "receiveInventory"],
  expenses: ["getExpensesPage", "submitExpense", "approveExpense", "rejectExpense", "markExpensePaid", "markExpenseInvoiced"],
  receivables: ["getReceivables", "recordWarehousePayment", "verifyWarehousePayment", "voidWarehousePayment", "updateWarehouseTerm"],
  reports: ["getReports", "getBossPerformance", "submitWeekly", "approvePolicy", "rejectPolicy"],
  admin: ["getAdminPage", "saveUser", "toggleUser", "resetUserPassword", "unbindUserWechat", "deleteUser", "adminImportRows"],
  permissions: ["getPermissionCenter", "savePermissionRole", "savePermissionAdmin", "saveUserPermissions", "reviewPermissionRequest", "saveApprovalDelegation", "migratePermissions"]
};
const allActions = Object.values(actionGroups).flat();

function injectHandler(name, actions) {
  const file = path.join(apiRoot, "handlers", `${name}.js`);
  const exports = Array.isArray(actions) ? {} : actions;
  if (Array.isArray(actions)) {
    for (const action of actions) exports[action] = async (payload) => ({ action, payload });
  }
  require.cache[require.resolve(file)] = {
    id: file,
    filename: file,
    loaded: true,
    exports
  };
}

(async () => {
  Object.entries(actionGroups).forEach(([name, actions]) => injectHandler(name, actions));
  const indexPath = path.join(apiRoot, "index.js");
  delete require.cache[require.resolve(indexPath)];
  const api = require(indexPath);

  // API-ROUTE-01：44个公开动作全部路由到对应处理函数并原样传递payload。
  assert.strictEqual(allActions.length, 44);
  for (const action of allActions) {
    const result = await api.main({ action, payload: { testId: action } });
    assert.strictEqual(result.ok, true, action);
    assert.strictEqual(result.data.action, action);
    assert.deepStrictEqual(result.data.payload, { testId: action });
  }

  // API-ROUTE-02：未知动作返回稳定错误码。
  const unknown = await api.main({ action: "notExisting", payload: {} });
  assert.deepStrictEqual(unknown, {
    ok: false,
    code: "UNKNOWN_ACTION",
    message: "请求的功能不存在，请更新小程序后重试。"
  });

  // API-ROUTE-03：业务错误保留错误码和详情，内部错误隐藏具体信息。
  injectHandler("auth", {
    bootstrap: async () => {
      const error = new Error("可展示业务错误");
      error.code = "BUSINESS_ERROR";
      error.details = { row: 2 };
      throw error;
    },
    login: async () => {
      throw new Error("数据库内部敏感错误");
    },
    me: async () => ({}),
    changePassword: async () => ({})
  });
  delete require.cache[require.resolve(indexPath)];
  const errorApi = require(indexPath);
  const originalConsoleError = console.error;
  console.error = () => {};
  const business = await errorApi.main({ action: "bootstrap" });
  assert.strictEqual(business.code, "BUSINESS_ERROR");
  assert.strictEqual(business.message, "可展示业务错误");
  assert.deepStrictEqual(business.details, { row: 2 });
  const internal = await errorApi.main({ action: "login" });
  console.error = originalConsoleError;
  assert.strictEqual(internal.code, "INTERNAL_ERROR");
  assert.strictEqual(internal.message, "系统暂时无法处理，请稍后重试或联系管理员。");
  assert(!JSON.stringify(internal).includes("数据库内部敏感错误"));

  // UI-CONTRACT-01：13个页面均有脚本、模板和配置，并且全部云端动作存在于API路由。
  const app = JSON.parse(fs.readFileSync(path.join(root, "miniprogram", "app.json"), "utf8"));
  assert.strictEqual(app.pages.length, 13);
  for (const page of app.pages) {
    for (const extension of [".js", ".json", ".wxml"]) {
      assert(fs.existsSync(path.join(root, "miniprogram", `${page}${extension}`)), `${page}${extension}`);
    }
  }
  const uiActions = new Set();
  for (const page of app.pages) {
    const js = fs.readFileSync(path.join(root, "miniprogram", `${page}.js`), "utf8");
    const wxml = fs.readFileSync(path.join(root, "miniprogram", `${page}.wxml`), "utf8");
    for (const match of js.matchAll(/call\("([A-Za-z0-9_]+)"/g)) uiActions.add(match[1]);
    for (const match of wxml.matchAll(/data-action="([A-Za-z0-9_]+)"/g)) uiActions.add(match[1]);
  }
  const missing = [...uiActions].filter((action) => !allActions.includes(action));
  assert.deepStrictEqual(missing, []);
  const notReachable = allActions.filter((action) => !uiActions.has(action));
  assert.deepStrictEqual(notReachable, []);

  console.log("API路由与13页面契约测试通过");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
