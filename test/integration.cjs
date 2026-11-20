const vscode = require('vscode');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const ROOT = process.env.PYDANTIC_TOOLS_TEST_ROOT;
if (!ROOT) throw new Error('Set PYDANTIC_TOOLS_TEST_ROOT to the isolated integration workspace root.');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.run = async () => {
  const results = [];
  try {
    const config = vscode.workspace.getConfiguration();
    await config.update('python.defaultInterpreterPath', ROOT + '/venv/bin/python', vscode.ConfigurationTarget.Workspace);
    await config.update('python.analysis.typeCheckingMode', 'basic', vscode.ConfigurationTarget.Workspace);
    const document = await vscode.workspace.openTextDocument(ROOT + '/test-workspace/demo.py');
    const editor = await vscode.window.showTextDocument(document);
    if (document.isDirty) await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.extensions.getExtension('ms-python.python').activate();
    await vscode.extensions.getExtension('ms-python.vscode-pylance').activate();
    const extension = vscode.extensions.getExtension('Toximiner.pydantic-tools');
    assert.ok(extension, 'development extension registered');
    const api = await extension.activate();
    const at = (needle, inside = 0) => {
      const offset = document.getText().indexOf(needle); assert.ok(offset >= 0, needle);
      return document.positionAt(offset + inside);
    };
    const getActions = async needle => {
      const position = at(needle, 2); editor.selection = new vscode.Selection(position, position);
      return (await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(position, position), vscode.CodeActionKind.QuickFix.value))?.filter(a => a.command?.command?.startsWith('pydanticTools.')) || [];
    };
    let actions;
    for (let i = 0; i < 150; i++) {
      actions = await getActions('Novel()');
      if (actions.length === 2) break;
      await sleep(300);
    }
    assert.deepEqual(actions.map(a => a.title), ['＋ Insert required arguments', '≡ Insert all arguments']);
    results.push('Quick Fix actions on imported/aliased model with inherited fields');
    let original = document.getText();
    await vscode.commands.executeCommand(actions[0].command.command, ...actions[0].command.arguments);
    let text = document.getText().slice(0, document.getText().indexOf('partial ='));
    for (const name of ['code', 'title', 'subtitle', 'writer', 'rating']) assert.ok(text.includes(name + '=,'), name);
    for (const name of ['count', 'tags', 'edition', 'category']) assert.ok(!text.includes(name + '='), name);
    assert.ok(editor.selection.isEmpty, 'first empty required placeholder selected');
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), original, 'one undo restores the complete call');
    await vscode.commands.executeCommand('leaveSnippet');
    results.push('Required insertion, aliases, nullable required fields, inherited fields and single-step undo');

    actions = await getActions("Novel(title='Maps')");
    const all = actions.find(a => a.title === '≡ Insert all arguments'); assert.ok(all);
    await vscode.commands.executeCommand(all.command.command, ...all.command.arguments);
    text = document.getText().slice(document.getText().indexOf('partial ='), document.getText().indexOf('session ='));
    assert.equal((text.match(/\btitle=/g) || []).length, 1);
    assert.ok(text.includes("title='Maps',")); assert.ok(text.includes('count=1,')); assert.ok(text.includes('tags=[],'));
    assert.ok(!text.includes('category='));
    await vscode.commands.executeCommand('undo'); await vscode.commands.executeCommand('leaveSnippet');
    assert.equal(document.getText(), original);
    results.push('All insertion preserves existing values and defaults, excludes ClassVar, handles default_factory');

    actions = await getActions('ReadingSession()');
    assert.equal(actions.length, 2, 'Pydantic dataclass actions');
    results.push('Pydantic dataclasses');
    actions = await getActions('Envelope[int]()');
    assert.equal(actions.length, 2, 'Generic model actions');
    results.push('Generic model constructors');
    for (let i = 0; i < 20; i++) {
      await api.validate(document);
      const problems = vscode.languages.getDiagnostics(document.uri).filter(d => d.source === 'Pydantic Tools');
      if (problems.length >= 6) break;
      await sleep(300);
    }
    const problems = vscode.languages.getDiagnostics(document.uri).filter(d => d.source === 'Pydantic Tools');
    fs.writeFileSync(ROOT + '/diagnostics.json', JSON.stringify(problems.map(d => ({ message: d.message, line: d.range.start.line })), null, 2));
    assert.equal(problems.length, 6, JSON.stringify(problems.map(d => d.message)));
    assert.equal(problems.filter(d => d.message.includes("'missing'")).length, 4);
    assert.equal(problems.filter(d => d.message.includes("'absent'")).length, 1);
    assert.ok(problems.some(d => d.message.includes("'code'") && d.message.includes("'Summary'")));
    assert.ok(!problems.some(d => d.message.includes("'label'") || d.message.includes("'Labels'")));
    results.push('ClassVar overrides, computed serialization fields and RootModel exclusion safety');
    results.push('Unknown fields: instance, model_validate chain, constructor chain, legacy dict, validator; no false positives for check_fields=False or ordinary objects');

    const position = at("exclude={''}", "exclude={'".length);
    const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position);
    const labels = completions.items.map(item => typeof item.label === 'string' ? item.label : item.label.label);
    for (const name of ['title', 'code', 'author', 'tags', 'label']) assert.ok(labels.includes(name), name + ': ' + labels.join(','));
    assert.ok(!labels.includes('category')); assert.ok(!labels.includes('writer'));
    results.push('include/exclude field completion uses field names, not constructor aliases');

    const validatorPosition = at("@field_validator('')", "@field_validator('".length);
    const validatorItems = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, validatorPosition);
    assert.ok(validatorItems.items.some(i => i.label === 'name'));
    results.push('Validator field completion');

    const definitionPosition = at("exclude={'title'", "exclude={'ti".length);
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, definitionPosition);
    assert.ok(definitions.some(d => (d.uri || d.targetUri).path.endsWith('/library.py')));
    results.push('Go to field declaration from include/exclude string');

    const old = at("exclude={'missing'}", "exclude={'".length);
    await editor.edit(edit => edit.replace(new vscode.Range(old, old.translate(0, 7)), 'title'));
    assert.ok(document.getText().includes("validated.model_dump(exclude={'title'})"));
    for (let i = 0; i < 30; i++) {
      await api.validate(document);
      if (vscode.languages.getDiagnostics(document.uri).filter(d => d.source === 'Pydantic Tools').length === 5) break;
      await sleep(100);
    }
    assert.equal(vscode.languages.getDiagnostics(document.uri).filter(d => d.source === 'Pydantic Tools').length, 5);
    await vscode.commands.executeCommand('undo');
    results.push('Diagnostics update after edits');
    actions = await getActions('Novel()');
    const stale = actions[0];
    const end = document.positionAt(document.getText().length);
    await editor.edit(edit => edit.insert(end, '\n'));
    const beforeStale = document.getText();
    await vscode.commands.executeCommand(stale.command.command, ...stale.command.arguments);
    assert.equal(document.getText(), beforeStale);
    await vscode.commands.executeCommand('undo');
    results.push('Stale Quick Fix actions do not edit a changed document');

    await config.update('python.analysis.typeCheckingMode', 'off', vscode.ConfigurationTarget.Workspace);
    for (let i = 0; i < 30; i++) {
      await api.validate(document);
      if (vscode.languages.getDiagnostics(document.uri).filter(d => d.source === 'Pydantic Tools').length === 6) break;
      await sleep(100);
    }
    assert.equal(vscode.languages.getDiagnostics(document.uri).filter(d => d.source === 'Pydantic Tools').length, 6);
    results.push('Field warnings work with Pylance type-checking mode off');

    await api.validate(document);
    const generationText = document.getText();
    await sleep(1500);
    assert.equal(document.getText(), generationText);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    fs.writeFileSync(ROOT + '/integration-result.json', JSON.stringify({ passed: results }, null, 2));
  } catch (error) {
    fs.writeFileSync(ROOT + '/integration-result.json', JSON.stringify({ passed: results, error: error.stack }, null, 2));
    throw error;
  }
};
