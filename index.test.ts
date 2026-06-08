import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { attachPageCapture, filterConsoleLogs, filterNetworkRequests } from './index';

// These will fail until the types and exports are added to index.ts
// Import will be added once exports exist — for now test the shape inline

describe('CaptureState', () => {
  it('initializes with empty buffers and null dialog', () => {
    const state = {
      consoleLogs: [] as Array<{ type: string; text: string; timestamp: number }>,
      networkRequests: [] as Array<{ method: string; url: string; status: number | null; timestamp: number }>,
      pendingDialog: null as null | { action: 'accept' | 'dismiss'; promptText?: string },
      maxEntries: 500,
    };
    expect(state.consoleLogs).toHaveLength(0);
    expect(state.networkRequests).toHaveLength(0);
    expect(state.pendingDialog).toBeNull();
    expect(state.maxEntries).toBe(500);
  });
});

function makeMockPage() {
  const emitter = new EventEmitter();
  return {
    on: (event: string, handler: (...args: any[]) => void) => emitter.on(event, handler),
    emit: (event: string, ...args: any[]) => emitter.emit(event, ...args),
  };
}

describe('attachPageCapture', () => {
  it('caps consoleLogs at maxEntries using ring buffer', () => {
    const state: any = { consoleLogs: [], networkRequests: [], pendingDialog: null, maxEntries: 3 };
    const page = makeMockPage() as any;
    attachPageCapture(page, state);

    for (let i = 0; i < 4; i++) {
      page.emit('console', { type: () => 'log', text: () => `msg${i}` });
    }

    expect(state.consoleLogs).toHaveLength(3);
    expect(state.consoleLogs[0].text).toBe('msg1');
    expect(state.consoleLogs[2].text).toBe('msg3');
  });

  it('matches response to request by object identity, not URL', () => {
    const state: any = { consoleLogs: [], networkRequests: [], pendingDialog: null, maxEntries: 100 };
    const page = makeMockPage() as any;
    attachPageCapture(page, state);

    const req1 = { method: () => 'GET', url: () => 'https://example.com/api' };
    const req2 = { method: () => 'GET', url: () => 'https://example.com/api' };

    page.emit('request', req1);
    page.emit('request', req2);
    page.emit('response', { status: () => 200, request: () => req2 });

    expect(state.networkRequests[0].status).toBeNull();
    expect(state.networkRequests[1].status).toBe(200);
  });

  it('auto-dismisses dialog when pendingDialog is null', async () => {
    const state: any = { consoleLogs: [], networkRequests: [], pendingDialog: null, maxEntries: 100 };
    const page = makeMockPage() as any;
    attachPageCapture(page, state);

    const dismissed = { called: false };
    const dialog = { dismiss: async () => { dismissed.called = true; }, accept: async () => {} };

    page.emit('dialog', dialog);
    await new Promise(r => setTimeout(r, 10));

    expect(dismissed.called).toBe(true);
  });

  it('accepts dialog when pendingDialog is armed with accept', async () => {
    const state: any = { consoleLogs: [], networkRequests: [], pendingDialog: { action: 'accept', promptText: 'yes' }, maxEntries: 100 };
    const page = makeMockPage() as any;
    attachPageCapture(page, state);

    let acceptedWith: string | undefined;
    const dialog = { dismiss: async () => {}, accept: async (text?: string) => { acceptedWith = text; } };

    page.emit('dialog', dialog);
    await new Promise(r => setTimeout(r, 10));

    expect(acceptedWith).toBe('yes');
    expect(state.pendingDialog).toBeNull();
  });

  it('dismisses dialog when pendingDialog is armed with dismiss', async () => {
    const state: any = { consoleLogs: [], networkRequests: [], pendingDialog: { action: 'dismiss' }, maxEntries: 100 };
    const page = makeMockPage() as any;
    attachPageCapture(page, state);

    const dismissed = { called: false };
    const dialog = { dismiss: async () => { dismissed.called = true; }, accept: async () => {} };

    page.emit('dialog', dialog);
    await new Promise(r => setTimeout(r, 10));

    expect(dismissed.called).toBe(true);
    expect(state.pendingDialog).toBeNull();
  });
});

