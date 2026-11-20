'use strict';
const vscode = require('vscode');
const { analyze } = require('./source');

class ModelResolver {
  constructor() { this.sources = new Map(); this.models = new Map(); }
  clear() { this.sources.clear(); this.models.clear(); }
  source(document) {
    const key = document.uri.toString();
    let cached = this.sources.get(key);
    if (!cached || cached.version !== document.version) {
      cached = { version: document.version, parsed: analyze(document.getText()) };
      this.sources.set(key, cached);
      if (this.sources.size > 80) this.sources.delete(this.sources.keys().next().value);
    }
    return cached.parsed;
  }
  async resolve(document, offset, typeDefinition = false, seen = new Set()) {
    if (seen.size > 12) return null;
    const command = typeDefinition ? 'vscode.executeTypeDefinitionProvider' : 'vscode.executeDefinitionProvider';
    const definitions = await vscode.commands.executeCommand(command, document.uri, document.positionAt(offset));
    if (!definitions?.length || definitions.length > 1) return null; // Ambiguous unions are deliberately not guessed.
    const location = definitions[0], uri = location.targetUri || location.uri;
    const range = location.targetSelectionRange || location.range;
    if (!uri || !range) return null;
    const target = await vscode.workspace.openTextDocument(uri);
    if (target.getText().length > 2_000_000) return null;
    const at = target.offsetAt(range.start), key = uri.toString() + ':' + target.version + ':' + at;
    if (seen.has(key)) return null;
    if (this.models.has(key)) return this.models.get(key);
    const next = new Set(seen); next.add(key);
    const cls = this.source(target).classes.find(c => c.start <= at && at < c.headerEnd);
    if (!cls) return null;
    const path = uri.path.replace(/\\/g, '/');
    if (cls.name === 'BaseModel' && /\/pydantic\/(?:v1\/)?main\.pyi?$/.test(path)) return { name: cls.name, fields: [], document: target, cls };
    const bases = [];
    for (const base of cls.bases) {
      const result = await this.resolve(target, base.start, false, next);
      if (result) bases.push(result);
    }
    if (!bases.length && !cls.dataclass) return null;
    const fields = new Map();
    // Python's first base wins in multiple inheritance.
    for (const base of [...bases].reverse()) for (const field of base.fields) fields.set(field.name, field);
    for (const name of cls.excludedFields) fields.delete(name);
    for (const field of cls.fields) fields.set(field.name, { ...field, uri: target.uri });
    const rootModel = bases.some(base => base.rootModel) || (cls.name === 'RootModel' && /\/pydantic\/root_model\.pyi?$/.test(path));
    const model = { name: cls.name, fields: [...fields.values()], document: target, cls, rootModel };
    this.models.set(key, model);
    return model;
  }
}
module.exports = { ModelResolver };
