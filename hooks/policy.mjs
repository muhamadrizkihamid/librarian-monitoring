/**
 * Policy evaluator untuk enforcement PreToolUse.
 * Memuat config/policy.json dan mengevaluasi (tool_name, tool_input) -> keputusan.
 * Fail-open: bila policy hilang/rusak, kembalikan allow (jangan rusak CLI).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = path.resolve(__dirname, '..', 'config', 'policy.json');

let POLICY = { version: 'none', rules: [] };
try {
  POLICY = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
} catch {
  // fail-open: tanpa policy = tidak ada enforcement
}

export const policyVersion = POLICY.version || 'none';

function toolMatches(ruleTool, toolName) {
  if (!ruleTool || ruleTool === '*') return true;
  const wants = ruleTool.split('|').map((s) => s.trim());
  if (wants.includes(toolName)) return true;
  if (wants.includes('mcp') && typeof toolName === 'string' && toolName.startsWith('mcp__')) return true;
  return false;
}

function haystack(field, toolInput) {
  const ti = toolInput || {};
  if (field === 'command') return String(ti.command ?? '');
  if (field === 'path') return String(ti.file_path ?? ti.path ?? ti.notebook_path ?? '');
  // 'any' / default: gabungan command + path + seluruh input
  return [ti.command, ti.file_path, ti.path, JSON.stringify(ti)].filter(Boolean).join(' ');
}

function ruleHits(rule, text) {
  if (Array.isArray(rule.contains)) {
    return rule.contains.some((s) => text.includes(s));
  }
  if (rule.regex) {
    try { return new RegExp(rule.regex, 'i').test(text); } catch { return false; }
  }
  return false;
}

/**
 * @returns {{action:'allow'|'deny'|'flag', rule_id?:string, reason?:string}}
 */
export function evaluate(toolName, toolInput) {
  try {
    for (const rule of POLICY.rules || []) {
      if (!toolMatches(rule.tool, toolName)) continue;
      if (ruleHits(rule, haystack(rule.field || 'any', toolInput))) {
        return { action: rule.action || 'flag', rule_id: rule.id, reason: rule.reason || '' };
      }
    }
  } catch {
    // fail-open
  }
  return { action: 'allow' };
}
