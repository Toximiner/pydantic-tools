'use strict';
const { lex } = require('./core');

const VALIDATORS = new Set(['validator', 'field_validator', 'field_serializer']);
const DUMP_METHODS = new Set(['model_dump', 'model_dump_json', 'dict', 'json']);
const MODEL_FACTORIES = new Set(['model_validate', 'model_validate_json', 'model_validate_strings', 'model_construct', 'parse_obj', 'parse_raw', 'from_orm', 'construct']);

function analyze(text) {
  const tokens = lex(text), pairs = new Map(), stack = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  let line = 0, depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= t.start) line++;
    t.line = line;
    t.indent = text.slice(lineStarts[line], t.start).match(/^[\t ]*/)[0].length;
    t.first = i === 0 || tokens[i - 1].line !== line;
    t.depth = depth;
    if (t.kind !== 'punctuation') continue;
    if ('([{'.includes(t.value)) { stack.push(i); depth++; }
    else if (')]}'.includes(t.value)) {
      const j = stack.pop(); depth = Math.max(0, depth - 1);
      if (j !== undefined && '([{'.indexOf(tokens[j].value) === ')]}'.indexOf(t.value)) { pairs.set(j, i); pairs.set(i, j); }
    }
  }
  const classes = [];
  for (let i = 0; i < tokens.length; i++) {
    const keyword = tokens[i], name = tokens[i + 1];
    if (keyword.value !== 'class' || keyword.kind !== 'name' || name?.kind !== 'name') continue;
    let cursor = i + 2;
    if (tokens[cursor]?.value === '[' && pairs.has(cursor)) cursor = pairs.get(cursor) + 1;
    let headerEnd = cursor;
    if (tokens[cursor]?.value === '(') headerEnd = (pairs.get(cursor) ?? cursor) + 1;
    if (tokens[headerEnd]?.value !== ':') continue;
    const endToken = tokens.slice(headerEnd + 1).find(t => t.line > keyword.line && t.first && t.depth === 0 && t.indent <= keyword.indent);
    const end = endToken?.start ?? text.length;
    const body = tokens.slice(headerEnd + 1).filter(t => t.start < end);
    const bodyIndent = Math.min(...body.filter(t => t.first && t.depth === 0).map(t => t.indent));
    const fields = [], excludedFields = [];
    for (let k = headerEnd + 1; k < tokens.length && tokens[k].start < end; k++) {
      const field = tokens[k];
      if (!field.first || field.depth !== 0 || field.indent !== bodyIndent || field.kind !== 'name' || field.value.startsWith('_') || field.value === 'model_config') continue;
      if (![':', '='].includes(tokens[k + 1]?.value)) continue;
      let last = k + 1;
      while (last + 1 < tokens.length && tokens[last + 1].start < end && !(tokens[last + 1].first && tokens[last + 1].depth === 0)) last++;
      const declaration = tokens.slice(k + 2, last + 1);
      const equals = declaration.findIndex(t => t.depth === 0 && t.value === '=');
      const annotation = tokens[k + 1].value === ':' ? declaration.slice(0, equals < 0 ? undefined : equals) : [];
      if (annotation.some(t => t.value === 'ClassVar') || declaration.some(t => t.value === 'PrivateAttr')) { excludedFields.push(field.value); continue; }
      fields.push({ name: field.value, start: field.start, end: field.end, annotation });
    }
    const bases = [];
    if (tokens[cursor]?.value === '(' && pairs.has(cursor)) {
      for (const part of split(tokens, cursor + 1, pairs.get(cursor), tokens[cursor].depth + 1)) {
        if (part.some(t => t.depth === tokens[cursor].depth + 1 && t.value === '=')) continue;
        const chain = [];
        for (const t of part) {
          if (t.kind === 'name') chain.push(t);
          else if (t.value !== '.') break;
        }
        if (chain.length) bases.push(chain.at(-1));
      }
    }
    const prefix = text.slice(Math.max(0, text.lastIndexOf('\n\n', keyword.start)), keyword.start);
    const dataclass = (/@dataclass\b/.test(prefix) && /from\s+pydantic\.dataclasses\s+import\s*(?:\(\s*)?dataclass\b/.test(text)) || /@pydantic\.dataclasses\.dataclass\b/.test(prefix);
    // Computed properties participate in serialization, but not validation or constructor arguments.
    for (let k = headerEnd + 1; k < tokens.length && tokens[k].start < end; k++) {
      const method = tokens[k];
      if (method.value !== 'def' || !method.first || method.indent !== bodyIndent || method.depth !== 0) continue;
      let previous = k - 1, computed = false;
      while (previous > headerEnd) {
        const token = tokens[previous];
        if (token.first && token.depth === 0 && token.indent <= bodyIndent && token.value !== '@') break;
        if (token.value === 'computed_field' && tokens[previous - 1]?.value === '@') computed = true;
        previous--;
      }
      const identifier = tokens[k + 1];
      if (computed && identifier?.kind === 'name') fields.push({ name: identifier.value, start: identifier.start, end: identifier.end, computed: true, annotation: [] });
    }
    classes.push({ name: name.value, start: keyword.start, nameStart: name.start, headerEnd: tokens[headerEnd].end, end, fields, excludedFields, bases, dataclass });
  }
  return { text, tokens, pairs, classes };
}

