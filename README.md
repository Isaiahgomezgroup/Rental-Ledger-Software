# Rental Statement Sorter

A local browser workflow for sorting bank statement CSV exports by rental property.

## What it does

- Imports CSV bank statements with date, description, and amount columns.
- Connects bank accounts with Plaid and syncs transactions into the same review workflow.
- Separates deposits from expenses by amount sign.
- Assigns each transaction to a rental and bookkeeping category.
- Persists imported transactions in MongoDB Community Server.
- Keeps transaction data out of the app code and browser storage.
- Lets you ignore transactions so they are saved for duplicate detection but excluded from totals, AI matching, and exports.
- Lets you split one transaction across multiple rentals/categories, including partial ignored amounts.
- Can use AI matching from corrected transaction history when the local server has an API key.
- Exports sorted transactions as CSV files.

## How to use it

1. Run `npm start` or double-click `start-app.cmd`.
2. Open `http://127.0.0.1:4173`.
3. Add your rental property names.
4. Upload a CSV export from your bank.
   Or click `Connect Bank` to link an account with Plaid, then click `Sync Plaid`.
5. Correct the rental and category for each transaction that needs review.
6. Click `Ignore` on transfers or other transactions that should not count.
7. Click `Split` when one transaction belongs to multiple rentals or partly to ignored activity.
8. Upload the next statement and click `AI Match` to classify from saved transaction history.
9. Review the AI guesses, correct anything needed, then export the sorted CSV.

## Splitting transactions

Use `Split` on a transaction to open the split editor. Add one row per allocation, enter the amount, choose the rental and category from the dropdowns, or mark a row as ignored.

The split row amounts must add up to the original transaction amount. Ignored split rows stay attached to the original transaction for deduplication, but they do not count toward summaries or exports.

## Project scripts

- `npm start` starts the local app server.
- `npm run backup:export` exports MongoDB state to `backups/rental-business-backup.json`.
- `npm run backup:import` restores MongoDB state from `backups/rental-business-backup.json`.
- `npm run check` checks the server file for JavaScript syntax errors.

## Local MongoDB

Install MongoDB Community Server locally, then start MongoDB before running the app. By default, the app connects to:

`mongodb://127.0.0.1:27017`

The database name defaults to:

`rental_business`

You can override these in `.env`:

```text
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=rental_business
```

If MongoDB is not available, editing is disabled so private transaction data is not stored in browser local storage.

Every UI edit saves back to MongoDB through `PUT /api/state`. The app stores the full UI state and also rebuilds query-friendly collections for other workloads:

- `app_state`: full app state document used by the UI
- `transactions`: one source document per imported bank transaction
- `transaction_allocations`: sorted allocation rows for downstream workloads
- `properties`: rental list
- `categories`: category list

For reporting and automation, use `transaction_allocations`. It includes:

- `originalTransactionId`
- `date`
- `description`
- `amount`
- `absoluteAmount`
- `property`
- `category`
- `status`
- `source`
- `ignored`
- `countable`

Use `countable: true` to exclude ignored whole transactions and ignored split allocations.

## GitHub backup and restore

To create a private portable backup:

1. Make sure MongoDB is running.
2. Run `npm run backup:export`, or click `Backup DB` in the app.
3. Store `backups/rental-business-backup.json` somewhere private if you need to move machines.

To restore on a new machine:

1. Clone the GitHub repository.
2. Install MongoDB Community Server.
3. Run `npm install`.
4. Run `npm run backup:import`.
5. Run `npm start`.

The backup file can contain bank transaction data. The `backups/` folder is ignored by Git so backups do not get pushed with the shareable app code.

## Legacy Windows launcher

You can also double-click `start-app.cmd` from File Explorer.

## AI matching

AI matching is optional. It sends the selected unmatched transactions plus corrected history examples to the local server, which then calls the configured LLM provider.

To enable OpenAI matching:

1. Create a local `.env` file (all `.env` files are excluded from Git).
2. Add `OPENAI_API_KEY=your_key_here`.
3. Restart `start-app.cmd`.
4. Correct a handful of transactions manually.
5. Click `AI Match`.

If no API key is configured, AI matching is disabled and the app shows a setup message.

## Plaid import

Plaid import is optional and runs through the local server so Plaid secrets stay out of the app code.

To enable Plaid:

1. Create Plaid API keys in your Plaid dashboard.
2. Create a local `.env` file if one does not already exist.
3. Set `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV` in that file.
4. Restart the app.
5. Click `Connect Bank`, complete Plaid Link, then click `Sync Plaid`.

Supported `PLAID_ENV` values are `sandbox`, `development`, and `production`.

Plaid reports outflows as positive amounts and inflows as negative amounts. The importer flips the sign so expenses stay negative and deposits stay positive in this app.

Connected Plaid access tokens are stored in the local MongoDB app state. Treat database backups as private financial data.

## CSV columns

The importer looks for common column names:

- Date: `date`, `posted date`, or `transaction date`
- Description: `description`, `memo`, `name`, `payee`, or `details`
- Amount: `amount`

It also supports separate debit and credit columns such as `withdrawal` and `deposit`.

## Notes

This prototype keeps transactions, rentals, and categories in MongoDB. The app code is safe to share because private data is stored in the configured database, not in committed files or browser storage.
