const assert = require("assert");
const fixture = require("./fixtures/business-fixture");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const state = clone(fixture);
const command = {
  in: (values) => ({ operator: "in", values }),
  nin: (values) => ({ operator: "nin", values }),
  neq: (value) => ({ operator: "neq", value }),
  lte: (value) => ({ operator: "lte", value }),
  gte: (value) => ({ operator: "gte", value })
};

function matches(value, condition) {
  if (!condition || typeof condition !== "object" || !condition.operator) return value === condition;
  if (condition.operator === "in") return condition.values.includes(value);
  if (condition.operator === "nin") return !condition.values.includes(value);
  if (condition.operator === "neq") return value !== condition.value;
  if (condition.operator === "lte") return value <= condition.value;
  if (condition.operator === "gte") return value >= condition.value;
  return false;
}

async function fetchAll(collectionName, where = {}, options = {}) {
  let rows = (state[collectionName] || []).filter((row) =>
    Object.entries(where).every(([key, condition]) => matches(row[key], condition))
  );
  if (options.orderBy) {
    const { field, direction } = options.orderBy;
    rows = rows.slice().sort((a, b) => String(a[field] || "").localeCompare(String(b[field] || "")) * (direction === "desc" ? -1 : 1));
  }
  return clone(rows.slice(0, options.max || rows.length));
}

async function getDoc(collectionName, id) {
  return clone((state[collectionName] || []).find((row) => row._id === id) || null);
}

async function setDoc(collectionName, id, data) {
  if (!state[collectionName]) state[collectionName] = [];
  const index = state[collectionName].findIndex((row) => row._id === id);
  const record = { _id: id, ...clone(data) };
  if (index >= 0) state[collectionName][index] = record;
  else state[collectionName].push(record);
  return clone(record);
}

async function updateDoc(collectionName, id, data) {
  const current = await getDoc(collectionName, id);
  if (!current) throw new Error(`Missing ${collectionName}/${id}`);
  return setDoc(collectionName, id, { ...current, ...data });
}

function userBusinessId(user) {
  return user.personId || user._id;
}

function scopeWhere(user) {
  const id = userBusinessId(user);
  if (user.role === "manager") return { managerId: id };
  if (user.role === "supervisor") return { supervisorId: id };
  if (user.role === "rep") return { repId: id };
  return null;
}