function split(tokens, from, to, depth) {
  const parts = [[]];
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (t.depth === depth && t.value === ',' && t.kind === 'punctuation') parts.push([]);
    else parts.at(-1).push(t);
  }
  return parts.filter(part => part.length);
}

function unquote(token) {
  if (token?.kind !== 'string') return null;
  const quote = token.value.startsWith(token.value[0].repeat(3)) ? token.value[0].repeat(3) : token.value[0];
  const value = token.value.slice(quote.length, -quote.length);
  if (!token.value.endsWith(quote) || /[\\\r\n]/.test(value)) return null;
  return { name: value, start: token.start + quote.length, end: token.end - quote.length };
}

function ownerClass(parsed, offset) {
  return parsed.classes.filter(c => c.headerEnd <= offset && offset < c.end).sort((a, b) => b.start - a.start)[0];
}

function references(parsed) {
  const { tokens, pairs } = parsed, result = [];
  const validatorNames = new Set(VALIDATORS);
  // Recognize imported aliases, e.g. field_validator as validate_fields.
  for (let i = 0; i < tokens.length - 2; i++) {
    if (VALIDATORS.has(tokens[i].value) && tokens[i + 1].value === 'as') validatorNames.add(tokens[i + 2].value);
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'name' || tokens[i + 1]?.value !== '(') continue;
    const open = i + 1, close = pairs.get(open);
    if (close === undefined) continue;
    const args = split(tokens, open + 1, close, tokens[open].depth + 1);
    if (validatorNames.has(t.value)) {
      let previous = i - 1;
      while (previous >= 0 && (tokens[previous].kind === 'name' || tokens[previous].value === '.')) previous--;
      if (tokens[previous]?.value !== '@') continue;
      const cls = ownerClass(parsed, t.start);
      if (!cls) continue;
      const checkFields = args.find(p => p[0]?.value === 'check_fields' && p[1]?.value === '=');
      const skipCheck = checkFields?.[2]?.value === 'False';
      const fields = args.filter(p => p.length === 1 && p[0].kind === 'string').map(p => unquote(p[0])).filter(Boolean);
      result.push({ kind: 'validator', owner: cls.nameStart, fields, skipCheck, method: t.value });
    } else if (DUMP_METHODS.has(t.value) && tokens[i - 1]?.value === '.') {
      const receiver = receiverAnchor(tokens, pairs, i - 2);
      if (!receiver) continue;
      for (const arg of args) {
        if (!['include', 'exclude'].includes(arg[0]?.value) || arg[1]?.value !== '=') continue;
        const literal = arg[2], literalIndex = tokens.indexOf(literal), literalClose = pairs.get(literalIndex);
        // Only statically written sets/dicts; variables and unpacking are left alone.
        if (literal?.value !== '{' || literalClose === undefined) continue;
        const parts = split(tokens, literalIndex + 1, literalClose, literal.depth + 1);
        const fields = parts.filter(p => p.length === 1 || p[1]?.value === ':').map(p => unquote(p[0])).filter(Boolean);
        result.push({ kind: 'dump', owner: receiver.start, typeDefinition: receiver.typeDefinition, fields, skipCheck: false, method: t.value, argument: arg[0].value });
      }
    }
  }
  return result;
}

function receiverAnchor(tokens, pairs, index) {
  const t = tokens[index];
  if (!t) return null;
  if (t.kind === 'name') return { start: t.start, typeDefinition: true };
  if (t.value === ')') {
    const open = pairs.get(index), name = tokens[open - 1];
    if (!name || name.kind !== 'name') return null;
    if (MODEL_FACTORIES.has(name.value) && tokens[open - 2]?.value === '.') return receiverAnchor(tokens, pairs, open - 3);
    return { start: name.start, typeDefinition: true };
  }
  return null;
}

module.exports = { analyze, references, ownerClass, unquote };
