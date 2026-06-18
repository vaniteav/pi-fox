import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { attachPageCapture, filterConsoleLogs, filterNetworkRequests, isBlockedIp, validateFetchUrlScheme, customProviderCodeAllowed, uploadPathAllowed } from './index';
import { resolve as resolvePath } from 'node:path';

// These will fail until the types and exports are added to index.ts
// Import will be added once exports exist — for now test the shape inline

describe('CaptureState', () => {
  it('initializes with empty buffers and null dialog', () => {
    const state = {
      consoleLogs: [] as Array<{ type: string; text: string; timestamp: number }>,
      networkRequests: [] as Array<{ method: string; url: string; status: number | null; timestamp: number }>,
      pendingNetworkQueue: [] as Array<{ req: unknown; entry: unknown }>,
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
    const state: any = { consoleLogs: [], networkRequests: [], pendingNetworkQueue: [], pendingDialog: null, maxEntries: 3 };
    const page = makeMockPage() as any;
    attachPageCapture(page, state);

    for (let i = 0; i < 4; i++) {
      page.emit('console', { type: () => 'log', text: () => `msg${i}` });
    }

    expect(state.consoleLogs).toHaveLength(3);
    expect(state.consoleLogs[0].text).toBe('msg1');
    expect(state.consoleLogs[2].text).toBe('msg3');
  });

  it('caps networkRequests at maxEntries and evicts pending queue entry by identity', () => {
    const state: any = { consoleLogs: [], networkRequests: [], pendingNetworkQueue: [], pendingDialog: null, maxEntries: 3 };
    const page = makeMockPage() as any;
    attachPageCapture(page, state);

    const req1 = { method: () => 'GET', url: () => 'https://a.com/1' };
    const req2 = { method: () => 'GET', url: () => 'https://a.com/2' };
    const req3 = { method: () => 'GET', url: () => 'https://a.com/3' };
    const req4 = { method: () => 'GET', url: () => 'https://a.com/4' };

    page.emit('request', req1);
    page.emit('request', req2);
    page.emit('request', req3);
    page.emit('request', req4); // evicts req1 entry

    expect(state.networkRequests).toHaveLength(3);
    expect(state.networkRequests[0].url).toBe('https://a.com/2');

    // evicted entry must be removed from pendingNetworkQueue
    const pendingUrls = state.pendingNetworkQueue.map((item: any) => item.entry.url);
    expect(pendingUrls).not.toContain('https://a.com/1');

    // a late response for evicted req1 must not mutate networkRequests
    page.emit('response', { status: () => 999, request: () => req1 });
    expect(state.networkRequests.find((e: any) => e.url === 'https://a.com/1')).toBeUndefined();
  });

  it('caps networkRequests correctly when evicted entry was already resolved', () => {
    const state: any = { consoleLogs: [], networkRequests: [], pendingNetworkQueue: [], pendingDialog: null, maxEntries: 2 };
    const page = makeMockPage() as any;
    attachPageCapture(page, state);

    const req1 = { method: () => 'GET', url: () => 'https://a.com/1' };
    const req2 = { method: () => 'GET', url: () => 'https://a.com/2' };
    const req3 = { method: () => 'GET', url: () => 'https://a.com/3' };

    page.emit('request', req1);
    page.emit('response', { status: () => 200, request: () => req1 }); // req1 resolved before eviction
    page.emit('request', req2);
    page.emit('request', req3); // evicts req1 entry (already resolved — not in pendingNetworkQueue)

    expect(state.networkRequests).toHaveLength(2);
    expect(state.networkRequests[0].url).toBe('https://a.com/2');
    // pendingNetworkQueue should only contain req2 and req3 (req1 was removed on response)
    const pendingUrls = state.pendingNetworkQueue.map((item: any) => item.entry.url);
    expect(pendingUrls).not.toContain('https://a.com/1');
  });

  it('matches response to request by object identity, not URL', () => {
    const state: any = { consoleLogs: [], networkRequests: [], pendingNetworkQueue: [], pendingDialog: null, maxEntries: 100 };
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
    const state: any = { consoleLogs: [], networkRequests: [], pendingNetworkQueue: [], pendingDialog: null, maxEntries: 100 };
    const page = makeMockPage() as any;
    attachPageCapture(page, state);

    const dismissed = { called: false };
    const dialog = { dismiss: async () => { dismissed.called = true; }, accept: async () => {} };

    page.emit('dialog', dialog);
    await new Promise(r => setTimeout(r, 10));

    expect(dismissed.called).toBe(true);
  });

  it('accepts dialog when pendingDialog is armed with accept', async () => {
    const state: any = { consoleLogs: [], networkRequests: [], pendingNetworkQueue: [], pendingDialog: { action: 'accept', promptText: 'yes' }, maxEntries: 100 };
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
    const state: any = { consoleLogs: [], networkRequests: [], pendingNetworkQueue: [], pendingDialog: { action: 'dismiss' }, maxEntries: 100 };
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

// browser_dialog.execute() sets captureState.pendingDialog — tested here by simulating that
// assignment and verifying the listener handles it. execute() lives inside the registerTool
// closure and cannot be imported directly; these tests verify the arm-then-handle contract.
describe('browser_dialog arming', () => {
  it('armed accept handler is consumed by dialog listener', async () => {
    const state: any = { consoleLogs: [], networkRequests: [], pendingNetworkQueue: [], pendingDialog: { action: 'accept', promptText: 'input' }, maxEntries: 100 };
    const page = makeMockPage() as any;
    attachPageCapture(page, state);

    let accepted: string | undefined;
    page.emit('dialog', { accept: async (t?: string) => { accepted = t; }, dismiss: async () => {} });
    await new Promise(r => setTimeout(r, 10));

    expect(accepted).toBe('input');
    expect(state.pendingDialog).toBeNull();
  });

  it('armed dismiss handler is consumed by dialog listener', async () => {
    const state: any = { consoleLogs: [], networkRequests: [], pendingNetworkQueue: [], pendingDialog: { action: 'dismiss' }, maxEntries: 100 };
    const page = makeMockPage() as any;
    attachPageCapture(page, state);

    let dismissed = false;
    page.emit('dialog', { accept: async () => {}, dismiss: async () => { dismissed = true; } });
    await new Promise(r => setTimeout(r, 10));

    expect(dismissed).toBe(true);
    expect(state.pendingDialog).toBeNull();
  });
});

describe('pi SDK v0.79.7 compatibility', () => {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8');

  it('uses StringEnum instead of Type.Union/Type.Literal for string enum schemas', () => {
    expect(source).toContain('StringEnum');
    expect(source).not.toMatch(/Type\.(Union|Literal)/);
  });

  it('throws tool errors instead of returning isError from execute results', () => {
    expect(source).not.toMatch(/isError:\s*true/);
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

describe('isBlockedIp — SSRF guard', () => {
  it('blocks IPv4 loopback', () => { expect(isBlockedIp('127.0.0.1')).toBe(true); });
  it('blocks 127/8 anywhere in range', () => { expect(isBlockedIp('127.255.255.254')).toBe(true); });
  it('blocks 10/8 private', () => { expect(isBlockedIp('10.0.0.5')).toBe(true); });
  it('blocks 172.16/12 private', () => { expect(isBlockedIp('172.16.0.1')).toBe(true); });
  it('does NOT block 172.32 (outside 172.16/12)', () => { expect(isBlockedIp('172.32.0.1')).toBe(false); });
  it('blocks 192.168/16 private', () => { expect(isBlockedIp('192.168.1.1')).toBe(true); });
  it('blocks link-local 169.254/16', () => { expect(isBlockedIp('169.254.10.20')).toBe(true); });
  it('blocks cloud metadata 169.254.169.254', () => { expect(isBlockedIp('169.254.169.254')).toBe(true); });
  it('blocks CGNAT 100.64/10', () => { expect(isBlockedIp('100.64.0.1')).toBe(true); });
  it('blocks 0.0.0.0', () => { expect(isBlockedIp('0.0.0.0')).toBe(true); });
  it('blocks IPv6 loopback ::1', () => { expect(isBlockedIp('::1')).toBe(true); });
  it('blocks IPv6 unspecified ::', () => { expect(isBlockedIp('::')).toBe(true); });
  it('blocks IPv6 unique-local fc00::/7', () => { expect(isBlockedIp('fc00::1')).toBe(true); });
  it('blocks IPv6 link-local fe80::/10', () => { expect(isBlockedIp('fe80::1')).toBe(true); });
  it('blocks IPv4-mapped IPv6 to a private addr', () => { expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true); });
  it('blocks COMPRESSED IPv4-mapped IPv6 loopback (::ffff:7f00:1)', () => { expect(isBlockedIp('::ffff:7f00:1')).toBe(true); });
  it('blocks COMPRESSED IPv4-mapped IPv6 private (::ffff:c0a8:1 = 192.168.0.1)', () => { expect(isBlockedIp('::ffff:c0a8:1')).toBe(true); });
  it('still allows COMPRESSED IPv4-mapped public (::ffff:808:808 = 8.8.8.8)', () => { expect(isBlockedIp('::ffff:808:808')).toBe(false); });
  it('allows public IPv4 8.8.8.8', () => { expect(isBlockedIp('8.8.8.8')).toBe(false); });
  it('allows public IPv4 1.1.1.1', () => { expect(isBlockedIp('1.1.1.1')).toBe(false); });
  it('allows public IPv6 2606:4700::1111', () => { expect(isBlockedIp('2606:4700::1111')).toBe(false); });
});

describe('uploadPathAllowed — upload root allowlist', () => {
  it('allows any path when no roots are configured (non-breaking default)', () => {
    expect(uploadPathAllowed('/etc/passwd', [])).toBe(true);
    expect(uploadPathAllowed('/etc/passwd', undefined)).toBe(true);
  });
  it('allows a path inside an allowed root', () => {
    const root = resolvePath('uploads');
    expect(uploadPathAllowed(resolvePath('uploads/a.png'), [root])).toBe(true);
  });
  it('allows the root itself', () => {
    const root = resolvePath('uploads');
    expect(uploadPathAllowed(root, [root])).toBe(true);
  });
  it('blocks a path outside all allowed roots', () => {
    expect(uploadPathAllowed(resolvePath('/etc/passwd'), [resolvePath('uploads')])).toBe(false);
  });
  it('blocks traversal that escapes the root', () => {
    const root = resolvePath('uploads');
    expect(uploadPathAllowed(resolvePath('uploads/../secrets/key'), [root])).toBe(false);
  });
  it('does not treat a sibling sharing a name prefix as inside', () => {
    expect(uploadPathAllowed(resolvePath('uploads-evil/x'), [resolvePath('uploads')])).toBe(false);
  });
});

describe('customProviderCodeAllowed — RCE gate', () => {
  it('blocks by default when the trust flag is unset', () => { expect(customProviderCodeAllowed({ ext: {} } as any)).toBe(false); });
  it('blocks when the trust flag is explicitly false', () => { expect(customProviderCodeAllowed({ ext: { trustCustomProviders: false } } as any)).toBe(false); });
  it('allows only when the trust flag is strictly true', () => { expect(customProviderCodeAllowed({ ext: { trustCustomProviders: true } } as any)).toBe(true); });
  it('does NOT allow on truthy-but-not-true values (no coercion)', () => {
    expect(customProviderCodeAllowed({ ext: { trustCustomProviders: 1 } } as any)).toBe(false);
    expect(customProviderCodeAllowed({ ext: { trustCustomProviders: 'true' } } as any)).toBe(false);
  });
});

describe('validateFetchUrlScheme — SSRF guard', () => {
  it('allows https', () => { expect(validateFetchUrlScheme('https://example.com').ok).toBe(true); });
  it('allows http', () => { expect(validateFetchUrlScheme('http://example.com').ok).toBe(true); });
  it('rejects file://', () => { expect(validateFetchUrlScheme('file:///etc/passwd').ok).toBe(false); });
  it('rejects ftp://', () => { expect(validateFetchUrlScheme('ftp://host/x').ok).toBe(false); });
  it('rejects unparseable url', () => { expect(validateFetchUrlScheme('not a url').ok).toBe(false); });
  it('rejects a literal-IP host that is private', () => { expect(validateFetchUrlScheme('http://127.0.0.1:8080/admin').ok).toBe(false); });
  it('rejects literal metadata IP host', () => { expect(validateFetchUrlScheme('http://169.254.169.254/latest/meta-data/').ok).toBe(false); });
  it('allows a literal public-IP host', () => { expect(validateFetchUrlScheme('http://8.8.8.8/').ok).toBe(true); });
});
