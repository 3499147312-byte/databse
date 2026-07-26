const path = require("path");

const apiRoot = path.resolve(__dirname, "..", "..", "cloudfunctions", "api");
const contextPath = path.join(apiRoot, "lib", "context.js");
const domainPath = path.join(apiRoot, "lib", "domain.js");
const permissionLib = require(path.join(apiRoot, "lib", "permissions.js"));

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  throw error;
}

const command = {
  in: (values) => ({ __op: "in", values }),
  nin: (values) => ({ __op: "nin", values }),
  neq: (value) => ({ __op: "neq", value }),
  gte: (value) => ({ __op: "gte", value }),
  lte: (value) => ({ __op: "lte", value }),
  inc: (value) => ({ __op: "inc", value }),
  push: (value) => ({ __op: "push", value }),
  or: (conditions) => ({ __op: "or", conditions })
};

function matches(row, where = {}) {
  if (where?.__op === "or") return where.conditions.some((item) => matches(row, item));
  return Object.entries(where || {}).every(([key, expected]) => {
    if (expected?.__op === "in") return expected.values.includes(row[key]);
    if (expected?.__op === "nin") return !expected.values.includes(row[key]);
    if (expected?.__op === "neq") return row[key] !== expected.value;
    if (expected?.__op === "gte") return row[key] >= expected.value;
    if (expected?.__op === "lte") return row[key] <= expected.value;
    if (expected?.__op === "or") return expected.conditions.some((item) => matches(row, item));
    return row[key] === expected;
  });
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data || {})) {
    if (value?.__op === "inc") row[key] = Number(row[key] || 0) + Number(value.value);
    else if (value?.__op === "push") row[key] = [...(Array.isArray(row[key]) ? row[key] : []), clone(value.value)];
    else row[key] = clone(value);
  }
}

