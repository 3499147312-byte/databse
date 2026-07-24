const crypto = require("crypto");
const config = require("../config");
const {
  db,
  command,
  fetchAll,
  getDoc,
  setDoc,
  updateDoc,
  findUserByBusinessId,
  requireUser,
  assertRole,
  writeAudit,
  userBusinessId,
  safeUser,
  fail
} = require("../lib/context");
const {
  nowIso,
  monthKey,
  validDate,
  validCode,
  validBatchNo,
  roleFromLabel,
  validPassword,
  newPasswordRecord,
  temporaryPassword,
  positiveNumber,
  nonNegativeNumber,
  calc4
} = require("../lib/core");
const { lotId, rebuildReceivable } = require("../lib/domain");

const STATUS_VALUES = new Set(["启用", "停用"]);
const CHANNEL_VALUES = new Set(["连锁药店", "单体药店", "诊所", "民营医院", "社区卫生院", "其他"]);
const IMPORT_HEADERS = {
  personnel: ["人员编号*", "姓名*", "角色*", "省区/区域*", "上级人员编号", "登录账号*", "临时密码", "状态*"],
  warehouses: ["仓库编号*", "商业公司/仓库名称*", "省区/区域*", "负责人经理编号*", "月结账期(天)*", "状态*"],
  customers: ["客户编号*", "客户全称*", "渠道*", "省区/区域*", "经理人员编号*", "月度任务(盒)", "状态*"],
  stores: ["门店编号*", "门店名称*", "客户编号*", "业务代表人员编号*", "仓库编号*", "状态*"],
  products: ["产品编号*", "产品名称*", "包装规格*", "规格换算系数*", "状态*"],
  inventory: ["入库单号*", "入库日期*", "仓库编号*", "产品编号*", "入库数量(盒)*", "供货单价(元)*", "批号*", "有效期*"],
  policies: ["政策编号*", "客户编号*", "产品编号*", "开始日期*", "结束日期*", "开票价(元/盒)*", "预计月销(盒)*"],
  historicalSales: ["销售单号*", "销售日期*", "代表人员编号*", "客户编号*", "门店编号*", "仓库编号*", "产品编号*", "销售数量(盒)*", "批号*", "单盒销售价*", "单盒代表提成*", "单盒主管提成*", "单盒省区提成*", "单盒客情额度*"]
};

