/**
 * 能力层纯逻辑（工具 / 技能 / MCP 识别与归一化）的断言。
 *
 * 这一层决定"界面上把什么算作工具、什么算作 MCP、脏条目怎么处理"，
 * 全是纯函数，边界情况都在这里钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_TOOL_PREFIX, normalizeSkill, normalizeTool, parseMcpToolName, readParameters, sortByName,
  summarizeCapabilities,
} from '../lib/capabilities.js';

test('MCP 工具名拆解：mcp__<服务器>__<工具>，只按第一个 __ 切', () => {
  assert.deepEqual(parseMcpToolName('mcp__github__create_issue'), { server: 'github', tool: 'create_issue' });
  assert.deepEqual(parseMcpToolName('mcp__my_server__read_file'), { server: 'my_server', tool: 'read_file' },
    '服务器名里有单个下划线是常见的，不能按最后一段切');
  assert.deepEqual(parseMcpToolName('mcp__a__b__c'), { server: 'a', tool: 'b__c' });
  assert.equal(parseMcpToolName('read'), null, '普通工具不是 MCP');
  assert.equal(parseMcpToolName('mcp__onlyserver'), null, '缺第二段分隔符 → 无法拆解');
  assert.equal(parseMcpToolName('mcp____tool'), null, '空服务器名 → 不认');
  assert.equal(parseMcpToolName('mcp__server__'), null, '空工具名 → 不认');
  assert.equal(parseMcpToolName(''), null);
  assert.equal(parseMcpToolName(null), null);
  assert.equal(parseMcpToolName(undefined), null);
  assert.equal(MCP_TOOL_PREFIX, 'mcp__');
});

test('参数解析：从 ToolSchema.parameters 里取参数名与必填项，形状不对就当没有', () => {
  assert.deepEqual(
    readParameters({ type: 'object', properties: { file_path: {}, offset: {}, limit: {} }, required: ['file_path'] }),
    { params: ['file_path', 'offset', 'limit'], required: ['file_path'] },
  );
  // 契约里 parameters 的类型只是 Record<string, unknown>，所以脏形状一律安全退化
  assert.deepEqual(readParameters(undefined), { params: [], required: [] });
  assert.deepEqual(readParameters(null), { params: [], required: [] });
  assert.deepEqual(readParameters('nope'), { params: [], required: [] });
  assert.deepEqual(readParameters({ properties: [] }), { params: [], required: [] }, 'properties 是数组 → 不认');
  assert.deepEqual(readParameters({ properties: { a: {} }, required: ['a', 42, ''] }).required, ['a'], '脏 required 项被过滤');
  assert.deepEqual(readParameters({ properties: { '': {} } }).params, [], '空键名不算参数');
});

test('工具归一化：取名称 / 描述 / 参数，脏条目返回 null', () => {
  assert.deepEqual(normalizeTool({ name: 'read', description: '读取文件', parameters: { type: 'object' } }),
    { name: 'read', description: '读取文件', params: [], required: [], mcp: null });
  assert.deepEqual(
    normalizeTool({ name: 'read', parameters: { properties: { file_path: {} }, required: ['file_path'] } }),
    { name: 'read', description: '', params: ['file_path'], required: ['file_path'], mcp: null },
  );
  assert.deepEqual(normalizeTool({ name: 'mcp__gh__issue' }).mcp, { server: 'gh', tool: 'issue' });
  assert.deepEqual(normalizeTool({ name: 'x' }).description, '', '缺描述时给空串而不是 undefined');
  assert.equal(normalizeTool(null), null);
  assert.equal(normalizeTool('read'), null);
  assert.equal(normalizeTool({}), null, '没有名字不算工具');
  assert.equal(normalizeTool({ name: '' }), null);
  assert.equal(normalizeTool({ name: 42 }), null);
});

test('技能归一化：description/provider/whenToUse 只在确实是字符串时采用', () => {
  assert.deepEqual(
    normalizeSkill({ name: 'pdf', description: '处理 PDF', provider: 'builtin', whenToUse: '当用户提到 PDF' }),
    { name: 'pdf', description: '处理 PDF', provider: 'builtin', whenToUse: '当用户提到 PDF' },
  );
  const dirty = normalizeSkill({ name: 'x', description: 123, provider: { a: 1 }, whenToUse: null });
  assert.deepEqual(dirty, { name: 'x', description: '', provider: undefined, whenToUse: undefined },
    '对象/数字不能渲染成 [object Object]');
  assert.equal(normalizeSkill({ name: 42 }), null);
  assert.equal(normalizeSkill(null), null);
  assert.equal(normalizeSkill([]), null, '数组没有字符串 name → 不算技能');
});

test('排序：按名称且不改动入参', () => {
  const input = [{ name: 'b' }, { name: 'a' }, { name: 'C' }];
  assert.deepEqual(sortByName(input).map((entry) => entry.name), ['a', 'b', 'C']);
  assert.deepEqual(input.map((entry) => entry.name), ['b', 'a', 'C']);
  assert.deepEqual(sortByName(null), []);
});

test('能力摘要：计数 + MCP 服务器去重', () => {
  const mcpTools = [
    { name: 'mcp__gh__a', server: 'gh', tool: 'a' },
    { name: 'mcp__gh__b', server: 'gh', tool: 'b' },
    { name: 'mcp__fs__read', server: 'fs', tool: 'read' },
  ];
  assert.deepEqual(summarizeCapabilities([{ name: 'read' }], [{ name: 'pdf' }], mcpTools), {
    tools: 1, skills: 1, mcpServers: ['gh', 'fs'], mcpTools: 3,
  });
  assert.deepEqual(summarizeCapabilities(null, null, null), { tools: 0, skills: 0, mcpServers: [], mcpTools: 0 });
  assert.deepEqual(
    summarizeCapabilities([], [], [{ name: 'bad' }, null, { server: 42 }]).mcpServers,
    [],
    '缺 server 的条目不该污染服务器列表',
  );
});
