'use strict';

// A small structural lexer, not a Python interpreter. Strings and comments are
// opaque, so brackets in them cannot be mistaken for calls or argument lists.
function lex(text) {
  const tokens = [];
  for (let i = 0; i < text.length;) {
    const start = i, c = text[i];
    if (/\s/u.test(c)) { i++; continue; }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'") {
      const quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += quote.length;
      while (i < text.length && !text.startsWith(quote, i)) {
        if (text[i] === '\\') i++;
        i++;
      }
      i = Math.min(i + quote.length, text.length);
      tokens.push({ value: text.slice(start, i), start, end: i, kind: 'string' });
    } else if (/[\p{L}_]/u.test(c)) {
      i++;
      while (i < text.length && /[\p{L}\p{N}_]/u.test(text[i])) i++;
      tokens.push({ value: text.slice(start, i), start, end: i, kind: 'name' });
    } else {
      i++;
      tokens.push({ value: c, start, end: i, kind: 'punctuation' });
    }
  }
  return tokens;
}

function findCall(text, offset) {
  const tokens = lex(text), stack = [], calls = [], brackets = new Map();
  const closing = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'punctuation') continue;
    if ('([{'.includes(t.value)) stack.push(i);
    else if (closing[t.value]) {
      const openIndex = stack.pop(), open = tokens[openIndex];
      if (!open || open.value !== closing[t.value]) return null;
      brackets.set(i, openIndex);
      if (open.value !== '(') continue;
      let nameIndex = openIndex - 1;
      if (tokens[nameIndex]?.value === ']') nameIndex = (brackets.get(nameIndex) ?? 0) - 1;
      const name = tokens[nameIndex], before = tokens[nameIndex - 1];
      if (!name || name.kind !== 'name' || ['def', 'class'].includes(before?.value)) continue;
      if (['if', 'elif', 'while', 'for', 'with', 'except', 'match', 'case', 'assert', 'return', 'yield', 'not', 'and', 'or', 'in', 'is', 'lambda'].includes(name.value)) continue;
      if (offset >= name.start && offset <= t.end) {
        calls.push({ name: name.value, nameStart: name.start, open: open.start,
          close: t.start, tokens: tokens.slice(openIndex + 1, i) });
      }
    }
  }
  // Nested calls take precedence over their enclosing call.
  return calls.sort((a, b) => b.open - a.open)[0] || null;
}

function topLevelTokens(tokens) {
  const result = [];
  let depth = 0;
  for (const t of tokens) {
    if (depth === 0) result.push(t);
    if (t.kind !== 'punctuation') continue;
    if ('([{'.includes(t.value)) depth++;
    else if (')]}'.includes(t.value)) depth--;
  }
  return result;
}

function parseParameters(signature) {
  if (!signature?.parameters?.length) return [];
  let keywordOnly = false;
  const parameters = [];
  for (const p of signature.parameters) {
    const label = Array.isArray(p.label) ? signature.label.slice(...p.label) : p.label;
    if (typeof label !== 'string') return [];
    const value = label.trim();
    if (value === '/') { for (const parameter of parameters) parameter.positionalOnly = true; continue; }
    if (value.startsWith('*')) { keywordOnly = true; continue; }
    const tokens = topLevelTokens(lex(value));
    const eq = tokens.findIndex((t, i) => t.value === '=' && tokens[i - 1]?.value !== '=' && tokens[i + 1]?.value !== '=');
    const colon = tokens.findIndex(t => t.value === ':');
    const boundary = Math.min(...[eq, colon].filter(i => i >= 0).map(i => tokens[i].start), value.length);
    const name = value.slice(0, boundary).trim();
    if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) || ['self', 'cls', '__pydantic_self__'].includes(name)) continue;
    parameters.push({ name, type: colon < 0 ? '' : value.slice(tokens[colon].end, eq < 0 ? value.length : tokens[eq].start).trim(),
      required: eq < 0, defaultValue: eq < 0 ? undefined : value.slice(tokens[eq].end).trim(), keywordOnly, positionalOnly: false });
  }
  return parameters;
}

function missingParameters(call, parameters, mode) {
  const tokens = topLevelTokens(call.tokens);
  const arguments_ = [];
  let part = [];
  for (const t of tokens) {
    if (t.value === ',' && t.kind === 'punctuation') { if (part.length) arguments_.push(part); part = []; }
    else part.push(t);
  }
  if (part.length) arguments_.push(part);
  const supplied = new Set();
  let positional = 0;
  for (const argument of arguments_) {
    // Never guess which fields a starred expression supplies.
    if (argument[0].value === '*') return null;
    if (argument[0].kind === 'name' && argument[1]?.value === '=' && argument[2]?.value !== '=') supplied.add(argument[0].value);
    else {
      const parameter = parameters.filter(p => !p.keywordOnly)[positional++];
      if (!parameter) return null;
      supplied.add(parameter.name);
    }
  }
  return parameters.filter(p => !p.positionalOnly && !supplied.has(p.name) && (mode === 'all' || p.required));
}

function placeholder(parameter) {
  if (parameter.required) return ''; 
  const value = parameter.defaultValue;
  // Defaults from signature help may name a factory rather than its result.
  // Do not copy a factory as a field value and never evaluate Python code.
  const factory = { list: '[]', dict: '{}', set: 'set()', tuple: '()', frozenset: 'frozenset()' };
  if (Object.hasOwn(factory, value)) return factory[value];
  if (/^(?:None|True|False|[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)$/.test(value || '')) return value;
  if (value && lex(value).length === 1 && lex(value)[0].kind === 'string') return value;
  if (['[]', '{}', '()'].includes(value)) return value;
  if (value && /^[\[({]/.test(value) && lex(value).every(t => t.kind === 'string' || (t.kind === 'name' && ['None', 'True', 'False'].includes(t.value)) || (t.kind === 'punctuation' && /^[\[\]{}(),:.+\-0-9]$/.test(t.value)))) return value;
  return '';
}

function escapeSnippet(value) { return value.replace(/[\\$}]/g, '\\$&'); }

function buildSnippet(text, call, parameters, { indentUnit = '    ', eol = '\n' } = {}) {
  const baseIndent = text.slice(text.lastIndexOf('\n', call.nameStart) + 1, call.nameStart).match(/^[\t ]*/)[0];
  const inner = text.slice(call.open + 1, call.close);
  const existingIndent = inner.match(/\r?\n([\t ]+)\S/);
  const indent = existingIndent && existingIndent[1].length > baseIndent.length ? existingIndent[1] : baseIndent + indentUnit;
  let preserved = inner;
  const last = call.tokens.at(-1);
  if (last && last.value !== ',') {
    const at = last.end - call.open - 1;
    preserved = preserved.slice(0, at) + ',' + preserved.slice(at);
  }
  // Keep existing arguments and comments; trim only the closing whitespace.
  preserved = preserved.replace(/[\t \r\n]+$/, '');
  if (preserved && !/^\s*\r?\n/.test(preserved)) preserved = eol + indent + preserved.replace(/^[\t ]*/, '');
  let result = escapeSnippet(preserved);
  for (let i = 0; i < parameters.length; i++) {
    const p = parameters[i];
    result += eol + escapeSnippet(indent + p.name + '=') + '${' + (i + 1) + ':' + escapeSnippet(placeholder(p)) + '},';
  }
  result += eol + escapeSnippet(baseIndent) + '$0';
  return result;
}

module.exports = { lex, findCall, parseParameters, missingParameters, placeholder, buildSnippet };