function hashId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 40)}`;
}

function clean(value) {
  return String(value ?? "").trim();
}

function rowValues(source) {
  const values = source && typeof source.values === "object" ? source.values : source;
  return Object.fromEntries(Object.entries(values || {}).map(([key, value]) => [clean(key), clean(value)]));
}

function addError(errors, rowNumber, field, message) {
  errors.push({
    key: `${rowNumber}_${field}_${errors.length}`,
    rowNumber,
    field,
    message
  });
}

function publicUser(user, peopleMap) {
  const item = safeUser(user);
  const parentId = user.role === "rep" ? user.supervisorId || user.managerId : user.role === "supervisor" ? user.managerId : "";
  return {
    ...item,
    parentId,
    parentName: peopleMap.get(parentId)?.name || "",
    boundWechat: Boolean(user.openid)
  };
}

async function getAdminPage() {
  const actor = await requireUser();
  assertRole(actor, ["boss"]);
  const users = await fetchAll("users", {}, { max: 3000 });
  const peopleMap = new Map(users.map((item) => [userBusinessId(item), item]));
  return {
    users: users
      .filter((item) => item.role !== "boss")
      .map((item) => publicUser(item, peopleMap))
      .sort((a, b) => `${a.province}|${a.role}|${a.name}`.localeCompare(`${b.province}|${b.role}|${b.name}`, "zh-CN"))
  };
}

async function resolveHierarchy(role, parentId) {
  if (["manager", "hq_auditor", "finance"].includes(role)) return { managerId: "", supervisorId: "" };
  const parent = await findUserByBusinessId(parentId);
  if (role === "supervisor") {
    if (!parent || parent.disabled || parent.role !== "manager") {
      fail("INVALID_PARENT", "地区主管的上级必须是一个启用的省区/区域经理。");
    }
    return { managerId: userBusinessId(parent), supervisorId: "" };
  }
  if (!parent || parent.disabled || !["manager", "supervisor"].includes(parent.role)) {
    fail("INVALID_PARENT", "业务代表的上级必须是启用的地区主管或省区/区域经理。");
  }
  if (parent.role === "manager") return { managerId: userBusinessId(parent), supervisorId: "" };
  if (!parent.managerId) fail("INVALID_PARENT", "该地区主管尚未归属经理，不能管理业务代表。");
  return { managerId: parent.managerId, supervisorId: userBusinessId(parent) };
}

async function saveUser(payload) {
  const actor = await requireUser();
  assertRole(actor, ["boss"]);
  const personId = clean(payload.id);
  const username = clean(payload.username);
  const name = clean(payload.name);
  const province = clean(payload.province);
  const role = clean(payload.role);
  if (!validCode(personId) || !validCode(username) || !name || name.length > 50 || !province || province.length > 50) {
    fail("INVALID_USER", "人员编号、姓名、登录账号或省区/区域格式不正确。");
  }
  if (!["hq_auditor", "finance", "manager", "supervisor", "rep"].includes(role)) fail("INVALID_ROLE", "人员角色不正确。");
  const existing = await findUserByBusinessId(personId);
  if (existing?.role === "boss") fail("BOSS_PROTECTED", "老板账号不能在这里修改。");
  const duplicate = await db.collection("users").where({ usernameLower: username.toLowerCase() }).limit(2).get();
  if (duplicate.data.some((item) => item._id !== existing?._id)) fail("USERNAME_EXISTS", "这个登录账号已经被其他人使用。");
  const hierarchy = await resolveHierarchy(role, clean(payload.parentId));
  const tempPassword = String(payload.tempPassword || "");
  if (!existing && !tempPassword) fail("TEMP_PASSWORD_REQUIRED", "新增人员必须填写临时密码。");
  if (tempPassword && !validPassword(tempPassword, { username, name })) {
    fail("WEAK_PASSWORD", "临时密码至少10位，并包含大小写字母、数字和特殊符号，且不能包含账号或姓名。");
  }
  const id = existing?._id || hashId("acct", personId);
  const record = {
    ...(existing || {}),
    personId,
    username,
    usernameLower: username.toLowerCase(),
    name,
    role,
    province,
    department: province,
    ...hierarchy,
    disabled: existing?.disabled || false,
    mustChangePassword: tempPassword ? true : Boolean(existing?.mustChangePassword),
    failedAttempts: 0,
    lockedUntil: 0,
    updatedAt: nowIso(),
    createdAt: existing?.createdAt || nowIso(),
    source: existing?.source || "老板后台新增"
  };
  if (tempPassword) Object.assign(record, newPasswordRecord(tempPassword, config.passwordIterations));
  await setDoc("users", id, record);
  await writeAudit(actor, existing ? "修改人员" : "新增人员", personId, `${name} / ${role} / ${province}`);
  return { user: safeUser({ _id: id, ...record }) };
}

async function toggleUser(payload) {
  const actor = await requireUser();
  assertRole(actor, ["boss"]);
  const target = await findUserByBusinessId(clean(payload.userId));
  if (!target || target.role === "boss" || target._id === actor._id) fail("USER_PROTECTED", "该账号不存在或不能停用。");
  await updateDoc("users", target._id, {
    disabled: !target.disabled,
    failedAttempts: 0,
    lockedUntil: 0,
    updatedAt: nowIso()
  });
  await writeAudit(actor, target.disabled ? "启用人员" : "停用人员", userBusinessId(target), target.name);
  return { status: target.disabled ? "启用" : "停用" };
}

async function resetUserPassword(payload) {
  const actor = await requireUser();
  assertRole(actor, ["boss"]);
  const target = await findUserByBusinessId(clean(payload.userId));
  if (!target || target.role === "boss") fail("USER_PROTECTED", "该账号不存在或不能由这里重置。");
  const password = temporaryPassword();
  await updateDoc("users", target._id, {
    ...newPasswordRecord(password, config.passwordIterations),
    mustChangePassword: true,
    failedAttempts: 0,
    lockedUntil: 0,
    passwordResetAt: nowIso(),
    passwordResetBy: userBusinessId(actor)
  });
  await writeAudit(actor, "重置人员密码", userBusinessId(target), `${target.name}的临时密码已重置`);
  return { temporaryPassword: password };
}

async function unbindUserWechat(payload) {
  const actor = await requireUser();
  assertRole(actor, ["boss"]);
  const target = await findUserByBusinessId(clean(payload.userId));
  if (!target || target.role === "boss") fail("USER_PROTECTED", "该账号不存在或不能由这里解绑。");
  if (!target.openid) return { boundWechat: false };
  await updateDoc("users", target._id, {
    openid: "",
    unboundAt: nowIso(),
    unboundBy: userBusinessId(actor)
  });
  await writeAudit(actor, "解除微信绑定", userBusinessId(target), target.name);
  return { boundWechat: false };
}

async function dependencyCount(collectionName, where) {
  const result = await db.collection(collectionName).where(where).count();
  return Number(result.total || 0);
}

async function deleteUser(payload) {
  const actor = await requireUser();
  assertRole(actor, ["boss"]);
  const target = await findUserByBusinessId(clean(payload.userId));
  if (!target || target.role === "boss" || target._id === actor._id) fail("USER_PROTECTED", "该账号不存在或不能删除。");
  const id = userBusinessId(target);
  const checks = [
    ["下属人员", "users", command.or([{ managerId: id }, { supervisorId: id }])],
    ["仓库", "warehouses", { managerId: id }],
    ["客户", "customers", command.or([{ managerId: id }, { supervisorId: id }])],
    ["门店", "stores", { repId: id }],
    ["销售", "sales", command.or([{ managerId: id }, { supervisorId: id }, { repId: id }])],
    ["费用", "expenses", command.or([{ managerId: id }, { supervisorId: id }, { repId: id }])],
    ["周报", "weekly_reports", { ownerId: id }],
    ["回款", "warehouse_payments", { registeredBy: id }]
  ];
  const dependencies = [];
  for (const [label, collectionName, where] of checks) {
    const count = await dependencyCount(collectionName, where);
    if (count) dependencies.push(`${label}${count}条`);
  }
  if (dependencies.length) {
    fail("USER_HAS_DEPENDENCIES", `该人员还有${dependencies.join("、")}，请停用账号，不能删除。`);
  }
  await db.collection("users").doc(target._id).remove();
  await writeAudit(actor, "删除无业务人员", id, target.name);
  return { deleted: true };
}

function normalizeRows(type, sourceRows) {
  return sourceRows.map((source, index) => {
    const values = rowValues(source);
    const rowNumber = Number(source.rowNumber || index + 2);
    if (type === "personnel") {
      return { rowNumber, values, id: values["人员编号*"], name: values["姓名*"], role: roleFromLabel(values["角色*"]), province: values["省区/区域*"], parentId: values["上级人员编号"], username: values["登录账号*"], tempPassword: values["临时密码"], status: values["状态*"] };
    }
    if (type === "warehouses") {
      return { rowNumber, values, id: values["仓库编号*"], name: values["商业公司/仓库名称*"], province: values["省区/区域*"], managerId: values["负责人经理编号*"], creditDays: Number(values["月结账期(天)*"]), status: values["状态*"] };
    }
    if (type === "customers") {
      return { rowNumber, values, id: values["客户编号*"], name: values["客户全称*"], channel: values["渠道*"], province: values["省区/区域*"], supervisorId: values["主管人员编号"] || values["主管人员编号*"] || "", managerId: values["经理人员编号*"], monthlyTarget: Number(values["月度任务(盒)"] || 0), status: values["状态*"] };
    }
    if (type === "stores") {
      return { rowNumber, values, id: values["门店编号*"], name: values["门店名称*"], customerId: values["客户编号*"], repId: values["业务代表人员编号*"], warehouseId: values["仓库编号*"], status: values["状态*"] };
    }
    if (type === "products") {
      return { rowNumber, values, id: values["产品编号*"], name: values["产品名称*"], spec: values["包装规格*"], ratio: Number(values["规格换算系数*"]), status: values["状态*"] };
    }
    if (type === "inventory") {
      return { rowNumber, values, id: values["入库单号*"], date: values["入库日期*"], warehouseId: values["仓库编号*"], productId: values["产品编号*"], qty: Number(values["入库数量(盒)*"]), unitPrice: Number(values["供货单价(元)*"]), batchNo: values["批号*"], expiryDate: values["有效期*"] };
    }
    if (type === "policies") {
      return {
        rowNumber,
        values,
        id: values["政策编号*"],
        customerId: values["客户编号*"],
        productId: values["产品编号*"],
        start: values["开始日期*"],
        end: values["结束日期*"],
        invoicePrice: Number(values["开票价(元/盒)*"]),
        retailPrice: Number(values["零售价(元/盒)"] || 0),
        headRebate: Number(values["总部返利(元/盒)"] || 0),
        noInvoiceRebate: Number(values["无票返利(元/盒)"] || 0),
        promoSpend: Number(values["单盒推广开销(元)"] || 0),
        monthlyTarget: Number(values["预计月销(盒)*"]),
        repCommission: values["单盒业务代表提成(元)"] === undefined || values["单盒业务代表提成(元)"] === "" ? null : Number(values["单盒业务代表提成(元)"]),
        supervisorCommission: values["单盒主管提成(元)"] === undefined || values["单盒主管提成(元)"] === "" ? null : Number(values["单盒主管提成(元)"]),
        managerCommission: values["单盒省区提成(元)"] === undefined || values["单盒省区提成(元)"] === "" ? null : Number(values["单盒省区提成(元)"]),
        note: values["备注"] || ""
      };
    }
    return {
      rowNumber,
      values,
      id: values["销售单号*"],
      date: values["销售日期*"],
      repId: values["代表人员编号*"],
      customerId: values["客户编号*"],
      storeId: values["门店编号*"],
      warehouseId: values["仓库编号*"],
      productId: values["产品编号*"],
      qty: Number(values["销售数量(盒)*"]),
      batchNo: values["批号*"],
      salePrice: Number(values["单盒销售价*"]),
      repCommission: Number(values["单盒代表提成*"]),
      supervisorCommission: Number(values["单盒主管提成*"]),
      managerCommission: Number(values["单盒省区提成*"]),
      promoBudget: Number(values["单盒客情额度*"])
    };
  });
}

function validateHeaders(type, sourceRows, errors) {
  const headers = new Set(Object.keys(rowValues(sourceRows[0])));
  for (const header of IMPORT_HEADERS[type]) {
    if (!headers.has(header)) addError(errors, 1, "表头", `缺少列“${header}”，请使用系统模板，不要修改带星号的表头。`);
  }
}

function validateCommonIds(type, rows, errors) {
  const seen = new Set();
  for (const row of rows) {
    if (!validCode(row.id)) addError(errors, row.rowNumber, "编号", "编号只能使用2至64位字母、数字、点、横线或下划线。");
    if (String(row.id).startsWith("EXAMPLE-")) addError(errors, row.rowNumber, "编号", "模板中的示例行必须删除后再导入。");
    const key = type === "historicalSales" ? `${row.id}|${row.productId}|${row.batchNo}` : type === "inventory" ? `${row.id}|${row.warehouseId}|${row.productId}|${row.batchNo}` : row.id;
    if (seen.has(key)) addError(errors, row.rowNumber, "编号", "文件中存在完全重复的数据行。");
    seen.add(key);
  }
}

async function loadMasterMaps() {
  const [users, warehouses, customers, stores, products] = await Promise.all([
    fetchAll("users", {}, { max: 3000 }),
    fetchAll("warehouses", {}, { max: 3000 }),
    fetchAll("customers", {}, { max: 5000 }),
    fetchAll("stores", {}, { max: 10000 }),
    fetchAll("products", {}, { max: 3000 })
  ]);
  return {
    users,
    people: new Map(users.map((item) => [userBusinessId(item), item])),
    usernames: new Map(users.map((item) => [String(item.usernameLower || "").toLowerCase(), item])),
    warehouses: new Map(warehouses.map((item) => [item._id, item])),
    customers: new Map(customers.map((item) => [item._id, item])),
    stores: new Map(stores.map((item) => [item._id, item])),
    products: new Map(products.map((item) => [item._id, item]))
  };
}

function validatePersonnel(rows, maps, errors) {
  const combinedPeople = new Map(maps.people);
  rows.forEach((row) => combinedPeople.set(row.id, row));
  const incomingUsernames = new Map();
  for (const row of rows) {
    if (!row.name || row.name.length > 50 || !row.province || row.province.length > 50) addError(errors, row.rowNumber, "姓名/省区", "姓名和省区/区域不能为空，且最长50个字。");
    if (!["hq_auditor", "finance", "manager", "supervisor", "rep"].includes(row.role)) addError(errors, row.rowNumber, "角色", "角色只能填写总部审核人员、总部财务人员、省区/区域经理、地区主管或业务代表。");
    if (!validCode(row.username)) addError(errors, row.rowNumber, "登录账号", "登录账号只能使用2至64位字母、数字、点、横线或下划线。");
    if (!STATUS_VALUES.has(row.status)) addError(errors, row.rowNumber, "状态", "状态只能填写启用或停用。");
    const current = maps.people.get(row.id) || maps.usernames.get(String(row.username).toLowerCase());
    if (!current && !row.tempPassword) addError(errors, row.rowNumber, "临时密码", "新增人员必须填写临时密码。");
    if (row.tempPassword && !validPassword(row.tempPassword, { username: row.username, name: row.name })) addError(errors, row.rowNumber, "临时密码", "至少10位，必须含大小写字母、数字和特殊符号，且不能包含账号或姓名。");
    const usernameKey = String(row.username).toLowerCase();
    const usernameOwner = maps.usernames.get(usernameKey);
    if (usernameOwner && userBusinessId(usernameOwner) !== row.id && usernameOwner.personId) addError(errors, row.rowNumber, "登录账号", "该账号已经绑定其他正式人员编号。");
    if (incomingUsernames.has(usernameKey) && incomingUsernames.get(usernameKey) !== row.id) addError(errors, row.rowNumber, "登录账号", "文件中有重复的登录账号。");
    incomingUsernames.set(usernameKey, row.id);
    if (["hq_auditor", "finance", "manager"].includes(row.role) && row.parentId) addError(errors, row.rowNumber, "上级人员编号", "总部人员和经理不填写上级人员编号。");
    if (row.role === "supervisor" && combinedPeople.get(row.parentId)?.role !== "manager") addError(errors, row.rowNumber, "上级人员编号", "地区主管的上级必须是省区/区域经理。");
    if (row.role === "rep" && !["manager", "supervisor"].includes(combinedPeople.get(row.parentId)?.role)) addError(errors, row.rowNumber, "上级人员编号", "业务代表的上级必须是地区主管或省区/区域经理。");
  }
}

function validateRowsByType(type, rows, maps, errors) {
  if (type === "personnel") {
    validatePersonnel(rows, maps, errors);
    return;
  }
  for (const row of rows) {
    if (type === "warehouses") {
      if (!row.name || !row.province) addError(errors, row.rowNumber, "仓库/区域", "仓库名称和省区/区域不能为空。");
      if (maps.people.get(row.managerId)?.role !== "manager") addError(errors, row.rowNumber, "负责人经理编号", "对应人员不存在或不是省区/区域经理。");
      if (!Number.isInteger(row.creditDays) || row.creditDays < 0 || row.creditDays > 365) addError(errors, row.rowNumber, "月结账期", "必须填写0至365之间的整数天数。");
      if (!STATUS_VALUES.has(row.status)) addError(errors, row.rowNumber, "状态", "状态只能填写启用或停用。");
    } else if (type === "customers") {
      const supervisor = maps.people.get(row.supervisorId);
      const manager = maps.people.get(row.managerId);
      if (!row.name || !row.province) addError(errors, row.rowNumber, "客户/区域", "客户名称和省区/区域不能为空。");
      if (!CHANNEL_VALUES.has(row.channel)) addError(errors, row.rowNumber, "渠道", "渠道不在允许范围内。");
      if (row.supervisorId && supervisor?.role !== "supervisor") addError(errors, row.rowNumber, "主管人员编号", "填写后，对应人员必须是地区主管；经理直管客户可以留空。");
      if (manager?.role !== "manager") addError(errors, row.rowNumber, "经理人员编号", "对应人员不存在或不是省区/区域经理。");
      if (row.supervisorId && supervisor && supervisor.managerId !== row.managerId) addError(errors, row.rowNumber, "主管/经理", "该主管不归属于填写的经理。");
      if (!nonNegativeNumber(row.monthlyTarget, 1000000)) addError(errors, row.rowNumber, "月度任务", "必须是0至100万之间的数字。");
      if (!STATUS_VALUES.has(row.status)) addError(errors, row.rowNumber, "状态", "状态只能填写启用或停用。");
    } else if (type === "stores") {
      const customer = maps.customers.get(row.customerId);
      const rep = maps.people.get(row.repId);
      const warehouse = maps.warehouses.get(row.warehouseId);
      if (!row.name) addError(errors, row.rowNumber, "门店名称", "门店名称不能为空。");
      if (!customer) addError(errors, row.rowNumber, "客户编号", "客户不存在，请先导入客户。");
      if (rep?.role !== "rep") addError(errors, row.rowNumber, "业务代表人员编号", "对应人员不存在或不是业务代表。");
      if (!warehouse) addError(errors, row.rowNumber, "仓库编号", "仓库不存在，请先导入仓库。");
      if (customer && rep && (rep.managerId !== customer.managerId || (customer.supervisorId && rep.supervisorId !== customer.supervisorId))) addError(errors, row.rowNumber, "归属关系", "业务代表与客户不属于同一经理，或不属于该客户指定的主管。");
      if (customer && warehouse && customer.managerId !== warehouse.managerId) addError(errors, row.rowNumber, "归属关系", "客户与仓库不属于同一个经理。");
      if (!STATUS_VALUES.has(row.status)) addError(errors, row.rowNumber, "状态", "状态只能填写启用或停用。");
    } else if (type === "products") {
      if (!row.name || !row.spec) addError(errors, row.rowNumber, "产品/规格", "产品名称和包装规格不能为空。");
      if (!positiveNumber(row.ratio, 100)) addError(errors, row.rowNumber, "规格换算系数", "必须大于0且不超过100。");
      if (!STATUS_VALUES.has(row.status)) addError(errors, row.rowNumber, "状态", "状态只能填写启用或停用。");
    } else if (type === "inventory") {
      if (!validDate(row.date)) addError(errors, row.rowNumber, "入库日期", "日期必须是yyyy-mm-dd。");
      if (!maps.warehouses.has(row.warehouseId)) addError(errors, row.rowNumber, "仓库编号", "仓库不存在，请先导入仓库。");
      if (!maps.products.has(row.productId)) addError(errors, row.rowNumber, "产品编号", "产品不存在，请先导入产品。");
      if (!positiveNumber(row.qty, 1000000, true)) addError(errors, row.rowNumber, "入库数量", "必须是1至100万之间的整数。");
      if (!positiveNumber(row.unitPrice, 10000000)) addError(errors, row.rowNumber, "供货单价", "必须是有效正数。");
      if (!validBatchNo(row.batchNo)) addError(errors, row.rowNumber, "批号", "批号只能使用字母、数字、点、横线、下划线或斜线。");
      if (!validDate(row.expiryDate) || row.expiryDate < row.date) addError(errors, row.rowNumber, "有效期", "有效期必须合法且不能早于入库日期。");
    } else if (type === "policies") {
      const customer = maps.customers.get(row.customerId);
      if (!customer) addError(errors, row.rowNumber, "客户编号", "客户不存在，请先导入客户。");
      if (!maps.products.has(row.productId)) addError(errors, row.rowNumber, "产品编号", "产品不存在，请先导入产品。");
      if (!validDate(row.start) || !validDate(row.end) || row.start > row.end) addError(errors, row.rowNumber, "有效期", "开始和结束日期必须合法，且开始日期不能晚于结束日期。");
      const amounts = [row.invoicePrice, row.retailPrice, row.headRebate, row.noInvoiceRebate, row.promoSpend];
      if (!positiveNumber(row.invoicePrice) || !amounts.every((value) => nonNegativeNumber(value))) addError(errors, row.rowNumber, "金额", "开票价必须大于0，其他金额必须是非负数。");
      if (!positiveNumber(row.monthlyTarget, 1000000, true)) addError(errors, row.rowNumber, "预计月销", "必须是1至100万之间的整数。");
      const commissions = [row.repCommission, row.supervisorCommission, row.managerCommission].filter((value) => value !== null);
      if (!commissions.every((value) => nonNegativeNumber(value))) addError(errors, row.rowNumber, "特殊提成", "特殊提成必须留空或填写非负数。");
      if (row.note.length > 500) addError(errors, row.rowNumber, "备注", "备注最长500个字。");
    } else {
      const rep = maps.people.get(row.repId);
      const customer = maps.customers.get(row.customerId);
      const store = maps.stores.get(row.storeId);
      if (!validDate(row.date)) addError(errors, row.rowNumber, "销售日期", "日期必须是yyyy-mm-dd。");
      if (rep?.role !== "rep") addError(errors, row.rowNumber, "代表人员编号", "对应人员不存在或不是业务代表。");
      if (!customer) addError(errors, row.rowNumber, "客户编号", "客户不存在。");
      if (!store || store.customerId !== row.customerId || store.repId !== row.repId || store.warehouseId !== row.warehouseId) addError(errors, row.rowNumber, "门店归属", "门店、客户、代表和仓库的归属关系不一致。");
      if (!maps.products.has(row.productId)) addError(errors, row.rowNumber, "产品编号", "产品不存在。");
      if (!positiveNumber(row.qty, 1000000, true)) addError(errors, row.rowNumber, "销售数量", "必须是1至100万之间的整数。");
      if (!validBatchNo(row.batchNo)) addError(errors, row.rowNumber, "批号", "批号格式不正确。");
      const amounts = [row.salePrice, row.repCommission, row.supervisorCommission, row.managerCommission, row.promoBudget];
      if (!positiveNumber(row.salePrice) || !amounts.every((value) => nonNegativeNumber(value))) addError(errors, row.rowNumber, "单盒金额", "销售价必须大于0，提成和客情额度必须是非负数。");
      if (customer && rep && (customer.managerId !== rep.managerId || (customer.supervisorId && customer.supervisorId !== rep.supervisorId))) addError(errors, row.rowNumber, "销售归属", "业务代表与客户不属于同一经理，或不属于该客户指定的主管。");
    }
  }
}

function inventoryMoveId(row) {
  return hashId("import_move", `${row.id}|${row.warehouseId}|${row.productId}|${row.batchNo}`);
}

function historicalSaleId(sourceNo) {
  return hashId("import_sale", sourceNo);
}

function policyId(sourceNo) {
  return hashId("policy", sourceNo);
}

async function projectedInventoryErrors(type, rows, errors) {
  if (!["inventory", "historicalSales"].includes(type) || errors.length) return;
  const [moves, sales] = await Promise.all([
    fetchAll("inventory_moves", { status: "已通过" }, { max: 10000 }),
    fetchAll("sales", { status: "已通过", correctionStatus: "正常" }, { max: 10000 })
  ]);
  const moveMap = new Map(moves.map((item) => [item._id, item]));
  if (type === "inventory") {
    for (const row of rows) {
      moveMap.set(inventoryMoveId(row), {
        _id: inventoryMoveId(row),
        type: "in",
        status: "已通过",
        warehouseId: row.warehouseId,
        productId: row.productId,
        qty: row.qty,
        batchNo: row.batchNo,
        expiryDate: row.expiryDate
      });
    }
  }
  const grouped = groupHistoricalSales(rows);
  const saleMap = new Map(sales.map((item) => [item._id, item]));
  if (type === "historicalSales") {
    for (const group of grouped) {
      const existing = saleMap.get(group._id) || await getDoc("sales", group._id);
      if (existing && existing.source !== "历史销售导入") {
        addError(errors, group.firstRow.rowNumber, "销售单号", "该编号已被正式销售单使用，不能通过历史导入覆盖。");
      } else {
        saleMap.set(group._id, group.record);
      }
    }
  }
  const balances = new Map();
  const expiry = new Map();
  for (const move of moveMap.values()) {
    const key = `${move.warehouseId}|${move.productId}|${move.batchNo}`;
    const sign = move.type === "out" ? -1 : 1;
    balances.set(key, Number(balances.get(key) || 0) + sign * Number(move.qty || 0));
    if (move.expiryDate) {
      if (expiry.has(key) && expiry.get(key) !== move.expiryDate) {
        const row = rows.find((item) => `${item.warehouseId}|${item.productId}|${item.batchNo}` === key);
        if (row) addError(errors, row.rowNumber, "有效期", "同一仓库、产品和批号存在不同有效期。");
      }
      expiry.set(key, move.expiryDate);
    }
  }
  for (const sale of saleMap.values()) {
    for (const line of sale.lines || []) {
      const key = `${sale.warehouseId}|${line.productId}|${line.batchNo}`;
      balances.set(key, Number(balances.get(key) || 0) - Number(line.qty || 0));
    }
  }
  for (const row of rows) {
    const key = `${row.warehouseId}|${row.productId}|${row.batchNo}`;
    if (Number(balances.get(key) || 0) < 0) addError(errors, row.rowNumber, "库存", "导入后该批号会出现负库存，请先补录商业发货入库。");
  }
}

function groupHistoricalSales(rows) {
  const groups = new Map();
  for (const row of rows) {
    const id = historicalSaleId(row.id);
    if (!groups.has(id)) {
      groups.set(id, {
        _id: id,
        sourceNo: row.id,
        firstRow: row,
        lines: []
      });
    }
    groups.get(id).lines.push({
      productId: row.productId,
      qty: row.qty,
      batchNo: row.batchNo,
      ruleSnapshot: {
        salePrice: calc4(row.salePrice),
        repCommission: calc4(row.repCommission),
        supervisorCommission: calc4(row.supervisorCommission),
        managerCommission: calc4(row.managerCommission),
        promoBudget: calc4(row.promoBudget)
      }
    });
  }
  return [...groups.values()].map((group) => {
    const row = group.firstRow;
    return {
      ...group,
      record: {
        sourceNo: group.sourceNo,
        source: "历史销售导入",
        date: row.date,
        settlementMonth: monthKey(row.date),
        repId: row.repId,
        supervisorId: "",
        managerId: "",
        customerId: row.customerId,
        storeId: row.storeId,
        warehouseId: row.warehouseId,
        status: "已通过",
        correctionStatus: "正常",
        lines: group.lines,
        approvalTrail: [{ role: "system", actorName: "历史数据导入", time: nowIso() }],
        approvedAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
    };
  });
}

function validateHistoricalGroups(rows, errors) {
  const firstById = new Map();
  for (const row of rows) {
    const first = firstById.get(row.id);
    if (!first) {
      firstById.set(row.id, row);
      continue;
    }
    const fields = ["date", "repId", "customerId", "storeId", "warehouseId"];
    if (fields.some((field) => first[field] !== row[field])) {
      addError(errors, row.rowNumber, "销售单号", "同一销售单号的日期、代表、客户、门店和仓库必须一致。");
    }
  }
}

async function existingImportIds(type, rows, maps) {
  const ids = [];
  if (type === "personnel") {
    rows.forEach((row) => {
      if (maps.people.has(row.id) || maps.usernames.has(String(row.username).toLowerCase())) ids.push(row.id);
    });
  } else if (["warehouses", "customers", "stores", "products"].includes(type)) {
    rows.forEach((row) => {
      if (maps[type].has(row.id)) ids.push(row.id);
    });
  } else if (type === "inventory") {
    const existing = new Set((await fetchAll("inventory_moves", { source: "商业发货申请导入" }, { max: 10000 })).map((item) => item._id));
    rows.forEach((row) => {
      if (existing.has(inventoryMoveId(row))) ids.push(`${row.id}|${row.productId}|${row.batchNo}`);
    });
  } else if (type === "policies") {
    const existing = new Set((await fetchAll("policies", { source: "客户政策备案导入" }, { max: 10000 })).map((item) => item._id));
    rows.forEach((row) => {
      if (existing.has(policyId(row.id))) ids.push(row.id);
    });
  } else {
    const existing = new Set((await fetchAll("sales", { source: "历史销售导入" }, { max: 10000 })).map((item) => item._id));
    for (const sourceNo of new Set(rows.map((row) => row.id))) {
      if (existing.has(historicalSaleId(sourceNo))) ids.push(sourceNo);
    }
  }
  return new Set(ids);
}

async function rebuildInventoryLot(warehouseId, productId, batchNo) {
  const moves = await fetchAll("inventory_moves", { warehouseId, productId, batchNo, status: "已通过" }, { max: 10000 });
  const sales = await fetchAll("sales", { warehouseId, status: "已通过", correctionStatus: "正常" }, { max: 10000 });
  const inQty = moves.reduce((sum, item) => sum + (item.type === "out" ? -1 : 1) * Number(item.qty || 0), 0);
  const soldQty = sales.reduce((sum, sale) => sum + (sale.lines || []).filter((line) => line.productId === productId && line.batchNo === batchNo).reduce((lineSum, line) => lineSum + Number(line.qty || 0), 0), 0);
  const qty = inQty - soldQty;
  if (qty < 0) fail("NEGATIVE_INVENTORY", `仓库${warehouseId}的产品${productId}批号${batchNo}出现负库存，导入已停止。`);
  const latestMove = moves.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0];
  const warehouse = await getDoc("warehouses", warehouseId);
  await setDoc("inventory_lots", lotId(warehouseId, productId, batchNo), {
    warehouseId,
    managerId: warehouse?.managerId || "",
    productId,
    batchNo,
    expiryDate: latestMove?.expiryDate || "",
    qty,
    unitPrice: calc4(latestMove?.unitPrice || 0),
    createdAt: latestMove?.createdAt || nowIso(),
    updatedAt: nowIso()
  });
}

async function commitImport(type, rows, maps, actor) {
  const affectedLots = new Set();
  const affectedReceivables = new Set();
  if (type === "personnel") {
    const combinedPeople = new Map(maps.people);
    rows.forEach((row) => combinedPeople.set(row.id, row));
    for (const row of rows) {
      const existing = maps.people.get(row.id) || maps.usernames.get(String(row.username).toLowerCase());
      const parent = row.role === "rep" ? combinedPeople.get(row.parentId) : null;
      const identityChanged = Boolean(existing && existing.name && existing.name !== row.name);
      const record = {
        ...(existing || {}),
        personId: row.id,
        username: row.username,
        usernameLower: row.username.toLowerCase(),
        name: row.name,
        role: row.role,
        province: row.province,
        department: row.province,
        managerId: ["manager", "hq_auditor", "finance"].includes(row.role) ? "" : row.role === "supervisor" ? row.parentId : parent?.role === "manager" ? row.parentId : parent?.managerId || parent?.parentId || "",
        supervisorId: row.role === "rep" && parent?.role === "supervisor" ? row.parentId : "",
        openid: identityChanged ? "" : existing?.openid || "",
        disabled: row.status === "停用",
        mustChangePassword: row.tempPassword ? true : Boolean(existing?.mustChangePassword),
        failedAttempts: 0,
        lockedUntil: 0,
        createdAt: existing?.createdAt || nowIso(),
        updatedAt: nowIso(),
        source: "人员导入"
      };
      if (row.tempPassword) Object.assign(record, newPasswordRecord(row.tempPassword, config.passwordIterations));
      await setDoc("users", existing?._id || hashId("acct", row.id), record);
    }
  } else if (type === "warehouses") {
    for (const row of rows) {
      const existing = maps.warehouses.get(row.id);
      await setDoc("warehouses", row.id, { ...(existing || {}), name: row.name, province: row.province, managerId: row.managerId, creditDays: row.creditDays, status: row.status, createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso(), source: "商业公司建档备案导入" });
    }
  } else if (type === "customers") {
    for (const row of rows) {
      const existing = maps.customers.get(row.id);
      await setDoc("customers", row.id, { ...(existing || {}), name: row.name, channel: row.channel, province: row.province, supervisorId: row.supervisorId, managerId: row.managerId, monthlyTarget: calc4(row.monthlyTarget), status: row.status, createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso(), source: "客户资料导入" });
    }
  } else if (type === "stores") {
    for (const row of rows) {
      const existing = maps.stores.get(row.id);
      const customer = maps.customers.get(row.customerId);
      await setDoc("stores", row.id, { ...(existing || {}), name: row.name, customerId: row.customerId, repId: row.repId, supervisorId: customer.supervisorId, managerId: customer.managerId, warehouseId: row.warehouseId, status: row.status, createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso(), source: "门店资料导入" });
    }
  } else if (type === "products") {
    for (const row of rows) {
      const existing = maps.products.get(row.id);
      await setDoc("products", row.id, { ...(existing || {}), name: row.name, spec: row.spec, ratio: calc4(row.ratio), status: row.status, createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso(), source: "产品资料导入" });
    }
  } else if (type === "inventory") {
    for (const row of rows) {
      const warehouse = maps.warehouses.get(row.warehouseId);
      await setDoc("inventory_moves", inventoryMoveId(row), {
        sourceNo: row.id,
        type: "in",
        status: "已通过",
        date: row.date,
        warehouseId: row.warehouseId,
        managerId: warehouse.managerId,
        productId: row.productId,
        qty: row.qty,
        unitPrice: calc4(row.unitPrice),
        batchNo: row.batchNo,
        expiryDate: row.expiryDate,
        source: "商业发货申请导入",
        createdBy: userBusinessId(actor),
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      affectedLots.add(`${row.warehouseId}|${row.productId}|${row.batchNo}`);
    }
  } else if (type === "policies") {
    for (const row of rows) {
      const customer = maps.customers.get(row.customerId);
      const id = policyId(row.id);
      const existing = await getDoc("policies", id);
      await setDoc("policies", id, {
        ...(existing || {}),
        sourceNo: row.id,
        customerId: row.customerId,
        productId: row.productId,
        supervisorId: customer.supervisorId,
        managerId: customer.managerId,
        start: row.start,
        end: row.end,
        invoicePrice: calc4(row.invoicePrice),
        retailPrice: calc4(row.retailPrice),
        headRebate: calc4(row.headRebate),
        noInvoiceRebate: calc4(row.noInvoiceRebate),
        promoSpend: calc4(row.promoSpend),
        monthlyTarget: row.monthlyTarget,
        ...(row.repCommission === null ? {} : { repCommission: calc4(row.repCommission) }),
        ...(row.supervisorCommission === null ? {} : { supervisorCommission: calc4(row.supervisorCommission) }),
        ...(row.managerCommission === null ? {} : { managerCommission: calc4(row.managerCommission) }),
        note: row.note,
        status: "待老板审核",
        submittedBy: customer.supervisorId,
        submittedAt: nowIso(),
        updatedAt: nowIso(),
        createdAt: existing?.createdAt || nowIso(),
        source: "客户政策备案导入"
      });
    }
  } else {
    const groups = groupHistoricalSales(rows);
    for (const group of groups) {
      const row = group.firstRow;
      const customer = maps.customers.get(row.customerId);
      const existing = await getDoc("sales", group._id);
      if (existing && existing.source !== "历史销售导入") fail("SALE_SOURCE_CONFLICT", `销售单${row.id}不是历史导入数据，不能覆盖。`);
      const record = {
        ...group.record,
        supervisorId: customer.supervisorId,
        managerId: customer.managerId,
        createdAt: existing?.createdAt || group.record.createdAt,
        updatedAt: nowIso()
      };
      await setDoc("sales", group._id, record);
      for (const line of record.lines) affectedLots.add(`${record.warehouseId}|${line.productId}|${line.batchNo}`);
      affectedReceivables.add(`${record.warehouseId}|${record.settlementMonth}`);
    }
  }
  for (const key of affectedLots) {
    const [warehouseId, productId, batchNo] = key.split("|");
    await rebuildInventoryLot(warehouseId, productId, batchNo);
  }
  for (const key of affectedReceivables) {
    const [warehouseId, settlementMonth] = key.split("|");
    await rebuildReceivable(warehouseId, settlementMonth);
  }
}

async function adminImportRows(payload) {
  const actor = await requireUser();
  assertRole(actor, ["boss"]);
  const type = clean(payload.type);
  const sourceRows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!IMPORT_HEADERS[type]) fail("INVALID_IMPORT_TYPE", "导入的数据类型不正确。");
  if (!sourceRows.length || sourceRows.length > config.maxRowsPerImport) fail("INVALID_IMPORT_SIZE", `每次必须导入1至${config.maxRowsPerImport}行数据。`);
  const errors = [];
  validateHeaders(type, sourceRows, errors);
  const rows = normalizeRows(type, sourceRows);
  validateCommonIds(type, rows, errors);
  const maps = await loadMasterMaps();
  validateRowsByType(type, rows, maps, errors);
  if (type === "historicalSales") validateHistoricalGroups(rows, errors);
  await projectedInventoryErrors(type, rows, errors);
  const existingIds = await existingImportIds(type, rows, maps);
  const entityIds = type === "historicalSales" ? [...new Set(rows.map((row) => row.id))] : rows.map((row) => type === "inventory" ? `${row.id}|${row.productId}|${row.batchNo}` : row.id);
  const preview = {
    totalRows: rows.length,
    insertCount: entityIds.filter((id) => !existingIds.has(id)).length,
    updateCount: entityIds.filter((id) => existingIds.has(id)).length,
    errors: errors.slice(0, 100)
  };
  if (payload.dryRun) return preview;
  if (errors.length) fail("IMPORT_VALIDATION_FAILED", "导入文件仍有错误，不能写入。", preview);
  await commitImport(type, rows, maps, actor);
  await writeAudit(actor, "批量导入", type, `共${rows.length}行，新增${preview.insertCount}行，更新${preview.updateCount}行`);
  return preview;
}

module.exports = {
  getAdminPage,
  saveUser,
  toggleUser,
  resetUserPassword,
  unbindUserWechat,
  deleteUser,
  adminImportRows
};
