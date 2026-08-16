#!/bin/bash
# Open Markets database test suite.
#
#   sudo ./supabase/tests/run.sh
#
# Builds a throwaway database from _base.sql (a minimal stand-in for the parts
# of production this engine touches), loads the Open Markets migrations into
# it, and runs the lifecycle and cron suites.
#
# Errors are detected by ON_ERROR_STOP and the exit code, NOT by grepping for
# "^ERROR". psql prefixes its errors with "psql:file:line:", so a "^ERROR"
# grep silently reports broken migrations as clean — that mistake made this
# suite pass twice on a migration with a syntax error in it.
set -u
DB=${DB:-om_test}
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../migrations"

MIGRATIONS=(
  20260806000000_open_markets_schema
  20260806010000_open_markets_trade_rpc
  20260806020000_open_markets_treasury_and_halt
  20260806030000_open_markets_invariants
  20260806040000_open_markets_settlement
  20260806050000_open_markets_horizon
  20260807000000_open_markets_review
  20260807010000_open_markets_invariant_fix
  20260807020000_open_markets_creator_and_disputes
)

psql_as() { su postgres -c "psql -v ON_ERROR_STOP=1 -q -d $DB $*"; }

echo "── building $DB ──"
su postgres -c "dropdb --if-exists $DB && createdb $DB" >/dev/null 2>&1
if ! psql_as < "$HERE/_base.sql" >/dev/null 2>&1; then
  echo "base schema failed"; exit 1
fi

for f in "${MIGRATIONS[@]}"; do
  if ! out=$(psql_as -f "$MIG/$f.sql" 2>&1); then
    echo "MIGRATION FAILED: $f"; echo "$out" | head -5; exit 1
  fi
done
echo "migrations loaded: ${#MIGRATIONS[@]}"

fail=0
for suite in open_markets_e2e open_markets_cron open_markets_creator; do
  echo
  echo "── $suite ──"
  # Each suite gets a fresh database: they both create users and markets, and
  # a shared database would make the second suite's results depend on the
  # first suite's leftovers.
  su postgres -c "dropdb --if-exists $DB && createdb $DB" >/dev/null 2>&1
  psql_as < "$HERE/_base.sql" >/dev/null 2>&1
  for f in "${MIGRATIONS[@]}"; do psql_as -f "$MIG/$f.sql" >/dev/null 2>&1; done

  out=$(su postgres -c "psql -q -d $DB" < "$HERE/$suite.sql" 2>&1 | sed 's/^psql:<stdin>:[0-9]*: //')
  echo "$out" | grep -E "PASS|FAIL|ERROR"
  p=$(echo "$out" | grep -c PASS)
  f_=$(echo "$out" | grep -c FAIL)
  e=$(echo "$out" | grep -c ERROR)
  echo "  → $p passed, $f_ failed, $e errors"
  [ "$f_" -gt 0 ] && fail=1
  [ "$e" -gt 0 ] && fail=1
done

su postgres -c "dropdb --if-exists $DB" >/dev/null 2>&1
echo
[ $fail -eq 0 ] && echo "ALL SUITES PASSED" || echo "SUITE FAILURES"
exit $fail
