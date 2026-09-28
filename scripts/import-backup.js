const fs = require("fs/promises");
const path = require("path");
const { closeDatabase, importSnapshot } = require("../db");

async function main() {
  const backupPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, "..", "backups", "rental-business-backup.json");

  const snapshot = JSON.parse(await fs.readFile(backupPath, "utf8"));
  const state = await importSnapshot(snapshot);

  console.log(`Imported ${state.transactions.length} transactions from ${backupPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
}).finally(async () => {
  await closeDatabase();
});
