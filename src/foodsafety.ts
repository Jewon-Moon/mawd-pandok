// 식품안전나라 Open API C003: 건강기능식품 품목제조신고(원재료)
// https://www.foodsafetykorea.go.kr/api/openApiInfo.do?svc_no=C003
// 제품이 건강기능식품으로 신고됐는지, 신고된 "주된기능성" 문구가 무엇인지 확인합니다.

export type Registration = {
  // similar: 이름이 일부만 겹치는 다른 제품. 같은 제품으로 단정하지 않습니다
  status: 'found' | 'similar' | 'not_found' | 'unknown';
  keyType: 'real' | 'sample';
  products: { name: string; company: string; reportNo: string; functionality: string; caution: string }[];
};

export async function lookupProduct(productName: string): Promise<Registration> {
  const real = process.env.FOODSAFETY_API_KEY?.trim();
  const keyType = real ? 'real' : 'sample';
  // 공개 샘플 키는 한 번에 5건까지만 돌려줍니다
  const url = `http://openapi.foodsafetykorea.go.kr/api/${real || 'sample'}/C003/json/1/5/PRDLST_NM=${encodeURIComponent(productName)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const j: any = await res.json();
    const rows: any[] = j?.C003?.row ?? [];
    const products = rows.map((r) => ({
      name: r.PRDLST_NM ?? '',
      company: r.BSSH_NM ?? '',
      reportNo: r.PRDLST_REPORT_NO ?? '',
      functionality: String(r.PRIMARY_FNCLTY ?? '').replace(/\r?\n/g, ' ').trim(),
      caution: String(r.IFTKN_ATNT_MATR_CN ?? '').replace(/\r?\n/g, ' ').trim(),
    }));
    // shortcut: 샘플 키는 데이터 일부만 보여줘서 "없음"을 단정할 수 없음. 실제 키를 넣으면 not_found가 의미를 가짐
    const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
    const exact = products.filter((p) => norm(p.name) === norm(productName));
    if (exact.length) return { status: 'found', keyType, products: exact };
    if (products.length) return { status: 'similar', keyType, products };
    return { status: real ? 'not_found' : 'unknown', keyType, products: [] };
  } catch {
    return { status: 'unknown', keyType, products: [] };
  }
}
