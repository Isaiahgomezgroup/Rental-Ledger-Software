const http = require("http");
const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const {
  exportSnapshot,
  importSnapshot,
  isMongoAvailable,
  loadState,
  readModelCounts,
  saveState
} = require("./db");

const root = __dirname;
const port = 4173;
loadEnv();

let PlaidApi;
let PlaidEnvironments;
let Configuration;

try {
  ({ PlaidApi, PlaidEnvironments, Configuration } = require("plaid"));
} catch {
  PlaidApi = null;
  PlaidEnvironments = null;
  Configuration = null;
}

let plaidClient;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

http.createServer(async (request, response) => {
  const route = request.url.split("?")[0];

  if (request.url === "/api/ai-match" && request.method === "POST") {
    await handleAiMatch(request, response);
    return;
  }

  if (route === "/api/state" && request.method === "GET") {
    await handleLoadState(response);
    return;
  }

  if (route === "/api/state" && request.method === "PUT") {
    await handleSaveState(request, response);
    return;
  }

  if (route === "/api/backup/export" && request.method === "POST") {
    await handleExportBackup(response);
    return;
  }

  if (route === "/api/backup/import" && request.method === "POST") {
    await handleImportBackup(request, response);
    return;
  }

  if (route === "/api/database/status" && request.method === "GET") {
    await handleDatabaseStatus(response);
    return;
  }

  if (route === "/api/plaid/link-token" && request.method === "POST") {
    await handlePlaidLinkToken(response);
    return;
  }

  if (route === "/api/plaid/exchange-token" && request.method === "POST") {
    await handlePlaidExchange(request, response);
    return;
  }

  if (route === "/api/plaid/sync" && request.method === "POST") {
    await handlePlaidSync(request, response);
    return;
  }

  if (route === "/api/plaid/accounts" && request.method === "PUT") {
    await handlePlaidAccounts(request, response);
    return;
  }

  const requestPath = decodeURIComponent(route);
  const safePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const filePath = path.resolve(root, safePath);

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream"
    });
    response.end(data);
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`Rental Statement Sorter running at http://127.0.0.1:${port}/`);
});

async function handleLoadState(response) {
  try {
    sendJson(response, 200, {
      database: databaseStatus(),
      state: await loadState()
    });
  } catch (error) {
    sendJson(response, 503, {
      database: databaseStatus(error),
      error: error.message
    });
  }
}

async function handleSaveState(request, response) {
  try {
    const payload = await readJson(request);
    const state = await saveState(payload.state || payload);
    sendJson(response, 200, {
      database: databaseStatus(),
      readModel: await readModelCounts(),
      state
    });
  } catch (error) {
    sendJson(response, 503, {
      database: databaseStatus(error),
      error: error.message
    });
  }
}

async function handleDatabaseStatus(response) {
  try {
    sendJson(response, 200, {
      database: databaseStatus(),
      readModel: await readModelCounts(),
      collections: {
        sourceTransactions: "transactions",
        sortedAllocations: "transaction_allocations",
        rentals: "properties",
        categories: "categories",
        fullAppState: "app_state"
      }
    });
  } catch (error) {
    sendJson(response, 503, {
      database: databaseStatus(error),
      error: error.message
    });
  }
}

