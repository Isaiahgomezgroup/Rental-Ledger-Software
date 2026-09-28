let MongoClient;

try {
  ({ MongoClient } = require("mongodb"));
} catch {
  MongoClient = null;
}

const DEFAULT_STATE = {
  owners: [],
  plaidItems: [],
  accounting: {
    plaidItems: [],
    transactions: []
  },
  propertyDetails: {},
  properties: [],
  categories: [
    "Rent Income",
    "Security Deposit",
    "Repairs & Maintenance",
    "Utilities",
    "Mortgage",
    "Property Tax",
    "Insurance",
    "HOA",
    "Supplies",
    "Professional Services",
    "Bank Fees",
    "Transfer",
    "Owner Draw",
    "Uncategorized"
  ],
  transactions: []
};

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGODB_DB || "rental_business";
const stateId = "default";

let clientPromise;

function isMongoAvailable() {
  return Boolean(MongoClient);
}

async function getClient() {
  if (!MongoClient) {
    throw new Error("MongoDB driver is not installed. Run `npm install` first.");
  }
  if (!clientPromise) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    clientPromise = client.connect();
  }
  try {
    return await clientPromise;
  } catch (error) {
    clientPromise = null;
    throw error;
  }
}

async function stateCollection() {
  const client = await getClient();
  return client.db(dbName).collection("app_state");
}

async function database() {
  const client = await getClient();
  return client.db(dbName);
}

async function withMongoRetry(operation) {
  try {
    return await operation();
  } catch (error) {
    await resetMongoConnection();
    return operation();
  }
}

async function loadState() {
  return withMongoRetry(async () => {
    const collection = await stateCollection();
    const record = await collection.findOne({ _id: stateId });
    if (!record) return { ...DEFAULT_STATE };

    return {
      owners: Array.isArray(record.owners) ? record.owners : DEFAULT_STATE.owners,
      plaidItems: Array.isArray(record.plaidItems) ? record.plaidItems : DEFAULT_STATE.plaidItems,
      accounting: cleanAccountingState(record.accounting),
      propertyDetails: record.propertyDetails && typeof record.propertyDetails === "object" ? record.propertyDetails : DEFAULT_STATE.propertyDetails,
      properties: Array.isArray(record.properties) ? record.properties : DEFAULT_STATE.properties,
      categories: Array.isArray(record.categories) ? record.categories : DEFAULT_STATE.categories,
      transactions: Array.isArray(record.transactions) ? record.transactions : []
    };
  });
}

async function saveState(state) {
  const nextState = {
    owners: cleanStringList(state.owners, DEFAULT_STATE.owners),
    plaidItems: Array.isArray(state.plaidItems) ? state.plaidItems : [],
    accounting: cleanAccountingState(state.accounting),
    propertyDetails: state.propertyDetails && typeof state.propertyDetails === "object" ? state.propertyDetails : {},
    properties: cleanStringList(state.properties, DEFAULT_STATE.properties),
    categories: cleanStringList(state.categories, DEFAULT_STATE.categories),
    transactions: Array.isArray(state.transactions) ? state.transactions : [],
    updatedAt: new Date()
  };

  await withMongoRetry(async () => {
    const collection = await stateCollection();
    await collection.updateOne(
      { _id: stateId },
      { $set: nextState, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    await rebuildReadModel(nextState);
  });

  return nextState;
}

async function exportSnapshot() {
  const state = await loadState();
  return {
    exportedAt: new Date().toISOString(),
    app: "rental-statement-sorter",
    version: 1,
    state
  };
}

async function importSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !snapshot.state) {
    throw new Error("Invalid backup snapshot.");
  }
  return saveState(snapshot.state);
}

async function rebuildReadModel(state) {
  const db = await database();
  const now = new Date();
  const sourceTransactions = state.transactions.map((transaction) => ({
    ...transaction,
    _id: transaction.id,
    updatedAt: now
  }));
  const allocations = state.transactions.flatMap((transaction) => transactionAllocations(transaction, now));
  const propertyDocs = state.properties.map((name) => ({ _id: name, name, updatedAt: now }));
  const categoryDocs = state.categories.map((name) => ({ _id: name, name, updatedAt: now }));

  await replaceCollection(db.collection("transactions"), sourceTransactions);
  await replaceCollection(db.collection("transaction_allocations"), allocations);
  await replaceCollection(db.collection("properties"), propertyDocs);
  await replaceCollection(db.collection("categories"), categoryDocs);

  await db.collection("transaction_allocations").createIndex({ originalTransactionId: 1 });
  await db.collection("transaction_allocations").createIndex({ property: 1, category: 1 });
  await db.collection("transaction_allocations").createIndex({ owner: 1, property: 1, unit: 1 });
  await db.collection("transaction_allocations").createIndex({ countable: 1, date: 1 });
  await db.collection("transactions").createIndex({ date: 1 });
}

