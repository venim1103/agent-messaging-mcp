type NativePort = {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};

type NativeReply = { kind: string; protocolVersion: number; requestId: string;
  connectionGeneration: 0; deadlineMs: number; payload: Record<string, unknown> };
type PendingRequest = { deadlineMs: number; timer: ReturnType<typeof setTimeout>;
  resolve(reply: NativeReply): void; reject(error: Error): void };
type NativeChannel = { port: NativePort; requests: Map<string, PendingRequest>;
  idleTimer?: ReturnType<typeof setTimeout> };

export function createNativeRequestChannel(connect: () => NativePort, consumeLastError: () => void = () => {}) {
  let active: NativeChannel | undefined;

  function close(channel: NativeChannel): void {
    if (active !== channel) return;
    active = undefined;
    clearTimeout(channel.idleTimer);
    for (const request of channel.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Native request unavailable"));
    }
    channel.requests.clear();
    try { channel.port.disconnect(); } catch {}
  }

  function open(): NativeChannel {
    const channel: NativeChannel = { port: connect(), requests: new Map() };
    active = channel;
    channel.port.onDisconnect.addListener(() => {
      consumeLastError();
      close(channel);
    });
    channel.port.onMessage.addListener(value => {
      if (active !== channel) return;
      if (typeof value !== "object" || value === null || Array.isArray(value)) return close(channel);
      const reply = value as Record<string, unknown>;
      const request = typeof reply.requestId === "string" ? channel.requests.get(reply.requestId) : undefined;
      if (!request || Date.now() >= request.deadlineMs || Object.keys(reply).length !== 6
        || reply.protocolVersion !== 1 || reply.connectionGeneration !== 0 || reply.deadlineMs !== request.deadlineMs
        || typeof reply.kind !== "string" || typeof reply.payload !== "object"
        || reply.payload === null || Array.isArray(reply.payload)) return close(channel);
      channel.requests.delete(reply.requestId as string);
      clearTimeout(request.timer);
      if (channel.requests.size === 0) channel.idleTimer = setTimeout(() => close(channel), 1_000);
      request.resolve(reply as NativeReply);
    });
    return channel;
  }

  return (kind: string, payload: object, deadlineMs: number): Promise<NativeReply> => new Promise((resolve, reject) => {
    const now = Date.now();
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now || deadlineMs > now + 30_000
      || (active && active.requests.size >= 16)) {
      reject(new Error("Native request unavailable"));
      return;
    }
    let channel: NativeChannel | undefined;
    try {
      channel = active ?? open();
      clearTimeout(channel.idleTimer);
      channel.idleTimer = undefined;
      const requestId = crypto.randomUUID();
      const current = channel;
      const timer = setTimeout(() => close(current), Math.max(1, deadlineMs - Date.now()));
      channel.requests.set(requestId, { deadlineMs, timer, resolve, reject });
      if (Date.now() >= deadlineMs) return close(channel);
      channel.port.postMessage({ kind, protocolVersion: 1, requestId, connectionGeneration: 0, deadlineMs, payload });
    } catch {
      const failed = channel ?? active;
      if (failed) close(failed);
      reject(new Error("Native request unavailable"));
    }
  });
}