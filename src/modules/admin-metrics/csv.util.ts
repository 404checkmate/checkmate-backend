/**
 * 지표 내보내기용 CSV 직렬화 (외부 의존성 없음).
 * 값 규칙: null/undefined → 빈 칸, bigint → 문자열, boolean → true/false,
 * 객체 → JSON 문자열. 따옴표·콤마·개행이 있으면 RFC4180 방식으로 감싼다.
 */

export type CsvRow = Record<string, unknown>;

/** Excel 수식 주입 방지 — channel(utm_source/referrer)처럼 사용자 입력이 값에 섞이는 컬럼이 있다. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function csvValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString();
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && FORMULA_PREFIX.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 행 배열 → CSV. 헤더는 등장 순서대로 모든 행의 키 합집합. */
export function rowsToCsv(rows: CsvRow[]): string {
  if (!rows || rows.length === 0) return '';
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvValue(row[h])).join(','));
  }
  return lines.join('\r\n');
}

export interface CsvSection {
  key: string;
  label: string;
  rows: CsvRow[];
}

/**
 * 여러 데이터셋을 한 파일로 묶은 CSV.
 * `#` 주석으로 기간/집계 규칙을, `##` 헤더로 데이터셋 경계를 표시한다.
 * (Excel 에서 그대로 열리고, pandas 는 `comment='#'` 로 읽을 수 있다)
 * 선두 BOM 은 Excel 이 UTF-8 한글을 깨뜨리지 않게 하기 위한 것.
 */
export function buildCsvBundle(sections: CsvSection[], notes: string[]): string {
  const out = notes.map((line) => `# ${line}`);
  for (const section of sections) {
    out.push('', `## ${section.key} — ${section.label}`);
    out.push(section.rows.length > 0 ? rowsToCsv(section.rows) : '(데이터 없음)');
  }
  return `\uFEFF${out.join('\r\n')}\r\n`;
}
