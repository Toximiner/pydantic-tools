'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findCall, parseParameters, missingParameters, buildSnippet, placeholder } = require('../src/core');
const sig = (...labels) => ({ label: '', parameters: labels.map(label => ({ label })) });
const call = text => findCall(text, text.indexOf('Book') + 2);
const parameters = parseParameters(sig('*', 'title: str', 'count: int = 1', 'subtitle: str | None', 'tags: list[str] = list'));

test('Pydantic v2 nullable field is required without a default', () => {
  assert.deepEqual(missingParameters(call('Book()'), parameters, 'required').map(p => p.name), ['title', 'subtitle']);
});
test('all mode includes defaulted fields in signature order', () => {
  assert.deepEqual(missingParameters(call('Book()'), parameters, 'all').map(p => p.name), ['title', 'count', 'subtitle', 'tags']);
});
test('existing keyword arguments and nested commas are preserved', () => {
  assert.deepEqual(missingParameters(call("Book(title=combine('a,b', {'x': (1, 2)}))"), parameters, 'required').map(p => p.name), ['subtitle']);
});
test('starred arguments are not guessed', () => {
  assert.equal(missingParameters(call('Book(**data)'), parameters, 'all'), null);
  assert.equal(missingParameters(call('Book(*data)'), parameters, 'all'), null);
});
test('positional arguments consumed for Pydantic dataclasses', () => {
  const p = parseParameters(sig('title: str', 'count: int = 1'));
  assert.deepEqual(missingParameters(call("Book('Maps')"), p, 'all').map(x => x.name), ['count']);
});
test('positional-only parameters are not inserted as keywords', () => {
  assert.deepEqual(parseParameters(sig('first: str', '/', 'next: int')).filter(p => !p.positionalOnly).map(p => p.name), ['next']);
});
test('brackets in strings and comments do not become calls', () => {
  assert.equal(findCall("s = 'Book()'", 10), null);
  assert.equal(findCall('# Book()', 5), null);
  assert.equal(findCall('"""Book()"""', 6), null);
});
test('nearest nested model at cursor wins', () => {
  const text = 'Outer(child=Book())';
  assert.equal(findCall(text, text.indexOf('Book') + 1).name, 'Book');
});
test('function and class declarations are not calls', () => {
  assert.equal(findCall('def Book():', 5), null);
  assert.equal(findCall('class Book(Base):', 8), null);
});
test('signature label offset tuples are understood', () => {
  const label = '(*, title: str, count: int = 1) -> Book';
  assert.deepEqual(parseParameters({ label, parameters: [{ label: [1, 2] }, { label: [4, 14] }, { label: [16, 30] }] }).map(p => p.name), ['title', 'count']);
});
test('equals or commas inside Literal do not split parameter metadata', () => {
  const p = parseParameters(sig("title: Literal['a=b,c']", "options: dict[str, tuple[int, int]] = {}"));
  assert.equal(p[0].required, true);
  assert.equal(p[1].name, 'options');
  assert.equal(p[1].defaultValue, '{}');
});
test('required fields get editable empty values, as in the PyCharm action', () => {
  assert.equal(placeholder(parameters[0]), '');
  const text = 'value = Book()';
  assert.equal(buildSnippet(text, call(text), parameters.slice(0, 2)), '\n    title=${1:},\n    count=${2:1},\n$0');
});
test('comment after existing argument stays intact and comma precedes it', () => {
  const text = "Book(\n    title='Maps'  # keep this comment\n)";
  const snippet = buildSnippet(text, call(text), [parameters[2]]);
  assert.match(snippet, /title='Maps',  # keep this comment/);
  assert.match(snippet, /\n    subtitle=\$\{1:\},/);
});
test('existing trailing comma is not duplicated', () => {
  const text = "Book(title='Maps',)";
  const snippet = buildSnippet(text, call(text), [parameters[2]]);
  assert.match(snippet, /title='Maps',\n/);
  assert.doesNotMatch(snippet, /,,/);
});
test('snippet metacharacters in user code are escaped', () => {
  const text = "Book(title='$HOME \\\\ path }')";
  const snippet = buildSnippet(text, call(text), [parameters[2]]);
  assert.ok(snippet.includes('\\$HOME'));
  assert.ok(snippet.includes('\\}'));
});
test('factory is not copied as a field value', () => {
  assert.equal(placeholder(parameters[3]), '[]');
  assert.equal(placeholder({ required: false, defaultValue: 'make_tags' }), '');
});
test('tabs, CRLF and nested indentation follow editor settings', () => {
  const text = '\tvalue = Book()';
  assert.equal(buildSnippet(text, call(text), [parameters[0]], { indentUnit: '\t', eol: '\r\n' }), '\r\n\t\ttitle=${1:},\r\n\t$0');
});
test('generic model constructor is recognized', () => {
  const text = 'book = Box[Book](content=None)';
  const found = findCall(text, text.indexOf('Box') + 1);
  assert.equal(found.name, 'Box');
  assert.equal(text[found.open], '(');
});
test('literal collection defaults are retained without copying executable expressions', () => {
  assert.equal(placeholder({ defaultValue: "['maps', 'fiction']" }), "['maps', 'fiction']");
  assert.equal(placeholder({ defaultValue: "{'enabled': True, 'limit': 2}" }), "{'enabled': True, 'limit': 2}");
  assert.equal(placeholder({ defaultValue: '[load_book()]' }), '');
});
