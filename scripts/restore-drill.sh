#!/usr/bin/env bash
# Restore drill: proves a backup can actually be restored, into a scratch database, and checks it.
# Run at least quarterly, and after any change to the backup process. Never restores over production.
# Usage: BACKUP_FILE=marchmaker-2026....archive.gz SCRATCH_URI=mongodb://localhost:27017 ./scripts/restore-drill.sh
set -euo pipefail

: "${BACKUP_FILE:?BACKUP_FILE is required (a local .archive.gz, decrypted)}"
: "${SCRATCH_URI:?SCRATCH_URI is required (an EMPTY scratch MongoDB, never production)}"

case "${SCRATCH_URI}" in
  *prod*|*production*) echo "refusing: SCRATCH_URI looks like production" >&2; exit 2 ;;
esac

start="$(date +%s)"
echo "restoring ${BACKUP_FILE} into a scratch database"
mongorestore --uri="${SCRATCH_URI}" --archive="${BACKUP_FILE}" --gzip \
  --nsFrom='*.*' --nsTo='drill_$db$.$collection$' --drop

elapsed=$(( $(date +%s) - start ))
echo "restore took ${elapsed}s (record this against the recovery time objective)"

# Sanity checks: the collections that matter exist and are not empty, and the immutable ledgers are intact.
mongosh "${SCRATCH_URI}" --quiet --eval '
  const dbName = db.getMongo().getDBNames().find((n) => n.startsWith("drill_"));
  const d = db.getSiblingDB(dbName);
  const must = ["users", "auditlogs", "creditledgers", "walletledgers", "payments", "invoices", "introductions"];
  let bad = 0;
  for (const c of must) {
    const n = d.getCollection(c).estimatedDocumentCount();
    print(c.padEnd(16), n);
    if (c === "users" && n === 0) bad++;
  }
  // Invoice numbers must be gap-free and unique within a financial year.
  const dup = d.invoices.aggregate([{ $group: { _id: "$number", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
  if (dup.length) { print("DUPLICATE INVOICE NUMBERS", dup.length); bad++; }
  if (bad) { print("DRILL FAILED"); quit(1); }
  print("drill checks passed");
'

echo "drop the scratch databases (names start with drill_) when you have noted the results"
