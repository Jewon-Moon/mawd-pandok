// 공개 배포에서 크레딧이 새지 않게 막는 간단한 제한. 서버 메모리에만 두므로 재시작하면 초기화됨
// shortcut: 서버 한 대 기준. 여러 대로 늘리면 Redis 같은 공용 저장소로 옮겨야 함

/** key(IP)마다 windowMs 동안 max번까지 허용. 허용이면 true */
export function createRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return function allow(key: string, now = Date.now()): boolean {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    // 오래된 IP 기록이 쌓이지 않게 가끔 정리
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return true;
  };
}
