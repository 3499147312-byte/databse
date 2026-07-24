module.exports = {
  users: [
    { _id: "acct_boss", personId: "BOSS", name: "测试老板", role: "boss", disabled: false },
    { _id: "acct_m1", personId: "M001", name: "经理甲", role: "manager", disabled: false },
    { _id: "acct_m2", personId: "M002", name: "经理乙", role: "manager", disabled: false },
    { _id: "acct_s1", personId: "S001", name: "主管甲", role: "supervisor", managerId: "M001", disabled: false },
    { _id: "acct_s2", personId: "S002", name: "主管乙", role: "supervisor", managerId: "M002", disabled: false },
    { _id: "acct_r1", personId: "R001", name: "代表甲", role: "rep", managerId: "M001", supervisorId: "S001", disabled: false },
    { _id: "acct_r2", personId: "R002", name: "代表乙", role: "rep", managerId: "M002", supervisorId: "S002", disabled: false },
    { _id: "acct_fin", personId: "F001", name: "测试财务", role: "finance", disabled: false }
  ],
  warehouses: [
    { _id: "W001", name: "甲区仓库", managerId: "M001", creditDays: 30, status: "启用" },
    { _id: "W002", name: "乙区仓库", managerId: "M002", creditDays: 15, status: "启用" },
    { _id: "W003", name: "停用仓库", managerId: "M001", creditDays: 10, status: "停用" }
  ],
  customers: [
    { _id: "C001", name: "客户甲", managerId: "M001", supervisorId: "S001", status: "启用" },
    { _id: "C002", name: "客户乙", managerId: "M002", supervisorId: "S002", status: "启用" },
    { _id: "C003", name: "经理直管客户", managerId: "M001", supervisorId: "", status: "启用" }
  ],
  stores: [
    { _id: "ST001", name: "门店甲", customerId: "C001", warehouseId: "W001", repId: "R001", managerId: "M001", supervisorId: "S001", status: "启用" },
    { _id: "ST002", name: "门店乙", customerId: "C002", warehouseId: "W002", repId: "R002", managerId: "M002", supervisorId: "S002", status: "启用" },
    { _id: "ST003", name: "停用门店", customerId: "C001", warehouseId: "W001", repId: "R001", managerId: "M001", supervisorId: "S001", status: "停用" }
  ],
  products: [
    { _id: "P240", name: "测试产品", spec: "240片", ratio: 1, status: "启用" },
    { _id: "P120", name: "测试产品", spec: "120片", ratio: 0.5, status: "启用" }
  ],
  policies: [
    {
      _id: "POL001",
      customerId: "C001",
      productId: "P240",
      status: "老板已通过",
      start: "2099-01-01",
      end: "2099-12-31",
      invoicePrice: 100,
      promoSpend: 18,
      repCommission: 2.5,
      supervisorCommission: 1.2,
      managerCommission: 0.8,
      approvedAt: "2099-01-02T00:00:00.000Z"
    }
  ],
  sales: [
    {
      _id: "SALE001",
      warehouseId: "W001",
      customerId: "C001",
      repId: "R001",
      supervisorId: "S001",
      managerId: "M001",
      settlementMonth: "2099-07",
      status: "已通过",
      correctionStatus: "正常",
      lines: [{
        productId: "P240",
        batchNo: "BATCH-001",
        qty: 3,
        ruleSnapshot: {
          salePrice: 100,
          promoBudget: 18,
          repCommission: 2.5,
          supervisorCommission: 1.2,
          managerCommission: 0.8
        }
      }]
    },
    {
      _id: "SALE002",
      warehouseId: "W001",
      customerId: "C003",
      repId: "R001",
      supervisorId: "",
      managerId: "M001",
      settlementMonth: "2099-07",
      status: "已通过",
      correctionStatus: "正常",
      lines: [{
        productId: "P120",
        batchNo: "BATCH-002",
        qty: 2,
        ruleSnapshot: {
          salePrice: 55.85,
          promoBudget: 10,
          repCommission: 1.5,
          supervisorCommission: 0.75,
          managerCommission: 0.375
        }
      }]
    }
  ],
  expenses: [
    { _id: "EXP001", repId: "R001", customerId: "C001", expenseMonth: "2099-07", amount: 20, status: "已通过" },
    { _id: "EXP002", repId: "R001", customerId: "C001", expenseMonth: "2099-07", amount: 5, status: "主管驳回" }
  ],
  warehouse_payments: []
};
