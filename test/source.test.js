'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, references } = require('../src/source');

test('class fields exclude private names, ClassVar, config and method locals', () => {
  const text = `class Book(BaseModel):
    title: str
    labels: list[str] = Field(
        default_factory=list,
    )
    category: ClassVar[str] = 'books'
    _secret: str
    model_config = ConfigDict()
    def method(self):
        local: int
other = Book()
`;
  assert.deepEqual(analyze(text).classes[0].fields.map(f => f.name), ['title', 'labels']);
});
test('class inheritance supports qualified names and generics', () => {
  const cls = analyze('class Book(models.Item[str], Generic[T]):\n    title: str\n').classes[0];
  assert.deepEqual(cls.bases.map(b => b.value), ['Item', 'Generic']);
});
test('validators use actual names and support imported aliases', () => {
  const text = `from pydantic import field_validator as validate_fields
class Book(BaseModel):
    title: str
    @validate_fields('title', 'missing', mode='before')
    @classmethod
    def check(cls, value):
        return value
`;
  const refs = references(analyze(text));
  assert.deepEqual(refs[0].fields.map(f => f.name), ['title', 'missing']);
});
test('check_fields=False suppresses unknown-field checks', () => {
  const refs = references(analyze(`class Book(BaseModel):
    @field_validator('future', check_fields=False)
    def check(cls, value): return value
`));
  assert.equal(refs[0].skipCheck, true);
});
test('include/exclude checks only top-level keys, not nested keys or values', () => {
  const text = "book.model_dump(exclude={'title', 'missing'}, include={'child': {'nested': True}, 'count': True})";
  const refs = references(analyze(text));
  assert.deepEqual(refs.map(r => r.fields.map(f => f.name)), [['title', 'missing'], ['child', 'count']]);
});
test('model_validate chain resolves owner before classmethod', () => {
  const text = "Book.model_validate({'x': 1}).model_dump(exclude={'missing'})";
  const ref = references(analyze(text))[0];
  assert.equal(ref.owner, 0);
  assert.equal(ref.typeDefinition, true);
});
test('constructor chain resolves model class', () => {
  const text = "Book(title='Maps').model_dump(exclude={'missing'})";
  assert.equal(references(analyze(text))[0].owner, 0);
});
test('plain dict/json methods are only candidates, model resolver must verify type', () => {
  const refs = references(analyze("response.json(exclude={'missing'})"));
  assert.equal(refs[0].owner, 0);
});
test('strings and comments containing fake model code are ignored', () => {
  assert.deepEqual(references(analyze('"book.model_dump(exclude={\'missing\'})"')), []);
  assert.deepEqual(references(analyze("# book.model_dump(exclude={'missing'})")), []);
});
test('empty quoted field is a completion target with a zero-length range', () => {
  const ref = references(analyze("book.model_dump(exclude={''})"))[0];
  assert.equal(ref.fields[0].start, ref.fields[0].end);
});
test('pydantic dataclass is distinct from standard-library dataclass', () => {
  assert.equal(analyze('from dataclasses import dataclass\nimport pydantic\n\n@dataclass\nclass Book:\n    title: str').classes[0].dataclass, false);
  assert.equal(analyze('from pydantic.dataclasses import dataclass\n\n@dataclass\nclass Book:\n    title: str').classes[0].dataclass, true);
});
test('computed properties are marked as serialization-only fields', () => {
  const cls = analyze(`class Book(BaseModel):
    title: str
    @computed_field
    @property
    def label(self) -> str:
        return self.title
    def method(self): return 1
`).classes[0];
  assert.deepEqual(cls.fields.map(f => [f.name, !!f.computed]), [['title', false], ['label', true]]);
});
test('ClassVar override can remove a field inherited from a base model', () => {
  const cls = analyze('class Book(Item):\n    count: ClassVar[int] = 0\n').classes[0];
  assert.deepEqual(cls.excludedFields, ['count']);
});