async function handleExportBackup(response) {
  try {
    const backupDir = path.join(root, "backups");
    const backupPath = path.join(backupDir, "rental-business-backup.json");
    const snapshot = await exportSnapshot();

    await fsPromises.mkdir(backupDir, { recursive: true });
    await fsPromises.writeFile(backupPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

    sendJson(response, 200, {
      database: databaseStatus(),
      path: backupPath,
      snapshot
    });
  } catch (error) {
    sendJson(response, 503, {
      database: databaseStatus(error),
      error: error.message
    });
  }
}

async function handleImportBackup(request, response) {
  try {
    const payload = await readJson(request);
    const state = await importSnapshot(payload.snapshot || payload);
    sendJson(response, 200, {
      database: databaseStatus(),
      state
    });
  } catch (error) {
    sendJson(response, 400, {
      database: databaseStatus(error),
      error: error.message
    });
  }
}

async function handlePlaidLinkToken(response) {
  try {
    const client = getPlaidClient();
    const tokenResponse = await client.linkTokenCreate({
      user: { client_user_id: "local-rental-business-user" },
      client_name: "Rental Business Accounting",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en"
    });

    sendJson(response, 200, tokenResponse.data);
  } catch (error) {
    sendJson(response, 400, { error: plaidErrorMessage(error) });
  }
}

async function handlePlaidExchange(request, response) {
  try {
    const client = getPlaidClient();
    const payload = await readJson(request);
    const scope = plaidScope(payload.scope);
    const publicToken = String(payload.public_token || "").trim();
    if (!publicToken) {
      sendJson(response, 400, { error: "Plaid did not return a public token." });
      return;
    }

    const exchangeResponse = await client.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = exchangeResponse.data.access_token;
    const itemId = exchangeResponse.data.item_id;
    const accountsResponse = await client.accountsGet({ access_token: accessToken });
    const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
    const institutionName = metadata.institution?.name || accountsResponse.data.item?.institution_name || "Connected bank";
    const accounts = accountsResponse.data.accounts.map((account) => ({
      id: account.account_id,
      name: account.name,
      mask: account.mask || "",
      type: account.type || "",
      subtype: account.subtype || ""
    }));
    const selectedAccountIds = selectedPlaidAccountIds(metadata, accounts);
    const state = await loadState();
    const branch = plaidBranchState(state, scope);
    const plaidItems = branch.plaidItems;
    const existingIndex = plaidItems.findIndex((item) => item.itemId === itemId);
    const nextItem = {
      itemId,
      accessToken,
      institutionName,
      accounts,
      selectedAccountIds: selectedAccountIds.length
        ? selectedAccountIds
        : existingIndex >= 0 ? plaidItems[existingIndex].selectedAccountIds || [] : [],
      cursor: existingIndex >= 0 ? plaidItems[existingIndex].cursor || "" : "",
      connectedAt: existingIndex >= 0 ? plaidItems[existingIndex].connectedAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (existingIndex >= 0) plaidItems[existingIndex] = nextItem;
    else plaidItems.push(nextItem);

    const nextState = await saveState(stateWithPlaidBranch(state, scope, { plaidItems }));
    sendJson(response, 200, {
      item: publicPlaidItem(nextItem),
      state: nextState
    });
  } catch (error) {
    sendJson(response, 400, { error: plaidErrorMessage(error) });
  }
}

async function handlePlaidSync(request, response) {
  try {
    const client = getPlaidClient();
    const payload = await readJson(request);
    const state = await loadState();
    const scope = plaidScope(payload.scope);
    const branch = plaidBranchState(state, scope);
    const plaidItems = applyRequestedPlaidSelections(branch.plaidItems, payload.items, {
      resetCursor: scope === "accounting" && !branch.transactions.length
    });
    const transactions = branch.transactions;
    const shouldReplayAccountingPlaid = scope === "accounting" &&
      plaidItems.some((item) => !item.plaidDuplicateFixAppliedAt);

    if (!plaidItems.length) {
      sendJson(response, 400, { error: "Connect a bank with Plaid before syncing transactions." });
      return;
    }

    const existingIds = new Set(transactions.map((transaction) => transaction.id));
    const existingPlaidTransactionIds = new Set(
      transactions
        .map((transaction) => transaction.plaid?.transactionId || plaidIdFromTransactionId(transaction.id))
        .filter(Boolean)
    );
    const nextTransactions = [...transactions];
    let added = 0;
    let skipped = 0;
    let removed = 0;

    for (const item of plaidItems) {
      const selectedAccountIds = new Set(Array.isArray(item.selectedAccountIds) ? item.selectedAccountIds : []);
      if (!selectedAccountIds.size) continue;
      const linkedAfterDate = dateOnlyKey(item.connectedAt);

      if (shouldReplayAccountingPlaid && !item.plaidDuplicateFixAppliedAt) {
        item.cursor = "";
        item.plaidDuplicateFixAppliedAt = new Date().toISOString();
      }

      let cursor = item.cursor || null;
      let hasMore = true;

      while (hasMore) {
        const syncRequest = {
          access_token: item.accessToken,
          count: 500
        };
        if (cursor) syncRequest.cursor = cursor;

        const syncResponse = await client.transactionsSync(syncRequest);
        const data = syncResponse.data;

        data.added.filter((transaction) =>
          selectedAccountIds.has(transaction.account_id) &&
          (scope === "accounting" || dateOnlyKey(transaction.date || transaction.authorized_date) > linkedAfterDate)
        ).forEach((transaction) => {
          const imported = plaidTransactionToAppTransaction(transaction, item);
          if (existingIds.has(imported.id) || existingPlaidTransactionIds.has(transaction.transaction_id)) {
            skipped += 1;
            return;
          }
          existingIds.add(imported.id);
          if (transaction.transaction_id) existingPlaidTransactionIds.add(transaction.transaction_id);
          nextTransactions.push(imported);
          added += 1;
        });

        skipped += data.modified.filter((transaction) => selectedAccountIds.has(transaction.account_id)).length;
        if (scope !== "accounting") {
          skipped += data.added.filter((transaction) =>
            selectedAccountIds.has(transaction.account_id) &&
            dateOnlyKey(transaction.date || transaction.authorized_date) <= linkedAfterDate
          ).length;
        }

        removed += data.removed.length;
        cursor = data.next_cursor;
        hasMore = data.has_more;
      }

      item.cursor = cursor || item.cursor || "";
      item.updatedAt = new Date().toISOString();
    }

    if (!plaidItems.some((item) => Array.isArray(item.selectedAccountIds) && item.selectedAccountIds.length)) {
      sendJson(response, 400, { error: "Choose at least one Plaid account before syncing transactions." });
      return;
    }

    const nextState = await saveState(stateWithPlaidBranch(state, scope, { plaidItems, transactions: nextTransactions }));
    sendJson(response, 200, {
      added,
      skipped,
      removed,
      items: plaidItems.map(publicPlaidItem),
      state: nextState
    });
  } catch (error) {
    sendJson(response, 400, { error: plaidErrorMessage(error) });
  }
}

async function handlePlaidAccounts(request, response) {
  try {
    const payload = await readJson(request);
    const scope = plaidScope(payload.scope);
    const requestedItems = Array.isArray(payload.items) ? payload.items : [];
    const state = await loadState();
    const branch = plaidBranchState(state, scope);
    const nextItems = applyRequestedPlaidSelections(branch.plaidItems, requestedItems);

    const nextState = await saveState(stateWithPlaidBranch(state, scope, { plaidItems: nextItems }));
    sendJson(response, 200, {
      items: nextItems.map(publicPlaidItem),
      state: nextState
    });
  } catch (error) {
    sendJson(response, 400, { error: error.message || "Plaid account selection could not be saved." });
  }
}

async function handleAiMatch(request, response) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      sendJson(response, 400, {
        error: "AI matching needs OPENAI_API_KEY. Add it to a .env file or your terminal environment, then restart the app."
      });
      return;
    }

    const payload = await readJson(request);
    const properties = cleanList(payload.properties);
    const categories = cleanList(payload.categories);
    const examples = Array.isArray(payload.examples) ? payload.examples.slice(-200) : [];
    const transactions = Array.isArray(payload.transactions) ? payload.transactions.slice(0, 80) : [];

    if (!properties.length || !categories.length || !examples.length || !transactions.length) {
      sendJson(response, 400, {
        error: "AI matching needs rentals, categories, corrected history examples, and transactions to classify."
      });
      return;
    }

    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You classify rental-property bank transactions from owner-provided history.",
              "Use only the provided property names and category names.",
              "Return strict JSON with a matches array.",
              "Each match must include id, property, category, confidence from 0 to 1, and a short reason.",
              "If unsure, choose the most likely property/category and use confidence below 0.65.",
              "Do not invent properties, categories, or extra fields."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify({
              properties,
              categories,
              corrected_history_examples: examples,
              transactions_to_match: transactions,
              output_shape: {
                matches: [
                  {
                    id: "transaction id",
                    property: "one provided property",
                    category: "one provided category",
                    confidence: 0.82,
                    reason: "brief explanation"
                  }
                ]
              }
            })
          }
        ]
      })
    });

    const aiJson = await aiResponse.json();
    if (!aiResponse.ok) {
      sendJson(response, aiResponse.status, {
        error: aiJson.error?.message || "The AI provider rejected the request."
      });
      return;
    }

    const content = aiJson.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    const validProperties = new Set(properties);
    const validCategories = new Set(categories);
    const validIds = new Set(transactions.map((transaction) => transaction.id));

    const matches = (Array.isArray(parsed.matches) ? parsed.matches : [])
      .filter((match) => validIds.has(match.id))
      .map((match) => ({
        id: match.id,
        property: validProperties.has(match.property) ? match.property : "",
        category: validCategories.has(match.category) ? match.category : "",
        confidence: clampConfidence(match.confidence),
        reason: String(match.reason || "AI history match").slice(0, 120)
      }))
      .filter((match) => match.property && match.category);

    sendJson(response, 200, { matches });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "AI matching failed." });
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        request.destroy();
        reject(new Error("Request is too large."));
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON request."));
      }
    });
    request.on("error", reject);
  });
}

