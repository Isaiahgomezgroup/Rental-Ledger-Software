const fs = require("fs/promises");
const path = require("path");
const { closeDatabase, exportSnapshot } = require("../db");

async function main() {
  const backupDir = path.join(__dirname, "..", "backups");
  const backupPath = path.join(backupDir, "rental-business-backup.json");
  await fs.mkdir(backupDir, { recursive: true });

  const snapshot = await exportSnapshot();
  await fs.writeFile(backupPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  console.log(`Backup written to ${backupPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
}).finally(async () => {
  await closeDatabase();
});
