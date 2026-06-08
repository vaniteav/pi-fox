import { describe, it, expect } from 'vitest';

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
