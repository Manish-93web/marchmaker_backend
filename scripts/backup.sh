#!/usr/bin/env bash
# Nightly logical backup of MongoDB to a compressed archive, then an upload to object storage.
# Usage: MONGODB_URI=... BACKUP_BUCKET=s3://my-backups/marchmaker ./scripts/backup.sh
# Atlas, if used, also has continuous cloud backups with point-in-time restore: this script is the
# provider-independent second copy, kept in a different account and region.
set -euo pipefail

: "${MONGODB_URI:?MONGODB_URI is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required (for example s3://bucket/prefix)}"
RETENTION_DAYS="${RETENTION_DAYS:-35}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="/tmp/marchmaker-${stamp}.archive.gz"

echo "dumping to ${file}"
# --oplog is not used with Atlas shared tiers; a replica set dump of a quiet window is consistent enough
# for the nightly copy, and the continuous backup covers point-in-time.
mongodump --uri="${MONGODB_URI}" --archive="${file}" --gzip --readPreference=secondaryPreferred

size="$(wc -c <"${file}")"
if [ "${size}" -lt 1024 ]; then
  echo "backup is suspiciously small (${size} bytes); refusing to upload" >&2
  exit 1
fi

# Encrypt before it leaves the machine. BACKUP_AGE_RECIPIENT is a public key; the private key is
# held offline by two people (see docs/RUNBOOK.md).
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  age -r "${BACKUP_AGE_RECIPIENT}" -o "${file}.age" "${file}"
  rm -f "${file}"
  file="${file}.age"
fi

aws s3 cp "${file}" "${BACKUP_BUCKET}/$(basename "${file}")" --only-show-errors
rm -f "${file}"

# Old archives are removed by a bucket lifecycle rule (${RETENTION_DAYS} days); nothing is deleted here.
echo "uploaded ${BACKUP_BUCKET}/$(basename "${file}") (${size} bytes before encryption)"
