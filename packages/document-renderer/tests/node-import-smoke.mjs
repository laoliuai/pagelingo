import assert from 'node:assert/strict';
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const renderer = await import('@pagelingo/document-renderer');
assert.equal(typeof renderer.buildReader, 'function');
assert.equal(typeof renderer.createStaticFilePlan, 'function');
console.log('No-DOM Node import passed');