function cleanList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.max(0, Math.min(1, number));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function getPlaidClient() {
  if (!PlaidApi) {
    throw new Error("Plaid dependency is not installed. Run `npm install` and restart the app.");
  }

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV || "sandbox";
  const basePath = PlaidEnvironments[env];

  if (!clientId || !secret) {
    throw new Error("Plaid needs PLAID_CLIENT_ID and PLAID_SECRET in .env, then restart the app.");
  }
  if (!basePath) {
    throw new Error("PLAID_ENV must be sandbox, development, or production.");
  }

  if (!plaidClient) {
    const configuration = new Configuration({
      basePath,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": clientId,
          "PLAID-SECRET": secret
        }
      }
    });
    plaidClient = new PlaidApi(configuration);
  }

  return plaidClient;
}

function plaidTransactionToAppTransaction(transaction, item) {
  const amount = -Number(transaction.amount || 0);
  const account = (item.accounts || []).find((candidate) => candidate.id === transaction.account_id);
  const description = transaction.merchant_name || transaction.name || "Plaid transaction";
  const date = transaction.date || transaction.authorized_date || "";

  return {
    id: `plaid-${transaction.transaction_id}`,
    date,
    description,
    amount,
    type: amount >= 0 ? "Deposit" : "Expense",
    property: "",
    owner: "",
    unit: "",
    category: amount >= 0 ? "Rent Income" : "Uncategorized",
    confidence: "Needs review",
    source: `Plaid: ${item.institutionName}${account ? ` / ${account.name}` : ""}`,
    ignored: false,
    billable: false,
    splits: [],
    plaid: {
      transactionId: transaction.transaction_id,
      accountId: transaction.account_id,
      itemId: item.itemId,
      pending: Boolean(transaction.pending),
      category: Array.isArray(transaction.category) ? transaction.category.join(" > ") : "",
      personalFinanceCategory: transaction.personal_finance_category?.primary || "",
      importedAt: new Date().toISOString()
    }
  };
}