function canSeeScoped(user, item) {
  const id = userBusinessId(user);
  if (user.role === "boss") return true;
  if (user.role === "manager") return item.managerId === id;
  if (user.role === "supervisor") return item.supervisorId === id;
  if (user.role === "rep") return item.repId === id;
  return false;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

const contextPath = require.resolve("../cloudfunctions/api/lib/context");
require.cache[contextPath] = {
  id: contextPath,
  filename: contextPath,
  loaded: true,
  exports: {
    db: {},
    command,
    fetchAll,
    getDoc,
    setDoc,
    updateDoc,
    scopeWhere,
    canSeeScoped,
    userBusinessId,
    fail
  }
};
const domainPath = require.resolve("../cloudfunctions/api/lib/domain");
delete require.cache[domainPath];
const {
  lotId,
  receivableId,
  visibleStores,
  visibleWarehouses,
  visibleCustomers,
  scopedRows,
  getLineRule,
  rebuildReceivable,
  decorateReceivables,
  expenseBudget
} = require(domainPath);

const byPersonId = (id) => state.users.find((item) => item.personId === id);

(async () => {
  const boss = byPersonId("BOSS");
  const managerOne = byPersonId("M001");
  const managerTwo = byPersonId("M002");
  const supervisorOne = byPersonId("S001");
  const repOne = byPersonId("R001");
  const finance = byPersonId("F001");

  assert.strictEqual((await visibleWarehouses(boss)).length, 2, "老板应看到全部启用仓库");
  assert.deepStrictEqual((await visibleWarehouses(managerOne)).map((item) => item._id), ["W001"]);
  assert.deepStrictEqual((await visibleWarehouses(supervisorOne)).map((item) => item._id), ["W001"]);
  assert.deepStrictEqual((await visibleWarehouses(repOne)).map((item) => item._id), ["W001"]);
  assert.deepStrictEqual(await visibleWarehouses(finance), []);

  assert.deepStrictEqual((await visibleStores(managerOne)).map((item) => item._id), ["ST001"]);
  assert.deepStrictEqual((await visibleStores(managerTwo)).map((item) => item._id), ["ST002"]);
  assert.deepStrictEqual((await visibleStores(supervisorOne)).map((item) => item._id), ["ST001"]);
  assert.deepStrictEqual((await visibleStores(repOne)).map((item) => item._id), ["ST001"]);
  assert.strictEqual((await visibleStores(boss)).length, 2);

  assert.deepStrictEqual((await visibleCustomers(repOne)).map((item) => item._id), ["C001"]);
  assert.deepStrictEqual((await visibleCustomers(managerOne)).map((item) => item._id).sort(), ["C001", "C003"]);
  assert.deepStrictEqual((await visibleCustomers(supervisorOne)).map((item) => item._id), ["C001"]);
  assert.strictEqual((await visibleCustomers(boss)).length, 3);

  assert.strictEqual((await scopedRows("sales", boss)).length, 2);
  assert.strictEqual((await scopedRows("sales", managerOne)).length, 2);
  assert.strictEqual((await scopedRows("sales", managerTwo)).length, 0);
  assert.strictEqual((await scopedRows("sales", finance)).length, 0);

  const policyRule = await getLineRule(state.customers[0], "P240", "2099-07-10");
  assert.deepStrictEqual(policyRule, {
    salePrice: 100,
    promoBudget: 18,
    repCommission: 2.5,
    supervisorCommission: 1.2,
    managerCommission: 0.8
  });
  const standardHalfRule = await getLineRule(state.customers[0], "P120", "2099-07-10");
  assert.deepStrictEqual(standardHalfRule, {
    salePrice: 55.85,
    promoBudget: 10,
    repCommission: 1.5,
    supervisorCommission: 0.75,
    managerCommission: 0.375
  });
  await assert.rejects(() => getLineRule(state.customers[0], "MISSING", "2099-07-10"), (error) => error.code === "PRODUCT_NOT_FOUND");

  const rebuilt = await rebuildReceivable("W001", "2099-07");
  assert.strictEqual(rebuilt.dueAmount, 411.7);
  assert.strictEqual(rebuilt.qty, 5);
  assert.strictEqual(rebuilt.dueDate, "2099-08-30");
  assert.deepStrictEqual(rebuilt.sourceSaleIds, ["SALE001", "SALE002"]);
  assert.strictEqual(rebuilt._id, receivableId("W001", "2099-07"));

  const decoratedForBoss = await decorateReceivables(boss, [rebuilt]);
  assert.strictEqual(decoratedForBoss.length, 1);
  assert.strictEqual(decoratedForBoss[0].warehouseName, "甲区仓库");
  assert.strictEqual(decoratedForBoss[0].managerName, "经理甲");
  assert.strictEqual(decoratedForBoss[0].outstanding, 411.7);
  assert.strictEqual(decoratedForBoss[0].canRecord, true);
  assert.strictEqual((await decorateReceivables(managerTwo, [rebuilt])).length, 0, "其他经理不能看到甲区应收");
  assert.strictEqual((await decorateReceivables(finance, [rebuilt])).length, 1, "财务可查看全局应收");

  assert.strictEqual(await expenseBudget("R001", "C001", "2099-07"), 34, "54元客情空间扣除20元有效费用后应剩34元");
  assert.strictEqual(await expenseBudget("R001", "C001", "2099-07", "EXP001"), 54, "编辑时应排除当前费用");

  assert.strictEqual(lotId("W001", "P240", "BATCH-001"), lotId("W001", "P240", "BATCH-001"), "批号库存ID必须稳定");
  assert.notStrictEqual(lotId("W001", "P240", "BATCH-001"), lotId("W002", "P240", "BATCH-001"));

  console.log("匿名业务数据与领域规则测试通过");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
