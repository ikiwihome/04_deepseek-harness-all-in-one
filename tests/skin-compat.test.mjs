import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCompatibleSkin } from '../docker/resolve-skin-version.mjs';

const versions = ['0.4.4', '0.4.8', '0.4.6', '0.4.7'];
const metadata = version => ({ version, peerDependencies: {
  '@deepseek-ai/dsh': ['0.4.8', '0.4.7'].includes(version) ? '>=0.2.1-rc.2' : '>=0.1.7-rc.1'
} });

test('alpha DSH selects newest compatible skin instead of incompatible latest', () => {
  assert.equal(selectCompatibleSkin({ dsh: '0.2.1-alpha.2', versions, metadata }), '0.4.6');
});
test('newer DSH can select latest skin', () => {
  assert.equal(selectCompatibleSkin({ dsh: '0.2.1-rc.2', versions, metadata }), '0.4.8');
});
test('explicit incompatible pin fails rather than granting an exemption', () => {
  assert.throws(() => selectCompatibleSkin({ dsh: '0.2.1-alpha.2', versions, pinned: '0.4.8', metadata }), /requires dsh/);
  assert.equal(selectCompatibleSkin({ dsh: '0.2.1-alpha.2', versions, pinned: '0.4.4', metadata }), '0.4.4');
});
test('unknown registry metadata and no compatible releases fail clearly', () => {
  assert.throws(() => selectCompatibleSkin({ dsh: '0.2.1-alpha.2', versions, metadata: () => null }), /Cannot read/);
  assert.throws(() => selectCompatibleSkin({ dsh: '0.1.0', versions, metadata }), /No compatible/);
});
