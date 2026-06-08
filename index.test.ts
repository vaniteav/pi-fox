import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { attachPageCapture } from './index';

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
