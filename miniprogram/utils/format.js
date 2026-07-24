function money(value) {
  return Number(value || 0).toFixed(2);
}

function roleLabel(role) {
  return {
    boss: "老板",
    hq_auditor: "总部审核人员",
    finance: "总部财务人员",
    manager: "省区/区域经理",
    supervisor: "地区主管",
    rep: "业务代表"
  }[role] || role || "";
}

function badgeClass(status) {
  const text = String(status || "");
  if (text.includes("逾期") || text.includes("驳回") || text.includes("作废") || text.includes("超额")) return "danger";
  if (text.includes("待") || text.includes("到期") || text.includes("部分") || text.includes("预警")) return "warn";
  return "";
}

function monthNow() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

module.exports = { money, roleLabel, badgeClass, monthNow };