function createHarness(seed = {}, currentUser = null) {
  const data = {};
  for (const [name, rows] of Object.entries(seed)) {
    data[name] = {};
    for (const row of rows || []) data[name][row._id] = clone(row);
  }
  const state = {
    data,
    currentUser: clone(currentUser),
    audits: [],
    idempotencyCalls: []
  };
  const table = (name) => {
    if (!state.data[name]) state.data[name] = {};
    return state.data[name];
  };
  const rows = (name) => Object.values(table(name));

  function query(name, where = {}) {
    let result = rows(name).filter((row) => matches(row, where));
    const api = {
      where(nextWhere) {
        result = result.filter((row) => matches(row, nextWhere));
        return api;
      },
      orderBy(field, direction = "desc") {
        result.sort((a, b) => String(a[field] ?? "").localeCompare(String(b[field] ?? "")));
        if (direction === "desc") result.reverse();
        return api;
      },
      skip(count) {
        result = result.slice(count);
        return api;
      },
      limit(count) {
        result = result.slice(0, count);
        return api;
      },
      async get() {
        return { data: clone(result) };
      },
      async count() {
        return { total: result.length };
      }
    };
    return api;
  }

  function collection(name) {
    return {
      where: (where) => query(name, where),
      orderBy: (field, direction) => query(name).orderBy(field, direction),
      skip: (count) => query(name).skip(count),
      limit: (count) => query(name).limit(count),
      async count() {
        return { total: rows(name).length };
      },
      doc(id) {
        return {
          async get() {
            const row = table(name)[id];
            if (!row) {
              const error = new Error("document does not exist");
              error.errCode = -1;
              throw error;
            }
            return { data: clone(row) };
          },
          async set({ data: value }) {
            table(name)[id] = { _id: id, ...clone(value) };
          },
          async update({ data: value }) {
            if (!table(name)[id]) throw new Error("document does not exist");
            applyData(table(name)[id], value);
          },
          async remove() {
            delete table(name)[id];
          }
        };
      }
    };
  }

  const db = {
    command,
    collection,
    async createCollection(name) {
      table(name);
    },
    async runTransaction(operation) {
      return operation({ collection });
    }
  };

  const userBusinessId = (user) => user?.personId || user?._id || "";
  const context = {
    db,
    command,
    collections: Object.keys(seed),
    cloud: {
      getWXContext: () => ({ OPENID: state.openid || "openid_test" })
    },
    async fetchAll(name, where = {}, options = {}) {
      let result = rows(name).filter((row) => matches(row, where));
      if (options.orderBy) {
        result.sort((a, b) => String(a[options.orderBy.field] ?? "").localeCompare(String(b[options.orderBy.field] ?? "")));
        if ((options.orderBy.direction || "desc") === "desc") result.reverse();
      }
      return clone(result.slice(0, Number(options.max || 3000)));
    },
    async getDoc(name, id) {
      return clone(table(name)[id] || null);
    },
    async setDoc(name, id, value) {
      table(name)[id] = { _id: id, ...clone(value) };
      return clone(table(name)[id]);
    },
    async updateDoc(name, id, value) {
      if (!table(name)[id]) throw new Error(`missing ${name}/${id}`);
      applyData(table(name)[id], value);
    },
    async findUserByBusinessId(id) {
      return clone(rows("users").find((item) => userBusinessId(item) === id) || null);
    },
    async findUserByOpenid(openid) {
      return clone(rows("users").find((item) => item.openid === openid) || null);
    },
    async attachAuthorization(user) {
      if (!user || user._authorization) return clone(user);
      const id = userBusinessId(user);
      const roleId = user.role === "boss"
        ? permissionLib.permissionRoleIdForPosition("boss")
        : user.permissionRoleId || permissionLib.permissionRoleIdForPosition(user.role);
      const roleDocument = table("permission_roles")[roleId] || null;
      const permissionDocument = table("user_permissions")[id] || null;
      const adminDocument = table("permission_admins")[id] || null;
      const authorization = permissionLib.resolveEffectivePermissions(user, roleDocument, permissionDocument, adminDocument);
      for (const grant of Object.values(authorization.grants || {})) {
        const regions = grant.scope?.regions || [];
        if (!regions.length) continue;
        const teamIds = rows("users")
          .filter((item) => item.role === "manager" && !item.disabled)
          .filter((item) => regions.some((region) => {
            const targetRegion = String(item.province || item.department || "");
            return targetRegion === region || targetRegion.startsWith(`${region}/`);
          }))
          .map(userBusinessId);
        grant.scope.teamIds = [...new Set([...(grant.scope.teamIds || []), ...teamIds])];
      }
      return {
        ...clone(user),
        permissionRoleId: roleId,
        _authorization: authorization,
        _permissionAdmin: clone(adminDocument)
      };
    },
    async requireUser(options = {}) {
      if (!state.currentUser) fail("AUTH_REQUIRED", "not logged in");
      if (state.currentUser.reauthRequired && !options.allowReauth) fail("REAUTH_REQUIRED", "reauth required");
      return context.attachAuthorization(state.currentUser);
    },
    assertRole(user, roles) {
      if (!roles.includes(user.role)) fail("FORBIDDEN", "forbidden");
    },
    hasPermission(user, permission, item = null) {
      const grant = user?._authorization?.grants?.[permission];
      return Boolean(grant?.allowed && permissionLib.scopeAllows(user, grant.scope, item));
    },
    assertPermission(user, permission, item = null) {
      const grant = user?._authorization?.grants?.[permission];
      if (!grant?.allowed && user?._authorization?.expiredCodes?.includes(permission)) fail("GRANT_EXPIRED", "grant expired");
      if (!grant?.allowed) fail("PERMISSION_DENIED", "permission denied");
      if (!permissionLib.scopeAllows(user, grant.scope, item)) fail("SCOPE_DENIED", "scope denied");
      return grant;
    },
    assertAnyPermission(user, permissions, item = null) {
      const matched = permissions.find((permission) => context.hasPermission(user, permission, item));
      if (!matched) fail("PERMISSION_DENIED", "permission denied");
      return matched;
    },
    scopeWhere(user) {
      const id = userBusinessId(user);
      if (user.role === "manager") return { managerId: id };
      if (user.role === "supervisor") return { supervisorId: id };
      if (user.role === "rep") return { repId: id };
      return null;
    },
    canSeeScoped(user, item, permission = "") {
      if (permission && user?._authorization) return context.hasPermission(user, permission, item);
      const id = userBusinessId(user);
      return user.role === "boss"
        || (user.role === "manager" && item.managerId === id)
        || (user.role === "supervisor" && item.supervisorId === id)
        || (user.role === "rep" && item.repId === id);
    },
    async fetchPermitted(name, user, permission, where = {}, options = {}) {
      context.assertPermission(user, permission);
      return (await context.fetchAll(name, where, options)).filter((item) => context.hasPermission(user, permission, item));
    },
    async ensureBuiltinPermissionRoles() {
      for (const role of permissionLib.builtinRoles()) {
        if (!table("permission_roles")[role._id]) {
          const record = clone(role);
          record.grantList = Object.entries(record.grants || {}).map(([permission, scope]) => ({ permission, scope }));
          delete record.grants;
          table("permission_roles")[role._id] = { _id: role._id, ...record, version: 1 };
        }
      }
    },
    async bumpPermissionVersion(userId, options = {}) {
      const user = rows("users").find((item) => userBusinessId(item) === userId);
      if (!user) fail("USER_NOT_FOUND", "user not found");
      user.permissionVersion = Number(user.permissionVersion || 0) + 1;
      if (options.forceReauth) user.reauthRequired = true;
      return user.permissionVersion;
    },
    async activeApprovalDelegation(user, item, businessType, stage) {
      const id = userBusinessId(user);
      const today = new Date().toISOString().slice(0, 10);
      return clone(rows("approval_delegations").find((entry) => entry.delegateUserId === id
        && entry.managerId === item.managerId
        && entry.businessType === businessType
        && entry.stage === stage
        && entry.status === "启用"
        && (!entry.startDate || entry.startDate <= today)
        && (!entry.expiresAt || entry.expiresAt.slice(0, 10) >= today)) || null);
    },
    async assertApprovalAuthority(user, item, businessType, stage) {
      const id = userBusinessId(user);
      const ownerId = stage === "supervisor" ? item.supervisorId : item.managerId;
      const permission = `${businessType}.approve.${stage}`;
      if (ownerId === id) {
        context.assertPermission(user, permission, item);
        return { delegated: false, stage, permission };
      }
      const delegation = await context.activeApprovalDelegation(user, item, businessType, stage);
      if (!delegation) fail("WRONG_APPROVAL_LEVEL", "wrong approval level");
      return { delegated: true, stage, permission, delegation };
    },
    HIGH_RISK_PERMISSIONS: permissionLib.HIGH_RISK_PERMISSIONS,
    async writeAudit(user, action, target, detail) {
      state.audits.push({ user: clone(user), action, target, detail });
    },
    async withIdempotency(user, key, action, operation) {
      if (!/^[A-Za-z0-9._-]{8,100}$/.test(String(key || ""))) fail("INVALID_IDEMPOTENCY_KEY", "invalid key");
      state.idempotencyCalls.push({ userId: userBusinessId(user), key, action });
      return operation();
    },
    safeUser(user) {
      if (!user) return null;
      const copy = clone(user);
      const authorization = copy._authorization;
      delete copy.passwordHash;
      delete copy.passwordSalt;
      delete copy.passwordIterations;
      delete copy._authorization;
      delete copy._permissionAdmin;
      copy.permissionRoleName = authorization?.roleName || "";
      copy.capabilities = authorization?.codes || [];
      return copy;
    },
    userBusinessId,
    fail
  };

  function inject(modulePath, exports) {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports
    };
  }

  function loadHandler(name, extraMocks = {}) {
    inject(contextPath, context);
    delete require.cache[require.resolve(domainPath)];
    const domain = require(domainPath);
    inject(domainPath, { ...domain, ...(extraMocks.domain || {}) });
    for (const [modulePath, exports] of Object.entries(extraMocks.modules || {})) inject(modulePath, exports);
    const handlerPath = path.join(apiRoot, "handlers", `${name}.js`);
    delete require.cache[require.resolve(handlerPath)];
    return require(handlerPath);
  }

  return {
    state,
    data,
    db,
    command,
    context,
    rows,
    get: (name, id) => table(name)[id],
    setUser: (user) => {
      state.currentUser = clone(user);
    },
    loadHandler
  };
}

async function expectCode(promise, code) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (!caught || caught.code !== code) {
    throw new Error(`expected error code ${code}, got ${caught?.code || "no error"}`);
  }
  return caught;
}

module.exports = { createHarness, expectCode, command, fail };
