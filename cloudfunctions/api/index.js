const auth = require("./handlers/auth");
const dashboard = require("./handlers/dashboard");
const sales = require("./handlers/sales");
const inventory = require("./handlers/inventory");
const expenses = require("./handlers/expenses");
const receivables = require("./handlers/receivables");
const reports = require("./handlers/reports");
const admin = require("./handlers/admin");

const actions = Object.freeze({
  bootstrap: auth.bootstrap,
  login: auth.login,
  me: auth.me,
  changePassword: auth.changePassword,
  getDashboard: dashboard.getDashboard,
  getApprovals: dashboard.getApprovals,
  getSalesPage: sales.getSalesPage,
  submitSale: sales.submitSale,
  submitZeroDaily: sales.submitZeroDaily,
  approveSale: sales.approveSale,
  rejectSale: sales.rejectSale,
  correctSale: sales.correctSale,
  getInventoryPage: inventory.getInventoryPage,
  receiveInventory: inventory.receiveInventory,
  getExpensesPage: expenses.getExpensesPage,
  submitExpense: expenses.submitExpense,
  approveExpense: expenses.approveExpense,
  rejectExpense: expenses.rejectExpense,
  markExpensePaid: expenses.markExpensePaid,
  markExpenseInvoiced: expenses.markExpenseInvoiced,
  getReceivables: receivables.getReceivables,
  recordWarehousePayment: receivables.recordWarehousePayment,
  verifyWarehousePayment: receivables.verifyWarehousePayment,
  voidWarehousePayment: receivables.voidWarehousePayment,
  updateWarehouseTerm: receivables.updateWarehouseTerm,
  getReports: reports.getReports,
  getBossPerformance: reports.getBossPerformance,
  submitWeekly: reports.submitWeekly,
  approvePolicy: reports.approvePolicy,
  rejectPolicy: reports.rejectPolicy,
  getAdminPage: admin.getAdminPage,
  saveUser: admin.saveUser,
  toggleUser: admin.toggleUser,
  resetUserPassword: admin.resetUserPassword,
  unbindUserWechat: admin.unbindUserWechat,
  deleteUser: admin.deleteUser,
  adminImportRows: admin.adminImportRows
});

exports.main = async (event) => {
  const action = String(event?.action || "");
  const handler = actions[action];
  if (!handler) {
    return { ok: false, code: "UNKNOWN_ACTION", message: "请求的功能不存在，请更新小程序后重试。" };
  }
  try {
    const data = await handler(event?.payload || {});
    return { ok: true, data };
  } catch (error) {
    console.error(JSON.stringify({
      action,
      code: error.code || "INTERNAL_ERROR",
      message: error.message,
      stack: error.stack
    }));
    return {
      ok: false,
      code: error.code || "INTERNAL_ERROR",
      message: error.code ? error.message : "系统暂时无法处理，请稍后重试或联系管理员。",
      ...(error.details ? { details: error.details } : {})
    };
  }
};
