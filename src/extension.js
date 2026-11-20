'use strict';
const vscode = require('vscode');
const { findCall, parseParameters, missingParameters, buildSnippet } = require('./core');
const { references } = require('./source');
const { ModelResolver } = require('./models');

function activate(context) {
  const resolver = new ModelResolver();
  const output = vscode.window.createOutputChannel('Pydantic Tools');
  const diagnostics = vscode.languages.createDiagnosticCollection('pydantic-tools');
  const selector = [{ language: 'python', scheme: 'file' }, { language: 'python', scheme: 'untitled' }];
  const timers = new Map();
  const generations = new Map();
  const externalDiagnostics = new Map();
  let disposed = false;
  const log = error => output.appendLine(String(error?.stack || error));
  const enabled = document => vscode.workspace.getConfiguration('pydanticTools', document.uri).get('enabled', true);
  const eligible = document => document.languageId === 'python' && document.getText().length <= 500_000 && enabled(document);

  async function getArguments(document, position, token) {
    if (!eligible(document)) return null;
    const version = document.version;
    const call = findCall(document.getText(), document.offsetAt(position));
    if (!call) return null;
    const model = await resolver.resolve(document, call.nameStart);
    if (!model || token?.isCancellationRequested) return null;
    const help = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', document.uri, document.positionAt(call.open + 1));
    if (token?.isCancellationRequested || document.version !== version || help?.signatures?.length !== 1) return null;
    const parameters = parseParameters(help.signatures[0]);
    return parameters.length ? { call, parameters, version } : null;
  }

  async function insert(mode, snapshot) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') return;
    const document = editor.document;
    if (snapshot && (document.uri.toString() !== snapshot.uri || document.version !== snapshot.version)) {
      vscode.window.showInformationMessage('The document changed. Open the Pydantic action again.'); return;
    }
    const position = snapshot ? document.positionAt(snapshot.offset) : editor.selection.active;
    const found = await getArguments(document, position);
    if (!found || document.version !== found.version) {
      vscode.window.showInformationMessage('Place the cursor on a Pydantic model constructor. Wait for Pylance to finish indexing if needed.'); return;
    }
    const missing = missingParameters(found.call, found.parameters, mode);
    if (missing === null) {
      vscode.window.showInformationMessage('Arguments cannot be inferred safely when *args or **kwargs are supplied.'); return;
    }
    if (!missing.length) { vscode.window.showInformationMessage('No missing ' + (mode === 'required' ? 'required ' : '') + 'arguments.'); return; }
    const options = editor.options;
    const snippet = buildSnippet(document.getText(), found.call, missing, {
      indentUnit: options.insertSpaces === false ? '\t' : ' '.repeat(Number(options.tabSize) || 4),
      eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'
    });
    const range = new vscode.Range(document.positionAt(found.call.open + 1), document.positionAt(found.call.close));
    await editor.insertSnippet(new vscode.SnippetString(snippet), range, { undoStopBefore: true, undoStopAfter: true });
  }

  context.subscriptions.push(output, diagnostics,
    vscode.commands.registerCommand('pydanticTools.insertRequired', snapshot => insert('required', snapshot).catch(log)),
    vscode.commands.registerCommand('pydanticTools.insertAll', snapshot => insert('all', snapshot).catch(log)),
    vscode.languages.registerCodeActionsProvider(selector, {
      async provideCodeActions(document, range, actionContext, token) {
        try {
          const found = await getArguments(document, range.start, token);
          if (!found) return [];
          const actions = [];
          for (const mode of ['required', 'all']) {
            const missing = missingParameters(found.call, found.parameters, mode);
            if (!missing?.length) continue;
            const title = mode === 'required' ? '＋ Insert required arguments' : '≡ Insert all arguments';
            const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
            action.isPreferred = mode === 'required';
            action.command = { title, command: mode === 'required' ? 'pydanticTools.insertRequired' : 'pydanticTools.insertAll', arguments: [{ uri: document.uri.toString(), version: found.version, offset: found.call.nameStart }] };
            actions.push(action);
          }
          return actions;
        } catch (error) { log(error); return []; }
      }
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] })
  );

  function referenceAt(document, position) {
    const offset = document.offsetAt(position);
    for (const reference of references(resolver.source(document))) {
      const field = reference.fields.find(f => f.start <= offset && offset <= f.end);
      if (field) return { reference, field };
    }
    return null;
  }

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
    async provideCompletionItems(document, position, token) {
      if (!eligible(document)) return [];
      const version = document.version, found = referenceAt(document, position);
      if (!found) return [];
      try {
        const model = await resolver.resolve(document, found.reference.owner, found.reference.typeDefinition);
        if (!model || token.isCancellationRequested || version !== document.version || (found.reference.kind === 'dump' && model.rootModel)) return [];
        const supplied = new Set(found.reference.fields.filter(f => f !== found.field).map(f => f.name));
        return model.fields.filter(f => !supplied.has(f.name) && (found.reference.kind !== 'validator' || !f.computed)).map(f => {
          const item = new vscode.CompletionItem(f.name, vscode.CompletionItemKind.Field);
          item.range = new vscode.Range(document.positionAt(found.field.start), document.positionAt(found.field.end));
          item.detail = model.name + ' field';
          item.sortText = '0' + f.name;
          return item;
        });
      } catch (error) { log(error); return []; }
    }
  }, "'", '"'));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
    async provideDefinition(document, position, token) {
      if (!eligible(document)) return;
      const version = document.version, found = referenceAt(document, position);
      if (!found) return;
      try {
        const model = await resolver.resolve(document, found.reference.owner, found.reference.typeDefinition);
        if (token.isCancellationRequested || document.version !== version) return;
        const field = model?.fields.find(f => f.name === found.field.name);
        if (!field) return;
        const target = await vscode.workspace.openTextDocument(field.uri);
        return new vscode.Location(field.uri, new vscode.Range(target.positionAt(field.start), target.positionAt(field.end)));
      } catch (error) { log(error); }
    }
  }));

  async function validate(document, generation) {
    const key = document.uri.toString(), version = document.version;
    if (!eligible(document) || (!vscode.workspace.getWorkspaceFolder(document.uri) && document.uri.scheme !== 'untitled' && !vscode.window.visibleTextEditors.some(editor => editor.document === document)) || !vscode.workspace.getConfiguration('pydanticTools', document.uri).get('unknownFieldDiagnostics', true)) {
      diagnostics.delete(document.uri); return;
    }
    const problems = [];
    try {
      for (const ref of references(resolver.source(document)).slice(0, 100)) {
        if (ref.skipCheck) continue;
        const model = await resolver.resolve(document, ref.owner, ref.typeDefinition);
        if (disposed || generations.get(key) !== generation || version !== document.version || document.isClosed) return;
        if (!model || (ref.kind === 'dump' && model.rootModel)) continue;
        const fields = new Set(model.fields.filter(f => ref.kind !== 'validator' || !f.computed).map(f => f.name));
        for (const field of ref.fields) {
          if (fields.has(field.name) || (ref.kind === 'validator' && field.name === '*') || (ref.kind === 'dump' && field.name === '__all__') || !field.name) continue;
          const range = new vscode.Range(document.positionAt(field.start), document.positionAt(field.end));
          const problem = new vscode.Diagnostic(range, `Field '${field.name}' not found in model '${model.name}'`, vscode.DiagnosticSeverity.Warning);
          problem.source = 'Pydantic Tools'; problem.code = 'unknown-field';
          problems.push(problem);
        }
      }
      if (!disposed && generations.get(key) === generation && version === document.version && !document.isClosed) diagnostics.set(document.uri, problems);
    } catch (error) { log(error); }
  }

  function schedule(document, delay = 500) {
    if (document.languageId !== 'python') return;
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    const generation = (generations.get(key) || 0) + 1;
    generations.set(key, generation);
    timers.set(key, setTimeout(() => { timers.delete(key); validate(document, generation); }, delay));
  }
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => schedule(document)),
    vscode.window.onDidChangeVisibleTextEditors(editors => { for (const editor of editors) schedule(editor.document); }),
    vscode.workspace.onDidChangeTextDocument(event => {
      resolver.clear();
      // An edited base class can change diagnostics in another open file.
      for (const document of vscode.workspace.textDocuments) schedule(document);
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString(); clearTimeout(timers.get(key)); timers.delete(key);
      generations.delete(key); diagnostics.delete(document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('pydanticTools') || event.affectsConfiguration('python')) {
        resolver.clear(); for (const document of vscode.workspace.textDocuments) schedule(document);
      }
    }),
    // Pylance publishes diagnostics after indexing. Retry references once types
    // become available, without polling or triggering a self-diagnostics loop.
    vscode.languages.onDidChangeDiagnostics(event => {
      for (const uri of event.uris) {
        const all = vscode.languages.getDiagnostics(uri).filter(d => d.source !== 'Pydantic Tools');
        const fingerprint = JSON.stringify(all.map(d => [d.message, d.code, d.range.start.line, d.range.start.character]));
        const key = uri.toString();
        if (externalDiagnostics.get(key) === fingerprint) continue;
        externalDiagnostics.set(key, fingerprint);
        const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        if (document) schedule(document);
      }
    }),
    { dispose() { disposed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); resolver.clear(); } }
  );
  for (const document of vscode.workspace.textDocuments) schedule(document, 1000);
  return { validate: document => { const key = document.uri.toString(); const generation = (generations.get(key) || 0) + 1; generations.set(key, generation); return validate(document, generation); }, getArguments, resolver };
}
module.exports = { activate };
