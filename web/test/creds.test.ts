import assert from 'node:assert/strict';
import { classify, inspectGoogleServices, normalizeFingerprint, isClientId } from '../src/publish/creds-logic.ts';

const sample = {
  project_info: { project_number: '123456789012', project_id: 'my-shop' },
  client: [
    {
      client_info: { mobilesdk_app_id: '1:123:android:abc', android_client_info: { package_name: 'com.ahmed.shop' } },
      oauth_client: [
        { client_id: '123456789012-aaaa.apps.googleusercontent.com', client_type: 1, android_info: { package_name: 'com.ahmed.shop', certificate_hash: '0123456789abcdef0123456789abcdef01234567' } },
        { client_id: '123456789012-webweb.apps.googleusercontent.com', client_type: 3 },
      ],
    },
  ],
  configuration_version: '1',
};

// classification
assert.equal(classify(JSON.stringify(sample)).kind, 'google-services');
assert.equal(classify('{"foo":1}').kind, 'unknown');
assert.equal(classify('123456789012-webweb.apps.googleusercontent.com').kind, 'client-id');
assert.equal(classify('01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67').kind, 'sha1');
assert.equal(classify('SHA1: 0123456789abcdef0123456789abcdef01234567').kind, 'sha1');
assert.equal(classify('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef').kind, 'sha256');
assert.equal(classify('hello').kind, 'unknown');
assert.equal(classify('').kind, 'unknown');

// fingerprints
assert.equal(normalizeFingerprint('0123456789abcdef0123456789abcdef01234567', 20), '01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67');
assert.equal(normalizeFingerprint('0123', 20), null);
assert.ok(isClientId('123456789012-abc.apps.googleusercontent.com'));
assert.ok(!isClientId('abc.apps.googleusercontent.com'));

// inspection
const ok = inspectGoogleServices(sample, 'com.ahmed.shop');
assert.equal(ok.matchesPackage, true);
assert.equal(ok.projectId, 'my-shop');
assert.equal(ok.webClientId, '123456789012-webweb.apps.googleusercontent.com');
assert.deepEqual(ok.registeredSha1, ['01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67']);

const bad = inspectGoogleServices(sample, 'com.other.app');
assert.equal(bad.matchesPackage, false);
assert.deepEqual(bad.packages, ['com.ahmed.shop']);

console.log('creds tests passed');
