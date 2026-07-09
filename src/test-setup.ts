import { vi } from 'vitest';

// navigator.mediaDevices のモック（マイク許可不要でテスト可能に）
Object.defineProperty(navigator, 'mediaDevices', {
  value: {
    getUserMedia: vi.fn().mockResolvedValue({
      getTracks: (): Array<{ stop: () => void }> => [{ stop: vi.fn() }],
    }),
  },
  configurable: true,
});