describe('filterConsoleLogs', () => {
  const logs = [
    { type: 'log', text: 'hello', timestamp: 1 },
    { type: 'error', text: 'boom', timestamp: 2 },
    { type: 'warning', text: 'careful', timestamp: 3 },
    { type: 'log', text: 'world', timestamp: 4 },
  ];

  it('returns all when type is "all"', () => {
    expect(filterConsoleLogs(logs, 'all', 50)).toHaveLength(4);
  });

  it('filters by type', () => {
    const result = filterConsoleLogs(logs, 'error', 50);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('boom');
  });

  it('respects limit by taking the most recent', () => {
    const result = filterConsoleLogs(logs, 'all', 2);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('careful');
    expect(result[1].text).toBe('world');
  });
});

describe('filterNetworkRequests', () => {
  const requests = [
    { method: 'GET', url: 'https://api.example.com/users', status: 200, timestamp: 1 },
    { method: 'POST', url: 'https://api.example.com/login', status: 401, timestamp: 2 },
    { method: 'GET', url: 'https://cdn.example.com/style.css', status: 200, timestamp: 3 },
    { method: 'GET', url: 'https://api.example.com/data', status: null, timestamp: 4 },
  ];

  it('returns all when no filters applied', () => {
    expect(filterNetworkRequests(requests)).toHaveLength(4);
  });

  it('filters by urlContains', () => {
    expect(filterNetworkRequests(requests, 'api.example.com')).toHaveLength(3);
  });

  it('filters by method case-insensitively', () => {
    const result = filterNetworkRequests(requests, undefined, 'post');
    expect(result).toHaveLength(1);
    expect(result[0].url).toContain('login');
  });

  it('combines urlContains and method filters', () => {
    expect(filterNetworkRequests(requests, 'api.example.com', 'GET')).toHaveLength(2);
  });
});

const ScrollParams = Type.Object({
  selector: Type.Optional(Type.String()),
  deltaX: Type.Optional(Type.Number()),
  deltaY: Type.Optional(Type.Number()),
});

describe('browser_scroll params', () => {
  it('accepts empty object', () => { expect(Value.Check(ScrollParams, {})).toBe(true); });
  it('accepts selector only', () => { expect(Value.Check(ScrollParams, { selector: '#main' })).toBe(true); });
  it('rejects non-numeric deltaY', () => { expect(Value.Check(ScrollParams, { deltaY: 'down' })).toBe(false); });
});

const KeyParams = Type.Object({
  key: Type.String(),
  count: Type.Optional(Type.Number()),
});

describe('browser_key params', () => {
  it('accepts key only', () => { expect(Value.Check(KeyParams, { key: 'Enter' })).toBe(true); });
  it('accepts key with count', () => { expect(Value.Check(KeyParams, { key: 'ArrowDown', count: 5 })).toBe(true); });
  it('rejects missing key', () => { expect(Value.Check(KeyParams, {})).toBe(false); });
});

const HoverParams = Type.Object({
  selector: Type.String(),
  position: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() })),
});

describe('browser_hover params', () => {
  it('accepts selector only', () => { expect(Value.Check(HoverParams, { selector: '#btn' })).toBe(true); });
  it('accepts selector with position', () => { expect(Value.Check(HoverParams, { selector: '#btn', position: { x: 10, y: 5 } })).toBe(true); });
  it('rejects missing selector', () => { expect(Value.Check(HoverParams, {})).toBe(false); });
});

const DragParams = Type.Object({ source: Type.String(), target: Type.String() });

describe('browser_drag params', () => {
  it('accepts source and target', () => { expect(Value.Check(DragParams, { source: '#item', target: '#drop-zone' })).toBe(true); });
  it('rejects missing target', () => { expect(Value.Check(DragParams, { source: '#item' })).toBe(false); });
});

const UploadParams = Type.Object({ selector: Type.String(), paths: Type.Array(Type.String()) });

describe('browser_upload_file params', () => {
  it('accepts selector and paths array', () => { expect(Value.Check(UploadParams, { selector: 'input[type=file]', paths: ['/tmp/file.png'] })).toBe(true); });
  it('accepts multiple paths', () => { expect(Value.Check(UploadParams, { selector: 'input[type=file]', paths: ['/a.png', '/b.png'] })).toBe(true); });
  it('rejects non-array paths', () => { expect(Value.Check(UploadParams, { selector: 'input[type=file]', paths: '/a.png' })).toBe(false); });
});
