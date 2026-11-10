// 쿠팡 주문목록 → CSV 추출 스크립트
//
// 사용법
//   1. 크롬에서 쿠팡 로그인 후 https://mc.coupang.com/ssr/desktop/order/list 열기
//      (특정 연도만 받고 싶으면 연도 탭을 먼저 눌러두세요)
//   2. F12 → Console 탭 → 이 파일 전체를 붙여넣고 Enter
//      (처음이면 크롬이 "allow pasting" 입력을 요구할 수 있음)
//   3. 페이지를 차례로 읽은 뒤 coupang_orders_YYYYMMDD.csv 파일이 다운로드됩니다.
//
// 동작 방식
//   화면(DOM)을 긁지 않고, 각 페이지 HTML에 들어 있는 __NEXT_DATA__ JSON
//   (props.pageProps.domains.desktopOrder.orderList)을 읽습니다.
//   본인 브라우저의 로그인 세션으로 같은 사이트 페이지만 요청하며, 외부로 아무것도 보내지 않습니다.

(async () => {
  const MAX_PAGES = 300; // 안전장치
  const DELAY_MS = 800; // 페이지 사이 대기 (서버 부담 줄이기)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const kst = (ts) => (ts ? new Date(ts + 9 * 3600 * 1000).toISOString() : '');
  const fmtDate = (ts) => kst(ts).slice(0, 10);
  const fmtDateTime = (ts) => kst(ts).slice(0, 16).replace('T', ' ');

  const STATUS = {
    FINAL_DELIVERY: '배송완료',
    DELIVERING: '배송중',
    DEPARTURE: '배송시작',
    INSTRUCT: '상품준비중',
    ACCEPT: '결제완료',
    PAYMENT_WAITING: '입금대기',
    CANCEL: '취소',
  };

  function extract(doc) {
    const el = doc.getElementById('__NEXT_DATA__');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent)?.props?.pageProps?.domains?.desktopOrder ?? null;
    } catch {
      return null;
    }
  }

  async function fetchPage(pageIndex) {
    const url = new URL(location.href);
    url.searchParams.set('pageIndex', String(pageIndex));
    const res = await fetch(url.toString(), { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} (pageIndex=${pageIndex})`);
    const html = await res.text();
    return extract(new DOMParser().parseFromString(html, 'text/html'));
  }

  // 1) 모든 페이지 수집
  const seen = new Set();
  const orders = [];
  let pageIndex = 0;
  for (let n = 0; n < MAX_PAGES; n++) {
    const data = await fetchPage(pageIndex);
    if (!data || !Array.isArray(data.orderList)) {
      console.warn(`[coupang-csv] pageIndex=${pageIndex}: 주문 데이터를 찾지 못해 중단합니다.`);
      break;
    }
    const fresh = data.orderList.filter((o) => !seen.has(o.orderId));
    fresh.forEach((o) => seen.add(o.orderId));
    orders.push(...fresh);
    const pg = data.orderPagination || {};
    console.log(`[coupang-csv] pageIndex=${pageIndex}: 신규 ${fresh.length}건 (누적 ${orders.length}건)`, pg);
    if (fresh.length === 0 || !pg.hasNext) break;
    pageIndex = pg.nextPageIndex ?? pageIndex + 1;
    await sleep(DELAY_MS);
  }

  // 2) 상품 단위 행으로 펼치기
  const header = [
    '주문일시', '주문번호', '상태', '배송안내', '배송완료일시',
    '상품명', '브랜드', '수량', '정가(단가)', '할인단가', '합계(할인단가x수량)', '취소수량',
    '판매자', '택배사', '송장번호', '배송유형', '상품링크',
  ];
  const rows = [];
  const pushRow = (o, g, p, statusOverride) => {
    const qty = p.quantity ?? 0;
    const unit = p.discountedUnitPrice ?? p.unitPrice ?? '';
    rows.push([
      fmtDateTime(o.orderedAt),
      o.orderId,
      statusOverride || STATUS[g?.groupStatus?.status] || g?.groupStatus?.status || g?.invoiceStatus || '',
      g?.pddMessage?.message || '',
      fmtDateTime(g?.deliveredDate),
      p.vendorItemName || p.productName || '',
      p.brandInfo?.brandName || '',
      qty,
      p.unitPrice ?? '',
      unit,
      unit === '' ? '' : unit * qty,
      p.cancelQuantity ?? 0,
      g?.vendor?.vendorName || '',
      g?.deliveryCompany?.companyName || '',
      g?.invoiceNumber || '',
      p.badgeImageType || '',
      p.productId ? `https://www.coupang.com/vp/products/${p.productId}?vendorItemId=${p.vendorItemId}` : '',
    ]);
  };
  for (const o of orders) {
    for (const g of o.deliveryGroupList || []) for (const p of g.productList || []) pushRow(o, g, p);
    for (const b of o.deliveryCancelBundleList || []) for (const p of b.productList || []) pushRow(o, b, p, '취소');
  }

  // 3) CSV 다운로드 (엑셀 한글 깨짐 방지용 BOM 포함)
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `coupang_orders_${fmtDate(Date.now()).replace(/-/g, '')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  console.log(`[coupang-csv] 완료: 주문 ${orders.length}건, 상품 ${rows.length}행`);
})();
