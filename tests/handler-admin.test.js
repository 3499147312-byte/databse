const assert = require("assert");
const path = require("path");
const fixture = require("./fixtures/business-fixture");
const { createHarness, expectCode } = require("./helpers/handler-harness");
const { localDate } = require("../cloudfunctions/api/lib/core");

const configPath = path.resolve(__dirname, "..", "cloudfunctions", "api", "config.js");
const testConfig = {
  setupCode: "TEST",
  passwordIterations: 1000,
  maxRowsPerImport: 1000
};

function seed() {
  const copy = JSON.parse(JSON.stringify(fixture));
  copy.users.forEach((user, index) => {
    user.username = user.username || `testuser${index + 1}`;
    user.usernameLower = user.username.toLowerCase();
    user.province = user.province || (user.personId === "M002" || user.managerId === "M002" ? "乙区" : "甲区");
    user.department = user.province;
    user.openid = user.personId === "R001" ? "openid_rep_1" : "";
  });
  copy.inventory_moves = [{
    _id: "MOVE_HIST",
    type: "in",
    status: "已通过",
    date: localDate(),
    warehouseId: "W001",
    managerId: "M001",
    productId: "P240",
    qty: 100,
    unitPrice: 60,
    batchNo: "BATCH-HIST",
    expiryDate: "2099-12-31"
  }];
  copy.inventory_lots = [];
  copy.receivables = [];
  copy.weekly_reports = [];
  copy.audit_logs = [];
  copy.corrections = [];
  copy.daily_reports = [];
  return copy;
}

function importRows() {
  return {
    personnel: {
      "人员编号*": "IMP-M01",
      "姓名*": "导入经理",
      "角色*": "省区/区域经理",
      "省区/区域*": "测试区域",
      "上级人员编号": "",
      "登录账号*": "impmgr01",
      "临时密码": "Zz!ImportPass7788",
      "状态*": "启用"
    },
    warehouses: {
      "仓库编号*": "IMP-W01",
      "商业公司/仓库名称*": "导入测试仓库",
      "省区/区域*": "甲区",
      "负责人经理编号*": "M001",
      "月结账期(天)*": "30",
      "状态*": "启用"
    },
    customers: {
      "客户编号*": "IMP-C01",
      "客户全称*": "导入测试客户",
      "渠道*": "诊所",
      "省区/区域*": "甲区",
      "主管人员编号": "S001",
      "经理人员编号*": "M001",
      "月度任务(盒)": "100",
      "状态*": "启用"
    },
    stores: {
      "门店编号*": "IMP-ST01",
      "门店名称*": "导入测试门店",
      "客户编号*": "C001",
      "业务代表人员编号*": "R001",
      "仓库编号*": "W001",
      "状态*": "启用"
    },
    products: {
      "产品编号*": "IMP-P01",
      "产品名称*": "导入测试产品",
      "包装规格*": "60片",
      "规格换算系数*": "0.25",
      "状态*": "启用"
    },
    inventory: {
      "入库单号*": "IMP-IN01",
      "入库日期*": localDate(),
      "仓库编号*": "W001",
      "产品编号*": "P240",
      "入库数量(盒)*": "100",
      "供货单价(元)*": "60.25",
      "批号*": "BATCH-IMPORT",
      "有效期*": "2099-12-31"
    },
    policies: {
      "政策编号*": "IMP-POL01",
      "客户编号*": "C001",
      "产品编号*": "P240",
      "开始日期*": localDate(),
      "结束日期*": "2099-12-31",
      "开票价(元/盒)*": "100",
      "零售价(元/盒)": "128",
      "总部返利(元/盒)": "2",
      "无票返利(元/盒)": "0",
      "单盒推广开销(元)": "18",
      "预计月销(盒)*": "100",
      "单盒业务代表提成(元)": "2.5",
      "单盒主管提成(元)": "1.2",
      "单盒省区提成(元)": "0.8",
      "备注": "匿名导入测试"
    },
    historicalSales: {
      "销售单号*": "IMP-SALE01",
      "销售日期*": localDate(),
      "代表人员编号*": "R001",
      "客户编号*": "C001",
      "门店编号*": "ST001",
      "仓库编号*": "W001",
      "产品编号*": "P240",
      "销售数量(盒)*": "10",
      "批号*": "BATCH-HIST",
      "单盒销售价*": "100",
      "单盒代表提成*": "2.5",
      "单盒主管提成*": "1.2",
      "单盒省区提成*": "0.8",
      "单盒客情额度*": "18"
    }
  };
}

