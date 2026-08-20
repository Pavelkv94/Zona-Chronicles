import { describe, expect, it } from 'vitest';
import { classifySession } from './session-role.ts';

describe('classifySession', () => {
  it('task: непустой agent_id', () => {
    expect(classifySession({ agent_id: 'agent-123' })).toBe('task');
  });

  it('task: непустой agent_type', () => {
    expect(classifySession({ agent_type: 'tooling-implementer' })).toBe('task');
  });

  it('task: оба поля присутствуют', () => {
    expect(classifySession({ agent_id: 'agent-123', agent_type: 'tooling-implementer' })).toBe(
      'task',
    );
  });

  it('lead: оба поля отсутствуют, есть только общие поля hook payload', () => {
    expect(
      classifySession({
        session_id: 'sess-1',
        cwd: '/repo',
        permission_mode: 'default',
        hook_event_name: 'PreToolUse',
      }),
    ).toBe('lead');
  });

  it('lead: пустой payload', () => {
    expect(classifySession({})).toBe('lead');
  });

  it('lead: пустая строка не считается признаком', () => {
    expect(classifySession({ agent_id: '', agent_type: '' })).toBe('lead');
  });

  it('lead: значения не-строкового типа игнорируются', () => {
    expect(classifySession({ agent_id: null })).toBe('lead');
    expect(classifySession({ agent_id: 42 })).toBe('lead');
    expect(classifySession({ agent_type: [] })).toBe('lead');
    expect(classifySession({ agent_type: {} })).toBe('lead');
  });

  it('файл на диске не участвует в решении: функция читает только payload', () => {
    // classifySession принимает только объект — у неё физически нет доступа к файловой системе,
    // поэтому rm -f .claude/writeset.json не может повлиять на её результат.
    expect(classifySession({ agent_id: 'agent-123', writeset_deleted: true })).toBe('task');
  });

  it('minor 4: main-поток с mainThreadAgentType() тоже классифицируется как task — safe direction', () => {
    // Документированное допущение: установленный CLI может подставить agent_type даже главному
    // потоку (не только subagent-сессии). Это не проверенная гарантия платформы, а осознанно
    // принятый компромисс: направление ошибки — deny/ограничение (task), а не allow без
    // ограничений (lead) — см. doc-комментарий модуля, minor 4.
    expect(classifySession({ agent_type: 'main-thread-agent-type', session_id: 'sess-main' })).toBe(
      'task',
    );
  });
});
