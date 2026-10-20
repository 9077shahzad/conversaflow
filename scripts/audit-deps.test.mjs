// Unit tests for the dependency-audit decision rules (node --test). Run: pnpm test:scripts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from './audit-deps.mjs';

const today = '2026-10-20';
const adv = (id, severity, pkg = 'pkg') => ({
  [id]: { github_advisory_id: id, module_name: pkg, severity, patched_versions: '<0.0.0', title: 't', findings: [{ paths: ['a>b'] }] },
});
const ok = { advisory: 'GHSA-1', package: 'pkg', scope: 'development', status: 'approved', approvedBy: 'Owner', owner: 'Owner', expires: '2027-01-31', reviewBy: '2026-12-15' };
const outcome = (exceptions, { prod = false, severity = 'high', allow = false } = {}) =>
  evaluate(adv('GHSA-1', severity), new Set(prod ? ['GHSA-1'] : []), exceptions, today, allow)[0].outcome;

test('high advisory without an exception fails', () => assert.match(outcome([]), /^FAIL/));
test('moderate development-only advisory is reported, not failed', () => assert.match(outcome([], { severity: 'moderate' }), /^reported/));
test('any production advisory fails, even moderate', () => assert.match(outcome([], { prod: true, severity: 'moderate' }), /^FAIL/));
test('approved, in-scope, owned, reviewed exception passes', () => assert.match(outcome([ok]), /^excepted until 2027-01-31, review by 2026-12-15/));
test('proposed exception fails in strict mode', () => assert.match(outcome([{ ...ok, status: 'proposed' }]), /^FAIL \(exception proposed/));
test('proposed exception is labelled, not silently passed, in local mode', () => assert.match(outcome([{ ...ok, status: 'proposed' }], { allow: true }), /^PROPOSED/));
test('approved without an approver fails', () => assert.match(outcome([{ ...ok, approvedBy: null }]), /^FAIL/));
test('missing owner fails', () => assert.match(outcome([{ ...ok, owner: '' }]), /^FAIL \(exception lacks an owner/));
test('missing review date fails', () => assert.match(outcome([{ ...ok, reviewBy: undefined }]), /^FAIL \(exception lacks/));
test('review date after expiry fails', () => assert.match(outcome([{ ...ok, reviewBy: '2027-02-28' }]), /^FAIL \(exception lacks/));
test('overdue review fails', () => assert.match(outcome([{ ...ok, reviewBy: '2026-10-01' }]), /^FAIL \(exception review overdue/));
test('expired exception fails', () => assert.match(outcome([{ ...ok, expires: '2026-10-19', reviewBy: '2026-10-01' }]), /^FAIL \(exception expired/));
test('development exception does not cover a production finding', () => assert.match(outcome([ok], { prod: true }), /^FAIL \(exception covers development only/));
test('status is case-sensitive ("Approved" is not approved)', () => assert.match(outcome([{ ...ok, status: 'Approved' }]), /^FAIL/));
