/**
 * 키별 단일 비행(single-flight) 뮤텍스 (설계 10.4).
 * 같은 키로 동시에 들어온 호출은 하나의 작업을 기다렸다가 같은 결과(또는 같은 오류)를 받는다.
 */
export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = fn().finally(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  has(key: string): boolean {
    return this.inflight.has(key);
  }
}
