const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
const fakeCommand = {
  in: (values) => ({ operator: "in", values }),
  neq: (value) => ({ operator: "neq", value })
};
const fakeDb = { command: fakeCommand };
const fakeCloud = {
  DYNAMIC_CURRENT_ENV: "test",
  init() {},
  database() {
    return fakeDb;
  },
  getWXContext() {
    return { OPENID: "test-openid" };
  }
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "wx-server-sdk") return fakeCloud;
  return originalLoad.call(this, request, parent, isMain);
};

const contextPath = require.resolve("../cloudfunctions/api/lib/context");
delete require.cache[contextPath];
const {
  assertRole,
  scopeWhere,
  canSeeScoped,
  userBusinessId
} = require(contextPath);
Module._load = originalLoad;

const users = {
  boss: { _id: "acct_boss", personId: "BOSS", role: "boss" },
  manager: { _id: "acct_m1", personId: "M001", role: "manager" },
  supervisor: { _id: "acct_s1", personId: "S001", role: "supervisor", managerId: "M001" },
  rep: { _id: "acct_r1", personId: "R001", role: "rep", managerId: "M001", supervisorId: "S001" },
  finance: { _id: "acct_f1", personId: "F001", role: "finance" }
};

assert.deepStrictEqual(scopeWhere(users.manager), { managerId: "M001" });
assert.deepStrictEqual(scopeWhere(users.supervisor), { supervisorId: "S001" });
assert.deepStrictEqual(scopeWhere(users.rep), { repId: "R001" });
assert.strictEqual(scopeWhere(users.boss), null);
assert.strictEqual(scopeWhere(users.finance), null);

const teamOneRow = { managerId: "M001", supervisorId: "S001", repId: "R001" };
const teamTwoRow = { managerId: "M002", supervisorId: "S002", repId: "R002" };
assert.strictEqual(canSeeScoped(users.boss, teamOneRow), true);
assert.strictEqual(canSeeScoped(users.boss, teamTwoRow), true);
assert.strictEqual(canSeeScoped(users.manager, teamOneRow), true);
assert.strictEqual(canSeeScoped(users.manager, teamTwoRow), false);
assert.strictEqual(canSeeScoped(users.supervisor, teamOneRow), true);
assert.strictEqual(canSeeScoped(users.supervisor, teamTwoRow), false);
assert.strictEqual(canSeeScoped(users.rep, teamOneRow), true);
assert.strictEqual(canSeeScoped(users.rep, teamTwoRow), false);
assert.strictEqual(canSeeScoped(users.finance, teamOneRow), false);

assert.doesNotThrow(() => assertRole(users.manager, ["manager", "boss"]));
assert.throws(
  () => assertRole(users.rep, ["manager", "boss"]),
  (error) => error.code === "FORBIDDEN"
);
assert.strictEqual(userBusinessId({ _id: "acct_only" }), "acct_only");

console.log("角色与数据隔离测试通过");
