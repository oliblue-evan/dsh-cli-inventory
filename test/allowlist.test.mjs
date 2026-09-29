/**
 * 白名单的断言 —— 这是本插件的**安全边界**（"只对写死的清单执行二进制"），
 * 所以值得单独钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_CONCURRENCY, PROBE_TIMEOUT_MS, VERSION_PROBES, probeArgsFor } from '../lib/allowlist.js';

test('白名单结构：名称唯一、参数为非空字符串数组', () => {
  const names = VERSION_PROBES.map((probe) => probe.name);
  assert.equal(new Set(names).size, names.length, '不能有重复命令名');
  for (const probe of VERSION_PROBES) {
    assert.equal(typeof probe.name, 'string');
    assert.ok(probe.name.length > 0);
    assert.ok(Array.isArray(probe.args) && probe.args.length > 0, probe.name + ' 必须有参数');
    for (const arg of probe.args) assert.equal(typeof arg, 'string');
  }
  assert.ok(Object.isFrozen(VERSION_PROBES), '白名单应是冻结的，避免运行时被改');
});

test('查表：白名单内返回参数，白名单外返回 undefined（调用方据此不执行）', () => {
  assert.deepEqual(probeArgsFor('git'), ['--version']);
  assert.deepEqual(probeArgsFor('java'), ['-version'], 'java 的版本走 -version');
  assert.deepEqual(probeArgsFor('tmux'), ['-V']);
  assert.equal(probeArgsFor('rm'), undefined, '危险/无关命令不得进白名单');
  assert.equal(probeArgsFor('bash'), undefined);
  assert.equal(probeArgsFor(''), undefined);
  assert.equal(probeArgsFor(undefined), undefined);
});

test('超时与并发是有限值', () => {
  assert.ok(Number.isFinite(PROBE_TIMEOUT_MS) && PROBE_TIMEOUT_MS > 0 && PROBE_TIMEOUT_MS <= 10000);
  assert.ok(Number.isInteger(PROBE_CONCURRENCY) && PROBE_CONCURRENCY >= 1 && PROBE_CONCURRENCY <= 16);
});