function plaidIdFromTransactionId(id) {
  const text = String(id || "");
  return text.startsWith("plaid-") ? text.slice("plaid-".length) : "";
}

function transactionFingerprint(transaction) {
  if (!transaction) return "";
  const parsedAmount = Number(transaction.amount || 0);
  if (!transaction.date || !Number.isFinite(parsedAmount)) return "";
  return [
    normalizeDateKey(transaction.date),
    parsedAmount.toFixed(2),
    normalizeText(transaction.description)
  ].join("|");
}

function normalizeDateKey(value) {
  const text = String(value || "").trim();
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;

  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${String(us[1]).padStart(2, "0")}-${String(us[2]).padStart(2, "0")}`;

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function dateOnlyKey(value) {
  return normalizeDateKey(String(value || "").slice(0, 10));
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function publicPlaidItem(item) {
  return {
    itemId: item.itemId,
    institutionName: item.institutionName,
    accounts: item.accounts || [],
    selectedAccountIds: item.selectedAccountIds || [],
    connectedAt: item.connectedAt,
    updatedAt: item.updatedAt
  };
}

function plaidScope(value) {
  return String(value || "").trim().toLowerCase() === "accounting" ? "accounting" : "rental";
}

function plaidBranchState(state, scope) {
  if (scope === "accounting") {
    const accounting = state.accounting && typeof state.accounting === "object" ? state.accounting : {};
    return {
      plaidItems: Array.isArray(accounting.plaidItems) ? accounting.plaidItems : [],
      transactions: Array.isArray(accounting.transactions) ? accounting.transactions : []
    };
  }

  return {
    plaidItems: Array.isArray(state.plaidItems) ? state.plaidItems : [],
    transactions: Array.isArray(state.transactions) ? state.transactions : []
  };
}

function stateWithPlaidBranch(state, scope, branch) {
  if (scope === "accounting") {
    const accounting = state.accounting && typeof state.accounting === "object" ? state.accounting : {};
    return {
      ...state,
      accounting: {
        ...accounting,
        plaidItems: Array.isArray(branch.plaidItems) ? branch.plaidItems : [],
        transactions: Array.isArray(branch.transactions) ? branch.transactions : plaidBranchState(state, scope).transactions
      }
    };
  }

  return {
    ...state,
    plaidItems: Array.isArray(branch.plaidItems) ? branch.plaidItems : [],
    transactions: Array.isArray(branch.transactions) ? branch.transactions : plaidBranchState(state, scope).transactions
  };
}

function applyRequestedPlaidSelections(plaidItems, requestedItems, options = {}) {
  const items = Array.isArray(plaidItems) ? plaidItems : [];
  const requested = Array.isArray(requestedItems) ? requestedItems : [];
  if (!requested.length) return items;

  return items.map((item) => {
    const requestedItem = requested.find((candidate) => candidate.itemId === item.itemId);
    if (!requestedItem) return item;

    const validAccountIds = new Set((item.accounts || []).map((account) => account.id));
    const selectedAccountIds = cleanList(requestedItem.selectedAccountIds)
      .filter((accountId) => validAccountIds.has(accountId));

    const previous = Array.isArray(item.selectedAccountIds) ? [...item.selectedAccountIds].sort().join("|") : "";
    const next = [...selectedAccountIds].sort().join("|");

    return {
      ...item,
      selectedAccountIds,
      cursor: previous === next && !options.resetCursor ? item.cursor || "" : "",
      updatedAt: new Date().toISOString()
    };
  });
}

function selectedPlaidAccountIds(metadata, accounts) {
  const selected = Array.isArray(metadata.accounts)
    ? metadata.accounts.map((account) => account.id || account.account_id)
    : [];
  const valid = new Set(accounts.map((account) => account.id));
  return selected.filter((accountId) => valid.has(accountId));
}

function plaidErrorMessage(error) {
  return error.response?.data?.error_message || error.message || "Plaid request failed.";
}

function databaseStatus(error) {
  return {
    driverInstalled: isMongoAvailable(),
    ok: !error,
    message: error ? error.message : "MongoDB state store ready"
  };
}

function loadEnv() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const separator = trimmed.indexOf("=");
    if (separator === -1) return;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  });
}
