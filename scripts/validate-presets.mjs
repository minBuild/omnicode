#!/usr/bin/env node
// validate-presets.mjs — CI gate for presets/*.json (design 16.7). Node ESM, no dependencies.
//
// For every presets/<id>.json (schema.json excluded):
//   1. it parses as a JSON object and <id> equals its "id"
//   2. it validates against presets/schema.json. The schema is interpreted by the small validator
//      below, which supports exactly the keyword subset the schema uses (type, enum, const, pattern,
//      minLength, maxLength, required, properties, additionalProperties, items, minItems, maxItems,
//      uniqueItems) and refuses unknown keywords so the schema cannot silently outgrow the check.
//   3. "url" and "docs" are https URLs whose hostname is a DNS name with a dot — not an IP literal,
//      not localhost — and carry no userinfo (design 16.2 host rules)
//   4. nothing that looks like a secret appears anywhere in the file
// Exit status 1 with one line per problem, 0 with a summary otherwise.
//
// Usage: node scripts/validate-presets.mjs [presets-dir]

import { readdir, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const presetsDir = path.resolve(process.argv[2] ?? path.join(here, '..', 'presets'));
const schemaFile = 'schema.json';
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', 'title', 'description', 'examples',
  'type', 'enum', 'const', 'pattern', 'minLength', 'maxLength',
  'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems',
]);

const SECRET_KEY_RE = /^(?:api[-_]?key|token|secret|password|passwd|authorization|credentials?|client[-_]?secret|access[-_]?token|refresh[-_]?token|private[-_]?key|bearer)$/i;
const SECRET_VALUE_PATTERNS = [
  [/omh_[A-Za-z0-9_-]{20,}/, 'an OmniCode agent token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'an API key (sk-...)'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/, 'a bearer token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'a JWT'],
];
const SECRET_QUERY_KEY_RE = /token|secret|key|auth|password|passwd|sig|credential/i;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Reject keywords the validator does not implement, anywhere in the schema tree.
function checkSchemaKeywords(schema, at, problems) {
  if (typeOf(schema) !== 'object') {
    problems.push(`${at}: schema must be an object`);
    return;
  }
  for (const [k, v] of Object.entries(schema)) {
    if (!SUPPORTED_KEYWORDS.has(k)) problems.push(`${at}: keyword "${k}" is not supported by scripts/validate-presets.mjs`);
    if (k === 'properties' && typeOf(v) === 'object') {
      for (const [name, sub] of Object.entries(v)) checkSchemaKeywords(sub, `${at}.properties.${name}`, problems);
    }
    if (k === 'items' || (k === 'additionalProperties' && typeOf(v) === 'object')) checkSchemaKeywords(v, `${at}.${k}`, problems);
  }
}

function validate(schema, value, at, problems) {
  const t = typeOf(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((a) => a === t || (a === 'number' && t === 'integer'))) {
      problems.push(`${at}: expected ${allowed.join(' | ')}, got ${t}`);
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, value))) {
    problems.push(`${at}: must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    problems.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (t === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) problems.push(`${at}: does not match /${schema.pattern}/`);
  }
  if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) problems.push(`${at}: items must be unique`);
    if (schema.items !== undefined) value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`, problems));
  }
  if (t === 'object') {
    for (const r of schema.required ?? []) {
      if (!Object.hasOwn(value, r)) problems.push(`${at}: missing required property "${r}"`);
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub !== undefined) validate(sub, v, `${at}.${k}`, problems);
      else if (schema.additionalProperties === false) problems.push(`${at}: unknown property "${k}"`);
      else if (typeOf(schema.additionalProperties) === 'object') validate(schema.additionalProperties, v, `${at}.${k}`, problems);
    }
  }
}

function checkUrl(s, at, problems) {
  let u;
  try {
    u = new URL(s);
  } catch {
    problems.push(`${at}: not a valid URL`);
    return;
  }
  if (u.protocol !== 'https:') problems.push(`${at}: must use https (got ${u.protocol})`);
  if (u.username !== '' || u.password !== '') problems.push(`${at}: must not contain userinfo (credentials in the URL)`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === '') problems.push(`${at}: missing host`);
  else if (isIP(host) !== 0) problems.push(`${at}: host must be a DNS name, not an IP literal (${host})`);
  else if (host === 'localhost' || host.endsWith('.localhost')) problems.push(`${at}: localhost is not allowed`);
  else if (!host.includes('.')) problems.push(`${at}: host "${host}" has no dot (dot-less names are rejected, design 16.2)`);
  for (const key of u.searchParams.keys()) {
    if (SECRET_QUERY_KEY_RE.test(key)) problems.push(`${at}: query parameter "${key}" looks like a credential`);
  }
}

function scanSecrets(value, at, problems) {
  if (typeof value === 'string') {
    for (const [re, label] of SECRET_VALUE_PATTERNS) {
      if (re.test(value)) problems.push(`${at}: looks like ${label}; presets must not contain secrets`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanSecrets(v, `${at}[${i}]`, problems));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) problems.push(`${at}.${k}: secret-looking key; presets must not contain secrets`);
      scanSecrets(v, `${at}.${k}`, problems);
    }
  }
}

async function readJson(file, label, problems) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    problems.push(`${label}: cannot read (${e.message})`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    problems.push(`${label}: invalid JSON (${e.message})`);
    return undefined;
  }
}

async function main() {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log('usage: node scripts/validate-presets.mjs [presets-dir]');
    return 0;
  }
  const problems = [];
  const schema = await readJson(path.join(presetsDir, schemaFile), `${path.basename(presetsDir)}/${schemaFile}`, problems);
  if (schema === undefined) return report(problems, []);
  if (schema.$schema !== DRAFT) problems.push(`${schemaFile}: $schema must be ${DRAFT}`);
  checkSchemaKeywords(schema, schemaFile, problems);
  if (problems.length > 0) return report(problems, []);

  let entries;
  try {
    entries = await readdir(presetsDir, { withFileTypes: true });
  } catch (e) {
    problems.push(`${presetsDir}: cannot list (${e.message})`);
    return report(problems, []);
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json') && e.name !== schemaFile)
    .map((e) => e.name)
    .sort();
  if (files.length === 0) problems.push(`${presetsDir}: no presets found`);

  for (const file of files) {
    const label = `${path.basename(presetsDir)}/${file}`;
    const data = await readJson(path.join(presetsDir, file), label, problems);
    if (data === undefined) continue;
    if (typeOf(data) !== 'object') {
      problems.push(`${label}: top-level value must be an object`);
      continue;
    }
    validate(schema, data, label, problems);
    const expectedId = file.slice(0, -'.json'.length);
    if (data.id !== expectedId) problems.push(`${label}: "id" must equal the file name ("${expectedId}"), got ${JSON.stringify(data.id)}`);
    if (typeof data.url === 'string') checkUrl(data.url, `${label}.url`, problems);
    if (typeof data.docs === 'string') checkUrl(data.docs, `${label}.docs`, problems);
    scanSecrets(data, label, problems);
  }
  return report(problems, files);
}

function report(problems, files) {
  if (problems.length > 0) {
    console.error(`validate-presets: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(`validate-presets: ${files.length} preset(s) OK: ${files.join(', ')}`);
  return 0;
}

process.exitCode = await main();