(async () => {
  const boss = fixture.users.find((item) => item.role === "boss");
  boss.username = "boss-test";
  boss.usernameLower = "boss-test";
  boss.province = "总部";

  // ADMIN-PAGE-01：老板查看全部非老板人员，密码字段被移除并显示上下级、微信绑定。
  {
    const harness = createHarness(seed(), boss);
    const admin = harness.loadHandler("admin", { modules: { [configPath]: testConfig } });
    const result = await admin.getAdminPage();
    assert.strictEqual(result.users.length, seed().users.length - 1);
    assert(result.users.every((item) => item.role !== "boss" && item.passwordHash === undefined));
    const rep = result.users.find((item) => item.personId === "R001");
    assert.strictEqual(rep.parentId, "S001");
    assert.strictEqual(rep.parentName, "主管甲");
    assert.strictEqual(rep.boundWechat, true);
  }

  // ADMIN-SAVE-01：老板新增经理、主管和经理直管代表，并能修改原人员。
  {
    const harness = createHarness(seed(), boss);
    const admin = harness.loadHandler("admin", { modules: { [configPath]: testConfig } });
    const managerResult = await admin.saveUser({
      id: "NEW-M01",
      username: "newmanager01",
      name: "新增经理",
      province: "新区域",
      role: "manager",
      parentId: "",
      tempPassword: "Aa!NewManager7788"
    });
    assert.strictEqual(managerResult.user.managerId, "");
    const supervisorResult = await admin.saveUser({
      id: "NEW-S01",
      username: "newsupervisor01",
      name: "新增主管",
      province: "新区域",
      role: "supervisor",
      parentId: "NEW-M01",
      tempPassword: "Bb!NewSupervisor7788"
    });
    assert.strictEqual(supervisorResult.user.managerId, "NEW-M01");
    const repResult = await admin.saveUser({
      id: "NEW-R01",
      username: "newrep01",
      name: "新增代表",
      province: "新区域",
      role: "rep",
      parentId: "NEW-M01",
      tempPassword: "Cc!NewRepresentative7788"
    });
    assert.strictEqual(repResult.user.managerId, "NEW-M01");
    assert.strictEqual(repResult.user.supervisorId, "");
    const modified = await admin.saveUser({
      id: "NEW-R01",
      username: "newrep01",
      name: "新增代表已修改",
      province: "新区域",
      role: "rep",
      parentId: "NEW-S01",
      tempPassword: ""
    });
    assert.strictEqual(modified.user.supervisorId, "NEW-S01");
  }

  // ADMIN-SAVE-02：重复登录账号、错误上下级及修改老板均被保护。
  {
    const harness = createHarness(seed(), boss);
    const admin = harness.loadHandler("admin", { modules: { [configPath]: testConfig } });
    await expectCode(admin.saveUser({
      id: "NEW-R02",
      username: "testuser6",
      name: "重复账号",
      province: "甲区",
      role: "rep",
      parentId: "M001",
      tempPassword: "Aa!Duplicate7788"
    }), "USERNAME_EXISTS");
    await expectCode(admin.saveUser({
      id: "NEW-S02",
      username: "newsupervisor02",
      name: "错误主管",
      province: "甲区",
      role: "supervisor",
      parentId: "R001",
      tempPassword: "Aa!WrongParent7788"
    }), "INVALID_PARENT");
    await expectCode(admin.saveUser({
      id: "BOSS",
      username: "boss-test",
      name: "修改老板",
      province: "总部",
      role: "manager",
      parentId: "",
      tempPassword: ""
    }), "BOSS_PROTECTED");
  }

  // ADMIN-TOGGLE-01：停用后可再次启用，老板账号受保护。
  {
    const harness = createHarness(seed(), boss);
    const admin = harness.loadHandler("admin", { modules: { [configPath]: testConfig } });
    assert.strictEqual((await admin.toggleUser({ userId: "R001" })).status, "停用");
    assert.strictEqual(harness.get("users", "acct_r1").disabled, true);
    assert.strictEqual((await admin.toggleUser({ userId: "R001" })).status, "启用");
    await expectCode(admin.toggleUser({ userId: "BOSS" }), "USER_PROTECTED");
  }

  // ADMIN-RESET-01：重置生成强临时密码，要求下次登录改密。
  {
    const harness = createHarness(seed(), boss);
    const admin = harness.loadHandler("admin", { modules: { [configPath]: testConfig } });
    const result = await admin.resetUserPassword({ userId: "R001" });
    assert(result.temporaryPassword.length >= 10);
    assert.strictEqual(harness.get("users", "acct_r1").mustChangePassword, true);
    assert(harness.get("users", "acct_r1").passwordHash);
  }

  // ADMIN-UNBIND-01：微信解绑可重复执行且不影响人员记录。
  {
    const harness = createHarness(seed(), boss);
    const admin = harness.loadHandler("admin", { modules: { [configPath]: testConfig } });
    assert.strictEqual((await admin.unbindUserWechat({ userId: "R001" })).boundWechat, false);
    assert.strictEqual(harness.get("users", "acct_r1").openid, "");
    assert.strictEqual((await admin.unbindUserWechat({ userId: "R001" })).boundWechat, false);
  }

  // ADMIN-DELETE-01：有业务依赖的人员禁止删除，无依赖人员允许删除。
  {
    const data = seed();
    data.users.push({
      _id: "acct_unused",
      personId: "UNUSED01",
      username: "unused01",
      usernameLower: "unused01",
      name: "无业务人员",
      role: "rep",
      managerId: "M001",
      supervisorId: "",
      disabled: true
    });
    const harness = createHarness(data, boss);
    const admin = harness.loadHandler("admin", { modules: { [configPath]: testConfig } });
    await expectCode(admin.deleteUser({ userId: "R001" }), "USER_HAS_DEPENDENCIES");
    assert.deepStrictEqual(await admin.deleteUser({ userId: "UNUSED01" }), { deleted: true });
    assert.strictEqual(harness.get("users", "acct_unused"), undefined);
  }

  // IMPORT-01：八类导入均先预检查，再正式写入相应集合。
  for (const [type, row] of Object.entries(importRows())) {
    const harness = createHarness(seed(), boss);
    const admin = harness.loadHandler("admin", { modules: { [configPath]: testConfig } });
    const preview = await admin.adminImportRows({ type, rows: [{ rowNumber: 2, values: row }], dryRun: true });
    assert.strictEqual(preview.totalRows, 1, `${type} preview total`);
    assert.deepStrictEqual(preview.errors, [], `${type} preview errors: ${JSON.stringify(preview.errors)}`);
    const committed = await admin.adminImportRows({ type, rows: [{ rowNumber: 2, values: row }], dryRun: false });
    assert.strictEqual(committed.totalRows, 1, `${type} commit total`);
    if (type === "personnel") assert(harness.rows("users").some((item) => item.personId === "IMP-M01"));
    if (type === "warehouses") assert(harness.get("warehouses", "IMP-W01"));
    if (type === "customers") assert(harness.get("customers", "IMP-C01"));
    if (type === "stores") assert(harness.get("stores", "IMP-ST01"));
    if (type === "products") assert(harness.get("products", "IMP-P01"));
    if (type === "inventory") assert(harness.rows("inventory_moves").some((item) => item.sourceNo === "IMP-IN01"));
    if (type === "policies") assert(harness.rows("policies").some((item) => item.sourceNo === "IMP-POL01" && item.status === "待老板审核"));
    if (type === "historicalSales") assert(harness.rows("sales").some((item) => item.sourceNo === "IMP-SALE01" && item.source === "历史销售导入"));
  }

  // IMPORT-02：错误类型、空文件、示例行和缺少表头返回明确错误。
  {
    const harness = createHarness(seed(), boss);
    const admin = harness.loadHandler("admin", { modules: { [configPath]: testConfig } });
    await expectCode(admin.adminImportRows({ type: "unknown", rows: [{}], dryRun: true }), "INVALID_IMPORT_TYPE");
    await expectCode(admin.adminImportRows({ type: "products", rows: [], dryRun: true }), "INVALID_IMPORT_SIZE");
    const bad = { ...importRows().products, "产品编号*": "EXAMPLE-001" };
    const preview = await admin.adminImportRows({ type: "products", rows: [{ rowNumber: 2, values: bad }], dryRun: true });
    assert(preview.errors.some((item) => item.field === "编号"));
    const missingHeaders = await admin.adminImportRows({
      type: "products",
      rows: [{ rowNumber: 2, values: { "产品编号*": "P-X" } }],
      dryRun: true
    });
    assert(missingHeaders.errors.some((item) => item.field === "表头"));
    const bossRow = {
      ...importRows().personnel,
      "人员编号*": "BOSS",
      "姓名*": "修改老板",
      "登录账号*": "boss-import",
      "临时密码": ""
    };
    const bossPreview = await admin.adminImportRows({
      type: "personnel",
      rows: [{ rowNumber: 2, values: bossRow }],
      dryRun: true
    });
    assert(bossPreview.errors.some((item) => item.message.includes("老板账号受系统保护")));
  }

  console.log("老板人员管理与八类批量导入测试通过");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
