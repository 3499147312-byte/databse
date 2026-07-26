const { call } = require("../../utils/api");
const { roleLabel } = require("../../utils/format");

const tabs = [
  { key: "roles", label: "角色模板" },
  { key: "users", label: "人员权限" },
  { key: "admins", label: "权限管理员" },
  { key: "requests", label: "高危申请" },
  { key: "delegations", label: "审批代理" },
  { key: "audit", label: "权限审计" }
];
const modes = [
  { key: "inherit", label: "继承" },
  { key: "extend", label: "追加" },
  { key: "replace", label: "替换" },
  { key: "deny", label: "禁用" }
];
const scopes = [
  { key: "self", label: "本人" },
  { key: "subordinates", label: "下属" },
  { key: "team", label: "本团队" },
  { key: "specified", label: "指定范围" },
  { key: "global", label: "全公司" }
];

function list(value) {
  return String(value || "").split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
}

Page({
  data: {
    loading: true,
    tabs,
    modes,
    scopes,
    tab: "roles",
    isBoss: false,
    roles: [],
    users: [],
    definitions: [],
    admins: [],
    requests: [],
    delegations: [],
    audit: [],
    managerOptions: [],
    roleEditor: null,
    userIndex: 0,
    roleIndex: 0,
    permissionIndex: 0,
    modeIndex: 0,
    scopeIndex: 0,
    overrideForm: { regions: "", teamIds: "", customerIds: "", warehouseIds: "", expiresAt: "", reason: "" },
    adminForm: { personIds: "", teamIds: "", regions: "", grantCeiling: "", expiresAt: "", canRequestHighRisk: true },
    delegationForm: { businessType: "sales", stage: "supervisor", managerId: "", delegateUserId: "", startDate: "", expiresAt: "", reason: "" }
  },

  onShow() {
    this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    try {
      const data = await call("getPermissionCenter", {}, { loading: false });
      const roles = data.roles || [];
      const users = (data.users || []).map((item) => ({ ...item, roleText: roleLabel(item.role) }));
      const roleIndex = Math.max(0, roles.findIndex((item) => item.id === users[0]?.permissionRoleId));
      this.setData({
        loading: false,
        isBoss: data.isBoss,
        roles,
        users,
        roleIndex,
        definitions: data.definitions || [],
        admins: data.admins || [],
        requests: data.requests || [],
        delegations: data.delegations || [],
        audit: data.audit || [],
        managerOptions: data.managerOptions || []
      });
    } catch {
      this.setData({ loading: false });
    }
  },

  switchTab(event) {
    this.setData({ tab: event.currentTarget.dataset.tab, roleEditor: null });
  },

  selectIndex(event) {
    const field = event.currentTarget.dataset.field;
    const value = Number(event.detail.value);
    const next = { [field]: value };
    if (field === "userIndex" && this.data.isBoss) {
      const roleId = this.data.users[value]?.permissionRoleId;
      next.roleIndex = Math.max(0, this.data.roles.findIndex((item) => item.id === roleId));
    }
    this.setData(next);
  },

  input(event) {
    this.setData({ [`${event.currentTarget.dataset.group}.${event.currentTarget.dataset.field}`]: event.detail.value });
  },

  toggleAdminRequest(event) {
    this.setData({ "adminForm.canRequestHighRisk": event.detail.value });
  },

  editRole(event) {
    const role = this.data.roles.find((item) => item.id === event.currentTarget.dataset.id);
    this.setData({
      roleEditor: {
        id: role.id,
        name: role.name,
        status: role.status,
        selected: Object.fromEntries((role.grants || []).map((item) => [item.permission, true])),
        scopeMap: Object.fromEntries((role.grants || []).map((item) => [item.permission, item.scope])),
        scopeIndex: Object.fromEntries((role.grants || []).map((item) => [
          item.permission,
          Math.max(0, scopes.findIndex((scope) => scope.key === item.scope.level))
        ])),
        reason: ""
      }
    });
  },

  newRole() {
    this.setData({ roleEditor: { id: "", name: "", status: "启用", selected: {}, scopeMap: {}, scopeIndex: {}, reason: "" } });
  },

  roleName(event) {
    this.setData({ "roleEditor.name": event.detail.value });
  },

  roleReason(event) {
    this.setData({ "roleEditor.reason": event.detail.value });
  },

  roleStatus(event) {
    this.setData({ "roleEditor.status": event.detail.value ? "启用" : "停用" });
  },

  rolePermission(event) {
    this.setData({ [`roleEditor.selected.${event.currentTarget.dataset.code}`]: event.detail.value.length > 0 });
  },

  roleScope(event) {
    const code = event.currentTarget.dataset.code;
    const index = Number(event.detail.value);
    this.setData({
      [`roleEditor.scopeIndex.${code}`]: index,
      [`roleEditor.scopeMap.${code}`]: { level: scopes[index].key }
    });
  },

  closeRole() {
    this.setData({ roleEditor: null });
  },

  async saveRole() {
    const editor = this.data.roleEditor;
    const grants = this.data.definitions
      .filter((item) => editor.selected[item.code])
      .map((item) => ({
        permission: item.code,
        scope: editor.scopeMap[item.code] || { level: item.code.includes(".view") ? "team" : "self" }
      }));
    const hasHighRisk = this.data.definitions.some((item) => item.highRisk && editor.selected[item.code]);
    if (hasHighRisk && editor.reason.trim().length < 2) {
      wx.showToast({ title: "请填写高危权限原因", icon: "none" });
      return;
    }
    if (hasHighRisk) {
      const result = await new Promise((resolve) => wx.showModal({
        title: "确认高危模板权限",
        content: "该模板包含高危权限，保存后可能立即影响已绑定人员。确认继续吗？",
        confirmText: "确认保存",
        success: resolve
      }));
      if (!result.confirm) return;
    }
    await call("savePermissionRole", {
      id: editor.id,
      name: editor.name,
      status: editor.status,
      grants,
      reason: editor.reason.trim(),
      confirmed: hasHighRisk
    });
    wx.showToast({ title: "模板已保存", icon: "success" });
    this.setData({ roleEditor: null });
    await this.load();
  },

  async saveUserPermission() {
    const user = this.data.users[this.data.userIndex];
    const role = this.data.roles[this.data.roleIndex];
    const definition = this.data.definitions[this.data.permissionIndex];
    const form = this.data.overrideForm;
    const highRiskGrant = definition.highRisk && ["extend", "replace"].includes(modes[this.data.modeIndex].key);
    const roleChanged = this.data.isBoss && role.id !== user.permissionRoleId;
    const roleAddsHighRisk = roleChanged && (role.grants || []).some((item) =>
      this.data.definitions.find((definitionItem) => definitionItem.code === item.permission)?.highRisk);
    if ((highRiskGrant || roleAddsHighRisk) && form.reason.trim().length < 2) {
      wx.showToast({ title: "高危授权必须填写原因", icon: "none" });
      return;
    }
    if (highRiskGrant || roleAddsHighRisk) {
      const result = await new Promise((resolve) => wx.showModal({
        title: "确认高危权限",
        content: `即将调整${user.name}的高危权限，确认继续吗？`,
        confirmText: "确认授权",
        success: resolve
      }));
      if (!result.confirm) return;
    }
    await call("saveUserPermissions", {
      userId: user.id,
      permissionRoleId: this.data.isBoss ? role.id : undefined,
      reason: form.reason.trim(),
      confirmed: highRiskGrant || roleAddsHighRisk,
      overrides: [{
        permission: definition.code,
        mode: modes[this.data.modeIndex].key,
        scope: {
          level: scopes[this.data.scopeIndex].key,
          regions: list(form.regions),
          teamIds: list(form.teamIds),
          customerIds: list(form.customerIds),
          warehouseIds: list(form.warehouseIds)
        },
        expiresAt: form.expiresAt,
        reason: form.reason
      }]
    });
    wx.showToast({ title: "权限已提交", icon: "success" });
    await this.load();
  },

  async saveAdmin() {
    const user = this.data.users[this.data.userIndex];
    const form = this.data.adminForm;
    await call("savePermissionAdmin", {
      userId: user.id,
      status: "启用",
      personIds: list(form.personIds),
      teamIds: list(form.teamIds),
      regions: list(form.regions),
      grantCeiling: list(form.grantCeiling),
      canRequestHighRisk: form.canRequestHighRisk,
      expiresAt: form.expiresAt
    });
    wx.showToast({ title: "管理员已保存", icon: "success" });
    await this.load();
  },

  async disableAdmin(event) {
    const admin = this.data.admins.find((item) => item._id === event.currentTarget.dataset.id);
    await call("savePermissionAdmin", { ...admin, userId: admin._id, status: "停用" });
    await this.load();
  },

  async reviewRequest(event) {
    await call("reviewPermissionRequest", {
      id: event.currentTarget.dataset.id,
      decision: event.currentTarget.dataset.decision,
      note: event.currentTarget.dataset.decision === "驳回" ? "老板审核驳回" : ""
    });
    await this.load();
  },

  async saveDelegation() {
    const form = this.data.delegationForm;
    await call("saveApprovalDelegation", form);
    wx.showToast({ title: "代理已保存", icon: "success" });
    await this.load();
  },

  async disableDelegation(event) {
    const item = this.data.delegations.find((entry) => entry._id === event.currentTarget.dataset.id);
    await call("saveApprovalDelegation", { ...item, id: item._id, status: "停用" });
    await this.load();
  },

  async migrate() {
    const result = await call("migratePermissions", {});
    wx.showModal({ title: "迁移完成", content: `已检查${result.totalUsers}个账号，更新${result.updated}个。`, showCancel: false });
    await this.load();
  }
});