async function replaceCollection(collection, docs) {
  await collection.deleteMany({});
  if (docs.length) await collection.insertMany(docs, { ordered: false });
}

function transactionAllocations(transaction, updatedAt) {
  if (transaction.ignored) {
    return [{
      _id: `${transaction.id}:ignored`,
      originalTransactionId: transaction.id,
      date: transaction.date,
      description: transaction.description,
      type: transaction.type,
      amount: transaction.amount,
      absoluteAmount: Math.abs(transaction.amount),
      property: "",
      owner: transaction.owner || "",
      unit: transaction.unit || "",
      category: "Ignored",
      status: "Ignored",
      source: transaction.source || "Ignored by user",
      ignored: true,
      countable: false,
      updatedAt
    }];
  }

  if (Array.isArray(transaction.splits) && transaction.splits.length) {
    return transaction.splits.map((split, index) => {
      const signedAmount = transaction.amount < 0 ? -Math.abs(split.amount) : Math.abs(split.amount);
      return {
        _id: split.id || `${transaction.id}:split:${index}`,
        originalTransactionId: transaction.id,
        date: transaction.date,
        description: transaction.description,
        type: transaction.type,
        amount: signedAmount,
        absoluteAmount: Math.abs(split.amount),
        property: split.ignored ? "" : split.property,
        owner: split.ignored ? "" : split.owner || transaction.owner || "",
        unit: split.ignored ? "" : split.unit || "",
        category: split.ignored ? "Ignored" : split.category,
        status: split.ignored ? "Ignored" : "Split",
        source: split.ignored ? "Ignored split allocation" : "Split allocation",
        ignored: Boolean(split.ignored),
        countable: !split.ignored,
        updatedAt
      };
    });
  }

  return [{
    _id: transaction.id,
    originalTransactionId: transaction.id,
    date: transaction.date,
    description: transaction.description,
    type: transaction.type,
    amount: transaction.amount,
    absoluteAmount: Math.abs(transaction.amount),
    property: transaction.property || "",
    owner: transaction.owner || "",
    unit: transaction.unit || "",
    category: transaction.category || "Uncategorized",
    status: transaction.confidence || "Needs review",
    source: transaction.source || "",
    ignored: false,
    countable: true,
    updatedAt
  }];
}

async function readModelCounts() {
  const [transactions, allocations, countableAllocations, ignoredAllocations, properties, categories] = await withMongoRetry(async () => {
    const db = await database();
    return Promise.all([
      db.collection("transactions").countDocuments(),
      db.collection("transaction_allocations").countDocuments(),
      db.collection("transaction_allocations").countDocuments({ countable: true }),
      db.collection("transaction_allocations").countDocuments({ ignored: true }),
      db.collection("properties").countDocuments(),
      db.collection("categories").countDocuments()
    ]);
  });

  return {
    transactions,
    allocations,
    countableAllocations,
    ignoredAllocations,
    properties,
    categories
  };
}

async function closeDatabase() {
  if (!clientPromise) return;
  const client = await clientPromise;
  await client.close();
  clientPromise = null;
}

async function resetMongoConnection() {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.close();
  } catch {
    // The connection is already unusable; dropping the cached promise is enough.
  }
  clientPromise = null;
}

function cleanStringList(value, fallback) {
  const clean = [];
  const seen = new Set();
  if (Array.isArray(value)) {
    value.forEach((item) => {
      const text = String(item || "").trim();
      const key = text.toLowerCase();
      if (!text || seen.has(key)) return;
      seen.add(key);
      clean.push(text);
    });
  }
  return clean.length ? clean : fallback;
}

function cleanAccountingState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    plaidItems: Array.isArray(state.plaidItems) ? state.plaidItems : [],
    transactions: Array.isArray(state.transactions) ? state.transactions : []
  };
}

module.exports = {
  DEFAULT_STATE,
  closeDatabase,
  exportSnapshot,
  importSnapshot,
  isMongoAvailable,
  loadState,
  readModelCounts,
  saveState
};
